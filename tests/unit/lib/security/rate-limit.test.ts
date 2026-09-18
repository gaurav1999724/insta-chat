import { describe, expect, it } from "vitest";

import { checkRateLimit, formatRetryAfter } from "@/lib/security/rate-limit";

describe("checkRateLimit", () => {
  it("allows requests up to the bucket's limit", async () => {
    for (let i = 0; i < 20; i++) {
      const result = await checkRateLimit("AI_GENERATION", "conversation-1");
      expect(result.allowed).toBe(true);
    }
  });

  it("blocks the request once the limit is exceeded, with a retryAfterSeconds", async () => {
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
    for (let i = 0; i < 20; i++) {
      await checkRateLimit("AI_GENERATION", "conversation-a");
    }
    const otherKey = await checkRateLimit("AI_GENERATION", "conversation-b");

    expect(otherKey.allowed).toBe(true);
  });

  it("tracks different buckets for the same key independently", async () => {
    for (let i = 0; i < 20; i++) {
      await checkRateLimit("AI_GENERATION", "shared-key");
    }
    const otherBucket = await checkRateLimit("MESSAGE_SEND", "shared-key");

    expect(otherBucket.allowed).toBe(true);
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
