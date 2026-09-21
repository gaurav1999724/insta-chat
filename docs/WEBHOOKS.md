# Webhooks

Status: switched from direct Meta Graph API webhooks to **SocialAPI.AI**
webhooks on 2026-09-21 (via a brief same-day CollectAPI detour — see
docs/INSTAGRAM_SETUP.md for the full history and why).

## Endpoint

`src/app/api/webhooks/instagram/route.ts` — registered **once, globally**
(not per account) via `POST /webhooks` (see docs/INSTAGRAM_SETUP.md §3) as
`{NEXTAUTH_URL}/api/webhooks/instagram`.

### GET — plain reachability check

SocialAPI.AI has no verification handshake of its own (no `hub.challenge`
protocol like Meta's) — the GET handler just returns `200 OK`.

### POST — event delivery

1. Read the raw body as text (`request.text()`) — signature verification
   needs the exact bytes SocialAPI signed; re-serializing via
   `request.json()` first would break the comparison.
2. Verify signature headers **before parsing anything** (spec §38):
   - `X-SocialAPI-Timestamp` — Unix seconds when the delivery was attempted.
   - `X-SocialAPI-Signature-V2: sha256=<hex>` — HMAC-SHA256 of
     `${timestamp}.${rawBody}` keyed by `SOCIALAPI_WEBHOOK_SECRET`
     (`isValidWebhookSignature`, timing-safe compare). The timestamp being
     bound into the signed value is what gives this replay protection over
     the v1 header (`X-SocialAPI-Signature`, body-only — not used here).
   - Reject with 403 on any mismatch.
3. Parse and Zod-validate the minimal envelope first
   (`socialApiWebhookEnvelopeSchema`: `{event: string, data: object}`) —
   every event type shares this shape.
4. If `event` isn't `dm.received` or `dm.sent`, acknowledge with 200 and
   stop — every other documented event type (`dm.referral`,
   `dm.postback`, `dm.status.*`, `comment.received`, `mention.received`)
   is intentionally out of scope (spec: "only what's actually used").
5. For a DM event, re-validate against the full `socialApiDmEventSchema`
   (`{event, data: {id, type, platform, account_id, conversation_id,
   platform_id, author: {id, name?, avatar_url?}, content: {text?,
   media?}, received_at}}`). Malformed bodies are logged (`APIError`,
   category `WEBHOOK_ERROR`) and acknowledged with 200 anyway.
6. Look up the owning `InstagramAccount` by
   `instagramUserId === data.account_id` (this column holds SocialAPI's
   `account_id` for this provider — spec §38/§74 account ownership check).
7. Record a `WebhookEvent` row keyed by `data.platform_id` before any
   further processing — a unique-constraint violation (Prisma `P2002`)
   means this exact delivery was already recorded, skip it silently (spec
   §28: redeliveries must never be processed twice).
8. Hand the event to `src/services/instagram/webhook-processor.ts` →
   `processMessagingItem()` (see below), then mark the event `PROCESSED`
   or `FAILED`.
9. Always respond `200 OK` once handled (except the signature-failure
   case, which is 403 before any of this runs).

## Message persistence

`processMessagingItem()` (per event, one DB transaction):

1. **Participant:** upsert `InstagramParticipant` keyed on
   `(instagramAccountId, externalUserId)`, where `externalUserId` is
   `data.author.id` — the other person's real Instagram user id.
2. **Conversation:** upsert `Conversation` keyed on
   `(instagramAccountId, externalConversationId)`, where
   `externalConversationId` is `data.conversation_id` — a **real, distinct
   thread id** SocialAPI.AI provides. This is a genuine improvement over
   the direct-Meta and CollectAPI integrations, both of which had no
   separate conversation id and had to reuse the participant's own user id
   as a synthetic thread key.
3. **Message:** upsert (by `externalMessageId = data.platform_id`) with
   `senderType`/`direction` derived from the top-level `event` field
   itself (`dm.received` → `CONTACT`/`INBOUND`; `dm.sent` → `USER`/
   `OUTBOUND`, an echo of a message sent outside this app) — rather than a
   boolean flag on the message like Meta/CollectAPI used. `messageType` is
   mapped from `data.content.media[0].type` (`image`/`video`/`reel`/
   `audio`/`file` → `IMAGE`/`VIDEO`/`VIDEO`/`AUDIO`/`FILE`; no media plus
   `content.text` → `TEXT`; otherwise `UNSUPPORTED`).

Note what's **not** modeled: delivery-receipt events (`dm.status.sent`/
`delivered`/`read`/`failed`) aren't turned into `MessageDelivery` updates
yet — acknowledged and ignored, same scope boundary as the original
integration's "only the messages field" comment.

**Automatic processing:** inbound messages are persisted synchronously.
Use the manual conversation actions for AI generation, memory analysis,
and sending.

## Local testing without a public URL

SocialAPI.AI requires an HTTPS callback URL it can reach — local
development needs a tunnel (e.g. ngrok) pointed at `localhost:3000`,
registered via the one-time `POST /webhooks` call (docs/INSTAGRAM_SETUP.md
§3) before the webhook can be exercised end-to-end.
