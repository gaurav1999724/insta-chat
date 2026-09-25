import type { Conversation, InstagramAccount } from "@prisma/client";

import { prisma } from "@/lib/db/prisma";
import { InstagramApiError } from "@/lib/instagram/errors";
import {
  SEND_NOT_SUPPORTED_MESSAGE,
  isWithinMessagingWindow,
} from "@/lib/instagram/send-eligibility";
import { computeNextRetryAt, isRetryableSendError } from "@/lib/instagram/retry-policy";
import { logOperation } from "@/lib/logging/logger";
import { checkRateLimit, formatRetryAfter } from "@/lib/security/rate-limit";
import { sendMessage } from "@/services/instagram/instagram-service";

import { SendMessageError } from "@/services/ai/send-errors";

export { SendMessageError } from "@/services/ai/send-errors";

type ConversationWithAccount = Conversation & {
  instagramAccount: InstagramAccount;
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
  // SocialAPI.AI's send endpoint addresses the conversation by its own
  // `conversation_id` (stored as `externalConversationId`), not the
  // participant's user id — a real, distinct thread id this provider
  // gives us, unlike Meta/CollectAPI's synthetic same-as-participant one.
  return sendMessage(
    conversation.instagramAccount.instagramUserId,
    conversation.externalConversationId,
    text,
  );
}

export type SendMessageResult = { messageId: string };

// Shared by the manual "Send" button (once a draft is APPROVED), the
// auto-send path (maybeAutoRespond()), and the automatic retry path
// (src/services/ai/retry-service.ts) for a previously FAILED send of the
// same draft. Always creates a Message/MessageDelivery row before
// attempting the network call, so even a failed attempt is tracked (spec
// §60) — not just successful sends. Safe to call again for the same
// aiResponseId: the placeholder externalMessageId makes the Message/
// MessageDelivery upserts reuse the existing rows and bump `attempts`
// instead of creating duplicates.
export async function sendApprovedDraft(
  aiResponseId: string,
  userId?: string,
): Promise<SendMessageResult> {
  const aiResponse = await prisma.aIResponse.findUnique({
    where: { id: aiResponseId },
    include: {
      conversation: {
        include: { instagramAccount: true },
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
  const delivery = await prisma.messageDelivery.upsert({
    where: { messageId: message.id },
    update: {
      status: "RETRYING",
      attempts: { increment: 1 },
      lastAttemptAt: new Date(),
      nextRetryAt: null,
    },
    create: {
      messageId: message.id,
      status: "PENDING",
      attempts: 1,
      lastAttemptAt: new Date(),
    },
  });

  try {
    // Checked inside the try (not before the delivery row exists) so that a
    // closed messaging window / disconnected account is recorded and
    // classified through the same failure path below — including marking
    // it permanently non-retryable — instead of throwing before any of
    // that bookkeeping happens.
    await assertSendEligible(conversation);
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
      error instanceof InstagramApiError || error instanceof SendMessageError
        ? error.message
        : "Failed to send the message.";
    const nextRetryAt = isRetryableSendError(error) ? computeNextRetryAt(delivery.attempts) : null;

    await prisma.$transaction([
      prisma.messageDelivery.update({
        where: { messageId: message.id },
        data: { status: "FAILED", errorMessage, nextRetryAt },
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
      detail: `${errorMessage} (attempt ${delivery.attempts}, ${nextRetryAt ? `retrying at ${nextRetryAt.toISOString()}` : "not retrying automatically"})`,
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
    include: { instagramAccount: true },
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
      detail: errorMessage,
    });

    throw new SendMessageError(errorMessage);
  }
}
