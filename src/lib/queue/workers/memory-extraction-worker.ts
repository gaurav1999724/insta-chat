import { Worker } from "bullmq";

import { getRedisConnection } from "@/lib/queue/connection";
import type { MemoryExtractionJobData } from "@/lib/queue/job-types";
import { MEMORY_EXTRACTION_QUEUE_NAME } from "@/lib/queue/queues";
import { runConversationAnalysis } from "@/services/ai/memory-service";

// spec §19: "After a configurable number of messages: analyze recent
// conversation, extract useful durable facts." This worker is that
// automatic trigger; `runConversationAnalysis` itself (memory extraction +
// style analysis) is the same code the manual "Analyze conversation"
// button calls (Phase 8).
export function startMemoryExtractionWorker(): Worker<MemoryExtractionJobData> | null {
  const connection = getRedisConnection();
  if (!connection) return null;

  return new Worker<MemoryExtractionJobData>(
    MEMORY_EXTRACTION_QUEUE_NAME,
    async (job) => {
      const result = await runConversationAnalysis(job.data.conversationId);
      if (!result.success) {
        throw new Error(result.error);
      }
    },
    { connection },
  );
}
