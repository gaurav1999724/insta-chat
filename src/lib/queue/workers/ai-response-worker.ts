import { Worker } from "bullmq";

import { prisma } from "@/lib/db/prisma";
import { isWithinMessagingWindow } from "@/lib/instagram/send-eligibility";
import { getRedisConnection } from "@/lib/queue/connection";
import type { AIResponseJobData } from "@/lib/queue/job-types";
import { AI_RESPONSE_QUEUE_NAME, getInstagramSendQueue } from "@/lib/queue/queues";
import { createDraftReply } from "@/services/ai/draft-service";

// spec §59 auto-send workflow: Generate → Validate (inside
// createDraftReply/generateResponse) → Queue → Send → Store delivery
// status. This worker does "Generate" and, when eligible, "Queue" (by
// enqueuing the instagram-send job); the send worker does the rest.
export function startAIResponseWorker(): Worker<AIResponseJobData> | null {
  const connection = getRedisConnection();
  if (!connection) return null;

  return new Worker<AIResponseJobData>(
    AI_RESPONSE_QUEUE_NAME,
    async (job) => {
      const { conversationId } = job.data;

      const conversation = await prisma.conversation.findUnique({
        where: { id: conversationId },
        include: {
          instagramAccount: {
            select: {
              status: true,
              user: { select: { aiConfiguration: { select: { autoSend: true } } } },
            },
          },
          settings: { select: { autoSend: true } },
        },
      });

      // Conditions may have changed between enqueue and processing (AI
      // turned off, human takeover engaged, account disconnected) — that's
      // a legitimate no-op, not a failure to retry.
      if (
        !conversation ||
        !conversation.aiEnabled ||
        conversation.humanTakeover ||
        conversation.status !== "ACTIVE" ||
        conversation.instagramAccount.status !== "ACTIVE"
      ) {
        return;
      }

      const result = await createDraftReply(conversationId);
      if (!result.success) {
        // Thrown (not swallowed) so BullMQ registers the job as failed and
        // retries per its configured backoff (spec §29).
        throw new Error(result.error);
      }

      const autoSend =
        conversation.settings?.autoSend ??
        conversation.instagramAccount.user.aiConfiguration?.autoSend ??
        false;

      if (!autoSend) {
        return; // stays PENDING_APPROVAL for manual review (Phase 8 UI)
      }

      const lastInbound = await prisma.message.findFirst({
        where: { conversationId, direction: "INBOUND" },
        orderBy: { createdAt: "desc" },
        select: { createdAt: true },
      });

      // spec §41: never send outside the messaging window, automated or
      // not. If auto-send is on but the window has already closed, the
      // draft just stays pending for a human to handle manually via
      // Instagram itself.
      if (!isWithinMessagingWindow(lastInbound?.createdAt ?? null)) {
        return;
      }

      await prisma.aIResponse.update({
        where: { id: result.aiResponseId },
        data: { status: "APPROVED" },
      });

      const sendQueue = getInstagramSendQueue();
      await sendQueue?.add("send", { aiResponseId: result.aiResponseId });
    },
    { connection },
  );
}
