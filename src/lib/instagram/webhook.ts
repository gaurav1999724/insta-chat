import crypto from "node:crypto";
import { z } from "zod";

import { getSystemConfig } from "@/lib/config/system-config";

// Modeled from SocialAPI.AI's webhook docs (docs.social-api.ai/guides/webhooks)
// — switched from direct Meta Graph API webhooks 2026-09-21. Every delivery
// is a single `{event, data}` envelope (not Meta's batched
// `entry[].messaging[]` array) — one event per HTTP call.
export const socialApiDmEventSchema = z.object({
  event: z.enum(["dm.received", "dm.sent"]),
  data: z.object({
    id: z.string(),
    type: z.string(),
    platform: z.string(),
    account_id: z.string(),
    conversation_id: z.string(),
    platform_id: z.string(),
    author: z.object({
      id: z.string(),
      // `.nullable()` throughout this schema: confirmed 2026-09-21 that
      // SocialAPI.AI sends unset optional fields as explicit `null`
      // rather than omitting them (see the `metadata` field below, where
      // this was first caught via a real failed delivery).
      name: z.string().nullable().optional(),
      avatar_url: z.string().nullable().optional(),
    }),
    content: z.object({
      text: z.string().nullable().optional(),
      media: z
        .array(z.object({ type: z.string().nullable().optional(), url: z.string().nullable().optional() }))
        .nullable()
        .optional(),
    }),
    received_at: z.string(),
    // Confirmed 2026-09-21 via a real delivery: SocialAPI.AI sends this as
    // an explicit `null`, not an omitted field — `.optional()` alone only
    // accepts `undefined`, so every real DM was failing schema validation
    // here until `.nullable()` was added.
    metadata: z.record(z.string(), z.unknown()).nullable().optional(),
  }),
});

// The minimal shape every event shares — parsed first so the route can
// branch on `event` before validating the (possibly much stricter)
// specific schema. Every other documented event type beyond dm.received/
// dm.sent (delivery receipts, comments, mentions, referrals, postbacks) is
// acknowledged but not modeled in detail — only inbound/outbound DM
// content is turned into a `Message` row (spec: "only what's actually
// used"), so this envelope is all that's needed for those.
export const socialApiWebhookEnvelopeSchema = z.object({
  event: z.string(),
  data: z.record(z.string(), z.unknown()),
});

export type SocialApiDmEvent = z.infer<typeof socialApiDmEventSchema>;

// SocialAPI.AI signs every webhook request (unlike CollectAPI, which
// didn't sign at all). Two headers exist for backward compatibility:
// `X-SocialAPI-Signature` (v1, HMAC-SHA256 of the raw body alone) and
// `X-SocialAPI-Signature-V2` (HMAC-SHA256 of `${timestamp}.${rawBody}`,
// which adds replay protection since the timestamp is bound into the
// signed value). Verify against v2, and against the exact raw bytes
// SocialAPI signed — never a re-serialized body, which would break the
// comparison.
export async function isValidWebhookSignature(
  rawBody: string,
  timestampHeader: string | null,
  signatureV2Header: string | null,
): Promise<boolean> {
  const secret = await getSystemConfig("SOCIALAPI_WEBHOOK_SECRET");
  if (!timestampHeader || !signatureV2Header || !secret) return false;

  const [scheme, signature] = signatureV2Header.split("=");
  if (scheme !== "sha256" || !signature) return false;

  const expected = crypto
    .createHmac("sha256", secret)
    .update(`${timestampHeader}.${rawBody}`)
    .digest("hex");

  const expectedBuffer = Buffer.from(expected, "hex");
  const providedBuffer = Buffer.from(signature, "hex");
  if (expectedBuffer.length !== providedBuffer.length) return false;

  return crypto.timingSafeEqual(expectedBuffer, providedBuffer);
}

// Idempotency key (spec §28): `platform_id` is the field SocialAPI's own
// docs say correlates a webhook delivery to the same message fetched via
// the REST inbox/messages endpoint — the stable key across both paths.
export function getMessageEventId(item: SocialApiDmEvent): string {
  return item.data.platform_id;
}
