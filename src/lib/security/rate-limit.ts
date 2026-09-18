import { getRedisConnection } from "@/lib/queue/connection";

// spec §50: "Implement rate limits for: AI generation, manual message
// sending, webhook processing, API endpoints. Use Redis if available."
// Limits are per named bucket, keyed by whatever scope makes sense for
// that bucket (conversation, Instagram account, or user — see call sites).
// Numbers are this project's own defaults (the spec doesn't prescribe
// exact figures) — generous enough for real personal use, tight enough to
// catch a runaway retry loop or a script hammering a button.
const RATE_LIMITS = {
  AI_GENERATION: { limit: 20, windowSeconds: 600 },
  MESSAGE_SEND: { limit: 20, windowSeconds: 600 },
  WEBHOOK_PROCESSING: { limit: 120, windowSeconds: 60 },
  INSTAGRAM_CONNECT: { limit: 10, windowSeconds: 600 },
} as const;

export type RateLimitBucket = keyof typeof RATE_LIMITS;

export type RateLimitCheck =
  { allowed: true } | { allowed: false; retryAfterSeconds: number };

// Fixed-window counter: INCR the window's key, EXPIRE it on first hit, and
// reject once the count exceeds the bucket's limit. Simpler than a sliding
// window or token bucket, and sufficient for the personal (single-user)
// scale this app runs at (spec §1) — revisit only if real usage shows
// window-boundary bursts are actually a problem.
export async function checkRateLimit(
  bucket: RateLimitBucket,
  key: string,
): Promise<RateLimitCheck> {
  const redis = getRedisConnection();
  // Same "optional service, degrade gracefully" pattern as BullMQ (§9a):
  // with no REDIS_URL configured, rate limiting simply doesn't run rather
  // than blocking the app from working at all.
  if (!redis) return { allowed: true };

  const { limit, windowSeconds } = RATE_LIMITS[bucket];
  const redisKey = `ratelimit:${bucket}:${key}`;

  try {
    const count = await redis.incr(redisKey);
    if (count === 1) {
      await redis.expire(redisKey, windowSeconds);
    }

    if (count > limit) {
      const ttl = await redis.ttl(redisKey);
      return { allowed: false, retryAfterSeconds: ttl > 0 ? ttl : windowSeconds };
    }

    return { allowed: true };
  } catch {
    // Fail open: rate limiting is defense-in-depth, not the primary
    // authorization boundary (that's the ownership checks every
    // action/service already does) — a transient Redis error should never
    // be the reason a legitimate request gets refused.
    return { allowed: true };
  }
}

export function formatRetryAfter(retryAfterSeconds: number): string {
  if (retryAfterSeconds <= 60) return "a minute";
  const minutes = Math.ceil(retryAfterSeconds / 60);
  return `${minutes} minutes`;
}
