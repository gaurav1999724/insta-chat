# Webhooks

Status: **Phase 5 implemented** (Instagram messaging webhook). Verified against Meta's
current Messenger/Instagram Platform webhook docs on 2026-09-17 (spec
§92); sources linked below.

## Endpoint

`src/app/api/webhooks/instagram/route.ts` — `{NEXTAUTH_URL}/api/webhooks/instagram`.

### GET — subscription verification

Meta calls this once when the webhook subscription is configured (and again
if it's ever re-verified). Query params: `hub.mode` (must be `"subscribe"`),
`hub.verify_token` (must match `META_WEBHOOK_VERIFY_TOKEN`), `hub.challenge`.
On match, the handler echoes `hub.challenge` back as **plain text** with
status 200 — not JSON-wrapped, which is the most common cause of failed
verification.

### POST — event delivery

1. Read the raw body as text (`request.text()`) — signature verification
   needs the exact bytes Meta signed; re-serializing via `request.json()`
   first would break the comparison.
2. Verify `X-Hub-Signature-256: sha256=<hex>` — an HMAC-SHA256 of the raw
   body keyed by `META_APP_SECRET` (`src/lib/instagram/webhook.ts`,
   `isValidWebhookSignature`, timing-safe compare). Reject with 403 if it
   doesn't match — never process unsigned/forged input (spec §38).
3. Parse and Zod-validate the payload (`instagramWebhookPayloadSchema`):
   `{ object: "instagram", entry: [{ id, time, messaging: [...] }] }`.
   Malformed bodies are logged (`APIError`, category `WEBHOOK_ERROR`) and
   acknowledged with 200 anyway — retrying a body we can't parse would just
   loop forever.
4. For each `entry`, look up the owning `InstagramAccount` by
   `instagramUserId === entry.id` (account ownership check, spec §38/§74).
5. For each `messaging` item **within every entry, recognized or not**:
   - Compute an idempotency key (`getMessagingItemEventId`): the message's
     `mid` if present, else `${entryId}:${senderId}:${timestamp}`.
   - `INSERT` a `WebhookEvent` row with that key as `externalEventId`
     first, before any other processing. A unique-constraint violation
     (Prisma `P2002`) means this exact delivery was already recorded —
     skip it silently (spec §28: Meta redelivers on timeout/non-2xx, never
     process the same event twice).
   - If the account wasn't recognized/active, mark the event `IGNORED` and
     move on — no error, since Meta may be configured with webhook fields
     this app doesn't handle, or the account may have been disconnected.
   - Otherwise, hand the item to
     `src/services/instagram/webhook-processor.ts` → `processMessagingItem()`
     (see below), then mark the event `PROCESSED` or `FAILED` with the
     message.
6. Always respond `200 OK` once every entry/item has been handled (except
   the signature-failure case, which is 403 before any of this runs).

Reference: [Instagram Platform Webhooks](https://developers.facebook.com/docs/instagram-platform/webhooks),
[Webhooks for Instagram Messaging — Messenger Platform](https://developers.facebook.com/docs/messenger-platform/instagram/features/webhook/)

## Message persistence (spec §27 steps 5–8, §9/§10)

`processMessagingItem()` (per messaging item, one DB transaction):

1. **Participant:** upsert `InstagramParticipant` keyed on
   `(instagramAccountId, externalUserId)`. The "other person" is
   `sender.id` normally, or `recipient.id` when the item is an echo
   (`message.is_echo` — a message the connected account itself sent,
   whether through a future `sendMessage()` call or typed directly in the
   Instagram app during human takeover).
2. **Conversation:** upsert `Conversation` keyed on
   `(instagramAccountId, externalConversationId)`. **Important
   simplification:** Instagram's messaging webhook does not include Meta's
   own conversation ID, so `externalConversationId` here is just the
   participant's `externalUserId` — correct because Instagram DMs are 1:1
   (one thread per participant), but it means this ID is _synthetic_, not
   something fetched from `GET /{ig-user-id}/conversations`. A future
   history-backfill job (not yet built) would need to reconcile by
   participant id rather than by matching Meta's conversation ID directly.
3. **Message:** upsert (by `externalMessageId` when present, else insert)
   with `senderType`/`direction` derived from `is_echo` (echo → `USER`/
   `OUTBOUND`; otherwise → `CONTACT`/`INBOUND`), and `messageType` inferred
   from the payload (`text` → `TEXT`; `attachments[0].type` mapped to
   `IMAGE`/`VIDEO`/`AUDIO`/`FILE`/`SHARE`/`STORY_MENTION`; `is_unsupported`
   or an unrecognized attachment type → `UNSUPPORTED`; a reply to a story →
   `STORY_REPLY`). `message.is_deleted` is handled separately: it clears
   the existing message's `text` (best-effort — a no-op if we never saw the
   original) rather than creating a new row.

**Automatic processing:** inbound messages are persisted synchronously.
Use the manual conversation actions for AI generation, memory analysis, and
sending.

Still not implemented: outbound historical sync via
`GET /{ig-user-id}/conversations` + `GET /{conversation-id}/messages`.

## Local testing without a public URL

Meta requires an HTTPS callback URL it can reach, so local development
needs a tunnel (e.g. ngrok) pointed at `localhost:3000` before the webhook
can be registered and exercised end-to-end. This has not been done in this
environment — see `PROJECT_ANALYSIS.md` §11.
