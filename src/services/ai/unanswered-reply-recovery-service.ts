import { prisma } from "@/lib/db/prisma";
import { maybeAutoRespond } from "@/services/ai/auto-respond-service";

const RECENT_CONVERSATION_LIMIT = 5;

export type RecoveryScanResult = {
  accounts: number;
  candidates: number;
  processed: number;
  failed: number;
};

export async function recoverUnansweredReplies(): Promise<RecoveryScanResult> {
  const accounts = await prisma.instagramAccount.findMany({
    where: { status: "ACTIVE" },
    select: {
      conversations: {
        orderBy: { lastMessageAt: "desc" },
        take: RECENT_CONVERSATION_LIMIT,
        select: {
          id: true,
          aiEnabled: true,
          humanTakeover: true,
          messages: {
            orderBy: { createdAt: "desc" },
            take: 1,
            select: { id: true, direction: true },
          },
        },
      },
    },
  });

  const candidates = accounts.flatMap((account) =>
    account.conversations.flatMap((conversation) => {
      const latestMessage = conversation.messages[0];
      if (
        !latestMessage ||
        latestMessage.direction !== "INBOUND" ||
        !conversation.aiEnabled ||
        conversation.humanTakeover
      ) {
        return [];
      }

      return [{ conversationId: conversation.id, triggerMessageId: latestMessage.id }];
    }),
  );

  let processed = 0;
  let failed = 0;

  await Promise.all(
    candidates.map(async ({ conversationId, triggerMessageId }) => {
      try {
        await maybeAutoRespond(conversationId, {
          ignoreAutoSendSetting: true,
          expectedTriggerMessageId: triggerMessageId,
        });
        processed += 1;
      } catch {
        failed += 1;
      }
    }),
  );

  return {
    accounts: accounts.length,
    candidates: candidates.length,
    processed,
    failed,
  };
}