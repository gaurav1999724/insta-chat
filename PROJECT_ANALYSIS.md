# PROJECT_ANALYSIS.md

Status: **Phase 14 complete — all 14 planned phases implemented — and
subsequently verified against real infrastructure (2026-09-18).** This
document is updated at the end of each phase.

## 0. Real-infrastructure verification (2026-09-18, post-Phase-14)

Everything in §10 below describing this project as **untested against
real Postgres/Meta/Gemini is now out of date**. It's kept as-is (rather
than rewritten line-by-line) because it's an accurate record of what was
true through Phase 14; this section is the update. Left standing: the
`.env` in this repo now holds real credentials for all three services.

- **Postgres (Neon):** `prisma migrate status`/`migrate dev` run clean
  against the real `DATABASE_URL`; 3 pre-existing migrations plus 2 new
  ones from this pass (see below) all applied. Seed data queried directly
  and confirmed present (1 user, 1 Instagram account, 1 conversation, 3
  messages).
- **Gemini API:** the real `GEMINI_API_KEY` works — confirmed with a live
  `generateContent` call. Found and fixed **two real bugs** in the
  process: `.env`'s `GEMINI_MODEL` was `gemini-2.0-flash`, a retired model
  (404); separately, `AIConfiguration.model` in `prisma/schema.prisma` had
  its own hardcoded `@default("gemini-2.0-flash")`, which silently
  overrode `env.ts`'s `GEMINI_MODEL` for every user (existing rows and new
  signups via the `createUser` hook) — the real bug, since fixing `.env`
  alone wouldn't have fixed this. Both now default to
  `gemini-flash-latest` (Google's current-Flash alias, chosen over another
  pinned version specifically so this doesn't silently rot the same way
  again); `src/lib/gemini/pricing.ts` updated to price the new default so
  cost tracking (spec §31) doesn't go silently blank. Two migrations
  (`fix_ai_config_default_model`, `switch_default_model_to_flash_latest`)
  plus a one-off data backfill (`UPDATE "AIConfiguration" SET model = ...`
  via Prisma, not a migration — existing rows needed the value changed,
  not just the column default) applied against the real database.
  `callGemini()` also gained a retry-with-backoff for 5xx ("ServerError")
  responses — Gemini's real API does return transient 503 "high demand"
  errors, and retrying those (never a 4xx) is standard practice, not
  speculative.
- **Meta/Instagram app credentials:** real and valid — confirmed via a
  live Graph API call (`GET /oauth/access_token?grant_type=client_credentials`
  succeeded, app resolves to name "chat-bot"). **`GET /{app-id}/subscriptions`
  returned an empty list** — the webhook has never been subscribed on
  Meta's side, confirming this specific gap precisely rather than just
  assuming it. Actually connecting a real Instagram account and receiving
  a real webhook delivery needs the account owner to complete Instagram's
  OAuth consent in a browser (can't be scripted) and a public HTTPS URL
  for the webhook callback (this environment has neither a tunnel tool nor
  Docker installed — see §10) — not done this pass.
- **Full E2E flow (spec §68, `tests/e2e/full-flow.spec.ts`):** rebuilt with
  a real scripted login (`tests/e2e/global-setup.ts` inserts a real
  `Session` row rather than mocking auth) and run against the real seeded
  Postgres and real Gemini — no mocks anywhere. Reached step 9 of 12 in a
  clean run (login, Instagram-connected check, conversation navigation,
  chat-mode selection, AI-enable, real Gemini-generated draft, draft
  review/edit all for real). Two real, non-app findings surfaced getting
  this far: real Gemini calls made from inside `next dev --turbopack`
  consistently 503'd (fine as a standalone script; the issue is Turbopack
  dev's request handling, not this app's Gemini integration — worked
  reliably once run against a real production build instead), and Auth.js
  enforces its `UntrustedHost` protection strictly in production, so the
  server's port must match `NEXTAUTH_URL` exactly. Steps 10-12 (approve/
  send/disable/takeover) are written and exercise real code paths but
  weren't confirmed reliably green — see the test file's header comment
  for the full detail, including a `.next` build-cache corruption caused
  by multiple concurrent Claude Code sessions on this machine running
  their own dev servers against the same project directory, which is
  suspected but not confirmed to be why session validation flaked
  intermittently in later attempts.
- **Not done this pass, needs the user:** a Docker build (Docker/WSL isn't
  installed on this machine — installing it is a real system change, left
  for the user to decide on) and a real Instagram OAuth connection +
  webhook delivery (needs the user's own Instagram login in a browser,
  plus a public tunnel for the webhook callback).

## 1. Current architecture (end of Phase 14)

- **Framework:** Next.js 15.5.25, App Router, TypeScript strict, React 19.
- **Styling:** Tailwind CSS v3 + shadcn/ui (New York style) + Lucide icons.
  - Tailwind v4 was the initial scaffold default but requires Node ≥20
    (`@tailwindcss/oxide` native binding). This environment runs Node
    18.20.8, so the project was downgraded to Tailwind v3 for compatibility.
    Revisit this when Node is upgraded (see §"Known environment constraints").
  - The shadcn CLI itself (`npx shadcn add ...`) fails on Node 18 (`File is
not defined`, an `undici` polyfill gap) — new `ui/*` primitives are
    hand-written to match the existing New York style instead of generated.
- **Auth:** Auth.js (NextAuth) v5 beta, Prisma adapter, database sessions,
  Nodemailer/email magic-link provider. In dev, with `EMAIL_SERVER` unset,
  the sign-in link is logged to the server console instead of emailed.
  `session.user.id` is now typed and populated (`src/types/next-auth.d.ts` +
  an explicit `session` callback), and an `events.createUser` hook seeds a
  default `AIConfiguration` row for every new sign-up.
- **Database:** PostgreSQL via Prisma. Full domain schema (§4 below) is
  implemented and migrated in `prisma/schema.prisma`, though the migration
  is unverified against a live database — see §4 and §10.
- **Validation:** Zod-based env loader (`src/lib/validation/env.ts`) that
  throws a clear, listed error at import time if required vars are missing
  or malformed.
- **UI shell:** Root layout with `next-themes` (dark/light/system), a public
  landing page, `/sign-in`, and an authenticated shell (`AppShell`) reused by
  `/dashboard`, `/conversations`, and `/settings`. `/dashboard`, `/settings`
  ("AI", "Instagram", "Usage", and "Recent errors" sections), and
  `/conversations` (§6b below) are wired to real, user-scoped Prisma
  queries; the remaining 4 `/settings` sections (Chat Modes, Memory,
  Notifications, Security) are still placeholders pending their phases.
- **Instagram:** direct "Instagram API with Instagram Login" OAuth connect
  flow (§6 below) — `/api/instagram/connect` + `/api/instagram/callback`.
  Inbound messages flow in via `/api/webhooks/instagram` (§6a below):
  signature-verified, idempotent, persisted to `Conversation`/`Message`,
  readable in the real `/conversations` UI (§6b). Outbound sending is real
  (§9a below) — `InstagramService.sendMessage()`, gated by the 24-hour
  messaging window (spec §41) — reachable now via an AI-approved draft
  _or_ (Phase 10, §9b below) a plain manually-typed message. Historical
  sync (`GET /{ig-user-id}/conversations`) is still not implemented.
- **Human takeover (§9b below):** already mostly in place since Phase 6
  (`aiEnabled`/`humanTakeover` toggles, both respected by Phase 9's
  automatic pipeline); Phase 10 closes the one real gap spec §61 called
  out — "the user must always be able to manually communicate" — with a
  manual type-and-send path in the composer, independent of AI state.
- **Gemini:** `@google/genai` (`^1.0.0` — the real npm `latest`, `2.23.0`,
  requires Node ≥20, so it's pinned down the same way Next.js/Tailwind are;
  see §7/§10). `GeminiService` has all four spec §30 methods:
  `generateResponse()`, `summarizeConversation()`, `extractMemory()`,
  `analyzeCommunicationStyle()` — all still manually triggered from the UI,
  but now _also_ triggered automatically (§9a below) via BullMQ queues.
- **Automatic processing (§9a below):** BullMQ + Redis (`bullmq` +
  `ioredis` — the latter pinned to `^5` for the same Node-18 reason as
  everything else, see §10). An inbound message can now, without any
  button click: generate a draft reply, decide whether to auto-send it
  (spec §59), actually send it if eligible, and periodically extract
  memory/style facts (spec §19/§21). Entirely optional — with no
  `REDIS_URL` configured, none of this runs and every manual button from
  Phase 7/8 works exactly as before.
- **Analytics, cost tracking, structured logging (§9c below):** every AI
  generation, Instagram send, and webhook-processing step now emits a
  narrow-field structured log line (spec §52) and, for AI generations, an
  estimated USD cost (spec §31). `/settings` "Usage" shows Today/7 days/
  30 days/Total token and cost totals; a new "Recent errors" card surfaces
  the last 25 `APIError` rows — the first UI to ever read that table back.
- **Rate limiting (§9d below):** Redis-backed fixed-window limits (spec
  §50) on AI generation, manual message sending, webhook processing, and
  the Instagram OAuth connect endpoint — each keyed by the scope that
  makes sense for it (conversation, Instagram account, or user), and each
  failing open (no limiting) when Redis isn't reachable, same as every
  other optional-Redis feature in this project.
- **Testing infrastructure (§9e below):** Vitest + React Testing Library
  (unit + integration) and Playwright (E2E), all pinned to Node-18-
  compatible versions. 141 unit/integration tests across 17 files, all
  passing; 3 real Playwright smoke tests run against a live dev server
  (no database needed); a 12-step spec §68 E2E scenario is written but
  explicitly `test.skip()`-gated on infrastructure this environment
  doesn't have (a seeded Postgres, a scripted login, mocked Meta/Gemini
  routes).
- **Docker, production configuration, final security review (§9f
  below):** a multi-stage `Dockerfile` (Next.js standalone output) +
  `docker-compose.yml` (app/postgres/redis), security response headers
  (previously entirely absent), and `SECURITY_REVIEW.md` — the spec §87
  final security audit, with two real findings fixed (missing headers, a
  `.gitignore` pattern that would have excluded the `.env.example`
  templates from version control).

## 2. Directory structure

Matches the spec's §4 layout:

```
src/
  app/{dashboard,conversations,settings,sign-in,api/{auth,instagram,webhooks,ai,conversations}}
  components/{ui,chat,conversations,instagram,ai,settings,layout}
  lib/{db,auth,instagram,gemini,ai,conversations,memory,security,queue,validation,logging}
  services/{instagram,ai,conversations,memory}
  types/
prisma/
tests/
docs/
```

`components/chat`, `components/instagram`, `components/ai`,
`components/settings`, and every `lib/*` / `services/*` subfolder besides
`lib/db`, `lib/auth`, `lib/validation` are empty placeholders reserved for
their implementation phase — nothing is stubbed inside them yet to avoid
dead code.

## 3. Reusable components already in place

- shadcn/ui primitives: `button`, `card`, `badge`, `separator`, `avatar`,
  `dropdown-menu`, `sonner` (toaster), `switch`, `label`, `textarea`,
  `input`, `scroll-area`, `tabs`, `select` — in `src/components/ui/`.
- `AppShell` (`src/components/layout/app-shell.tsx`) — top nav + sign-out,
  reused by every authenticated route.
- `requireUser()` (`src/lib/auth/require-user.ts`) — server-side auth guard,
  redirects to `/sign-in` when there's no session, returns a typed
  `{ id, email, name, ... }`. Use this in every future authenticated
  page/route instead of re-implementing the check.
- `prisma` singleton (`src/lib/db/prisma.ts`) — import this, never
  `new PrismaClient()` elsewhere.
- `env` (`src/lib/validation/env.ts`) — import this instead of touching
  `process.env` directly in new code.
- `getOrCreateAIConfiguration()` (`src/lib/ai/get-ai-configuration.ts`) —
  fetch-or-create a user's global `AIConfiguration`. New users get one via
  the auth `createUser` event; this is the defensive fallback.
- `AISettingsForm` (`src/components/settings/ai-settings-form.tsx`) —
  react-hook-form + Zod client form for `AIConfiguration`, posting to the
  `updateAIConfiguration` server action in `src/app/settings/actions.ts`.
  Established pattern for future settings/conversation-settings forms:
  a `"use server"` actions file per route + a client form component that
  calls it directly (no separate API route needed for same-origin form
  submissions).
- `encrypt()`/`decrypt()` (`src/lib/security/encryption.ts`) — AES-256-GCM
  keyed from `ENCRYPTION_KEY`. Use this for any future secret-at-rest
  (nothing else needs one yet).
- `instagram-service.ts` (`src/services/instagram/`) — the only module that
  calls Meta/Instagram HTTP endpoints; see §6. `InstagramApiError`
  (`src/lib/instagram/errors.ts`) is the error type it throws.
- `src/lib/instagram/webhook.ts` — webhook signature verification, the Zod
  payload schema, and the idempotency-key helper; `webhook-processor.ts`
  (`src/services/instagram/`) — turns one validated messaging item into
  `InstagramParticipant`/`Conversation`/`Message` rows. See §6a.
- `getConversationList()`/`parseStatusFilter()`
  (`src/lib/conversations/get-conversation-list.ts`) — the conversation
  list query (filters, search, computed unread flag) and the shared
  status-filter parser used by both `/conversations` and
  `/conversations/[conversationId]` (a Next.js layout can't read
  `searchParams`, so this couldn't live in a shared layout — see §6b).
  `ConversationSidebar` (`src/components/conversations/`) is the async
  Server Component both pages render to get an identical list.
- `gemini-service.ts` (`src/services/gemini/`) — the only module that
  calls `@google/genai`; see §7/§7a. `GeminiApiError`
  (`src/lib/gemini/errors.ts`) is the error type it throws.
  `buildPrompt()`/`buildSystemInstruction()`/`buildConversationContents()`
  (`src/lib/gemini/prompt-builder.ts`) and `validateAIResponse()`
  (`src/lib/gemini/response-validator.ts`) are pure functions, independently
  exercised via a standalone script — reusable wherever prompt construction
  or output validation is needed again.
- `getAIGenerationContext()` (`src/lib/conversations/get-ai-context.ts`) —
  gathers everything `buildPrompt()` needs (resolved language/response
  length/emoji level/chat mode across conversation → `AIConfiguration`
  fallback, recent messages, memory, latest summary). Pure data-gathering,
  no Gemini calls — kept separate from `gemini-service.ts` specifically to
  avoid a circular import (that service calls this, this never calls it
  back).
- `MessageComposer` (`src/components/conversations/message-composer.tsx`)
  — the approval-workflow UI (§8a): generate/edit/regenerate/approve/
  reject a draft reply.
- `ConversationMemoryPanel` (`src/components/conversations/conversation-memory-panel.tsx`)
  — view/delete/clear `ConversationMemory` rows + trigger "Analyze
  conversation". Established pattern for the memory-extraction and
  style-analysis JSON schemas: `responseMimeType: "application/json"` +
  `responseSchema` on the Gemini call, then a Zod schema validates the
  parsed result before it's ever persisted — a `responseSchema` hint
  doesn't guarantee compliant output.
- `src/services/ai/draft-service.ts` (`createDraftReply()`),
  `src/services/ai/memory-service.ts` (`runConversationAnalysis()`),
  `src/services/ai/send-service.ts` (`sendApprovedDraft()`,
  `sendManualMessage()`, `SendMessageError`, plus the private
  `assertSendEligible()`/`callInstagramSend()` both share) — extracted in
  Phase 9 specifically so both a `"use server"` action _and_ a plain BullMQ
  worker (which can't import a `"use server"` file) can call the same
  logic; Phase 10's manual-send path reuses the same eligibility/send
  helpers as the AI-approved path rather than duplicating them. This is now
  the pattern for any future capability that needs both a manual button
  and an automatic trigger.
- `src/lib/queue/` (`connection.ts`, `queues.ts`, `job-types.ts`,
  `workers/*.ts`, `start-workers.ts`) — see §9a and `docs/QUEUES.md`.
- `src/lib/instagram/send-eligibility.ts`
  (`isWithinMessagingWindow()`) — the single 24-hour-window gate every send
  path checks (spec §41), manual or automated alike; see §9a/§9b.
- `logOperation()` (`src/lib/logging/logger.ts`) — structured console
  logger with a fixed, secret-free field set; call this instead of
  `console.log`ing an operation result directly (see §9c).
- `estimateCostUsd()` (`src/lib/gemini/pricing.ts`) — model-keyed USD cost
  estimate from token counts; returns `null` for a model it has no pricing
  row for, rather than guessing (see §9c).
- `getUsageSummary()` (`src/lib/analytics/get-usage-summary.ts`) and
  `getRecentErrors()` (`src/lib/analytics/get-recent-errors.ts`) — the
  read-side queries behind `/settings`'s "Usage" and "Recent errors" cards
  (see §9c).
- `checkRateLimit()` (`src/lib/security/rate-limit.ts`) — the single
  Redis-backed rate limiter every rate-limited path calls; see §9d.

## 4. Database (implemented Phase 2)

Full domain schema per spec §5–11, in `prisma/schema.prisma`:

| Model                  | Purpose                                   | Key relations                                          |
| ---------------------- | ----------------------------------------- | ------------------------------------------------------ |
| `InstagramAccount`     | Connected IG account, encrypted token     | belongs to `User`                                      |
| `InstagramParticipant` | The other side of a conversation          | belongs to `InstagramAccount`                          |
| `Conversation`         | One DM thread                             | belongs to `InstagramAccount` + `InstagramParticipant` |
| `Message`              | Individual message, in/outbound           | belongs to `Conversation`                              |
| `ChatMode`             | Personality preset (built-in + custom)    | referenced by `Conversation`/`AIConfiguration`         |
| `ConversationSettings` | Per-conversation overrides (1:1)          | belongs to `Conversation`                              |
| `AIConfiguration`      | Global AI defaults (1:1)                  | belongs to `User`                                      |
| `ConversationMemory`   | Extracted durable facts                   | belongs to `Conversation`                              |
| `AIResponse`           | Generated draft/sent response + metadata  | belongs to `Conversation`, `Message`                   |
| `WebhookEvent`         | Raw inbound webhook, dedup key            | unique external event ID                               |
| `MessageDelivery`      | Send/delivery status per outbound message | belongs to `Message`                                   |
| `AIUsage`              | Token/cost tracking row per generation    | belongs to `Conversation`, `AIResponse`                |
| `AuditLog`             | Security-relevant action trail            | belongs to `User`                                      |
| `SystemSetting`        | Key/value global config                   | standalone                                             |
| `APIError`             | Structured error log                      | polymorphic-ish, references ids loosely (no FK)        |

Design notes:

- `WebhookEvent.externalEventId` and `Message.externalMessageId` are unique
  — idempotency depends on this (spec §28).
- `ConversationMemory` has `category`/`key`/`value`/`confidence` per spec
  §19, scoped to a single `Conversation` via
  `@@unique([conversationId, category, key])`, never shared across users.
- Token fields (`InstagramAccount.accessTokenEncrypted`) store ciphertext
  only; `ENCRYPTION_KEY` (already validated in `env.ts`) is the AES key.
  Encryption itself lands in Phase 4 alongside the Instagram connect flow.
- `Conversation.aiEnabled`/`humanTakeover`/`chatModeId` live directly on the
  conversation (spec §9/§23 — human takeover is mandatory, not an
  afterthought); `ConversationSettings` holds the rest of the
  per-conversation overrides (spec §57), each field nullable so `null` means
  "inherit the user's `AIConfiguration`" (spec §32).
- `ChatMode` rows with `userId: null` are the 10 seeded built-in modes,
  shared by every user; a row with `userId` set is one user's custom mode.
  `@@unique([userId, key])` lets every user (including the `null` "global"
  owner) have at most one mode per key.
- Migration `prisma/migrations/20260917094849_init_domain_schema/` was
  generated offline with `prisma migrate diff --from-empty
--to-schema-datamodel` because no local Postgres is reachable in this dev
  environment (see §10). It has never been applied or verified against a
  real database. Phase 3's dashboard/settings queries are written against
  it but are equally unverified at runtime — **run `npm run prisma:migrate`
  against a real database and manually click through `/dashboard` and
  `/settings` before trusting either.**
- Seed data (`prisma/seed.ts`, spec §69): the 10 built-in chat modes plus one
  demo user/account/conversation with 3 placeholder messages. No real
  Instagram data. Run via `npm run prisma:seed` (needs a live database).
- Migration `prisma/migrations/20260917103600_conversation_profile_and_read_tracking/`
  (Phase 6) adds `Conversation.lastReadAt` (unread tracking, spec §33) and
  `ConversationSettings.preferredName`/`relationshipLabel`/`notes` (contact
  profile spec §20 + personal notes spec §76). Same offline
  `prisma migrate diff` technique as the Phase 2 migration (schema-to-schema
  this time, not from-empty, so it's a clean incremental `ALTER TABLE` —
  see the file for the exact SQL) — equally unverified against a real
  database.

## 4a. Dashboard + AI settings (implemented Phase 3)

- `/dashboard` (`src/app/dashboard/page.tsx` + `get-dashboard-stats.ts`): all
  8 cards from spec §34 now come from real, user-scoped Prisma
  queries/counts instead of hardcoded strings. Every query filters through
  `instagramAccount: { userId }` (spec §74 authorization) so one user can
  never see another's counts. Everything reads zero until Phase 4 connects
  an Instagram account — that's expected, not a bug.
- `/settings` "AI" section (spec §32/§54): a real form bound to the user's
  `AIConfiguration` — default chat mode, language, response length, emoji
  level, auto-send, response delay (mode + min/max ms), memory enabled,
  style matching, max context messages, model, temperature. Selecting a
  default chat mode is restricted server-side to built-in modes or the
  user's own custom modes (spec §74) — enforced again in the server action,
  not just hidden in the UI.
- The remaining 6 settings sections (Chat Modes, Memory, Notifications,
  Security, Usage, Advanced) are unchanged placeholders — each depends on a
  later phase (Gemini, memory extraction, etc.) that hasn't landed yet.
  "Instagram" became real in Phase 4 (see §6/§6a) and moved out of this
  placeholder list, ahead of the AI card in the actual `/settings` layout.

## 5. API plan

Route surface per spec §73, implemented incrementally:

- `POST/GET /api/auth/[...nextauth]` — done (Phase 1).
- `GET /api/instagram/connect`, `GET /api/instagram/callback` — done (Phase 4).
  Deviates from the original sketch below: these two _must_ be GET
  (they're OAuth browser redirects, not client-initiated mutations).
  Disconnect and account-status reads turned out not to need their own REST
  routes — they follow the Phase 3 pattern instead: `disconnectInstagramAccount()`
  is a server action in `src/app/settings/actions.ts`, and account status is
  a direct Prisma query in the `/settings` Server Component. No `POST
/api/instagram/disconnect` or `GET /api/instagram/account` route exists;
  add one later only if an external/mobile client actually needs it.
- `GET/POST /api/webhooks/instagram` — done (Phase 5). GET is Meta's
  one-time subscription handshake; POST receives event deliveries. See §6a.
- `GET /api/conversations`, `GET /api/conversations/:id`,
  `PATCH /api/conversations/:id/settings` — done (Phase 6), but not as REST
  routes: same deviation as Instagram connect/disconnect in Phase 3/4 — the
  list and detail reads are direct Prisma queries in `/conversations` and
  `/conversations/[conversationId]` Server Components, and the "settings"
  writes (AI enabled, human takeover, chat mode, contact profile) are
  server actions in `src/app/conversations/actions.ts`. See §6b.
- `POST /api/conversations/:id/ai/generate`,
  `POST /api/conversations/:id/messages`,
  `POST /api/conversations/:id/takeover`,
  `POST /api/conversations/:id/resume-ai` — Phase 8/10.
- `GET/POST/PATCH /api/chat-modes*` — Phase 7.
- `GET /api/usage` — Phase 11.

All routes: server-side ownership check (`InstagramAccount.userId === session.user.id`
transitively through `Conversation`), Zod-validated input, no service logic
inside React components (services live in `src/services/*`).

## 6. Instagram integration (implemented Phase 4)

- Auth: "Instagram API with Instagram Login" (direct Business Login, no
  Facebook Page needed) — verified against Meta's current docs on
  2026-09-17, full research trail + sources in `docs/INSTAGRAM_SETUP.md`
  (spec §92 requires this verification step; done before writing any code).
- `src/services/instagram/instagram-service.ts` is the only place that calls
  Meta/Instagram HTTP endpoints — `getAuthorizationUrl()`,
  `exchangeCodeForShortLivedToken()`, `exchangeForLongLivedToken()`,
  `refreshLongLivedToken()` (implemented, still not called by anything —
  no scheduled job exists — see §10), `getProfile()`, `sendMessage()`
  (Phase 9, §9a below). Route handlers and Server Components call into
  this, never `fetch()` Meta directly (spec §37).
- `src/lib/instagram/errors.ts` (`InstagramApiError`, typed by
  `ErrorCategory`) + `src/lib/instagram/oauth.ts` (shared OAuth-state cookie
  config and the `/settings?instagram=...` redirect helper).
- `META_GRAPH_API_VERSION` is an env var, not hardcoded (spec §39).
  **Correction, made in Phase 9:** Phase 4 claimed `graph.instagram.com`
  was entirely unversioned — wrong, or too broad. Re-verified while
  researching the Send API: the _token-management_ endpoints
  (`/access_token`, `/refresh_access_token`) work unversioned, but
  _content_ endpoints (`/me`, `/{id}/messages`) use the standard
  `/vNN.N/` path. `getProfile()` was fixed to include the version; only
  the two token endpoints stay unversioned. Also bumped the default from
  the stale `v21.0` to `v26.0` (current as of 2026-09-17; v20.0 was about
  to be deprecated) — see `docs/INSTAGRAM_SETUP.md`.
- Scopes requested: `instagram_business_basic` +
  `instagram_business_manage_messages` only (spec §40 — no unused
  permissions; messaging scope is requested now so Phase 5 doesn't need a
  second consent round).
- Tokens are AES-256-GCM encrypted (`src/lib/security/encryption.ts`) before
  `InstagramAccount.accessTokenEncrypted` is written, and wiped
  (re-encrypted empty string) on disconnect — never stored or logged in
  plaintext.
- Cross-user protection: the callback rejects connecting an Instagram
  account already linked to a _different_ InstaMate user
  (`instagramUserId` is globally unique on `InstagramAccount`).
- Not implemented: historical conversation sync via
  `GET /{ig-user-id}/conversations`, and automatic token refresh (no
  scheduled job exists — the 3 queues that do exist are all triggered by
  webhook events, not a clock; see §10). Outbound sending and its spec §41
  eligibility check are now implemented — see §9a.

## 6a. Instagram webhook + message persistence (implemented Phase 5)

- `GET/POST /api/webhooks/instagram` — verified against Meta's current
  Messenger/Instagram Platform webhook docs on 2026-09-17, sources in
  `docs/WEBHOOKS.md` (spec §92).
- GET handles Meta's one-time subscription handshake (`hub.mode`/
  `hub.verify_token`/`hub.challenge`, echoed back as plain text — JSON-
  wrapping the response is the most common cause of failed verification).
- POST: reads the raw body (`request.text()`) and HMAC-SHA256-verifies
  `X-Hub-Signature-256` against it (`src/lib/instagram/webhook.ts`,
  `isValidWebhookSignature`) **before** parsing anything — spec §38 "never
  trust incoming webhook data blindly." Then Zod-validates the envelope
  (`instagramWebhookPayloadSchema`).
- Idempotency (spec §28): a `WebhookEvent` row is inserted per messaging
  item, keyed by `mid` (or a synthetic `entryId:senderId:timestamp` when
  `mid` is absent), **before** any other processing. A unique-constraint
  hit means "already saw this delivery" — skipped, not reprocessed.
- Account ownership (spec §38/§74): events for an `instagramUserId` with no
  matching active `InstagramAccount` are recorded (`WebhookEvent.status =
IGNORED`) but never turned into `Message` rows for someone else's data.
- `src/services/instagram/webhook-processor.ts` → `processMessagingItem()`
  does the actual persistence in one `$transaction`: upserts
  `InstagramParticipant`, upserts `Conversation`, upserts/creates `Message`
  (senderType/direction from `is_echo`; messageType inferred from
  `text`/`attachments[].type`/`is_unsupported`/`reply_to.story`), bumps
  `Conversation.lastMessageAt`.
- **Known simplification, documented in `docs/WEBHOOKS.md`:** Instagram's
  messaging webhook carries no Meta-assigned conversation ID, so
  `Conversation.externalConversationId` is synthesized as the participant's
  `externalUserId` (valid because Instagram DMs are 1:1 — one thread per
  participant). A future historical-sync job calling
  `GET /{ig-user-id}/conversations` needs to reconcile by participant id,
  not assume Meta's conversation ID matches this field.
- Explicitly out of scope this phase (per spec §89's Phase 5/6/7/8/9
  split): the `/conversations` UI, AI response generation off an inbound
  message, outbound sending, and the `instagram-webhook`/`ai-response`
  BullMQ queues from spec §29 — everything above runs synchronously inside
  the request handler today.
- **Phase 9 update:** the last bullet's gaps are now closed — see §9a.
  `ai-response`/`memory-extraction` jobs are enqueued right after message
  persistence in this same handler (still no `instagram-webhook` queue;
  see `docs/QUEUES.md` for why that one specifically stays synchronous).

## 6b. Conversation UI (implemented Phase 6)

- `/conversations` (list-only, no thread selected) and
  `/conversations/[conversationId]` (thread + settings panel) — both
  render their own copy of the left conversation list via the shared
  `ConversationSidebar` Server Component, because a Next.js **layout**
  cannot read `searchParams` (only a page can) and the list depends on the
  `status`/`q` query params. `src/app/conversations/layout.tsx` is now
  just `requireUser()` + `AppShell` wrapping; it does not fetch or render
  the list.
- Conversation list (spec §33): avatar (with initial-letter fallback for
  missing `profilePictureUrl`, spec §8), display name, latest message
  preview, relative timestamp, unread dot, AI/human-takeover badges,
  selected chat mode. Filters (spec §35 — All/AI Enabled/Human/Unread/
  Active) and search (spec §36 — username/display name/message text) are
  plain `?status=`/`?q=` query params rendered as links/a GET form, so
  filtering/search work with JavaScript disabled and are trivially
  shareable/bookmarkable URLs.
- **Unread is computed, not stored as a boolean:** `lastMessageAt >
lastReadAt` (or `lastReadAt` is null), evaluated in
  `getConversationList()`. The `unread` status filter can't be expressed as
  a single Prisma `where` clause (it compares two columns on the same row),
  so that one filter is applied in application code after the DB query —
  acceptable at the scale of one person's Instagram inbox; would need a
  raw query or a materialized flag at real scale.
- Search (spec §36) uses Postgres `contains`/`insensitive` (effectively
  `ILIKE`), not full-text search (`tsvector`/GIN index) — fine for personal
  inbox scale; revisit if/when message volume makes full-text search worth
  the added schema complexity.
- Opening a conversation marks it read (`Conversation.lastReadAt =
now()`), a best-effort write inside the page's Server Component render —
  not gated on anything, matching how read-tracking works in most chat UIs.
- Chat thread: renders every `Message` (`MessageBubble` — inbound/outbound/
  AI/system styling, timestamp, `MessageDelivery.status` if one exists).
  As of Phase 6, the composer's "AI Generate"/"Send" controls were
  disabled placeholders — generation (Phase 7) and sending (Phase 9) are
  both real now; see §7a/§8a/§9a for how the composer evolved.
- Right-side panel wires up what's real _today_: AI Enabled / Human
  Takeover switches and the Chat Mode selector are live (they're plain
  fields on `Conversation`, spec §9/§23 — human takeover is mandatory, not
  gated behind AI generation existing) via
  `setConversationAIEnabled()`/`setConversationHumanTakeover()`/
  `setConversationChatMode()` in `src/app/conversations/actions.ts`, each
  ownership-checked and audit-logged (`AI_ENABLED`/`AI_DISABLED`/
  `HUMAN_TAKEOVER_ENABLED`/`HUMAN_TAKEOVER_DISABLED`/`MODE_CHANGED`).
- Contact profile panel (spec §20) + personal notes (spec §76): preferred
  name, relationship label, and private notes are editable and persisted
  to the new `ConversationSettings` fields via `updateContactProfile()`
  (audit-logged as `SETTINGS_CHANGED`). Notes are never sent to Instagram
  and aren't fed to the AI — spec §76 allows that only behind an explicit
  opt-in, which doesn't exist yet.
- Explicitly deferred to Phase 8 (per spec §57, which reads as an AI-
  behavior settings panel): `ConversationSettings.language`/
  `responseLength`/`emojiLevel`/`autoSend`/`memoryEnabled`/
  `responseDelayMode`/`customInstructions` have no UI yet — they don't
  affect anything until Phase 7/8's AI generation reads them, so a form for
  them now would be dead UI.

## 7. Gemini integration (implemented Phase 7)

- Verified against Google's current Gemini API/SDK documentation on
  2026-09-17 (spec §93) — full research trail, sources, and the
  Node-18-vs-package-latest deviation in `docs/GEMINI_SETUP.md`.
- `GEMINI_API_KEY` / `GEMINI_MODEL` already in `env.ts` (optional, so the
  app boots without a real key). Default model updated from the Phase 1
  placeholder `gemini-2.0-flash` to `gemini-3.8-flash` — the verified
  current stable default (spec §30: don't hardcode a model name if the
  API recommends a different stable one).
- `GeminiService` (`src/services/gemini/gemini-service.ts`) is the only
  caller of `@google/genai`; prompt construction goes through
  `src/lib/gemini/prompt-builder.ts` (spec §44), never inlined at the call
  site.
- Prompt builder implements the full layered architecture from spec §14:
  base tone rules + Hinglish engine (spec §13) + response length + emoji
  level + chat mode + custom instructions + contact profile + memory +
  conversation summary, composed into one `systemInstruction`; recent
  messages become the actual conversation `contents`. Prompt injection
  protection (spec §48) falls directly out of this structure — inbound
  text is only ever a `user` turn, never spliced into the system
  instruction.
- Context window management (spec §45/§46): `ConversationSummary` is a new
  model this phase, populated on demand (not via a scheduled job — none
  exists until Phase 9) whenever a conversation has more messages than
  `maxContextMessages`.
- Response validation (spec §47) runs before any draft leaves
  `GeminiService` — see `docs/GEMINI_SETUP.md`/`docs/SECURITY.md` for the
  full check list.
- Confidence score is a documented best-effort heuristic
  (`avgLogprobs`-derived, or a finish-reason-based fallback) — Gemini has
  no native confidence field, and this is never presented as a calibrated
  probability.
- Token usage (spec §31) is threaded into both `AIResponse` and `AIUsage`
  in one transaction — the Phase 3 dashboard's "Gemini usage" card, empty
  since it was built, now has a real path to real data.

## 7a. AI Generate wiring (implemented Phase 7, extended Phase 8)

- The conversation composer (`src/components/conversations/message-composer.tsx`,
  a client component) has a working "AI Generate" button: `generateDraftReply()`
  server action (`src/app/conversations/actions.ts`) calls
  `GeminiService.generateResponse()`, persists an `AIResponse`
  (`PENDING_APPROVAL`) and an `AIUsage` row, writes an
  `AI_RESPONSE_GENERATED` audit log entry, and returns the draft to
  populate the composer.
- Deliberately **not** gated on `Conversation.aiEnabled`/`humanTakeover` —
  spec §23 explicitly allows AI-generated suggestions during human
  takeover; those two fields govern _automatic_ sending, which doesn't
  exist yet regardless.
- Phase 7 stopped here (draft shown, nothing to do with it but read it).
  Phase 8 (§8a below) adds the full approval workflow on top.

## 8a. Approval workflow, memory, and style matching (implemented Phase 8)

- **Approval workflow (spec §58):** `MessageComposer` now shows a pending
  `AIResponse` (if one exists, fetched server-side in
  `/conversations/[conversationId]/page.tsx`) as an "AI Suggested Reply"
  with Edit (the textarea itself, always editable)/Regenerate/Approve/
  Reject. `regenerateDraftReply()` generates a new draft and marks the
  superseded one `REGENERATED` (not deleted — `AIResponse` keeps the
  generation history). `approveDraftReply()`/`rejectDraftReply()` set
  `APPROVED`/`REJECTED`. `updateDraftReplyText()` persists in-place edits.
  **"Send" stays disabled** — spec §58 says "Only 'Send' should call
  Instagram's send API," and that API call doesn't exist until Phase 9;
  "Approve" is the closest equivalent available today ("ready to send
  whenever sending exists").
  - No `AuditAction` is logged for approve/reject/edit: spec §53's audit
    list doesn't include those actions, so none were invented.
- **Memory (spec §19/§75):** `GeminiService.extractMemory()` sends the last
  30 messages to Gemini with `responseSchema`-constrained JSON output,
  Zod-validates the result, and returns durable facts (never invented,
  never about the account owner, never a sensitive personal
  characteristic — all three constraints are explicit in the prompt, not
  just hoped for). `ConversationMemoryPanel` (in the conversation settings
  panel) lists facts, supports delete-one and clear-all
  (`deleteConversationMemory()`/`clearConversationMemory()`), and has the
  trigger button.
- **Style matching (spec §21):** `GeminiService.analyzeCommunicationStyle()`
  — same structured-JSON approach, but scoped to only the Contact's
  inbound messages (never the account owner's, since the point is to
  match their style). Results are stored as `ConversationMemory` rows
  under category `communication_style`, so they flow into the prompt
  builder's existing `LONG_TERM_MEMORY` layer with no changes needed there.
- **One button, two capabilities:** the UI has a single "Analyze
  conversation" button (`analyzeConversation()` action) that calls both
  `extractMemory()` and `analyzeCommunicationStyle()` together — simpler
  UX, while keeping them as two distinct, independently testable
  `GeminiService` methods underneath (matching spec §30's method list).
- **Per-conversation AI settings (spec §57), deferred from Phase 6:**
  language/response length/emoji level/memory enabled/auto-send/custom
  instructions are now editable per conversation
  (`updateConversationAISettings()`), each as "Inherit" (null → falls back
  to the user's `AIConfiguration`) or an explicit override — the same
  null-means-inherit pattern the schema was designed around in Phase 2.
  Auto-send became real in Phase 9 — see §9a.
- Explicitly out of scope this phase (per spec §89's Phase 9/10 split):
  anything triggering generation, memory extraction, or style analysis
  automatically off an inbound webhook message; actually sending approved
  text through Instagram; queues of any kind. **All closed in Phase 9 —
  see §9a.**

## 9a. Automatic processing: queues, auto-send, real sending (implemented Phase 9)

- **Queues (spec §29):** BullMQ + Redis. Only 3 of the 6 named queues are
  implemented — `ai-response`, `instagram-send`, `memory-extraction` — each
  with a real producer and a real consumer; `instagram-webhook`/`retry`/
  `analytics` are deliberately not built yet (reasons in `docs/QUEUES.md`,
  short version: webhook processing is already fast/synchronous, "retry" is
  BullMQ's own per-job `attempts`/`backoff` rather than a separate queue,
  and "analytics" has no consumer to build until Phase 11). Everything
  degrades to "no automatic processing, all manual buttons still work"
  when `REDIS_URL` is unset — same pattern as every other optional
  integration in this project.
- **Shared services, not duplicated logic:** `createDraftReply()`,
  `runConversationAnalysis()`, `sendApprovedDraft()`
  (`src/services/ai/*.ts`) are each called by both a `"use server"` action
  (for the manual button) and a BullMQ worker (for the automatic trigger).
  This is a new, reusable pattern this phase established: business logic
  that must run from both a Next.js request and a background job can't
  live in a `"use server"` file (workers can't import those), so it moved
  to plain `src/services/*` functions.
- **Auto-send (spec §59):** `Generate → Validate → Queue → Send → Store
delivery status`. The `ai-response` worker generates + validates (via
  `createDraftReply()`/`generateResponse()`, unchanged from Phase 7/8),
  then checks the resolved `autoSend` setting and the 24-hour messaging
  window; if both hold, it marks the draft `APPROVED` and enqueues
  `instagram-send`. Otherwise the draft sits `PENDING_APPROVAL` exactly as
  it did in Phase 8 — auto-send and manual-approval are the same code path
  up to that fork, not two parallel implementations.
- **Real sending, finally:** `InstagramService.sendMessage()` — `POST
/{ig-id}/messages` with `{recipient: {id}, message: {text}}`, returning
  `message_id` (spec §92 research: confirmed directly from Meta's Send
  Messages docs, including the exact endpoint shape, on 2026-09-17 — see
  `docs/INSTAGRAM_SETUP.md` §4a). The manual composer's "Send" button
  (only shown once a draft is `APPROVED`) and the automatic
  `instagram-send` worker both call the same `sendApprovedDraft()`.
- **Spec §41, actually enforced now:** `isWithinMessagingWindow()`
  (`src/lib/instagram/send-eligibility.ts`) gates every send path. Outside
  the 24-hour window, this app refuses the send with spec §41's exact
  message rather than using Meta's `human_agent` tag to extend it — that
  tag is documented as being for a human replying manually, and using it
  to let _our_ automation slip past the window would be precisely the
  "unofficial bypass" spec §41 forbids. This was a judgment call made
  during this phase's research, not something the spec spelled out
  explicitly.
- **Idempotency bug caught and fixed during this phase:** the first draft
  of `sendApprovedDraft()` created a fresh `Message` row on every call,
  which meant a BullMQ retry after a transient failure would produce a
  duplicate outbound message — a direct violation of spec §29's "jobs must
  be idempotent." Fixed by upserting the `Message`/`MessageDelivery` rows
  keyed on a synthetic placeholder derived from the `AIResponse` id, so a
  retry reuses the same row and just increments `attempts`.
- **Long-running recovery scheduler:** `src/instrumentation.ts` → `register()`
  starts a Node-runtime-only interval every 10 seconds. Each tick checks the
  five most recently active conversations per active Instagram account and
  auto-replies only when the latest message is inbound. A PostgreSQL advisory
  lock prevents duplicate scans when more than one app instance is running.
  The scheduler works without an open browser page and requires a persistent
  Node process; it is not a serverless cron replacement.
- **Trigger idempotency:** `AIResponse.triggerMessageId` is unique, so a
  webhook-triggered response and a recovery-triggered response cannot both
  be persisted for the same inbound message. Recovery ignores the
  per-conversation `autoSend` preference by design, but still respects AI
  disablement, human takeover, account status, rate limits, and the 24-hour
  messaging window.
- Not implemented: the `instagram-webhook`/`retry`/`analytics` queues (see
  above). The checked-out source does not contain the BullMQ worker files
  previously described in this section; the recovery scheduler is the active
  periodic-processing mechanism.

## 9b. Human takeover completed: manual messaging (implemented Phase 10)

- **What was already done (Phase 6/9):** `Conversation.aiEnabled`/
  `humanTakeover` — spec §23's mandatory "AI ON / PAUSE AI / HUMAN
  TAKEOVER" states — have been toggleable switches since Phase 6, and
  Phase 9's `ai-response` worker already respects both (re-checked at
  processing time, not just enqueue time) before generating or auto-sending
  anything. Two switches rather than three buttons, but the same two
  underlying booleans spec §23 asks for — a toggle is a normal UI for a
  binary state, not a shortcut around the requirement.
- **What Phase 10 actually added:** spec §61's "the user must always be
  able to manually communicate" was the one real gap. The composer
  (`src/components/conversations/message-composer.tsx`) now has a genuine
  manual path: type text with no AI draft active → **Send** calls
  `sendManualMessageAction()` → `sendManualMessage()`
  (`src/services/ai/send-service.ts`), or **Discard** (client-only, clears
  the box). This path is deliberately **not** gated on
  `aiEnabled`/`humanTakeover` at all — spec §61 doesn't make manual
  communication conditional on AI state, and gating it would defeat the
  point of human takeover existing in the first place.
- **Shared, not duplicated:** `sendManualMessage()` and `sendApprovedDraft()`
  now share `assertSendEligible()` (account connected + 24-hour window) and
  `callInstagramSend()` (decrypt + `sendMessage()`) — refactored out of
  `sendApprovedDraft()` during this phase specifically so the manual path
  couldn't drift from the AI-send path's constraints. The manual path does
  **not** reuse the AI path's upsert-on-retry idempotency trick — it isn't
  queued/retried by BullMQ, it runs synchronously from one button click, so
  a plain `create()` per attempt is correct: a user who wants to retry
  after a failure just clicks Send again.
- `SendDraftError` was renamed to `SendMessageError` (it's no longer
  draft-specific) — every import updated, no stale references left.
- Both outbound paths write to the same `Message`/`MessageDelivery`/
  `AuditLog` tables with the same `senderType` distinction that already
  existed (`AI` vs `USER`), so the chat thread, delivery-status rendering,
  and audit trail all already handle manually-sent messages correctly with
  no further changes needed.
- **Deliberate UI simplification:** the composer's one text box switches
  meaning based on whether a draft exists — free-typed manual text when
  there's no draft, the (editable) draft text once one exists. A user
  can't type a from-scratch message while a draft is pending; they'd
  Reject it first. This avoids the ambiguity of "is this edit text meant
  to update the AI draft, or replace it with something unrelated" in a
  single shared field, at the cost of one extra click — a deliberate
  trade-off, not an oversight.

## 9c. Analytics, usage tracking, and structured logging (implemented Phase 11)

- **Scope, per spec §31/§52 (this phase's name in spec §89 is "Analytics,
  Usage, Logs, Errors"):** cost/token tracking with a Today/7-day/30-day/
  Total dashboard, structured operation logging, and a UI to actually read
  back errors that were already being written (`APIError`) since Phase 7.
  Spec §51/§53 (error handling categories, audit log) were already
  substantially implemented in earlier phases — every write path that
  could fail already created an `APIError` row and an `AuditLog` entry
  where the spec called for one; the gap this phase closed was that
  nothing ever displayed them, and no cost had ever been computed.
- **Structured logging (`src/lib/logging/logger.ts`):** `logOperation()`
  takes a fixed field set — `requestId`, `userId`, `instagramAccountId`,
  `conversationId`, `messageId`, `operation`, `status`, `durationMs`,
  `errorCode` — and writes one JSON line to `console.log`/`console.error`
  depending on `status`. Deliberately **no catch-all metadata field**: spec
  §52 says never log secrets, and a fixed field list makes it structurally
  impossible to accidentally pass an access token or API key into a log
  line the way a free-form `metadata` bag would allow. Wired into
  `createDraftReply()` (`ai.generate_response`), `sendApprovedDraft()`/
  `sendManualMessage()` (`instagram.send_message`/
  `instagram.send_manual_message`), and the webhook route
  (`webhook.process_message`, tagged with a per-request `requestId` so every
  messaging item in one delivery can be grouped by a log aggregator).
- **Cost estimation (`src/lib/gemini/pricing.ts`):** `estimateCostUsd(model,
inputTokens, outputTokens)` against a `PRICING` table keyed by exact model
  name. Only `gemini-3.8-flash` (this project's default model, see §7) is
  priced today — $0.75/1M input tokens, $3.75/1M output tokens, no
  prompt-size tiering, confirmed directly from
  `ai.google.dev/gemini-api/docs/pricing` on 2026-09-17 (spec §92/§93
  research step) and cross-checked against three independent secondary
  sources first. Pricing holds through 2026-12-31; Google's page lists a
  step to $1.50/$7.50 from 2027-01-01 — revisit `PRICING` before then. An
  unrecognized model returns `null` rather than a guessed number;
  `AIUsage.estimatedCostUsd` is nullable for exactly this reason.
  `createDraftReply()` now computes this per generation and stores it
  alongside the existing token counts.
- **Usage dashboard (`src/lib/analytics/get-usage-summary.ts`):**
  `getUsageSummary(userId)` runs four parallel window computations (today,
  7 days, 30 days, all time), each aggregating `AIUsage` (tokens, cost,
  count), `Message` (sent/received counts by `direction`), and `APIError`
  (count) — all scoped through `instagramAccount: { userId }` or `userId`
  directly, the same ownership boundary as every other cross-conversation
  query (spec §74). Rendered by `UsageSummaryPanel`
  (`src/components/settings/usage-summary.tsx`) as four cards in
  `/settings`.
- **Recent errors (`src/lib/analytics/get-recent-errors.ts`):**
  `getRecentErrors(userId, limit = 25)` — the last 25 `APIError` rows for
  the user, newest first. Scoped directly by `APIError.userId` (not through
  `InstagramAccount`, unlike most queries) because an error can happen
  before any Instagram account or conversation context exists — a failed
  OAuth connect attempt, for instance. Rendered by `RecentErrorsPanel`
  (`src/components/settings/recent-errors.tsx`) as a simple list with a
  category badge.
- **Deliberately excluded, and why:**
  - A webhook-events/queue-status debug view was considered and dropped:
    `WebhookEvent` has no `userId`/account foreign key by original schema
    design (§4's "polymorphic-ish, references ids loosely" note), so it
    can't be scoped to one user's data without either a schema change or an
    unscoped (and therefore unsafe, spec §74) view. Out of scope rather than
    built with a workaround.
  - An `AuditLog` viewer was considered and deferred to Phase 12 instead,
    where spec's "Security" settings section (token status, encryption,
    audit log) is the more natural home for it — this phase stayed scoped to
    its literal name, "Analytics, Usage, Logs, Errors."
- Not implemented: per-conversation or per-model cost breakdowns (only
  account-wide totals), any cost _alerting_/budget cap, and pricing rows for
  any Gemini model besides `gemini-3.8-flash`.

## 9d. Rate limiting, audit log coverage, security hardening (implemented Phase 12)

- **Scope, per spec §89 Phase 12 ("Security, Rate limiting, Encryption,
  Audit logs"):** encryption (Phase 4) and audit logging (Phases 4/6/7/8/9,
  spec §53's full list) were already substantially in place — this phase's
  real gap was rate limiting (spec §50, never implemented before now) plus
  a verification pass confirming the other three are actually complete
  against the spec, not just assumed to be.
- **Rate limiting (`src/lib/security/rate-limit.ts`):** `checkRateLimit(bucket,
key)` — a Redis `INCR`/`EXPIRE` fixed-window counter, checked against a
  `RATE_LIMITS` table of four buckets:

  | Bucket               | Limit       | Keyed by              | Applied at                                                                                                             |
  | -------------------- | ----------- | --------------------- | ---------------------------------------------------------------------------------------------------------------------- |
  | `AI_GENERATION`      | 20 / 10 min | `conversationId`      | `createDraftReply()` — manual button _and_ the automatic `ai-response` worker, since both call this one shared service |
  | `MESSAGE_SEND`       | 20 / 10 min | `conversationId`      | `sendManualMessage()` only (see below for why `sendApprovedDraft()` isn't separately limited)                          |
  | `WEBHOOK_PROCESSING` | 120 / 1 min | `instagramAccount.id` | the webhook POST handler, per messaging item, before `processMessagingItem()`                                          |
  | `INSTAGRAM_CONNECT`  | 10 / 10 min | `user.id`             | `GET /api/instagram/connect`                                                                                           |

  Fixed-window (not sliding window/token bucket) is a deliberate
  simplicity choice — this app runs at personal, single-user scale (spec
  §1), so a boundary-burst edge case isn't worth the extra complexity.
  **Fails open:** with no `REDIS_URL` configured, or on any Redis error,
  `checkRateLimit()` returns `{ allowed: true }` — same "optional service,
  degrade gracefully" pattern as BullMQ (§9a); rate limiting is
  defense-in-depth, not this app's primary authorization boundary (that's
  the per-request ownership checks every action/service already does).

- **Why `sendApprovedDraft()` (AI-approved sending) has no separate
  `MESSAGE_SEND` limit:** it's already implicitly bounded by the
  `AI_GENERATION` limit upstream — an approved draft only exists because a
  generation happened first, so limiting generation already caps how many
  AI-approved sends are even possible. Limiting it again would be
  redundant, not more secure.
- **Why the Instagram connect route is keyed by `user.id`, not client
  IP:** that route already requires a session (`requireUser()`); trusting
  an `X-Forwarded-For` header for an IP-based key would only be safe
  behind a known, correctly configured reverse proxy, which this app can't
  assume. `userId` is simpler and can't be spoofed the way a client-supplied
  IP header can.
- **New `InstagramConnectStatus` value:** `"rate_limited"`, surfaced as a
  `/settings?instagram=rate_limited` banner — same mechanism as
  `not_configured`/`already_connected` from Phase 4, no new pattern needed.
- **Verified against a real Redis, not just reasoned through:** this dev
  environment bundles a Redis binary via Laragon
  (`laragon/bin/redis/redis-x64-3.2.100/redis-server.exe`), started for
  this phase's verification — the first time any Redis-backed feature in
  this project has been exercised against a real Redis instance rather
  than only `tsc`/`eslint`. `checkRateLimit()` was round-tripped directly:
  20 calls to the same bucket/key allowed, the 21st and 22nd correctly
  blocked with `retryAfterSeconds` from the real key's TTL, and a
  different bucket/key confirmed independent. This does **not** mean the
  BullMQ pipeline itself (Phase 9) has been exercised end-to-end — that
  still needs a real Postgres too (see §10), which remains unreachable in
  this environment.
- **Audit log coverage, re-verified against spec §53's full list** (AI
  enabled/disabled, mode changed, settings changed, human takeover,
  AI response generated, message sent, message failed, account
  connected/disconnected, memory changed): every one of these already had
  an `AuditAction` enum value and a real write path from Phases 4/6/7/8/9 —
  **nothing was missing.** This phase's audit was a verification pass, not
  new implementation; see `docs/SECURITY.md`'s Phase 12 section for the
  point-by-point confirmation.
- **Encryption re-verified:** `src/lib/security/encryption.ts` (AES-256-GCM,
  random IV per call, authenticated tag checked on decrypt, key derived via
  SHA-256 from the operator-supplied `ENCRYPTION_KEY` passphrase) — no
  changes made, confirmed still sound. No other secret-at-rest exists in
  this app besides `InstagramAccount.accessTokenEncrypted`.
- **Secure cookies / CSRF, re-verified, no changes needed:** Auth.js v5's
  session cookie already gets `httpOnly` + the `__Secure-` prefix (when
  `NEXTAUTH_URL` is `https://`) by its own default — nothing in this app's
  config overrides that default down. The Instagram OAuth `state` cookie
  (Phase 4) was already `httpOnly`/conditionally `secure`/`sameSite: lax`.
  Next.js Server Actions already carry their own built-in Origin-header
  CSRF check — no extra code needed for the actions in
  `src/app/conversations/actions.ts`/`src/app/settings/actions.ts`.
- Not implemented: a distributed/sliding-window limiter (fixed-window is
  sufficient at this app's scale), any per-IP limiting anywhere (every
  limited path already has a more reliable non-IP key available), and a
  rate limit on Auth.js's own routes (its email magic-link flow already
  has its own built-in throttling upstream).

## 9e. Testing infrastructure (implemented Phase 13)

- **Scope, per spec §66/§67/§68/§89 Phase 13:** unit tests for the named
  modules (GeminiService, PromptBuilder, ConversationService,
  InstagramService, MessageProcessor, ResponseValidator, webhook
  validation/idempotency, authorization), an integration test for the
  webhook → persistence → AI draft → send → Instagram pipeline with mocked
  Meta/Gemini, and E2E tests for the spec §68 12-step user flow. One named
  target, "ChatModeService", has no dedicated module in this codebase (chat
  modes are plain `ChatMode` Prisma rows plus the ownership check inside
  `setConversationChatMode()`) — that ownership check is what's tested
  instead of inventing a service class that doesn't exist just to satisfy
  the checklist word.
- **Package versions, all pinned for Node 18 compatibility** (same
  recurring issue as `@google/genai`/`ioredis` in earlier phases — a
  package's real npm `latest` often needs Node ≥20):
  - `vitest@3.2.7` — the newest 3.x release; 3.x consistently supports
    `^18.0.0` across every version checked, so `^3.2.7` (caret) is safe
    here, unlike the two below.
  - `jsdom@26.1.0` — pinned to an exact version rather than a range: 26.x
    supports Node ≥18, but the very next major (27.4.0) requires Node ≥20.
  - `@testing-library/jest-dom@6.9.1` (exact) — 6.9.x supports Node ≥14,
    but 6.10.0 (a **minor**, not major, bump) raised the requirement to
    Node ≥22. A caret range here would have silently resolved to a
    Node-22-only version.
  - `@playwright/test@~1.61.0` (tilde) — 1.61.0 is the last `>=18`-compatible
    release; 1.62.0 (again a minor bump, not major) requires Node ≥20.
    Caret would have crossed that line; tilde (patch-only) doesn't.
  - Verified each with `npm view <package>@<version> engines` before
    installing, same discipline as every previous phase's dependency
    pinning.
- **Vitest config (`vitest.config.ts`):** `jsdom` environment,
  `@/` → `src/` alias (matching `tsconfig.json`), and `esbuild: { jsx:
"automatic" }` — needed because `tsconfig.json`'s `jsx: "preserve"` is
  for Next's own SWC compiler, not esbuild (Vitest doesn't go through
  Next.js/webpack at all). `test.env` seeds dummy-but-schema-valid values
  for every var `@/lib/validation/env` requires (`DATABASE_URL`,
  `NEXTAUTH_SECRET`, `NEXTAUTH_URL`, `ENCRYPTION_KEY`, plus
  `META_APP_SECRET`/`META_WEBHOOK_VERIFY_TOKEN` for the webhook signature
  tests) — never real credentials (spec §66/§67).
- **Unit tests (`tests/unit/`, 15 files):** pure logic (response validator,
  prompt builder, pricing, send-eligibility, webhook signature/idempotency,
  encryption round-trip) needs no mocking at all. Everything else mocks its
  dependencies at the module boundary with `vi.mock()`:
  `GeminiService` (mocks `@google/genai`'s `GoogleGenAI` class),
  `InstagramService` (mocks global `fetch`), `webhook-processor.ts`,
  `draft-service.ts`/`send-service.ts` (mock Prisma + each other's
  collaborators), the `ai-response` worker (mocks `bullmq`'s `Worker`
  class and captures the processor function it was constructed with),
  `getConversationList()`, and the authorization checks in
  `conversations/actions.ts` (a `"use server"` file — imports fine into a
  plain Vitest module, since that directive is a Next.js build-time/runtime
  convention, not something Vitest enforces).
- **Integration test (`tests/integration/webhook-to-send-pipeline.test.ts`,
  spec §67):** chains the three real, unmodified service functions
  (`processMessagingItem` → `createDraftReply` → `sendApprovedDraft`)
  against one shared hand-rolled in-memory Prisma fake — not a generic ORM
  stand-in, just the exact operations these three functions call, typed
  precisely (no `any`, matching spec §91's "no any unless unavoidable").
  Proves data flows correctly across the handoffs (a webhook-created
  conversation id reaches `createDraftReply`; a generated `aiResponseId`
  reaches `sendApprovedDraft`) and that the Phase 9 idempotency guarantee
  holds: a simulated retry after a transient send failure reuses the same
  `Message`/`MessageDelivery` row rather than creating a duplicate.
- **E2E (Playwright, `tests/e2e/`):**
  - `smoke.spec.ts` — 3 tests, actually run against a live `next dev`
    server in this environment (landing page renders and links to
    sign-in; sign-in form renders; an authenticated route redirects when
    signed out). None of these need a database — `auth()` and
    `requireUser()` both short-circuit before any Prisma call when there's
    no session cookie at all.
  - `full-flow.spec.ts` — the real spec §68 12-step scenario, written
    against actual selectors from `message-composer.tsx`/
    `conversation-settings-panel.tsx`/`settings/page.tsx`, but
    `test.skip()`-gated behind an `E2E_FULL_FLOW` env var and a comment
    explaining exactly what's missing to run it for real (seeded
    Postgres, a scripted login since there's no inbox to click a magic
    link from, `page.route()` interception of Meta/Gemini). This keeps it
    honestly inert rather than silently vanished or falsely "passing."
  - **Found via the smoke test, not assumed:** `CardTitle`
    (`src/components/ui/card.tsx`) renders a plain `<div>`, not a semantic
    heading — so it has no ARIA `heading` role. `getByRole("heading", ...)`
    failed against `/sign-in`'s title for exactly this reason; the test
    was fixed to use `getByText` instead. This is a pre-existing
    accessibility gap in the shared `Card` component (affects every
    `CardTitle` in the app), **not fixed in this phase** — changing a
    shared UI primitive is out of scope for a testing phase; tracked in
    §10 for a future accessibility pass.
  - No `webServer` block in `playwright.config.ts`: this repo's dev server
    needs `REDIS_URL` unset (see §10 — the bundled Redis is too old for
    BullMQ) for a clean boot, which Playwright's own server-management
    can't arrange; start `npm run dev` (with `REDIS_URL` unset) yourself
    before `npm run test:e2e`.
- **New discovery this phase — the bundled Redis is unusable by BullMQ:**
  starting `next dev` with `REDIS_URL` pointed at the Phase 12 Redis
  instance (Laragon's bundled `redis-server.exe`, version 3.2.100) sent
  every BullMQ worker into an infinite reconnect-error loop:
  `Redis version needs to be greater or equal than 5.0.0`. Plain
  `INCR`/`EXPIRE`/`TTL` (what `checkRateLimit()` uses) work fine on this
  Redis — only BullMQ itself refuses it. Killed the resulting runaway
  `next dev` process; see §10 for the practical implication.
- Not implemented: a coverage threshold/report (`@vitest/coverage-v8` — no
  spec requirement for one, and this phase's goal was real assertions over
  a number), CI wiring (spec doesn't ask for a specific CI provider; that's
  Phase 14 "Docker, production configuration" territory), and any test
  against a real Postgres/Meta/Gemini (still blocked on the same
  environment gaps as every phase since Phase 2).

## 9f. Docker, production configuration, and final security review (implemented Phase 14)

- **Scope, per spec §89 Phase 14 ("Docker, Production configuration,
  Documentation, Final security review"):** the four deliverables spec
  §71/§87/§88 name — `Dockerfile` + `docker-compose.yml`, production
  environment/deployment documentation, `SECURITY_REVIEW.md`, and closing
  out the `docs/` set (every file spec §88 lists now has real content —
  `docs/DEPLOYMENT.md` was the last stub).
- **Docker (`Dockerfile`, spec §71):** multi-stage build using Next.js's
  `output: "standalone"` (added to `next.config.ts` this phase) —
  `deps` (install), `builder` (`prisma generate` + `next build`), `runner`
  (the traced standalone server + explicitly-copied `@prisma/client`/
  `.prisma` generated engine, since Next's file tracer doesn't reliably
  catch Prisma's engine binary — a known, documented gap). Runs as a
  non-root user. `node:20-bookworm-slim` (Debian, not Alpine) for both
  build and runtime stages specifically to avoid a glibc/musl Prisma
  native-binary mismatch. Node 20, not this project's dev-pinned Node 18 —
  a container has none of this repo's local Node-18-compatibility
  constraints (§10), those exist only because _this development
  environment specifically_ can't be upgraded.
- **`docker-compose.yml`:** `app`/`postgres` (16-alpine)/`redis`
  (7-alpine — a real, current Redis, unlike this dev environment's
  bundled 3.2.100, see §10) with healthchecks and a `.env.docker` file
  (new `.env.docker.example` template) feeding `app`'s environment.
- **Deliberate design choice: migrations run from the host, not inside
  the `app` container.** The standalone runtime image doesn't ship the
  `prisma` CLI or `tsx` (dev-time tools the running server itself never
  imports) — re-adding just the CLI would mean also copying its own
  transitive dependencies (`@prisma/engines`, `@prisma/config`) by hand,
  a fragile Dockerfile pattern not worth taking on when this project has
  no way to actually build-and-test it here (see below). `npm run
prisma:migrate:deploy` (new script, spec §72: `prisma migrate deploy`,
  never `migrate dev`/`reset` against real data) and `npm run
prisma:seed` run from the host against Compose's exposed Postgres port
  instead — same pattern this project already uses for local dev seeding.
- **Security headers (`next.config.ts`):** `headers()` previously didn't
  exist at all — added `X-Content-Type-Options`, `X-Frame-Options`,
  `Referrer-Policy`, `Permissions-Policy` to every response. No
  `Content-Security-Policy` yet — deliberately deferred, needs a real
  Instagram profile-picture CDN URL to set `img-src` correctly, which
  this environment has never observed (no real Instagram account ever
  connected here). See `SECURITY_REVIEW.md`.
- **`SECURITY_REVIEW.md` (spec §87):** point-in-time final verdict across
  every item spec §87 names (authentication, authorization, secrets,
  token encryption, webhook validation, injection attacks, XSS, CSRF, SQL
  injection, rate limiting, logging, error leakage, prompt injection).
  Two real findings, both fixed: the missing security headers above, and
  a `.gitignore` bug (`.env*` with no exception would have excluded the
  `.env.example`/`.env.docker.example` templates from ever being
  committed). One traced-and-confirmed-safe finding worth recording: a
  repo sweep flagged `GeminiApiError`'s `details` field (persisted to
  `APIError.metadata`) as a plausible secret-leakage path since it stores
  the SDK's raw thrown error object — traced into the installed
  `@google/genai` SDK's actual source and confirmed its error classes
  only ever carry a `message` built from the **response** body, never
  request headers/API keys (full trace in `SECURITY_REVIEW.md`).
- **Not built or run — Docker is unavailable in this environment**
  (`docker`/`docker compose` commands don't exist here, same class of gap
  as no reachable Postgres). `docker-compose.yml`'s YAML was validated
  with a real parser (`js-yaml`, found already installed transitively);
  the Dockerfile's logic was traced by hand against the actual installed
  `prisma`/`@prisma/client` package layouts (confirmed
  `node_modules/prisma`'s `bin` entry, confirmed `prisma`'s own
  dependencies would be missing if copied naively — which is exactly why
  the host-run-migrations design above was chosen instead of a more
  fragile in-container approach). This is reasoned-through, not
  build-verified — **run `docker compose --env-file .env.docker up
--build` for real before trusting it**, per `docs/DEPLOYMENT.md`'s own
  caveat.
- Not implemented: a managed-hosting-specific guide (Vercel/Railway/
  Fly.io) — this app's in-process BullMQ workers (Phase 9) need a
  long-running Node process, ruling out serverless platforms for anything
  beyond manual-button-only mode; documented as out of scope in
  `docs/DEPLOYMENT.md` rather than guessed at. CI/CD pipeline
  configuration — not requested by the spec.

## 8. Security plan

- Tokens: encrypted at rest (`ENCRYPTION_KEY`, AES-256-GCM,
  `src/lib/security/encryption.ts` — implemented Phase 4), never sent to the
  client.
- Secrets: `GEMINI_API_KEY`, `META_APP_SECRET`, `NEXTAUTH_SECRET`,
  `ENCRYPTION_KEY` only read server-side via `env.ts`.
- AuthZ: every conversation-scoped query filters by the owning user's
  `InstagramAccount`. Applied in the Phase 3 dashboard queries, the Phase 3
  AI-settings chat-mode-ownership check, the Phase 4 Instagram
  connect/disconnect ownership checks, and now (Phase 6) every
  `/conversations` read and every action in
  `src/app/conversations/actions.ts` — each re-verifies
  `conversation.instagramAccount.userId === session.user.id` server-side
  before reading or writing, never trusting a conversation id from the URL
  alone. A request for another user's conversation 404s
  (`notFound()`), it doesn't leak a permission error that would confirm the
  id exists. Phase 8 extends the same pattern to `AIResponse` ownership
  (`requireOwnedAIResponse()`, for approve/reject/edit) and
  `ConversationMemory` ownership (for delete/clear).
- OAuth CSRF: the Instagram connect flow's `state` parameter is generated
  server-side, stored in an `httpOnly` cookie, and checked on callback
  (Phase 4).
- Webhook trust boundary (Phase 5): every inbound webhook request is
  HMAC-verified against the raw body before it's parsed at all; malformed
  or unsigned requests never reach the database layer.
- Prompt injection: inbound Instagram text is always treated as
  conversation content, never concatenated into system-level instructions
  (spec §48) — enforced in the Phase 7 prompt builder.
- AI response validation (spec §47): every draft is checked for emptiness,
  length, leaked internal markers, secret-shaped strings, unexpected
  structured output, and unexpected script — Phase 7.
- Memory/style extraction (Phase 8): prompts explicitly instruct Gemini
  never to infer sensitive personal characteristics and never to analyze
  the account owner's own messages; structured JSON output is Zod-validated
  before it's ever persisted — a `responseSchema` hint constrains but
  doesn't guarantee the model's output shape.
- Send eligibility (spec §41, Phase 9): the 24-hour messaging window is
  enforced before every send, and this app deliberately never uses Meta's
  `human_agent` tag to bypass it for automation — see §9a.
- Send idempotency (spec §29, Phase 9): a retried send job reuses its
  tracking `Message`/`MessageDelivery` row instead of creating a duplicate
  outbound message — see §9a.
- Manual sending (Phase 10) is authorized and constrained identically to
  AI-approved sending — same ownership check, same eligibility gate, same
  logging — see §9b.
- Structured logging (spec §52, Phase 11): `logOperation()` writes a fixed,
  enumerated field set with no catch-all metadata field, making it
  structurally impossible to log a secret by accident — see §9c.
- Error/usage read paths (Phase 11): `getRecentErrors()`/`getUsageSummary()`
  are scoped by `userId` (directly, or transitively through
  `InstagramAccount.userId`) the same way every other cross-conversation
  query is — see §9c.
- Rate limiting (spec §50, Phase 12): AI generation, manual message
  sending, webhook processing, and the Instagram connect endpoint are all
  Redis-backed rate limited — see §9d.
- Audit log coverage (spec §53, Phase 12): re-verified against the spec's
  full list — every named action already had a write path from earlier
  phases; nothing was missing — see §9d.
- Encryption, secure cookies, and CSRF protection (spec §49, Phase 12):
  re-verified, no changes needed — see §9d.
- Security headers, error-leakage tracing, and the final spec §87 review
  (Phase 14): see §9f and `SECURITY_REVIEW.md` — the point-in-time final
  verdict. Two real findings fixed (missing security headers, a
  `.gitignore` bug); no unresolved high-severity findings.
- Full checklist tracked in `docs/SECURITY.md` (incremental, per-phase
  history) and `SECURITY_REVIEW.md` (final, consolidated verdict).

## 9. Testing plan

- **Unit (Vitest + RTL): done (Phase 13).** 15 unit test files covering
  every module spec §66 names except `ChatModeService` (no such module
  exists — see §9e), plus the rate limiter and structured logger added in
  Phases 11/12. Pure logic with no DB/API dependency prior to Phase 13
  (the webhook Zod schema in Phase 5; the prompt builder and response
  validator in Phase 7; the memory-extraction and style-analysis Zod
  schemas in Phase 8; `isWithinMessagingWindow()` in Phase 9;
  `estimateCostUsd()`'s pricing-table lookup in Phase 11;
  `checkRateLimit()` against a real local Redis in Phase 12) had already
  been sanity-checked via standalone `tsx` scripts — Phase 13 turned all
  of that into committed, re-runnable tests (`npm run test`) instead of
  one-off scripts, and added mocked-dependency tests for everything that
  does call Prisma/Gemini/Meta/BullMQ.
- **Integration: done (Phase 13).** `tests/integration/webhook-to-send-pipeline.test.ts`
  — see §9e for exactly what it proves and how (a hand-rolled in-memory
  Prisma fake, since no real Postgres exists in this environment).
- **E2E (Playwright): partially done (Phase 13).** 3 real smoke tests run
  against a live dev server; spec §68's full 12-step flow is written but
  `test.skip()`-gated on infrastructure (seeded DB, scripted login, mocked
  Meta/Gemini routes) not available in this environment — see §9e.
- No real credentials in automated tests, ever — confirmed: `vitest.config.ts`'s
  `test.env` and every test file's mocked env values are all obvious
  placeholders, never `.env`'s real (still-empty) secrets.

## 10. Known environment constraints

- **Node 18.20.8 is installed; Next.js 16 and Tailwind v4 require Node ≥20.**
  This project currently pins to Next.js 15.x + Tailwind v3 to stay
  compatible. If Node is upgraded to 20+, both can be revisited — ask
  before doing that upgrade since it touches core tooling versions.
- `npm audit` reports a handful of high-severity advisories in transitive
  dev-tooling dependencies (`postcss` bundled inside `next`, `deepmerge-ts`
  inside `prisma`'s config loader, `sharp`'s bundled `libvips`). All require
  either a breaking downgrade or are irrelevant to this app's actual attack
  surface (dev-time only, no untrusted input reaches them here). **Revisited
  in the Phase 14 security review (`SECURITY_REVIEW.md`) and still not
  actioned** — same conclusion holds (dev-time only, no untrusted input
  reaches them); tracked, not forgotten.
- No git repository has been initialized per user request — version control
  is on the user to set up whenever they're ready.
- **No local Postgres (or Docker) is reachable in this dev environment.**
  `prisma migrate dev`/`migrate status` fail with P1001; `docker`/
  `docker compose` commands don't exist at all. All three schema
  migrations so far (Phase 2's full init, Phase 6's `lastReadAt`/contact-
  profile columns, Phase 7's `ConversationSummary`; Phases 8–13 added no
  schema changes) were produced with the DB-less `prisma migrate diff`
  path instead (see §4) and are untested against a real database. All of
  Phases 3–14's code is written against that same unverified schema and has
  only been checked with `tsc`/`eslint`/`next build`/`vitest`/`playwright`
  (plus, for pure logic, standalone scripts) — never actually run against
  real data or a real request, and the Phase 14 `Dockerfile`/
  `docker-compose.yml` have never been built or run for the same reason
  (see §9f). This is the single biggest risk in the project right now and
  has been for the entire project: **before this app handles any real
  Instagram conversation, get a real Postgres reachable, run
  `docker compose --env-file .env.docker up --build` for real, and
  exercise all thirteen prior phases' code against it** — nothing about
  reaching "Phase 14 complete" changes that; it's a milestone in the
  spec's phase plan, not a claim that the app has been run for real.
- **The shadcn CLI (`npx shadcn add ...`) does not run on Node 18** (`File is
not defined`, from a Node 18/`undici` gap) — install the underlying Radix
  package with plain `npm install` and hand-write the `ui/*` file to match
  the existing New York style instead (see `select.tsx` for the pattern).
- **No public HTTPS URL exists in this environment**, so the Instagram
  webhook (Phase 5) has never been registered with Meta or received a real
  delivery — local testing needs a tunnel (ngrok or similar) in addition to
  real `META_APP_ID`/`META_APP_SECRET`/`META_WEBHOOK_VERIFY_TOKEN` values.
- **`npm install <package>` with no version specifier can silently resolve
  below the real `latest`** when `latest` needs a newer Node than 18 — seen
  with `@google/genai` (real latest `2.23.0` needs Node ≥20; npm resolved
  `1.0.0` instead) and again with `ioredis` (real latest `6.0.0` needs
  Node ≥20; npm resolved `5.11.1` instead). Always check
  `npm view <package> engines` and `dist-tags` before assuming an
  unspecified install got the version the docs describe (see
  `docs/GEMINI_SETUP.md`/`docs/QUEUES.md`).
- **No real `GEMINI_API_KEY` is configured**, so `GeminiService` has never
  actually called the Gemini API — same class of gap as the Instagram/DB
  ones above, tracked in `docs/GEMINI_SETUP.md`'s last section.
- **`REDIS_URL` is set in `.env` (`redis://localhost:6379`), but nothing was
  listening on that port for Phases 9–11** — no BullMQ worker had ever
  actually processed a real job, because there was no Redis server running
  to connect to, not because the URL was unset. **Corrected in Phase 12:**
  this environment (Laragon) bundles a Redis binary at
  `laragon/bin/redis/redis-x64-3.2.100/redis-server.exe`; started it and
  confirmed `PING`/`INCR`/`EXPIRE`/`TTL` all work for real, and used it to
  verify `checkRateLimit()` against a real Redis (see §9d). This closes the
  Redis half of the gap, but **not** the whole thing: BullMQ's own workers
  still need Prisma/Postgres to do anything meaningful once a job runs, and
  Postgres remains unreachable (see below) — so the auto-send pipeline
  itself still hasn't processed a real job end-to-end. If this Redis
  process isn't still running in a later session, start it again the same
  way, or run any local Redis (`docker run -p 6379:6379 redis` if Docker
  becomes available).
- **Gotcha found in Phase 9: `export type { X } from "./other-module"` inside
  a `"use server"` file breaks the entire module** — Next.js's build
  reported "the module has no exports at all" for `actions.ts` and every
  component importing from it, even though the re-export was type-only
  (erased at compile time). The SWC transform that enforces "every export
  must be an async function" apparently doesn't special-case a type-only
  re-export syntactically. Fix: don't re-export types through a
  `"use server"` file — use `Awaited<ReturnType<typeof fn>>` inline, or
  just don't export the type from there at all.
- **Found in Phase 13: the Laragon-bundled Redis (3.2.100) works for plain
  commands but not for BullMQ**, which refuses to connect to anything
  below Redis 5.0.0. Rate limiting (`checkRateLimit()`, plain
  `INCR`/`EXPIRE`/`TTL`) works fine against it; running `next dev` with
  `REDIS_URL` pointed at it does not — every BullMQ worker enters an
  infinite reconnect-error loop instead of failing cleanly. Practical
  effect: leave `REDIS_URL` unset when running `npm run dev` in this
  environment (rate limiting fails open exactly as designed; BullMQ
  simply doesn't start, same as when the var is unset entirely), or
  provision an actual Redis ≥5.0.0 before testing the automatic pipeline.
- **Found in Phase 13 (via a real Playwright run): `CardTitle`
  (`src/components/ui/card.tsx`) renders a `<div>`, not a semantic heading**
  — no ARIA `heading` role, so every `CardTitle` across the app (dashboard,
  settings, conversation panels) is invisible to `getByRole("heading", ...)`
  and to screen-reader heading navigation. Not fixed this phase (out of
  scope for a testing phase — it's a shared UI primitive used everywhere);
  worth a small, deliberate fix (render an `h2`/`h3` or add
  `role="heading" aria-level`) during Phase 14's production/final pass.

## 11. Remaining work

**All 14 phases from spec §89 are now implemented.** There is no Phase 15
in the spec — what remains is not a missing feature, it's the
verification debt every phase since Phase 2 has carried and explicitly
flagged: this codebase has never been run against a real Postgres, a real
Meta app, a real Gemini API key, a real public HTTPS URL, or a real Docker
build. Phases 9/10's manually-typed and AI-approved sends have still never
actually reached Instagram. Nothing in Phases 11–14 closed that gap —
each verified one more _piece_ for real (a real Redis in Phase 12, a real
Playwright run in Phase 13, a real YAML parse of `docker-compose.yml` in
Phase 14) without ever assembling all the pieces together against live
infrastructure.

**Before trusting this app with a real Instagram account:**

1. Get a real Postgres reachable. Run `npm run prisma:migrate:deploy`
   (or, for local dev, `npm run prisma:migrate`) and `npm run prisma:seed`
   against it — this alone exercises Phases 2–14's entire unverified
   schema/query surface for the first time.
2. `docker compose --env-file .env.docker up --build` for real (Phase 14)
   and fix whatever the first actual build surfaces — the Dockerfile has
   been reasoned through carefully but never built.
3. A real `META_APP_ID`/`META_APP_SECRET`/`META_WEBHOOK_VERIFY_TOKEN` and
   a public HTTPS URL (a tunnel like ngrok for local testing, or the
   deployed app itself) to register the webhook and exercise the OAuth
   connect flow end-to-end.
4. A real `GEMINI_API_KEY` — exercise the full approval workflow
   (generate → edit → regenerate → approve/reject → send) and "Analyze
   conversation" against real Gemini output, not mocked responses.
5. With all of the above real: connect an account, receive a real inbound
   DM, and confirm the whole spec §67 pipeline (webhook → persistence →
   AI draft → send → Instagram) works outside of Phase 13's mocked
   integration test — including a forced transient send failure, to
   confirm the retry doesn't duplicate the outbound message for real.
6. Run `npm run test:e2e` with `E2E_FULL_FLOW=1` once a seeded database
   and a scripted login exist (see `tests/e2e/full-flow.spec.ts`'s header
   comment for exactly what that needs).
7. Set a real `Content-Security-Policy` once step 5 has produced a real
   Instagram profile-picture CDN URL to configure `img-src` against (see
   `SECURITY_REVIEW.md`).

This has been the single biggest risk in the project since Phase 2 and
remains so at "feature-complete": **every phase's code is real,
reviewed, and — where the environment allowed — tested for real, but the
fully assembled system has never processed one real Instagram message
end-to-end.**
