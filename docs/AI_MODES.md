# AI Modes

Status: **Phase 7 implemented** — the layered prompt architecture and the
Hinglish engine rules are live in `src/lib/gemini/prompt-builder.ts`; see
`docs/GEMINI_SETUP.md` for the full breakdown and sources. This doc covers
the chat-mode-specific pieces.

## Layered prompt architecture (spec §14)

See `docs/GEMINI_SETUP.md` "Prompt architecture" — not duplicated here to
avoid two documents drifting out of sync (same reasoning as
`ARCHITECTURE.md`/`DATABASE.md` pointing at `PROJECT_ANALYSIS.md`).

## Hinglish engine (spec §13)

Implemented as the `LANGUAGE_PROMPT` layer (`buildLanguagePrompt()` in
`prompt-builder.ts`) — all 11 rules from spec §13 map directly onto
instruction sentences in that function: Roman-script Hindi, mixing in
English naturally, never switching to Devanagari, not translating every
English word, matching the other person's language mix, avoiding overly
formal Hindi. The "no Devanagari" rule is also **enforced**, not just
requested: `response-validator.ts` rejects a draft that contains Devanagari
script when the conversation's language isn't explicitly `HINDI` (see
`docs/GEMINI_SETUP.md` "Response validation").

## Built-in chat modes

All 10 seeded in Phase 2 (`prisma/seed.ts`) as `ChatMode` rows with
`isBuiltIn: true`, `userId: null` — shared by every user. Each row's
`personalityInstructions` becomes the `CHAT_MODE_PROMPT` layer verbatim:

| Mode         | Personality instructions (as seeded)                                                                                                                                                        |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Casual       | Talk like a normal person chatting casually. Keep replies short, natural Hinglish, no formality.                                                                                            |
| Friendly     | Talk like a warm, friendly Indian friend. Be encouraging and easygoing, natural Hinglish, light humor when it fits.                                                                         |
| Romantic     | Be affectionate, playful, caring and emotionally warm, like a loving partner. Never invent real-world actions, meetings, locations or events that were not explicitly provided by the user. |
| Flirty       | Be playful and lightly flirty: teasing, compliments, natural Hinglish banter. Respect boundaries, never become explicit automatically, and always follow the conversation's actual context. |
| Study        | Prioritize clarity and helpfulness. Explain concepts simply and concisely in natural Hinglish, like a patient study partner.                                                                |
| Business     | Be professional, concise, polite and clear. No romantic or casual slang. Use structure when it helps.                                                                                       |
| Professional | Maintain a formal, precise, respectful tone suited for professional contacts. Avoid slang and emojis.                                                                                       |
| Funny        | Be witty and playful, with natural jokes and light banter in Hinglish. Keep it fun without forcing humor into every line.                                                                   |
| Supportive   | Be empathetic, encouraging and supportive. Listen first, validate feelings, and offer gentle encouragement in natural Hinglish.                                                             |
| Custom       | Follow the user's custom instructions for this conversation exactly, while staying within the natural Hinglish conversational style.                                                        |

Romantic and Flirty specifically encode spec §15/§16's guardrails (no
fabricated real-world actions; playful but boundaried) directly in the
seeded instructions, so the prompt builder doesn't need mode-specific
branching logic — it just includes `personalityInstructions` as-is for
whichever mode is selected.

## Custom mode (spec §43)

Schema support already existed from Phase 2: a `ChatMode` row with
`userId` set (not `null`) and `isBuiltIn: false` is one user's custom mode,
built from the same fields spec §43 lists (name, description, personality
instructions, language, response length, emoji style — `examples`/
`restrictions` are `Json?`/`String?` columns, not yet surfaced in any UI).
**No UI to create/edit a custom mode exists yet** — that's the `/settings`
"Chat Modes" section, still a placeholder (`PROJECT_ANALYSIS.md` §4a's
Phase 3 note, unchanged since). The AI settings page and the
per-conversation chat-mode selector (Phase 6) already list any custom modes
that exist, they just can't be created from the UI yet — only by writing a
row directly (e.g. via `prisma studio`).

## Mode selection

Per-conversation (`Conversation.chatModeId`, spec §77 chat mode switching)
via the settings panel built in Phase 6; falls back to
`AIConfiguration.defaultChatModeId` when unset (spec §32), and to a generic
"no mode selected" instruction when neither is set. No mode preview
(spec §78) exists yet — selecting a mode has no UI feedback beyond the
selector itself; generating a draft is the only way to see it in effect.
