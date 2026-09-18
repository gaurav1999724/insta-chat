# Instagram Setup

Status: **Phase 4 implemented** (connection/account management), **sending
implemented Phase 9**. Historical conversation sync (`GET
/{ig-user-id}/conversations`) is still not implemented.

Verified against Meta's current developer documentation on **2026-09-17**
(spec §92 requires this — Instagram API capabilities and permissions
change, and this integration must not be built from stale assumptions).
Sources are linked in each section below.

## 1. Meta Developer App

1. Create an app at [developers.facebook.com](https://developers.facebook.com/)
   (type: "Business" or "Consumer" — either supports adding the Instagram
   product).
2. Add the **Instagram** product to the app, specifically **"Instagram API
   with Instagram Login"** (also called "Business Login for Instagram") —
   NOT the deprecated Instagram Basic Display API (shut down December 4, 2024) and not the Facebook-Login-based Instagram API (that path requires
   linking a Facebook Page, which this app does not need).
3. Note the app's **Instagram App ID** and **Instagram App Secret** — these
   are different from the app's top-level Facebook App ID/Secret. They go
   in `META_APP_ID` / `META_APP_SECRET`.

Reference: [Business Login for Instagram — Meta for Developers](https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-instagram-login/business-login)

## 2. Instagram account requirements

- Must be an Instagram **Professional account** (Business or Creator) — a
  personal account cannot authorize this flow.
- No linked Facebook Page is required for this flow ("Instagram API with
  Instagram Login" is the direct login path).

## 3. Facebook/Meta configuration where required

Not required for this flow. If a future phase needs Facebook-Page-linked
features (e.g. cross-posting), that would use a separate "Instagram API
with Facebook Login" integration and is out of scope here.

## 4. OAuth/authentication configuration

Implemented in `src/services/instagram/instagram-service.ts` +
`src/app/api/instagram/connect/route.ts` + `src/app/api/instagram/callback/route.ts`.

Flow:

1. `GET /api/instagram/connect` — generates a random CSRF `state`, stores it
   in an `httpOnly` cookie, and redirects the browser to
   `https://www.instagram.com/oauth/authorize` with `client_id`,
   `redirect_uri`, `response_type=code`, `scope`, and `state`.
2. The user approves on Instagram's consent screen.
3. Instagram redirects back to `GET /api/instagram/callback?code=...&state=...`
   (or `?error=...` if the user declined).
4. The callback verifies `state` against the cookie, then:
   - exchanges `code` for a short-lived token
     (`POST https://api.instagram.com/oauth/access_token`)
   - exchanges that for a 60-day long-lived token
     (`GET https://graph.instagram.com/access_token?grant_type=ig_exchange_token`)
   - fetches the account's profile (`GET https://graph.instagram.com/me`)
   - encrypts the long-lived token (`src/lib/security/encryption.ts`,
     AES-256-GCM keyed from `ENCRYPTION_KEY`) and upserts `InstagramAccount`
   - writes an `AuditLog` row (`ACCOUNT_CONNECTED`)
   - redirects to `/settings?instagram=connected` (or `denied`/`error`/
     `not_configured`/`already_connected`)

**Correction (Phase 9):** Phase 4 claimed `graph.instagram.com` was
entirely unversioned. That was wrong, or at least too broad — verified
again on 2026-09-17 while researching the Send API: the **token
management** endpoints (`/access_token`, `/refresh_access_token`) do work
unversioned, but the **content/messaging** endpoints (`/me`,
`/{id}/messages`) use the standard `/vNN.N/` path, confirmed directly from
Meta's own Send Messages docs example
(`https://graph.instagram.com/v25.0/<IG_ID>/messages`). `getProfile()` and
`sendMessage()` both now build their URL as
`` `${GRAPH_HOST}/${env.META_GRAPH_API_VERSION}/...` ``; only the two
token-management calls stay unversioned.

Reference: [Access Token — Instagram Platform](https://developers.facebook.com/docs/instagram-platform/reference/access_token/),
[Refresh Access Token — Instagram Platform](https://developers.facebook.com/docs/instagram-platform/reference/refresh_access_token/),
[Send Messages — Instagram Platform](https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/messaging-api/)

## 4a. Sending messages (implemented Phase 9, manual sending added Phase 10)

`InstagramService.sendMessage(accessToken, senderInstagramUserId,
recipientInstagramUserId, text)`:

```
POST https://graph.instagram.com/{META_GRAPH_API_VERSION}/{senderInstagramUserId}/messages
Authorization: Bearer {accessToken}
Content-Type: application/json

{ "recipient": { "id": "{recipientInstagramUserId}" }, "message": { "text": "{text}" } }
```

Success response: `{ "recipient_id": "...", "message_id": "..." }` —
`message_id` becomes `Message.externalMessageId` for the new outbound row.

**The 24-hour messaging window (spec §41):** your app has 24 hours from
the contact's last inbound message to reply freely. Meta's only official
extension is the `human_agent` message tag — up to 7 days — but that tag
is explicitly for **a real human replying manually**; Meta's own policy
says automating a send with that tag causes API errors/policy violations.
Using it here to let _our_ automation slip past the 24-hour window would
be exactly the "bypass a platform limitation through an unofficial path"
spec §41 forbids — so **this app never uses the `human_agent` tag**, full
stop. `src/lib/instagram/send-eligibility.ts`'s `isWithinMessagingWindow()`
is the single gate every send path checks before calling `sendMessage()`:
the "Send" button on an AI-approved draft, the automatic `instagram-send`
queue worker, **and** (Phase 10) a plain manually-typed message — all
three go through the exact same window check, with no special case for a
human typing directly. If the window has closed, the send is refused with
spec §41's exact message ("This action isn't available through the
currently supported Instagram API") rather than attempted — even for a
human-authored message, since the 24-hour rule is Meta's platform
constraint on the _API call_, not on who wrote the text.

Reference: [Instagram Messaging API 24-Hour Window — key details](https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/messaging-api/)

## 5. Webhook configuration

Implemented Phase 5 — see `docs/WEBHOOKS.md`. `META_WEBHOOK_VERIFY_TOKEN`
is in `.env.example`.

## 6. Required permissions

Only what's actually used, per spec §40 ("do not request unnecessary
permissions"):

- `instagram_business_basic` — required baseline scope for any Instagram
  Login integration.
- `instagram_business_manage_messages` — required to read/send DMs
  (Phase 5+). Requested now so the one-time OAuth consent already covers
  Phase 5 without asking the user to reconnect.

Not requested: `instagram_business_content_publish`,
`instagram_business_manage_comments` — this app does not publish content or
manage comments.

## 7. Redirect URL

Register exactly (must match `NEXTAUTH_URL` + this path, no trailing slash
differences):

```
{NEXTAUTH_URL}/api/instagram/callback
```

Local dev: `http://localhost:3000/api/instagram/callback`.

## 8. Webhook URL

Reserved for Phase 5: `{NEXTAUTH_URL}/api/webhooks/instagram`.

## 9. Environment variables

Already in `.env.example`:

```
META_APP_ID=
META_APP_SECRET=
META_GRAPH_API_VERSION=v26.0
META_WEBHOOK_VERIFY_TOKEN=
```

All are optional at boot (`env.ts`) so the app runs before Instagram is
configured — `/api/instagram/connect` fails gracefully
(`?instagram=not_configured`) rather than crashing if they're unset.

## 10. Development testing

1. Fill in `META_APP_ID`/`META_APP_SECRET` in `.env` from a Meta app in
   development mode.
2. Add your own Instagram account as an "Instagram tester" in the app's
   dashboard and accept the tester invite from the Instagram app/site — apps
   in development mode can only authorize accounts explicitly added as
   testers.
3. Register the local redirect URL (§7) in the app's Instagram product
   settings.
4. Sign in to InstaMate, go to Settings, click "Connect Instagram."

## 11. Production configuration

- Redirect URL must be the production `NEXTAUTH_URL` + `/api/instagram/callback`,
  served over HTTPS (Instagram requires HTTPS redirect URIs in production).
- `ENCRYPTION_KEY` must be a strong, unique secret distinct from any
  development value.

## 12. App review requirements where applicable

- `instagram_business_basic` is available in development mode without
  review for tester accounts.
- `instagram_business_manage_messages` requires **App Review** with a
  verified Meta Business portfolio before it works for accounts that
  aren't added as testers/developers on the app. Budget real time for this
  before Phase 5 (receiving)/Phase 9 (sending) need it in production.

## 13. API limitations

- **Token lifetime:** long-lived tokens expire in 60 days and must be
  refreshed (`graph.instagram.com/refresh_access_token`) at least every 60
  days, and only after they're 24 hours old. Still no refresh job as of
  Phase 9 (no scheduled/periodic job infra exists — the 3 queues that do
  exist are all triggered by webhook events, not a clock) —
  `refreshLongLivedToken()` in `instagram-service.ts` is ready for one
  whenever a scheduling mechanism is added (Phase 12, or a `cron`-style
  addition to Phase 9's queue infra).
- **One account per Instagram user, globally:** `InstagramAccount.instagramUserId`
  is unique across all InstaMate users — the callback route explicitly
  rejects connecting an Instagram account that's already linked to a
  different InstaMate user (spec §74).
- **Outbound message initiation (spec §41): implemented Phase 9.** The
  24-hour messaging window is enforced by
  `isWithinMessagingWindow()` before every send attempt, automated or
  manual; a send outside the window is refused with spec §41's exact
  message rather than attempted through the `human_agent` tag workaround
  (see §4a above). Rate limiting (the other §59 auto-send precondition) is
  not implemented — that's Phase 12.
- **No remote token revocation on disconnect:** disconnecting in InstaMate
  wipes our stored (encrypted) copy of the token and marks the account
  `DISCONNECTED`, but there is no documented Instagram-Login equivalent of
  Facebook's `DELETE /me/permissions` to revoke the token on Meta's side.
  The user can also revoke access directly from their Instagram app's
  "Apps and Websites" settings.
