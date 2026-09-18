import type { MessageType } from "@prisma/client";

import { prisma } from "@/lib/db/prisma";
import type { InstagramWebhookMessagingItem } from "@/lib/instagram/webhook";

function resolveMessageType(item: InstagramWebhookMessagingItem): MessageType {
  const message = item.message;
  if (!message) return "UNSUPPORTED";
  if (message.is_unsupported) return "UNSUPPORTED";
  if (message.reply_to?.story) return "STORY_REPLY";

  const attachment = message.attachments?.[0];
  if (attachment) {
    switch (attachment.type) {
      case "image":
        return "IMAGE";
      case "video":
      case "ig_reel":
      case "reel":
        return "VIDEO";
      case "audio":
        return "AUDIO";
      case "file":
        return "FILE";
      case "share":
        return "SHARE";
      case "story_mention":
        return "STORY_MENTION";
      default:
        return "UNSUPPORTED";
    }
  }

  return message.text ? "TEXT" : "UNSUPPORTED";
}

// JSON.parse(JSON.stringify(...)) strips the `unknown` payload fields down
// to plain, Prisma-Json-safe data.
function toJsonSafe(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value));
}

export type ProcessMessagingItemResult =
  { processed: false; reason: string } | { processed: true; messageId: string };

// One messaging item = one DM in a 1:1 Instagram thread (spec §9/§27).
// Instagram's webhook payload carries no Meta-assigned conversation ID, so
// the conversation's natural key here is (our account, the other person) —
// which is exactly what a 1:1 DM thread is. If a later phase backfills
// history from GET /{ig-user-id}/conversations, it should reconcile by this
// same participant id.
export async function processMessagingItem(
  instagramAccountId: string,
  item: InstagramWebhookMessagingItem,
): Promise<ProcessMessagingItemResult> {
  if (!item.sender || !item.recipient) {
    return { processed: false, reason: "unsupported-notification-shape" };
  }

  const isEcho = item.message?.is_echo === true;
  const participantExternalId = isEcho ? item.recipient.id : item.sender.id;

  if (item.message?.is_deleted) {
    if (!item.message.mid) {
      return { processed: false, reason: "deleted-message-without-mid" };
    }

    const deleted = await prisma.message.updateMany({
      where: { externalMessageId: item.message.mid },
      data: { text: null },
    });

    return deleted.count > 0
      ? { processed: true, messageId: item.message.mid }
      : { processed: false, reason: "deleted-message-not-found" };
  }

  const messageType = resolveMessageType(item);
  const externalMessageId = item.message?.mid;
  const attachmentMetadata = item.message?.attachments
    ? (toJsonSafe({ attachments: item.message.attachments }) as object)
    : undefined;

  const { message } = await prisma.$transaction(
    async (tx) => {
      const participant = await tx.instagramParticipant.upsert({
        where: {
          instagramAccountId_externalUserId: {
            instagramAccountId,
            externalUserId: participantExternalId,
          },
        },
        update: {},
        create: { instagramAccountId, externalUserId: participantExternalId },
      });

      const upsertedConversation = await tx.conversation.upsert({
        where: {
          instagramAccountId_externalConversationId: {
            instagramAccountId,
            externalConversationId: participantExternalId,
          },
        },
        update: { lastMessageAt: new Date(item.timestamp) },
        create: {
          instagramAccountId,
          externalConversationId: participantExternalId,
          participantId: participant.id,
          lastMessageAt: new Date(item.timestamp),
        },
        select: { id: true, aiEnabled: true, humanTakeover: true, status: true },
      });

      const messageData = {
        conversationId: upsertedConversation.id,
        senderType: isEcho ? ("USER" as const) : ("CONTACT" as const),
        direction: isEcho ? ("OUTBOUND" as const) : ("INBOUND" as const),
        messageType,
        text: item.message?.text,
        attachmentMetadata,
        externalTimestamp: new Date(item.timestamp),
      };

      const savedMessage = externalMessageId
        ? await tx.message.upsert({
            where: { externalMessageId },
            update: {},
            create: { ...messageData, externalMessageId },
          })
        : await tx.message.create({ data: messageData });

      const count = await tx.message.count({
        where: { conversationId: upsertedConversation.id, senderType: { not: "SYSTEM" } },
      });

      return {
        message: savedMessage,
        conversation: upsertedConversation,
        messageCount: count,
      };
    },
  );

  return { processed: true, messageId: message.id };
}
