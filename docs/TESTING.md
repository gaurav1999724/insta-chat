# Testing

Status: **Phase 13 implemented.** Verified against the installed package
versions' own `engines` fields (spec §92-style diligence applied to
tooling, not just external APIs) on **2026-09-17**.

## Running the tests

```bash
npm run test          # Vitest: unit + integration, single run
npm run test:watch    # Vitest: watch mode
npm run test:e2e      # Playwright: E2E (needs a running app — see below)
```

## Package versions and why they're pinned

Same Node 18.20.8 constraint that pins Next.js/Tailwind/`@google/genai`/
`ioredis` throughout this project (see `PROJECT_ANALYSIS.md` §10) applies
to the testing stack too — each package's real npm `latest` needs a newer
Node, so an older, still-current major/minor was chosen deliberately:

| Package                       | Installed                        | Real `latest`             | Why this version                                                                                                                                                                      |
| ----------------------------- | -------------------------------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `vitest`                      | `^3.2.7`                         | `5.0.1` (needs Node ≥22)  | Newest 3.x; every 3.x version checked supports `^18.0.0`, so a caret range is safe here.                                                                                              |
| `jsdom`                       | `26.1.0` (exact)                 | `30.1.0` (needs Node ≥22) | 26.x supports Node ≥18; the very next major (27.4.0) needs Node ≥20. Pinned exact rather than caret since the boundary is one major away.                                             |
| `@testing-library/react`      | `^16.3.3`                        | `16.3.3`                  | Already current; supports Node ≥18 throughout.                                                                                                                                        |
| `@testing-library/jest-dom`   | `6.9.1` (exact, **not** caret)   | `7.0.1` (needs Node ≥22)  | 6.9.x supports Node ≥14, but 6.10.0 — a **minor** bump — raised the requirement to Node ≥22. A caret range (`^6.9.1`) would have silently resolved to that incompatible minor.        |
| `@testing-library/user-event` | `^14.6.7`                        | `14.6.7`                  | Already current; supports Node ≥12.                                                                                                                                                   |
| `@playwright/test`            | `~1.61.0` (tilde, **not** caret) | `1.63.0` (needs Node ≥20) | 1.61.0 is the last `>=18`-compatible release; 1.62.0 — again a **minor** bump — raised the requirement to Node ≥20. Tilde (patch-only) avoids crossing that line the way caret would. |

**Lesson reinforced from every earlier phase's dependency pinning:** always
run `npm view <package>@<version> engines` before trusting a semver range —
a package's Node requirement can jump on a minor version, not just a major
one, as it did twice here.

## Vitest setup

`vitest.config.ts`:

- `environment: "jsdom"` — needed for the (currently none, but available)
  React Testing Library component tests; pure-logic/service tests don't
  need it but it's harmless overhead at this test count.
- `resolve.alias["@"]` → `src/` — matches `tsconfig.json`'s `paths`, since
  Vitest doesn't read `tsconfig.json` path mappings on its own.
- `esbuild: { jsx: "automatic" }` — overrides `tsconfig.json`'s
  `jsx: "preserve"` (which is for Next.js's own SWC/webpack compiler);
  Vitest transforms `.tsx` with esbuild directly and needs its own JSX
  setting or `.tsx` files fail to parse.
- `test.env` — dummy-but-schema-valid values for every variable
  `@/lib/validation/env` requires (`DATABASE_URL`, `NEXTAUTH_SECRET`,
  `NEXTAUTH_URL`, plus `SOCIALAPI_TOKEN`/`SOCIALAPI_WEBHOOK_SECRET` for
  the SocialAPI.AI/webhook tests), so importing `env` never throws in a
  test and no real secret is ever needed (spec §66/§67: "never use real
  credentials in automated tests").
- `test.include` covers `tests/unit/**` and `tests/integration/**`;
  `tests/e2e/**` is explicitly excluded — Playwright owns that directory.

`tests/setup.ts` just imports `@testing-library/jest-dom/vitest`, which
auto-extends Vitest's `expect` with the jest-dom matchers.

## What's covered

- **Pure logic, no mocking needed:** `validateAIResponse()`,
  `buildPrompt()`/`buildSystemInstruction()`/`buildConversationContents()`,
  `estimateCostUsd()`, `isWithinMessagingWindow()`,
  `isValidWebhookSignature()`/`getMessageEventId()`,
  `parseStatusFilter()`, `formatRetryAfter()`.
- **Mocked-dependency unit tests:** `createDraftReply()`,
  `sendManualMessage()`, `processMessagingItem()`, the `ai-response`
  worker's processor function, `generateResponse()`/`extractMemory()`/
  `analyzeCommunicationStyle()` (mocking `@google/genai`),
  `getConnectAuthUrl()`/`exchangeOAuthCode()`/`sendMessage()`/
  `listConnectedAccounts()` (mocking global `fetch`),
  `getConversationList()`, and the ownership/authorization
  checks in `src/app/conversations/actions.ts` (spec §66 "Authorization" —
  every action re-verifies `conversation.instagramAccount.userId ===
session.user.id`, and `setConversationChatMode()` re-verifies chat mode
  ownership the same way).
- **`checkRateLimit()`** is tested twice, deliberately: a fast, deterministic
  unit test against an in-memory fake Redis (`tests/unit/lib/security/rate-limit.test.ts`),
  plus a one-off spot-check against a real local Redis during Phase 12
  (documented in `PROJECT_ANALYSIS.md` §9d, not part of the committed
  suite — Redis isn't guaranteed reachable every session).
- **Integration (`tests/integration/webhook-to-send-pipeline.test.ts`,
  spec §67):** chains `processMessagingItem()` → `createDraftReply()` →
  `sendApprovedDraft()` — the three real, unmodified service functions —
  against a small hand-rolled in-memory Prisma fake (typed precisely, no
  `any`, per spec §91). No real Postgres exists in this dev environment
  (`PROJECT_ANALYSIS.md` §10), so this fake substitutes for one; it
  implements only the exact operations these three functions call, not a
  generic ORM. Proves the pipeline's data handoffs are correct and that a
  retried send after a transient failure reuses the same
  `Message`/`MessageDelivery` row (spec §29 idempotency) instead of
  duplicating it.
- **E2E (`tests/e2e/`, Playwright):**
  - `smoke.spec.ts` — 3 tests, real, run against a live `next dev` server:
    the landing page renders and its Sign In link works; the sign-in
    form renders; visiting `/dashboard` signed out redirects to
    `/sign-in`. None of these touch the database — `auth()`/
    `requireUser()` both return early when there's no session cookie.
  - `full-flow.spec.ts` — spec §68's full 12-step scenario (login →
    connect → open conversation → select mode → enable AI → receive
    message → generate reply → review → edit → send → disable AI →
    human takeover), written against real selectors from the actual
    components. `test.skip()`-gated behind an `E2E_FULL_FLOW` env var
    with a comment explaining exactly what's missing to run it (a seeded
    Postgres, a scripted login — there's no inbox to click a magic link
    from in CI — and `page.route()` interception of Meta's Graph API and
    Gemini's API hosts). Deliberately not deleted or silently skipped
    without explanation: it's real code, honestly marked as blocked on
    infrastructure this environment doesn't have.

## Not implemented this phase

- A coverage report/threshold (`@vitest/coverage-v8`) — not requested by
  the spec; the goal here was real assertions, not a coverage percentage.
- CI wiring (GitHub Actions or similar) — Phase 14 territory ("Docker,
  production configuration").
- Any test against a real Postgres, a real Meta app, or a real Gemini API
  key — still blocked on the same environment gaps tracked since Phase 2
  (`PROJECT_ANALYSIS.md` §10).

## Playwright and the bundled Redis: a real gotcha

Running `next dev` with `REDIS_URL` pointed at this environment's Redis
(Laragon's bundled `redis-server.exe`, version **3.2.100**) sends every
BullMQ worker into an infinite reconnect-error loop —
`Redis version needs to be greater or equal than 5.0.0`. Plain
`INCR`/`EXPIRE`/`TTL` (all `checkRateLimit()` uses) work fine against this
Redis; only BullMQ's own connection handshake refuses it. **Practical
effect: leave `REDIS_URL` unset when running `npm run dev` for E2E testing
in this environment** — rate limiting fails open exactly as designed, and
BullMQ simply doesn't start (same behavior as when the var is unset
entirely) rather than looping errors. This was discovered by actually
starting the dev server for the Playwright smoke tests, not assumed.

## A real finding from running the smoke tests

`getByRole("heading", { name: "Sign in to InstaMate AI" })` failed against
a real page load — not because the text was missing, but because
`CardTitle` (`src/components/ui/card.tsx`) renders a plain `<div>`, not a
semantic heading element, so it carries no ARIA `heading` role. The test
was fixed to use `getByText` instead (see `smoke.spec.ts`). This is a
pre-existing accessibility gap affecting every `CardTitle` in the app
(dashboard, settings, conversation panels) — **not fixed in this phase**,
since changing a shared UI primitive is out of scope for a testing phase
and would need checking every call site's surrounding heading hierarchy.
Tracked in `PROJECT_ANALYSIS.md` §10 for Phase 14.
