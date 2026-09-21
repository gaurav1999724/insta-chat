# Instagram Setup

**Provider switched 2026-09-21: direct Meta Graph API → SocialAPI.AI**
(`docs.social-api.ai`), a third-party aggregator. This replaced a brief,
same-day detour through CollectAPI (which drove a real logged-in Instagram
session via username/password and was rejected for that reason — see git
history / the conversation this was decided in). SocialAPI.AI is a
materially different, lower-risk integration.

## What kind of integration this is

SocialAPI.AI is **not an official Meta partnership**, but it connects
Instagram accounts through a **real Meta OAuth consent screen**, using its
own "managed" developer app — no Meta Developer App, App Review, or
Instagram App ID/Secret is needed on our side at all. Concretely:

- The account owner authorizes through Instagram's own real login/consent
  flow (redirected via SocialAPI.AI's managed OAuth app) — never asked for
  a raw username/password by this app or by SocialAPI.AI.
- The actual Meta OAuth token lives entirely on SocialAPI.AI's
  infrastructure; this app only ever stores their opaque `account_id`.
- Webhooks are properly HMAC-signed (`X-SocialAPI-Signature-V2`) — unlike
  the briefly-tried CollectAPI integration, which had no signing at all.

**Real risk that remains:** this app's Instagram access still depends on a
third party's continued reliability and trustworthiness — if SocialAPI.AI
has an outage, changes its API, or is compromised, this integration is
affected. That's a materially smaller risk than credential harvesting, but
it's not zero, and it's worth knowing before connecting a production
account.

## 1. SocialAPI.AI account

1. Sign up at [social-api.ai](https://social-api.ai/) and get your API key
   at their dashboard — it goes in `SOCIALAPI_TOKEN`.
2. One API key authenticates every call for your whole workspace; by
   default it has access to every connected account (scoped keys are
   possible via their `/keys` endpoints but not used by this app).

Reference: [SocialAPI.AI docs](https://docs.social-api.ai/)

## 2. Instagram account requirements

- Any Instagram account that can complete Meta's real OAuth consent screen
  works — no special account type is documented as required by
  SocialAPI.AI itself, but Meta's own Instagram Login rules still apply
  underneath (e.g. a Professional account is generally needed for
  messaging permissions).

## 3. One-time webhook registration (do this once, manually)

SocialAPI.AI's webhook is registered **once per workspace**, not per
connected account — unlike Meta's per-app webhook config or CollectAPI's
per-account config. Register it with a direct API call before connecting
any Instagram account:

```bash
curl -X POST https://api.social-api.ai/v1/webhooks \
  -H "Authorization: Bearer $SOCIALAPI_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://YOUR_PUBLIC_URL/api/webhooks/instagram",
    "events": ["dm.received", "dm.sent"]
  }'
```

The response includes a `secret` field, shown **only this once** — copy it
into `SOCIALAPI_WEBHOOK_SECRET` immediately. If you lose it, delete the
webhook endpoint and create a new one.

## 4. Connect flow

Implemented in `src/services/instagram/instagram-service.ts` +
`src/app/api/instagram/connect/route.ts` + `src/app/api/instagram/callback/route.ts`
— structurally the same redirect-based OAuth flow the original direct-Meta
integration used (CSRF `state` cookie, `src/lib/instagram/oauth.ts`), just
with SocialAPI.AI's endpoints in the middle:

1. `GET /api/instagram/connect` — generates a random CSRF `state`, stores
   it in an `httpOnly` cookie, calls `POST /accounts/connect` with
   `{platform: "instagram", redirect_uri: {NEXTAUTH_URL}/api/instagram/callback, state}`,
   and redirects the browser to the returned `auth_url` (SocialAPI.AI's
   managed OAuth flow, which itself redirects to Instagram's real consent
   screen).
2. The user approves on Instagram's actual consent screen.
3. Instagram/SocialAPI.AI redirects back to
   `GET /api/instagram/callback?code=...&state=...`.
4. The callback verifies `state` against the cookie, then calls
   `POST /oauth/exchange` with `{code, platform: "instagram", metadata: {redirect_uri, state}}`
   to finalize the connection, upserts `InstagramAccount` (`instagramUserId`
   holds SocialAPI's `account_id`), writes an `AuditLog` row
   (`ACCOUNT_CONNECTED`), and redirects to `/settings?instagram=connected`.

No per-account webhook subscription call is needed here (unlike the
original Meta integration's `subscribeToMessageWebhooks()`) — the
one-time, workspace-level webhook from step 3 above already covers every
connected account.

## 5. Sending messages

`sendMessage(accountId, conversationId, text)` in `instagram-service.ts`:

```
POST https://api.social-api.ai/v1/inbox/conversations/{conversationId}/messages
Authorization: Bearer {SOCIALAPI_TOKEN}
Content-Type: application/json

{ "account_id": "{accountId}", "text": "{text}" }
```

`conversationId` is SocialAPI's own real conversation id (stored as
`Conversation.externalConversationId`) — unlike Meta/CollectAPI, this
provider gives a distinct thread id separate from the participant's own
user id. Success response: `{ "success": true, "message_id": "..." }` —
`message_id` becomes `Message.externalMessageId`.

**The 24-hour messaging window still applies.** Since this integration
goes through real Meta OAuth and (presumably) real Meta Business Messaging
permissions underneath, Meta's standard 24-hour customer-service window
restriction is back in effect — `src/lib/instagram/send-eligibility.ts`
still enforces it exactly as the original direct-Meta integration did.
(This was correctly *not* enforced during the brief CollectAPI detour,
since that provider drove a real client session with no such platform
restriction — but it applies again here.)

## 6. Webhook configuration

See `docs/WEBHOOKS.md` for the full payload/verification details. Every
request is HMAC-SHA256 signed (`X-SocialAPI-Signature-V2` = HMAC of
`{timestamp}.{rawBody}` keyed by the secret from step 3, plus
`X-SocialAPI-Timestamp` for replay protection) — verified before any
parsing, same security posture as the original Meta integration had.

## 7. Environment variables

```
SOCIALAPI_TOKEN=""            # from https://social-api.ai
SOCIALAPI_WEBHOOK_SECRET=""   # from POST /webhooks (§3 above), shown once
```

Both optional at boot (`env.ts`) so the app runs before Instagram is
configured — `/api/instagram/connect` fails gracefully
(`?instagram=not_configured`) rather than crashing if `SOCIALAPI_TOKEN` is
unset.

No longer used (removed 2026-09-21): `META_APP_ID`, `META_APP_SECRET`,
`META_GRAPH_API_VERSION`, `META_WEBHOOK_VERIFY_TOKEN`, `ENCRYPTION_KEY`
(no per-account token to encrypt at rest — SocialAPI.AI holds the actual
Meta OAuth token, we only hold their `account_id`), and the briefly-added
`COLLECTAPI_TOKEN`/`COLLECTAPI_WEBHOOK_SECRET`.

## 8. Development testing

1. Fill in `SOCIALAPI_TOKEN` in `.env`.
2. Run a local HTTPS tunnel (e.g. ngrok) pointed at `localhost:3000`, set
   `NEXTAUTH_URL` to that tunnel's URL.
3. Register the webhook once per §3 above, using the tunnel URL, and fill
   in `SOCIALAPI_WEBHOOK_SECRET`.
4. Sign in to InstaMate, go to Settings, click "Connect Instagram."

## 9. Production configuration

- `NEXTAUTH_URL` must be the real production HTTPS URL — used both as the
  OAuth `redirect_uri` and, indirectly, for constructing the webhook URL
  you register in §3.
- Re-register the webhook (§3) pointing at the production URL if it was
  only set up for a dev tunnel — the URL isn't automatically migrated.
- `SOCIALAPI_WEBHOOK_SECRET` must be a strong, unique secret distinct from
  any development value.

## 10. API limitations

- **Rate limits:** 60–1,200 requests/minute depending on connected-account
  count (documented by SocialAPI.AI); 429 responses include `Retry-After`.
  Not yet implemented as client-side backoff in this app — worth adding if
  volume grows.
- **One account per Instagram user, globally:** `InstagramAccount.instagramUserId`
  (SocialAPI's `account_id`) is unique across all InstaMate users — the
  callback route rejects connecting an account already linked to a
  different InstaMate user (spec §74).
- **No documented per-account disconnect/revoke endpoint:** disconnecting
  in InstaMate marks the account `DISCONNECTED` locally only — same
  limitation the original Meta integration had. The user can revoke access
  from SocialAPI.AI's own dashboard or Instagram's "Apps and Websites"
  settings.
