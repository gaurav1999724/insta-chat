import { Queue, type JobsOptions } from "bullmq";

import { getRedisConnection } from "@/lib/queue/connection";
import type {
  AIResponseJobData,
  InstagramSendJobData,
  MemoryExtractionJobData,
} from "@/lib/queue/job-types";

// spec §29 names 6 queues: instagram-webhook, ai-response, instagram-send,
// memory-extraction, retry, analytics. Only the 3 with a real producer AND
// a real consumer this phase are implemented — see docs/QUEUES.md for why
// the other 3 aren't (short version: "retry" is BullMQ's own per-job
// attempts/backoff, not a separate queue; "instagram-webhook" isn't needed
// since Phase 5's webhook handler is already fast and synchronous;
// "analytics" has no consumer to build until Phase 11).
export const AI_RESPONSE_QUEUE_NAME = "ai-response";
export const INSTAGRAM_SEND_QUEUE_NAME = "instagram-send";
export const MEMORY_EXTRACTION_QUEUE_NAME = "memory-extraction";

// spec §29: "Jobs must be idempotent. Implement retry with exponential
// backoff."
const DEFAULT_JOB_OPTIONS: JobsOptions = {
  attempts: 3,
  backoff: { type: "exponential", delay: 5_000 },
  removeOnComplete: { age: 24 * 60 * 60 },
  removeOnFail: { age: 7 * 24 * 60 * 60 },
};

let aiResponseQueue: Queue<AIResponseJobData> | undefined;
let instagramSendQueue: Queue<InstagramSendJobData> | undefined;
let memoryExtractionQueue: Queue<MemoryExtractionJobData> | undefined;

export function getAIResponseQueue(): Queue<AIResponseJobData> | null {
  const connection = getRedisConnection();
  if (!connection) return null;

  aiResponseQueue ??= new Queue<AIResponseJobData>(AI_RESPONSE_QUEUE_NAME, {
    connection,
    defaultJobOptions: DEFAULT_JOB_OPTIONS,
  });
  return aiResponseQueue;
}

export function getInstagramSendQueue(): Queue<InstagramSendJobData> | null {
  const connection = getRedisConnection();
  if (!connection) return null;

  instagramSendQueue ??= new Queue<InstagramSendJobData>(INSTAGRAM_SEND_QUEUE_NAME, {
    connection,
    defaultJobOptions: DEFAULT_JOB_OPTIONS,
  });
  return instagramSendQueue;
}

export function getMemoryExtractionQueue(): Queue<MemoryExtractionJobData> | null {
  const connection = getRedisConnection();
  if (!connection) return null;

  memoryExtractionQueue ??= new Queue<MemoryExtractionJobData>(
    MEMORY_EXTRACTION_QUEUE_NAME,
    {
      connection,
      defaultJobOptions: DEFAULT_JOB_OPTIONS,
    },
  );
  return memoryExtractionQueue;
}
