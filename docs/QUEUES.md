# Queues

Status: **Phase 9 implemented** — automatic AI response generation,
Instagram sending, and memory extraction, all backed by BullMQ + Redis.

## Package versions

`bullmq` (`^6.3.6`) and `ioredis` (`^5.11.1`) — installed 2026-09-17.
`ioredis`'s actual npm `latest` is `6.0.0`, which requires Node ≥20; `npm
install` resolved `5.11.1` automatically (same Node-18-compatibility
resolution behavior seen with `@google/genai` in Phase 7 — see
`docs/GEMINI_SETUP.md`). `bullmq` itself supports Node ≥14.17.0, no
special pinning needed.

## Why only 3 of spec §29's 6 queues exist

Spec §29 names six queues: `instagram-webhook`, `ai-response`,
`instagram-send`, `memory-extraction`, `retry`, `analytics`. Only the
three with both a real producer and a real consumer are implemented
(`src/lib/queue/queues.ts`):

- **`instagram-webhook`** — not implemented. Phase 5's webhook handler
  already does its DB work synchronously and fast (no external API calls,
  just Postgres writes), and it's already idempotent
  (`WebhookEvent.externalEventId`). Decoupling it into a queue would mean
  acknowledging Meta's webhook _before_ processing succeeds, which trades
  a problem we don't have (slow processing) for one we'd have to solve
  carefully (acking before persistence). Revisit only if webhook volume
  ever makes synchronous processing too slow.
- **`retry`** — not implemented as a separate queue. Spec §29 also says
  "jobs must be idempotent... implement retry with exponential backoff",
  and BullMQ's own per-job `attempts`/`backoff` options
  (`DEFAULT_JOB_OPTIONS` in `queues.ts`) are the idiomatic way to do
  exactly that — a dedicated queue for retries would just be redundant
  machinery on top of a feature BullMQ already has.
- **`analytics`** — not implemented. There's no aggregation job to run
  yet; the analytics dashboard itself is Phase 11. Adding a queue with no
  consumer would be dead infrastructure.

## The three real queues

All defined in `src/lib/queue/queues.ts`, all `null` (no-op) when
`REDIS_URL` isn't configured — same "optional service, degrade
gracefully" pattern as Gemini/Meta throughout this project. Every
producer call site (`webhook-processor.ts`) already handles the `null`
case for exactly this reason.

### `ai-response`

**Producer:** `webhook-processor.ts`, right after an inbound (non-echo)
message is persisted, if `conversation.aiEnabled && !humanTakeover &&
conversation.status === "ACTIVE" && instagramAccount.status === "ACTIVE"`.

**Worker:** `src/lib/queue/workers/ai-response-worker.ts`. Re-checks the
same eligibility (conditions may have changed between enqueue and
processing — a changed condition is a no-op, not a failure), then calls
`createDraftReply()` (`src/services/ai/draft-service.ts` — the same
function the manual "AI Generate" button calls). If the resolved
`autoSend` setting (conversation override → `AIConfiguration` fallback) is
on **and** the conversation is still inside the 24-hour messaging window,
it marks the draft `APPROVED` and enqueues `instagram-send`. Otherwise the
draft just sits `PENDING_APPROVAL` for a human to review (Phase 8 UI).
This is spec §59's auto-send workflow: Generate → Validate (inside
`generateResponse()`) → Queue.

### `instagram-send`

**Producer:** the `ai-response` worker (auto-send path) and the manual
"Send" server action (`sendDraftReply()` in
`src/app/conversations/actions.ts`) — the manual path calls
`sendApprovedDraft()` directly rather than enqueuing, since a user
clicking Send wants to see the result immediately, not poll for a queued
job. The **shared logic is the same function either way**
(`src/services/ai/send-service.ts`), so behavior can't drift between the
two paths.

**Worker:** `src/lib/queue/workers/instagram-send-worker.ts`, thin —
calls `sendApprovedDraft()` and lets it throw on failure so BullMQ retries.

**Idempotency (spec §29):** `sendApprovedDraft()` upserts the outbound
`Message` row keyed on a synthetic placeholder
(`pending-send:{aiResponseId}`) _before_ attempting the network call, and
upserts (not creates) the paired `MessageDelivery` row, incrementing
`attempts` on each retry. Without this, a BullMQ retry after a transient
failure would create a second outbound `Message` row for the same logical
send — this was caught and fixed during this phase, not found later.

### `memory-extraction`

**Producer:** `webhook-processor.ts`, every `MEMORY_EXTRACTION_INTERVAL`
(10) non-system messages in a conversation — spec §19's "after a
configurable number of messages."

**Worker:** `src/lib/queue/workers/memory-extraction-worker.ts`, calls
`runConversationAnalysis()` (`src/services/ai/memory-service.ts` — the
same function the manual "Analyze conversation" button calls).

## How workers start

Next.js has no persistent background-process model inside a request
handler, so the three workers are started once from
`src/instrumentation.ts` → `register()` — Next's own documented hook for
one-time server startup code, and the sanctioned place to start
long-running things like a queue worker (guarded to the Node.js runtime
only; BullMQ needs `net`/`tls`, which the edge runtime doesn't have).
`src/lib/queue/start-workers.ts` guards against being called twice in the
same process. If `REDIS_URL` isn't set, it logs once and returns — no
workers, no crash, and every manual button (Generate/Analyze/Send) still
works exactly as it did in Phase 7/8.

## Untested against real infrastructure

`REDIS_URL` is actually set in `.env` (`redis://localhost:6379`) — the
gap through Phase 11 was that nothing was listening on that port, not
that the variable was unset. **Corrected in Phase 12:** this environment
(Laragon) bundles a Redis binary
(`laragon/bin/redis/redis-x64-3.2.100/redis-server.exe`); started for real
and confirmed reachable — see `PROJECT_ANALYSIS.md` §9d/§10, where it was
used to verify the new rate limiter's `INCR`/`EXPIRE`/`TTL` calls against
a real Redis. **That still doesn't close this section's gap, though:**
none of the three workers here has processed a real job, because they
also need Prisma/Postgres to do anything once triggered, and Postgres
remains unreachable in this environment. The idempotency upsert logic was
reasoned through carefully (see above) but not exercised against a real
Redis + Postgres + retried job. Before relying on this: get Postgres
reachable too, connect a real Instagram account with `autoSend` on, and
confirm an inbound test DM produces a generated, auto-approved, and
actually-sent reply — then force a failure (e.g. temporarily break
`sendMessage()`) and confirm the retry doesn't create a duplicate outbound
message.

**Correction, Phase 13: that same bundled Redis (3.2.100) is actually
unusable by BullMQ specifically.** Starting `next dev` with `REDIS_URL`
pointed at it sent every worker here into an infinite reconnect-error
loop — `Redis version needs to be greater or equal than 5.0.0`. Plain
`INCR`/`EXPIRE`/`TTL` (what the Phase 12 rate limiter uses) work fine on
this Redis; BullMQ's own connection handshake requires a newer server.
Practical effect for local dev in this environment: leave `REDIS_URL`
unset (BullMQ then just doesn't start, same as always) rather than
pointed at this specific Redis instance — see `docs/TESTING.md`'s
"Playwright and the bundled Redis" section for how this was found (via a
real `next dev` + Playwright run) and `PROJECT_ANALYSIS.md` §10.
