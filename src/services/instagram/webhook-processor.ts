import type { MessageType } from "@prisma/client";

import { prisma } from "@/lib/db/prisma";
import type { SocialApiDmEvent } from "@/lib/instagram/webhook";

function resolveMessageType(content: SocialApiDmEvent["data"]["content"]): MessageType {
  const media = content.media?.[0];
  if (!media) return content.text ? "TEXT" : "UNSUPPORTED";

  switch (media.type) {
    case "image":
      return "IMAGE";
    case "video":
    case "reel":
      return "VIDEO";
    case "audio":
      return "AUDIO";
    case "file":
      return "FILE";
    default:
      return "UNSUPPORTED";
  }
}

function toJsonSafe(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value));
}

export type ProcessMessagingItemResult =
  | { processed: false; reason: string }
  | { processed: true; messageId: string; conversationId: string };

// One SocialAPI.AI `dm.received` event = one inbound DM in a 1:1 Instagram
// thread (spec §9/§27). Unlike Meta/CollectAPI, SocialAPI.AI gives us a
// real, distinct `conversation_id` separate from the participant's own
// user id — no synthetic-thread-id workaround needed.
//
// Only ever called for `dm.received` — the webhook route deliberately
// never forwards `dm.sent` here (see its own comment): that event echoes
// messages *we* already sent, under a different id namespace than what we
// recorded them under ourselves, which caused a real duplicate-message
// bug (confirmed 2026-09-21). So every event reaching this function is
// necessarily inbound.
export async function processMessagingItem(
  instagramAccountId: string,
  event: SocialApiDmEvent,
): Promise<ProcessMessagingItemResult> {
  const { data } = event;
  const externalMessageId = data.platform_id;
  const messageType = resolveMessageType(data.content);
  const attachmentMetadata =
    data.content.media && data.content.media.length > 0
      ? (toJsonSafe({ media: data.content.media }) as object)
      : undefined;

  const { message, conversation } = await prisma.$transaction(
    async (tx) => {
      const participant = await tx.instagramParticipant.upsert({
        where: {
          instagramAccountId_externalUserId: {
            instagramAccountId,
            externalUserId: data.author.id,
          },
        },
        update: { username: data.author.name, profilePictureUrl: data.author.avatar_url },
        create: {
          instagramAccountId,
          externalUserId: data.author.id,
          username: data.author.name,
          profilePictureUrl: data.author.avatar_url,
        },
      });

      const upsertedConversation = await tx.conversation.upsert({
        where: {
          instagramAccountId_externalConversationId: {
            instagramAccountId,
            externalConversationId: data.conversation_id,
          },
        },
        update: { lastMessageAt: new Date(data.received_at) },
        create: {
          instagramAccountId,
          externalConversationId: data.conversation_id,
          participantId: participant.id,
          lastMessageAt: new Date(data.received_at),
        },
        select: { id: true, aiEnabled: true, humanTakeover: true, status: true },
      });

      const messageData = {
        conversationId: upsertedConversation.id,
        senderType: "CONTACT" as const,
        direction: "INBOUND" as const,
        messageType,
        text: data.content.text,
        attachmentMetadata,
        externalTimestamp: new Date(data.received_at),
      };

      const savedMessage = await tx.message.upsert({
        where: { externalMessageId },
        update: {},
        create: { ...messageData, externalMessageId },
      });

      const count = await tx.message.count({
        where: { conversationId: upsertedConversation.id, senderType: { not: "SYSTEM" } },
      });

      return {
        message: savedMessage,
        conversation: upsertedConversation,
        messageCount: count,
      };
    },
    // Prisma's default 5s interactive-transaction timeout is too tight for
    // this project's Neon Postgres, whose compute auto-suspends after
    // inactivity: a cold-start on the first query of the transaction alone
    // can take several seconds, then Prisma aborts the transaction before
    // the later queries in this callback even run ("Transaction API error:
    // Transaction not found") — confirmed 2026-09-21 via a real webhook
    // delivery that passed every earlier step and failed only here.
    { timeout: 15_000, maxWait: 10_000 },
  );

  return { processed: true, messageId: message.id, conversationId: conversation.id };
}
