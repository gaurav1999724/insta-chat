import type { Conversation, InstagramAccount } from "@prisma/client";

import { prisma } from "@/lib/db/prisma";
import { InstagramApiError } from "@/lib/instagram/errors";
import {
  SEND_NOT_SUPPORTED_MESSAGE,
  isWithinMessagingWindow,
} from "@/lib/instagram/send-eligibility";
import { logOperation } from "@/lib/logging/logger";
import { decrypt } from "@/lib/security/encryption";
import { checkRateLimit, formatRetryAfter } from "@/lib/security/rate-limit";
import { sendMessage } from "@/services/instagram/instagram-service";

// Thrown for both "we chose not to attempt this" (not approved, window
// closed) and "the API call failed" cases. Callers decide what to do with
// it: manual server actions catch it and return a friendly
// `{ success: false }` result.
export class SendMessageError extends Error {}

type ConversationWithAccount = Conversation & {
  instagramAccount: InstagramAccount;
  participant: { externalUserId: string };
};

async function assertSendEligible(conversation: ConversationWithAccount): Promise<void> {
  if (conversation.instagramAccount.status !== "ACTIVE") {
    throw new SendMessageError("Instagram account is not connected.");
  }

  const lastInbound = await prisma.message.findFirst({
    where: { conversationId: conversation.id, direction: "INBOUND" },
    orderBy: { createdAt: "desc" },
    select: { createdAt: true },
  });

  if (!isWithinMessagingWindow(lastInbound?.createdAt ?? null)) {
    throw new SendMessageError(SEND_NOT_SUPPORTED_MESSAGE);
  }
}

async function callInstagramSend(
  conversation: ConversationWithAccount,
  text: string,
): Promise<{ externalMessageId: string }> {
  const accessToken = decrypt(conversation.instagramAccount.accessTokenEncrypted);
  return sendMessage(
    accessToken,
    conversation.instagramAccount.instagramUserId,
    conversation.participant.externalUserId,
    text,
  );
}

export type SendMessageResult = { messageId: string };

// Shared by the manual "Send" button (once a draft is APPROVED) and the
// automatic `instagram-send` queue worker (Phase 9's auto-send path, spec
// §59). Always creates a Message/MessageDelivery row before attempting the
// network call, so even a failed attempt is tracked (spec §60) — not just
// successful sends.
export async function sendApprovedDraft(
  aiResponseId: string,
  userId?: string,
): Promise<SendMessageResult> {
  const aiResponse = await prisma.aIResponse.findUnique({
    where: { id: aiResponseId },
    include: {
      conversation: {
        include: {
          instagramAccount: true,
          participant: { select: { externalUserId: true } },
        },
      },
    },
  });

  if (!aiResponse) {
    throw new SendMessageError("Draft not found.");
  }
  if (aiResponse.status !== "APPROVED") {
    throw new SendMessageError("Draft must be approved before it can be sent.");
  }

  const { conversation } = aiResponse;
  await assertSendEligible(conversation);

  // Tracked before the network call so a failure still leaves a row (spec
  // §60 — never silently lose a send attempt), and so a repeated attempt
  // reuses the same
  // row instead of creating a duplicate outbound message. There's no real
  // Meta message id yet, so a placeholder keyed on the AIResponse id fills
  // the unique `externalMessageId` slot until (if) the send succeeds.
  const placeholderExternalId = `pending-send:${aiResponseId}`;
  const message = await prisma.message.upsert({
    where: { externalMessageId: placeholderExternalId },
    update: {},
    create: {
      conversationId: conversation.id,
      externalMessageId: placeholderExternalId,
      senderType: "AI",
      direction: "OUTBOUND",
      messageType: "TEXT",
      text: aiResponse.text,
    },
  });
  await prisma.messageDelivery.upsert({
    where: { messageId: message.id },
    update: { status: "RETRYING", attempts: { increment: 1 }, lastAttemptAt: new Date() },
    create: {
      messageId: message.id,
      status: "PENDING",
      attempts: 1,
      lastAttemptAt: new Date(),
    },
  });

  try {
    const result = await callInstagramSend(conversation, aiResponse.text);

    await prisma.$transaction([
      prisma.message.update({
        where: { id: message.id },
        data: {
          externalMessageId: result.externalMessageId,
          externalTimestamp: new Date(),
        },
      }),
      prisma.messageDelivery.update({
        where: { messageId: message.id },
        data: { status: "SENT" },
      }),
      prisma.aIResponse.update({
        where: { id: aiResponseId },
        data: { status: "SENT", sentMessageId: message.id },
      }),
      prisma.conversation.update({
        where: { id: conversation.id },
        data: { lastMessageAt: new Date() },
      }),
      prisma.auditLog.create({
        data: {
          userId,
          action: "MESSAGE_SENT",
          entityType: "Message",
          entityId: message.id,
        },
      }),
    ]);

    logOperation({
      userId,
      conversationId: conversation.id,
      messageId: message.id,
      operation: "instagram.send_message",
      status: "success",
    });

    return { messageId: message.id };
  } catch (error) {
    const errorMessage =
      error instanceof InstagramApiError ? error.message : "Failed to send the message.";

    await prisma.$transaction([
      prisma.messageDelivery.update({
        where: { messageId: message.id },
        data: { status: "FAILED", errorMessage },
      }),
      prisma.auditLog.create({
        data: {
          userId,
          action: "MESSAGE_FAILED",
          entityType: "Message",
          entityId: message.id,
        },
      }),
    ]);

    await prisma.aPIError.create({
      data: {
        category: "INSTAGRAM_API_ERROR",
        message: errorMessage,
        userId,
        conversationId: conversation.id,
        metadata:
          error instanceof InstagramApiError && error.details !== undefined
            ? { details: JSON.parse(JSON.stringify(error.details)) }
            : undefined,
      },
    });

    logOperation({
      userId,
      conversationId: conversation.id,
      messageId: message.id,
      operation: "instagram.send_message",
      status: "failure",
      errorCode: "INSTAGRAM_API_ERROR",
    });

    throw new SendMessageError(errorMessage);
  }
}

// spec §61: "The user must always be able to manually communicate" — not
// gated on `aiEnabled`/`humanTakeover` at all, only on the same universal
// Instagram constraints (account connected, 24-hour window) every send
// path is subject to. Not queued/retried like `sendApprovedDraft()` — this
// runs synchronously from the composer's "Send" click, so a plain
// `create()` (not an upsert-on-retry) is enough; a user who wants to retry
// after a failure just clicks Send again with a fresh attempt.
export async function sendManualMessage(
  conversationId: string,
  text: string,
  userId?: string,
): Promise<SendMessageResult> {
  const conversation = await prisma.conversation.findUnique({
    where: { id: conversationId },
    include: {
      instagramAccount: true,
      participant: { select: { externalUserId: true } },
    },
  });

  if (!conversation) {
    throw new SendMessageError("Conversation not found.");
  }

  // spec §50: rate limit manual message sending. AI-approved sends
  // (`sendApprovedDraft()`) are deliberately not limited here separately —
  // they're already bounded upstream by the AI_GENERATION limit (you can't
  // send more approved drafts than you generated) — see
  // PROJECT_ANALYSIS.md §9d.
  const rateLimit = await checkRateLimit("MESSAGE_SEND", conversationId);
  if (!rateLimit.allowed) {
    const message = `Too many messages sent in this conversation — try again in ${formatRetryAfter(rateLimit.retryAfterSeconds)}.`;
    await prisma.aPIError.create({
      data: { category: "RATE_LIMIT_ERROR", message, userId, conversationId },
    });
    logOperation({
      userId,
      conversationId,
      operation: "instagram.send_manual_message",
      status: "failure",
      errorCode: "RATE_LIMIT_ERROR",
    });
    throw new SendMessageError(message);
  }

  await assertSendEligible(conversation);

  const message = await prisma.message.create({
    data: {
      conversationId: conversation.id,
      senderType: "USER",
      direction: "OUTBOUND",
      messageType: "TEXT",
      text,
    },
  });
  await prisma.messageDelivery.create({
    data: {
      messageId: message.id,
      status: "PENDING",
      attempts: 1,
      lastAttemptAt: new Date(),
    },
  });

  try {
    const result = await callInstagramSend(conversation, text);

    await prisma.$transaction([
      prisma.message.update({
        where: { id: message.id },
        data: {
          externalMessageId: result.externalMessageId,
          externalTimestamp: new Date(),
        },
      }),
      prisma.messageDelivery.update({
        where: { messageId: message.id },
        data: { status: "SENT" },
      }),
      prisma.conversation.update({
        where: { id: conversation.id },
        data: { lastMessageAt: new Date() },
      }),
      prisma.auditLog.create({
        data: {
          userId,
          action: "MESSAGE_SENT",
          entityType: "Message",
          entityId: message.id,
        },
      }),
    ]);

    logOperation({
      userId,
      conversationId: conversation.id,
      messageId: message.id,
      operation: "instagram.send_manual_message",
      status: "success",
    });

    return { messageId: message.id };
  } catch (error) {
    const errorMessage =
      error instanceof InstagramApiError ? error.message : "Failed to send the message.";

    await prisma.$transaction([
      prisma.messageDelivery.update({
        where: { messageId: message.id },
        data: { status: "FAILED", errorMessage },
      }),
      prisma.auditLog.create({
        data: {
          userId,
          action: "MESSAGE_FAILED",
          entityType: "Message",
          entityId: message.id,
        },
      }),
    ]);

    await prisma.aPIError.create({
      data: {
        category: "INSTAGRAM_API_ERROR",
        message: errorMessage,
        userId,
        conversationId: conversation.id,
        metadata:
          error instanceof InstagramApiError && error.details !== undefined
            ? { details: JSON.parse(JSON.stringify(error.details)) }
            : undefined,
      },
    });

    logOperation({
      userId,
      conversationId: conversation.id,
      messageId: message.id,
      operation: "instagram.send_manual_message",
      status: "failure",
      errorCode: "INSTAGRAM_API_ERROR",
    });

    throw new SendMessageError(errorMessage);
  }
}
