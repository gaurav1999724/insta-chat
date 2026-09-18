import IORedis from "ioredis";

import { env } from "@/lib/validation/env";

let connection: IORedis | undefined;

// Lazily created, and only if REDIS_URL is configured — every queue
// producer/consumer in this app must tolerate Redis being absent (same
// "optional service, degrade gracefully" pattern as Gemini/Meta: nothing
// crashes, automatic processing just doesn't run and everything falls back
// to the manual buttons built in Phase 7/8).
export function getRedisConnection(): IORedis | null {
  if (!env.REDIS_URL) return null;

  connection ??= new IORedis(env.REDIS_URL, {
    maxRetriesPerRequest: null, // required by BullMQ
  });

  return connection;
}

export function isQueueingConfigured(): boolean {
  return Boolean(env.REDIS_URL);
}
