import crypto from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  getMessagingItemEventId,
  instagramWebhookPayloadSchema,
  isValidVerifyToken,
  isValidWebhookSignature,
  type InstagramWebhookMessagingItem,
} from "@/lib/instagram/webhook";

// Matches vitest.config.ts's `test.env.META_APP_SECRET` — never a real secret.
const TEST_APP_SECRET = "test-meta-app-secret";

function signBody(body: string): string {
  const digest = crypto.createHmac("sha256", TEST_APP_SECRET).update(body).digest("hex");
  return `sha256=${digest}`;
}

describe("isValidWebhookSignature", () => {
  it("accepts a correctly signed body (spec §38)", () => {
    const body = JSON.stringify({ object: "instagram", entry: [] });
    expect(isValidWebhookSignature(body, signBody(body))).toBe(true);
  });

  it("rejects a body whose signature doesn't match", () => {
    const body = JSON.stringify({ object: "instagram", entry: [] });
    expect(isValidWebhookSignature(body, signBody(body + "tampered"))).toBe(false);
  });

  it("rejects a missing signature header", () => {
    expect(isValidWebhookSignature("{}", null)).toBe(false);
  });

  it("rejects a malformed signature header (no sha256= scheme)", () => {
    expect(isValidWebhookSignature("{}", "not-a-real-header")).toBe(false);
  });
});

describe("isValidVerifyToken", () => {
  it("accepts the correct subscribe handshake (spec §38)", () => {
    expect(isValidVerifyToken("subscribe", "test-verify-token")).toBe(true);
  });

  it("rejects the wrong token", () => {
    expect(isValidVerifyToken("subscribe", "wrong-token")).toBe(false);
  });

  it("rejects a non-subscribe mode", () => {
    expect(isValidVerifyToken("unsubscribe", "test-verify-token")).toBe(false);
  });

  it("rejects a null token", () => {
    expect(isValidVerifyToken("subscribe", null)).toBe(false);
  });
});

describe("instagramWebhookPayloadSchema", () => {
  it("accepts a realistic Instagram messaging payload", () => {
    const result = instagramWebhookPayloadSchema.safeParse({
      object: "instagram",
      entry: [
        {
          id: "17841400000000000",
          time: 1700000000,
          messaging: [
            {
              sender: { id: "1234" },
              recipient: { id: "5678" },
              timestamp: 1700000000,
              message: { mid: "mid.123", text: "Hey!" },
            },
          ],
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("rejects a payload for a different platform", () => {
    const result = instagramWebhookPayloadSchema.safeParse({
      object: "page",
      entry: [],
    });
    expect(result.success).toBe(false);
  });

  it("rejects a malformed entry missing required fields", () => {
    const result = instagramWebhookPayloadSchema.safeParse({
      object: "instagram",
      entry: [{ messaging: [{ sender: { id: "1" } }] }],
    });
    expect(result.success).toBe(false);
  });
});

describe("getMessagingItemEventId (spec §28 idempotency)", () => {
  const baseItem: InstagramWebhookMessagingItem = {
    sender: { id: "1234" },
    recipient: { id: "5678" },
    timestamp: 1700000000,
  };

  it("uses the message's mid when present", () => {
    const item = { ...baseItem, message: { mid: "mid.abc123" } };
    expect(getMessagingItemEventId("entry1", item)).toBe("mid.abc123");
  });

  it("falls back to a synthetic key derived from entry/sender/timestamp when mid is absent", () => {
    expect(getMessagingItemEventId("entry1", baseItem)).toBe("entry1:1234:1700000000");
  });

  it("produces the same key for the same event delivered twice (redelivery)", () => {
    const first = getMessagingItemEventId("entry1", baseItem);
    const second = getMessagingItemEventId("entry1", { ...baseItem });
    expect(first).toBe(second);
  });

  it("produces different keys for different senders", () => {
    const other = { ...baseItem, sender: { id: "9999" } };
    expect(getMessagingItemEventId("entry1", baseItem)).not.toBe(
      getMessagingItemEventId("entry1", other),
    );
  });
});
