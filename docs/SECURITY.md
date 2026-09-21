# Security

Status: living checklist. **Finalized as `SECURITY_REVIEW.md` (Phase 14,
spec §87)** — that document is the point-in-time final verdict; this one
remains the per-phase incremental history.

> **Update (2026-09-21):** Instagram integration switched from direct Meta
> Graph API access to SocialAPI.AI (a third-party aggregator using its own
> managed Meta OAuth app) — see `docs/INSTAGRAM_SETUP.md` for the full
> reasoning. This invalidates two items in the Phase 4 section below:
> - "Instagram access tokens encrypted at rest" no longer applies — there
>   is no per-account token to encrypt anymore. `ENCRYPTION_KEY` and
>   `src/lib/security/encryption.ts` were removed. The real Meta OAuth
>   token now lives entirely on SocialAPI.AI's infrastructure.
> - Webhook signature verification still holds, but the mechanism changed:
>   `X-SocialAPI-Signature-V2` (HMAC-SHA256 of `{timestamp}.{rawBody}`,
>   with replay protection from the bound timestamp) replaces Meta's
>   `X-Hub-Signature-256`, keyed by `SOCIALAPI_WEBHOOK_SECRET` instead of
>   `META_APP_SECRET`. Still verified before any parsing, still
>   timing-safe.
>
> New consideration this checklist didn't have before: Instagram access
> now depends on a third party's continued reliability — see
> `docs/INSTAGRAM_SETUP.md`'s "What kind of integration this is" section.

## Done (Phase 1)

- [x] Secrets (`NEXTAUTH_SECRET`, `ENCRYPTION_KEY`, future API keys) only
      read server-side via `src/lib/validation/env.ts`, never imported into
      client components.
- [x] Auth sessions are database-backed (Auth.js `session.strategy: "database"`),
      not client-readable JWTs holding sensitive claims.
- [x] Every authenticated page guards with `requireUser()`
      (`src/lib/auth/require-user.ts`), server-side.

## Done (Phase 4)

- [x] Instagram access tokens encrypted at rest (AES-256-GCM,
      `src/lib/security/encryption.ts`, keyed from `ENCRYPTION_KEY`) — never
      stored or returned in plaintext. Disconnecting overwrites the stored
      ciphertext with an encrypted empty string rather than leaving the old
      token recoverable.
- [x] OAuth CSRF protection: the connect route sets a random `state` in an
      `httpOnly` cookie; the callback route rejects the request unless the
      returned `state` matches.
- [x] Cross-user account takeover prevented: the callback route rejects
      connecting an Instagram account that's already linked to a
      _different_ InstaMate user (`instagramUserId` is globally unique).
- [x] Ownership check on disconnect: `disconnectInstagramAccount()` only
      operates on an `InstagramAccount` row owned by the calling user.
- [x] Instagram OAuth/API failures are logged server-side to `APIError`
      (with `ErrorCategory`) and surfaced to the user only as a short,
      generic `?instagram=error` banner — no stack traces or raw Meta API
      responses reach the client (spec §51).
- [x] `AuditLog` rows for `ACCOUNT_CONNECTED`/`ACCOUNT_DISCONNECTED` (spec
      §53).

## Done (Phase 5)

- [x] Webhook signature verification: every `POST /api/webhooks/instagram`
      request is HMAC-SHA256-verified against the raw body
      (`X-Hub-Signature-256`, keyed by `META_APP_SECRET`) before anything
      is parsed; unsigned/forged requests get a 403 and are never touched
      by the JSON parser (spec §38).
- [x] Webhook payload structure is Zod-validated
      (`instagramWebhookPayloadSchema`) — malformed bodies are logged and
      acknowledged, never processed.
- [x] Webhook idempotency: `WebhookEvent.externalEventId` unique
      constraint rejects a redelivered event before any side effect runs
      (spec §28).
- [x] Webhook account-ownership check: events for an `instagramUserId` we
      don't have an active `InstagramAccount` for are recorded as
      `IGNORED`, never processed against another tenant's data.

## Done (Phase 6)

- [x] Per-conversation ownership checks on every query: `/conversations`
      reads and every action in `src/app/conversations/actions.ts`
      re-verify `conversation.instagramAccount.userId === session.user.id`
      server-side; an unowned/nonexistent conversation id 404s rather than
      leaking a permission error.

## Done (Phase 7)

- [x] Prompt injection guarding (spec §48): inbound Instagram text is
      passed to Gemini only as plain conversation turns (`contents`), never
      concatenated into the system instruction; the system instruction
      itself also explicitly tells the model to treat conversation content
      as content, never as instructions to it (defense in depth).
- [x] AI response validation (spec §47) before a draft ever leaves
      `GeminiService`: non-empty, length-capped, no leaked system-prompt
      markers, nothing shaped like an API key/token, no unexpected
      structured output, no control characters, no unexpected Devanagari
      script.
- [x] Gemini failures logged server-side to `APIError` (category
      `GEMINI_ERROR`) with a friendly message returned to the client — no
      raw API errors or prompt content reach the browser on failure.

## Done (Phase 8)

- [x] Every new action (approve/reject/edit a draft, extract memory,
      analyze style, delete/clear memory, update per-conversation AI
      settings) re-verifies ownership server-side
      (`requireOwnedConversation`/`requireOwnedAIResponse` in
      `src/app/conversations/actions.ts`) before touching anything — same
      pattern as every action since Phase 6.
- [x] Memory/style extraction prompts explicitly repeat spec §19/§21's "do
      not infer sensitive personal characteristics" instruction, and only
      ever analyze the Contact's own messages for style — never the
      account owner's.
- [x] Structured JSON output from Gemini (memory facts, style analysis) is
      Zod-validated before being persisted or trusted — a `responseSchema`
      hint doesn't guarantee compliant output.

## Done (Phase 9)

- [x] Never bypasses Instagram's 24-hour messaging window (spec §41): this
      app never uses the `human_agent` message tag to send outside it,
      whether automated or human-approved — see `docs/INSTAGRAM_SETUP.md`
      §4a for why that tag specifically would be the kind of unofficial
      workaround spec §41 forbids.
- [x] Auto-send (spec §59) only fires when the conversation is still
      AI-enabled, human-takeover-free, and both the conversation and the
      Instagram account are active _at processing time_ (re-checked in the
      worker, not just at enqueue time — conditions can change in between).
- [x] Every send attempt — success or failure — is recorded in
      `MessageDelivery` before/regardless of outcome (spec §60); a retried
      job updates the same row (`attempts` incremented) instead of creating
      a duplicate outbound message.
- [x] Instagram send failures logged to `APIError` (category
      `INSTAGRAM_API_ERROR`) with a friendly message returned to the caller
      — no raw Meta error bodies reach the client.

## Done (Phase 10)

- [x] Manual message sending (`sendManualMessageAction()`) re-verifies
      conversation ownership before doing anything, same as every other
      action since Phase 6 — a conversation id alone is never enough.
- [x] Manual sends go through the identical 24-hour-window /
      account-connected checks as AI-approved sends
      (`assertSendEligible()`, shared by both) — a human typing directly
      gets no special exemption from Meta's platform constraints.
- [x] Manual send failures are tracked and logged exactly like AI-send
      failures (`MessageDelivery` row, `APIError`, `AuditLog`) — no
      separate, less-audited code path for human-authored messages.

## Done (Phase 11)

- [x] Structured logging (spec §52) uses a fixed, enumerated field set
      (`requestId`, `userId`, `instagramAccountId`, `conversationId`,
      `messageId`, `operation`, `status`, `durationMs`, `errorCode`) with
      **no catch-all metadata field** — it's structurally impossible to
      accidentally pass a secret (access token, API key) into a log line,
      unlike a free-form metadata bag would allow.
- [x] The new "Recent errors" `/settings` view (`getRecentErrors()`) is
      scoped by `APIError.userId` — a user can only ever see their own
      error rows, never another tenant's.
- [x] The new "Usage" `/settings` view (`getUsageSummary()`) is scoped
      through `instagramAccount: { userId }` (or `userId` directly for the
      error-count figure) — the same ownership boundary every other
      cross-conversation query in this app uses (spec §74).
- [x] A webhook-events/queue-status debug view was considered and
      deliberately **not** built: `WebhookEvent` has no `userId`/account
      foreign key by original schema design, so it can't be scoped to one
      user without either a schema change or an unscoped (and therefore
      cross-tenant-leaking) view. Excluded rather than shipped unscoped.

## Done (Phase 12)

- [x] Rate limiting (spec §50, Redis-backed): `checkRateLimit()`
      (`src/lib/security/rate-limit.ts`) — fixed-window `INCR`/`EXPIRE`
      counters, four buckets (`AI_GENERATION`, `MESSAGE_SEND`,
      `WEBHOOK_PROCESSING`, `INSTAGRAM_CONNECT`), each keyed by the
      appropriate scope (conversation / Instagram account / user) rather
      than a spoofable client IP. This also satisfies spec §59's "rate
      limits allow it" auto-send precondition — `AI_GENERATION` covers the
      `ai-response` worker since it calls the same `createDraftReply()`
      the manual button uses. Fails open (no limiting) when Redis isn't
      reachable — verified for real against a local Redis instance this
      phase, not just reasoned through (see `PROJECT_ANALYSIS.md` §9d).
- [x] A rate-limited request never leaks anything beyond a friendly
      message + `retryAfterSeconds`-derived wait time; every rejection is
      also logged to `APIError` (category `RATE_LIMIT_ERROR`) and to
      `logOperation()` for later analysis.
- [x] Audit logging full-coverage review against spec §53's exact list —
      AI enabled/disabled, mode changed, settings changed, human takeover
      (enabled/disabled), AI response generated, message sent/failed,
      account connected/disconnected, memory changed. **Result: every one
      already had an `AuditAction` value and a real write path from
      Phases 4/6/7/8/9 — nothing was missing.** This was a verification
      pass, not new work.
- [x] Encryption re-verified (`src/lib/security/encryption.ts`): AES-256-GCM,
      random IV per call, auth tag checked on decrypt, key derived from
      `ENCRYPTION_KEY` via SHA-256 — sound, no changes made.
- [x] Secure cookies / CSRF re-verified: Auth.js v5's session cookie already
      defaults to `httpOnly` + `__Secure-` prefix under HTTPS; the Phase 4
      OAuth `state` cookie was already `httpOnly`/conditionally
      `secure`/`sameSite: lax`; Next.js Server Actions already carry their
      own Origin-header CSRF check. No gaps found, no changes needed.

## Done (Phase 14)

- [x] Error-message leakage review (spec §87): traced `GeminiApiError`'s
      and `InstagramApiError`'s `details` fields (persisted to
      `APIError.metadata`) down into the actual SDK/API error shapes — no
      leakage path found (full trace in `SECURITY_REVIEW.md`). Confirmed
      no route/action ever forwards a raw exception or stack trace to the
      client.
- [x] Security response headers added (`next.config.ts`): previously
      missing entirely — `X-Content-Type-Options`, `X-Frame-Options`,
      `Referrer-Policy`, `Permissions-Policy` now set on every response.
      A `Content-Security-Policy` is deliberately deferred (needs a real
      Instagram CDN image URL to configure `img-src` correctly — see
      `SECURITY_REVIEW.md`).
- [x] Repo-wide sweep for `dangerouslySetInnerHTML`, raw SQL
      (`$queryRaw`/`$executeRaw`/`*Unsafe`), `eval`/`new Function`/
      `child_process`, and manual `.cookies.set()` calls — zero findings
      beyond the already-reviewed Instagram OAuth state cookie.
- [x] `.gitignore` correctness fix: a bare `.env*` pattern would have
      excluded `.env.example`/`.env.docker.example` (the templates,
      meant to be committed) — added explicit `!` exceptions.
- [x] `SECURITY_REVIEW.md` — the final, consolidated write-up (spec §87).

## Tracked, not security-blocking

- [ ] `Content-Security-Policy` — needs a real Instagram profile-picture
      CDN URL observed to set `img-src` correctly; see `SECURITY_REVIEW.md`.
- [ ] This entire project's security posture has been reviewed at the code
      level only — never exercised against a real Postgres, Meta app, or
      Gemini key (`PROJECT_ANALYSIS.md` §10/§11's standing risk).
