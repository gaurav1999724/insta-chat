import { beforeEach, describe, expect, it, vi } from "vitest";

import { checkRateLimit, formatRetryAfter } from "@/lib/security/rate-limit";

const { getRedisConnection } = vi.hoisted(() => ({ getRedisConnection: vi.fn() }));
vi.mock("@/lib/queue/connection", () => ({ getRedisConnection }));

// A minimal in-memory stand-in for the three ioredis calls `checkRateLimit`
// actually uses — real Redis behavior for INCR/EXPIRE/TTL was already
// spot-checked against an actual local Redis during Phase 12 (see
// PROJECT_ANALYSIS.md §9d); this fake exercises the bucket/window logic in
// isolation and deterministically, without needing Redis running for `npm
// run test` to pass.
class FakeRedis {
  private store = new Map<string, { count: number; expiresAt: number | null }>();

  async incr(key: string): Promise<number> {
    const entry = this.store.get(key) ?? { count: 0, expiresAt: null };
    entry.count += 1;
    this.store.set(key, entry);
    return entry.count;
  }

  async expire(key: string, seconds: number): Promise<number> {
    const entry = this.store.get(key);
    if (!entry) return 0;
    entry.expiresAt = Date.now() + seconds * 1000;
    return 1;
  }

  async ttl(key: string): Promise<number> {
    const entry = this.store.get(key);
    if (!entry?.expiresAt) return -1;
    return Math.ceil((entry.expiresAt - Date.now()) / 1000);
  }
}

describe("checkRateLimit", () => {
  beforeEach(() => {
    getRedisConnection.mockReset();
  });

  it("allows requests up to the bucket's limit", async () => {
    getRedisConnection.mockReturnValue(new FakeRedis());

    for (let i = 0; i < 20; i++) {
      const result = await checkRateLimit("AI_GENERATION", "conversation-1");
      expect(result.allowed).toBe(true);
    }
  });

  it("blocks the request once the limit is exceeded, with a retryAfterSeconds", async () => {
    getRedisConnection.mockReturnValue(new FakeRedis());

    for (let i = 0; i < 20; i++) {
      await checkRateLimit("AI_GENERATION", "conversation-2");
    }
    const blocked = await checkRateLimit("AI_GENERATION", "conversation-2");

    expect(blocked.allowed).toBe(false);
    if (!blocked.allowed) {
      expect(blocked.retryAfterSeconds).toBeGreaterThan(0);
      expect(blocked.retryAfterSeconds).toBeLessThanOrEqual(600);
    }
  });

  it("tracks different keys in the same bucket independently", async () => {
    getRedisConnection.mockReturnValue(new FakeRedis());

    for (let i = 0; i < 20; i++) {
      await checkRateLimit("AI_GENERATION", "conversation-a");
    }
    const otherKey = await checkRateLimit("AI_GENERATION", "conversation-b");

    expect(otherKey.allowed).toBe(true);
  });

  it("tracks different buckets for the same key independently", async () => {
    const redis = new FakeRedis();
    getRedisConnection.mockReturnValue(redis);

    for (let i = 0; i < 20; i++) {
      await checkRateLimit("AI_GENERATION", "shared-key");
    }
    const otherBucket = await checkRateLimit("MESSAGE_SEND", "shared-key");

    expect(otherBucket.allowed).toBe(true);
  });

  it("allows every request when Redis isn't configured (fail open)", async () => {
    getRedisConnection.mockReturnValue(null);

    for (let i = 0; i < 50; i++) {
      const result = await checkRateLimit("AI_GENERATION", "no-redis");
      expect(result.allowed).toBe(true);
    }
  });

  it("allows the request when Redis throws (fail open, defense-in-depth only)", async () => {
    getRedisConnection.mockReturnValue({
      incr: vi.fn().mockRejectedValue(new Error("connection lost")),
    });

    const result = await checkRateLimit("AI_GENERATION", "redis-error");
    expect(result.allowed).toBe(true);
  });
});

describe("formatRetryAfter", () => {
  it("says 'a minute' for short waits", () => {
    expect(formatRetryAfter(30)).toBe("a minute");
    expect(formatRetryAfter(60)).toBe("a minute");
  });

  it("rounds up to whole minutes for longer waits", () => {
    expect(formatRetryAfter(61)).toBe("2 minutes");
    expect(formatRetryAfter(600)).toBe("10 minutes");
  });
});
