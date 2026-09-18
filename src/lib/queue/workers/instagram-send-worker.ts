import { Worker } from "bullmq";

import { getRedisConnection } from "@/lib/queue/connection";
import type { InstagramSendJobData } from "@/lib/queue/job-types";
import { INSTAGRAM_SEND_QUEUE_NAME } from "@/lib/queue/queues";
import { sendApprovedDraft } from "@/services/ai/send-service";

export function startInstagramSendWorker(): Worker<InstagramSendJobData> | null {
  const connection = getRedisConnection();
  if (!connection) return null;

  return new Worker<InstagramSendJobData>(
    INSTAGRAM_SEND_QUEUE_NAME,
    async (job) => {
      // Throws on failure (never approved, window closed, API error) —
      // BullMQ registers the job as failed and retries per its backoff
      // (spec §29). `sendApprovedDraft` already records the attempt in
      // `MessageDelivery` before the network call, so every retry is
      // visible, not just the final outcome.
      await sendApprovedDraft(job.data.aiResponseId);
    },
    { connection },
  );
}
