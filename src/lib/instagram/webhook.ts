import crypto from "node:crypto";
import { z } from "zod";

import { env } from "@/lib/validation/env";

// Verified against Meta's Instagram/Messenger Platform webhook docs on
// 2026-09-17 — see docs/WEBHOOKS.md for sources. Only the "messages" field
// is modeled; message_reactions/messaging_postbacks/etc. are out of scope
// until something in the app actually needs them.
export const instagramWebhookAttachmentSchema = z.object({
  type: z.string(),
  payload: z.record(z.string(), z.unknown()).optional(),
});

export const instagramWebhookMessageSchema = z.object({
  mid: z.string().optional(),
  text: z.string().optional(),
  attachments: z.array(instagramWebhookAttachmentSchema).optional(),
  is_echo: z.boolean().optional(),
  is_deleted: z.boolean().optional(),
  is_unsupported: z.boolean().optional(),
  reply_to: z
    .object({
      mid: z.string().optional(),
      story: z.record(z.string(), z.unknown()).optional(),
    })
    .optional(),
});

export const instagramWebhookMessagingItemSchema = z.object({
  sender: z.object({ id: z.string() }),
  recipient: z.object({ id: z.string() }),
  timestamp: z.number(),
  message: instagramWebhookMessageSchema.optional(),
});

export const instagramWebhookEntrySchema = z.object({
  id: z.string(),
  time: z.number().optional(),
  messaging: z.array(instagramWebhookMessagingItemSchema).optional(),
});

export const instagramWebhookPayloadSchema = z.object({
  object: z.literal("instagram"),
  entry: z.array(instagramWebhookEntrySchema),
});

export type InstagramWebhookMessagingItem = z.infer<
  typeof instagramWebhookMessagingItemSchema
>;

// Meta signs every Event Notification with the app secret; verify the raw
// request bytes before parsing anything (spec §38 — never trust incoming
// webhook data blindly).
export function isValidWebhookSignature(
  rawBody: string,
  signatureHeader: string | null,
): boolean {
  if (!signatureHeader || !env.META_APP_SECRET) return false;

  const [scheme, signature] = signatureHeader.split("=");
  if (scheme !== "sha256" || !signature) return false;

  const expected = crypto
    .createHmac("sha256", env.META_APP_SECRET)
    .update(rawBody)
    .digest("hex");

  const expectedBuffer = Buffer.from(expected, "hex");
  const providedBuffer = Buffer.from(signature, "hex");
  if (expectedBuffer.length !== providedBuffer.length) return false;

  return crypto.timingSafeEqual(expectedBuffer, providedBuffer);
}

export function isValidVerifyToken(mode: string | null, token: string | null): boolean {
  return (
    mode === "subscribe" &&
    !!token &&
    !!env.META_WEBHOOK_VERIFY_TOKEN &&
    token === env.META_WEBHOOK_VERIFY_TOKEN
  );
}

// A single POST can batch several messaging events across several entries;
// each needs its own idempotency key (spec §28) since Meta may redeliver
// the whole batch on a timeout or non-2xx response. `mid` is the natural
// key; events without one (rare) fall back to a synthetic key.
export function getMessagingItemEventId(
  entryId: string,
  item: InstagramWebhookMessagingItem,
): string {
  return item.message?.mid ?? `${entryId}:${item.sender.id}:${item.timestamp}`;
}
