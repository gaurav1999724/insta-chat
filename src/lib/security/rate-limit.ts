const RATE_LIMITS = {
  AI_GENERATION: { limit: 20, windowSeconds: 600 },
  MESSAGE_SEND: { limit: 20, windowSeconds: 600 },
  WEBHOOK_PROCESSING: { limit: 120, windowSeconds: 60 },
  INSTAGRAM_CONNECT: { limit: 10, windowSeconds: 600 },
} as const;

export type RateLimitBucket = keyof typeof RATE_LIMITS;

export type RateLimitCheck =
  { allowed: true } | { allowed: false; retryAfterSeconds: number };

const counters = new Map<string, { count: number; resetAt: number }>();

export async function checkRateLimit(
  bucket: RateLimitBucket,
  key: string,
): Promise<RateLimitCheck> {
  const { limit, windowSeconds } = RATE_LIMITS[bucket];
  const counterKey = `${bucket}:${key}`;
  const now = Date.now();
  const current = counters.get(counterKey);
  const counter = !current || current.resetAt <= now
    ? { count: 0, resetAt: now + windowSeconds * 1000 }
    : current;

  counter.count += 1;
  counters.set(counterKey, counter);

  if (counter.count > limit) {
    return {
      allowed: false,
      retryAfterSeconds: Math.max(1, Math.ceil((counter.resetAt - now) / 1000)),
    };
  }

  return { allowed: true };
}

export function formatRetryAfter(retryAfterSeconds: number): string {
  if (retryAfterSeconds <= 60) return "a minute";
  const minutes = Math.ceil(retryAfterSeconds / 60);
  return `${minutes} minutes`;
}
