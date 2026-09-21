import crypto from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  getMessageEventId,
  isValidWebhookSignature,
  socialApiDmEventSchema,
  socialApiWebhookEnvelopeSchema,
  type SocialApiDmEvent,
} from "@/lib/instagram/webhook";

// Matches vitest.config.ts's `test.env.SOCIALAPI_WEBHOOK_SECRET` — never a
// real secret.
const TEST_WEBHOOK_SECRET = "test-webhook-secret";

function signBody(body: string, timestamp: string): string {
  const digest = crypto
    .createHmac("sha256", TEST_WEBHOOK_SECRET)
    .update(`${timestamp}.${body}`)
    .digest("hex");
  return `sha256=${digest}`;
}

describe("isValidWebhookSignature", () => {
  it("accepts a correctly signed body", () => {
    const body = JSON.stringify({ event: "dm.received", data: {} });
    const timestamp = "1700000000";
    expect(isValidWebhookSignature(body, timestamp, signBody(body, timestamp))).toBe(true);
  });

  it("rejects a body whose signature doesn't match", () => {
    const body = JSON.stringify({ event: "dm.received", data: {} });
    const timestamp = "1700000000";
    expect(
      isValidWebhookSignature(body, timestamp, signBody(body + "tampered", timestamp)),
    ).toBe(false);
  });

  it("rejects a mismatched timestamp (replay protection)", () => {
    const body = JSON.stringify({ event: "dm.received", data: {} });
    const signedAt = "1700000000";
    expect(isValidWebhookSignature(body, "1700000999", signBody(body, signedAt))).toBe(false);
  });

  it("rejects a missing signature header", () => {
    expect(isValidWebhookSignature("{}", "1700000000", null)).toBe(false);
  });

  it("rejects a missing timestamp header", () => {
    expect(isValidWebhookSignature("{}", null, "sha256=abc")).toBe(false);
  });

  it("rejects a malformed signature header (no sha256= scheme)", () => {
    expect(isValidWebhookSignature("{}", "1700000000", "not-a-real-header")).toBe(false);
  });
});

describe("socialApiWebhookEnvelopeSchema", () => {
  it("accepts any event with a data object", () => {
    const result = socialApiWebhookEnvelopeSchema.safeParse({
      event: "comment.received",
      data: { foo: "bar" },
    });
    expect(result.success).toBe(true);
  });

  it("rejects a payload missing event", () => {
    const result = socialApiWebhookEnvelopeSchema.safeParse({ data: {} });
    expect(result.success).toBe(false);
  });
});

describe("socialApiDmEventSchema", () => {
  it("accepts a realistic dm.received payload", () => {
    const result = socialApiDmEventSchema.safeParse({
      event: "dm.received",
      data: {
        id: "sapi_dm_1",
        type: "dm",
        platform: "instagram",
        account_id: "acc_1",
        conversation_id: "conv_1",
        platform_id: "m_100",
        author: { id: "1234", name: "Jane" },
        content: { text: "Hey!" },
        received_at: "2026-03-01T14:30:00Z",
      },
    });
    expect(result.success).toBe(true);
  });

  it("accepts explicit null for optional fields (real SocialAPI.AI deliveries send null, not omit)", () => {
    // Regression test: confirmed 2026-09-21 via a real webhook delivery
    // that failed schema validation because `data.metadata` arrived as
    // `null` rather than being omitted — `.optional()` alone only accepts
    // `undefined`.
    const result = socialApiDmEventSchema.safeParse({
      event: "dm.received",
      data: {
        id: "sapi_dm_1",
        type: "dm",
        platform: "instagram",
        account_id: "acc_1",
        conversation_id: "conv_1",
        platform_id: "m_100",
        author: { id: "1234", name: null, avatar_url: null },
        content: { text: null, media: null },
        received_at: "2026-03-01T14:30:00Z",
        metadata: null,
      },
    });
    expect(result.success).toBe(true);
  });

  it("rejects a payload missing required fields", () => {
    const result = socialApiDmEventSchema.safeParse({
      event: "dm.received",
      data: { id: "sapi_dm_1" },
    });
    expect(result.success).toBe(false);
  });

  it("rejects an event type outside dm.received/dm.sent", () => {
    const result = socialApiDmEventSchema.safeParse({
      event: "comment.received",
      data: {
        id: "sapi_dm_1",
        type: "dm",
        platform: "instagram",
        account_id: "acc_1",
        conversation_id: "conv_1",
        platform_id: "m_100",
        author: { id: "1234" },
        content: {},
        received_at: "2026-03-01T14:30:00Z",
      },
    });
    expect(result.success).toBe(false);
  });
});

describe("getMessageEventId (spec §28 idempotency)", () => {
  const baseItem: SocialApiDmEvent = {
    event: "dm.received",
    data: {
      id: "sapi_dm_1",
      type: "dm",
      platform: "instagram",
      account_id: "acc_1",
      conversation_id: "conv_1",
      platform_id: "m_100",
      author: { id: "1234" },
      content: { text: "Hey!" },
      received_at: "2026-03-01T14:30:00Z",
    },
  };

  it("uses the message's platform_id", () => {
    expect(getMessageEventId(baseItem)).toBe("m_100");
  });

  it("produces the same key for the same event delivered twice (redelivery)", () => {
    const first = getMessageEventId(baseItem);
    const second = getMessageEventId({ ...baseItem, data: { ...baseItem.data } });
    expect(first).toBe(second);
  });

  it("produces different keys for different messages", () => {
    const other = { ...baseItem, data: { ...baseItem.data, platform_id: "m_200" } };
    expect(getMessageEventId(baseItem)).not.toBe(getMessageEventId(other));
  });
});
