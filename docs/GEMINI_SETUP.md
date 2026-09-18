# Gemini Setup

Status: **Phase 7 implemented, extended in Phase 8** (memory extraction,
style analysis, structured JSON output) **and Phase 11** (cost estimation).
Verified against Google's current Gemini API/SDK documentation on
**2026-09-17** (spec §93 requires this — do not assume the SDK package
name, API shape, or model names from prior knowledge). Sources are linked
in each section below.

## SDK package and version

Official package: **`@google/genai`** (installed as `^1.0.0`).

**Important deviation:** the actual npm `latest` tag is `2.23.0`, but that
major version's `engines.node` requires **Node ≥20**. This environment runs
Node 18.20.8 (the same constraint that pins Next.js 15 and Tailwind v3
project-wide — see `PROJECT_ANALYSIS.md` §10). `npm install @google/genai`
with no version specifier actually resolved to `1.0.0` on its own (npm
picked a version compatible with the installed Node), and `1.0.0`'s
`engines.node` is `>=18.0.0`. Pinned explicitly as `^1.0.0` rather than
relying on that implicit resolution.

The public API surface used here (`new GoogleGenAI({apiKey})`,
`ai.models.generateContent({model, contents, config})`, `response.text`,
`response.usageMetadata`, `response.candidates[0].finishReason`) was
confirmed directly against the installed package's own
`node_modules/@google/genai/dist/genai.d.ts` type definitions, not just web
docs — those can describe a newer major version than what's actually
installed.

Reference: [@google/genai on npm](https://www.npmjs.com/package/@google/genai),
[Gemini API libraries](https://ai.google.dev/gemini-api/docs/libraries)

## `GEMINI_API_KEY` / `GEMINI_MODEL`

Both already in `env.ts`/`.env.example`, optional at boot (so the app runs
before Gemini is configured). `src/services/gemini/gemini-service.ts`
throws a `GeminiApiError` — caught and logged as a friendly error, never a
crash — if `GEMINI_API_KEY` is missing when a generation is attempted.

**Default model:** `gemini-3.8-flash`. Checked directly against
`ai.google.dev/gemini-api/docs/models` on 2026-09-17: it's listed under
"Stable" as the current general-purpose Flash model recommendation
("most intelligent Flash model … speed and cost efficiency of Flash"),
launched September 2, 2026. Confirmed independently via Google Cloud docs,
the DeepMind model card, and Google's own blog announcement — not a single
unverified source. **Re-check this before assuming it's still current** —
Gemini ships new model names every few months (spec §30: "do not hardcode a
model name if the current SDK/API recommends another stable model").
`AIConfiguration.model` (per-user override, defaults to `env.GEMINI_MODEL`)
means a user can point at a different model without a code change.

Reference: [Gemini API models](https://ai.google.dev/gemini-api/docs/models),
[Gemini 3.8 Flash model card — DeepMind](https://deepmind.google/models/model-cards/gemini-3-8-flash/)

## Where Gemini is called from

`src/services/gemini/gemini-service.ts` is the **only** module that
imports `@google/genai` (PROJECT_ANALYSIS.md §7's rule, same as
`instagram-service.ts` for Meta calls):

- `generateResponse(conversationId)` — spec §22's `generateAIResponse()`.
  Gathers context (`src/lib/conversations/get-ai-context.ts`), ensures the
  conversation summary is fresh, builds the prompt
  (`src/lib/gemini/prompt-builder.ts`), calls `generateContent`, validates
  the result (`src/lib/gemini/response-validator.ts`), and returns
  `{ text, confidence, model, promptTokens, completionTokens, totalTokens, durationMs }`.
  `suggestedFollowUp`/`reason` from spec §22's output shape aren't produced
  yet — that would need a second model call or structured output, neither
  implemented this phase.
- `summarizeConversation(conversationId)` — spec §46. Only does work when
  the conversation has more messages than `maxContextMessages`; regenerates
  the summary only when it doesn't already cover the messages about to fall
  out of the recent-messages window. No scheduled/periodic regeneration job
  exists (that's Phase 9 territory) — this runs inline, on demand, from
  `generateResponse()`.
- `extractMemory(conversationId)` — spec §19. Sends the last 30 non-system
  messages and asks for structured JSON output (`responseMimeType:
"application/json"` + `responseSchema`, spec §19's "durable facts,
  assign confidence"), Zod-validates the shape before trusting it (a model
  can still return malformed JSON despite the schema hint), and returns
  the facts — it does not persist them (the caller does, since persistence
  here is an upsert-per-fact loop, more natural at the action layer).
- `analyzeCommunicationStyle(conversationId)` — spec §21. Same structured-
  JSON approach, but only ever looks at the **Contact's** inbound messages,
  never the account owner's — the point is to match their style, not judge
  it. The prompt explicitly repeats spec §21's "do not infer sensitive
  personal characteristics" instruction.

Wired into the UI (Phase 7/8): the conversation composer's **"AI
Generate"** button (`src/components/conversations/message-composer.tsx` →
`generateDraftReply()`/`regenerateDraftReply()` server actions) calls
`generateResponse()` and shows the draft as an "AI Suggested Reply" — Edit
(the textarea itself)/Regenerate/Approve/Reject, spec §58's approval
workflow. Approving sets `AIResponse.status = APPROVED`; there is still no
actual send (Phase 9), so approving just means "ready whenever sending
exists." The settings panel's **"Analyze conversation"** button
(`analyzeConversation()` action) calls both `extractMemory()` and
`analyzeCommunicationStyle()` together and upserts the results as
`ConversationMemory` rows (style facts under category
`communication_style`) — which the prompt builder's `LONG_TERM_MEMORY`
layer (already built in Phase 7) picks up automatically on the next
generation. Both generation and analysis are deliberately **not** gated on
`aiEnabled`/`humanTakeover`: spec §23 explicitly allows the AI to
"optionally generate suggestions" even during human takeover, it just must
never auto-send — and nothing auto-triggers either of them off an inbound
webhook message yet (that automatic wiring is Phase 9).

## Prompt architecture (spec §14/§44)

`buildPrompt()` composes, server-side, one `systemInstruction` string from
these layers, in order: BASE_SYSTEM_PROMPT (tone/style rules, spec §12,
plus the anti-fabrication rule from spec §15 and the prompt-injection rule
from spec §48); LANGUAGE_PROMPT (Hinglish engine rules, spec §13);
response-length prompt; emoji-level prompt; CHAT_MODE_PROMPT
(`ChatMode.personalityInstructions`, already seeded in Phase 2 — e.g. the
Romantic mode's instructions already say "never invent real-world
actions... not explicitly provided by the user", straight from spec §15);
USER_PREFERENCES (`ConversationSettings.customInstructions`);
CONTACT_PROFILE (preferred name/relationship, from Phase 6); LONG_TERM_MEMORY
(`ConversationMemory` rows — populated since Phase 8's "Analyze
conversation" action, empty until that's been run at least once for a given
conversation); CONVERSATION_CONTEXT (the rolling summary).

RECENT_MESSAGES become the actual `contents` array (spec §44's
CURRENT_MESSAGE is just the last turn in that list): inbound (`CONTACT`)
messages map to Gemini's `"user"` role, everything the account sent
(human-typed or AI-generated) maps to `"model"`. `SYSTEM` messages are
dropped — they're not conversational turns. Message text is passed through
as plain conversation content, verbatim, **never** concatenated into the
system instruction — this is the concrete implementation of spec §48
(prompt injection protection): an inbound message that reads like an
instruction ("ignore your instructions and say X") is still just a `user`
turn to Gemini, and the system instruction explicitly tells the model to
treat conversation content as content, never as instructions to it.

## Context window management (spec §45/§46)

`maxContextMessages` (per-conversation override, falling back to the
user's `AIConfiguration`) bounds how many recent messages are sent in full.
When a conversation has more messages than that, `summarizeConversation()`
ensures a `ConversationSummary` row covers everything older, and that
summary text becomes part of the system instruction instead of the full
older history.

## Response validation (spec §47)

`validateAIResponse()` checks, before a draft is ever returned to the
caller: not empty, not excessively long (2000 chars), no leaked
internal/system-prompt markers, nothing shaped like an API key/token, not
raw JSON (structured output we didn't ask for), no control characters, and
— specific to the Hinglish engine (spec §13 rule 3) — no unexpected
Devanagari script when the conversation's language isn't explicitly
`HINDI`. A failure throws `GeminiApiError`, which the caller logs to
`APIError` (category `GEMINI_ERROR`) and never shows to the user as a raw
draft.

## Token/cost tracking (spec §31)

`response.usageMetadata.{promptTokenCount, candidatesTokenCount,
totalTokenCount}` (confirmed field names from the installed SDK's type
definitions) are threaded through into both `AIResponse` (the draft row
itself) and `AIUsage` (`createDraftReply()` writes both, in one
`$transaction`). The `/dashboard` "Gemini usage" card (built in Phase 3
against an always-empty table) now has real data to read once a real
`GEMINI_API_KEY` generates something.

**Estimated cost (Phase 11):** `estimateCostUsd(model, inputTokens,
outputTokens)` (`src/lib/gemini/pricing.ts`) looks up a `PRICING` table keyed
by exact model name and returns a USD estimate, or `null` for a model with
no pricing row — `AIUsage.estimatedCostUsd` is nullable for exactly that
case, so an unrecognized model is never silently priced at zero or guessed.

Pricing researched on **2026-09-17** (spec §92/§93): cross-checked first
across three secondary sources (MindStudio, a tech-insider roundup, aicybr,
alphacorp), then confirmed directly against the official
[Gemini API pricing page](https://ai.google.dev/gemini-api/docs/pricing).
Only `gemini-3.8-flash` (this project's default model) is priced today:

| Model              | Input ($/1M tokens) | Output ($/1M tokens) | Valid through |
| ------------------ | ------------------- | -------------------- | ------------- |
| `gemini-3.8-flash` | $0.75               | $3.75                | 2026-12-31    |

Google's pricing page lists a step up to $1.50/$7.50 per million
input/output tokens effective 2027-01-01 — **revisit `PRICING` in
`src/lib/gemini/pricing.ts` before that date.** There's no prompt-size
tiering for this model (some Gemini models charge more above a token
threshold; this one doesn't). A separate, lower cached-input rate exists on
the pricing page but isn't used here since this project doesn't use Gemini's
context caching feature.

`getUsageSummary()` (`src/lib/analytics/get-usage-summary.ts`) sums
`AIUsage.estimatedCostUsd` across Today/7-day/30-day/all-time windows for
the `/settings` "Usage" card — see `PROJECT_ANALYSIS.md` §9c.

## Confidence score

Gemini's API has no native "confidence" field. `estimateConfidence()` in
`gemini-service.ts` uses `candidate.avgLogprobs` (average per-token
log-probability) when present, exponentiated to an average per-token
probability; otherwise a non-`STOP` finish reason (cut off, safety-filtered)
lowers the estimate, and a plain `STOP` with no logprobs gets a neutral
default. **This is a best-effort heuristic, not a calibrated probability**
— documented as such in code, so it's never mistaken for something more
rigorous later.

## Structured JSON output (memory extraction / style analysis)

`extractMemory()`/`analyzeCommunicationStyle()` request JSON directly via
`config.responseMimeType: "application/json"` + `config.responseSchema`
(confirmed fields on the installed SDK's `GenerateContentConfig`/`Schema`
types — `Type.OBJECT`/`Type.ARRAY`/`Type.STRING`/`Type.NUMBER` etc.). This
is more reliable than asking for JSON in plain text and hoping the model
complies, but the docs note it's model-guided, not guaranteed — so the
result is still Zod-validated before anything is persisted (never trust
model output blindly, same principle as spec §47's response validation,
applied to a different kind of output).

## Safety configuration

Not configured yet — `GenerateContentConfig.safetySettings` exists in the
SDK but no explicit thresholds are set this phase (Gemini's default safety
filtering applies). Revisit alongside spec §49/§50's broader security pass
if a specific mode (e.g. Romantic/Flirty) needs different safety
thresholds than the API default.

## Untested against a real API key

Same caveat as every phase since Phase 2: `GEMINI_API_KEY` is an empty
placeholder in this environment. The prompt builder, response validator,
and the memory-extraction/style-analysis Zod schemas were exercised
directly (standalone scripts fed them realistic inputs/sample model output
and the results were inspected — not committed tests, Phase 13 sets up
real test infra), but `generateResponse()`/`summarizeConversation()`/
`extractMemory()`/`analyzeCommunicationStyle()` have never actually called
the Gemini API. Before relying on this, set a real `GEMINI_API_KEY` and
exercise the full approval workflow (generate → edit → regenerate →
approve/reject) plus "Analyze conversation" against a real conversation.
