// spec §31: "estimated cost if pricing information is available/configured."
// Verified against ai.google.dev/gemini-api/docs/pricing on 2026-09-17 —
// only the model this app actually defaults to is priced here; an
// unrecognized model (a user pointed `AIConfiguration.model` at something
// else) returns `null` rather than guessing at a cost. Re-verify before
// assuming these numbers are still current — Gemini pricing changes with
// each model generation, and this specific rate is only guaranteed through
// 2026-12-31 (it steps up 2027-01-01).
type ModelPricing = { inputPerMillionUsd: number; outputPerMillionUsd: number };

const PRICING: Record<string, ModelPricing> = {
  "gemini-3.8-flash": { inputPerMillionUsd: 0.75, outputPerMillionUsd: 3.75 },
  // env.ts's actual default (2026-09-18): a pinned version name
  // (gemini-3.8-flash) can be retired without warning — this project's
  // original default, gemini-2.0-flash, already 404s — so GEMINI_MODEL
  // now defaults to this alias instead. It currently resolves to the same
  // Flash pricing tier as gemini-3.8-flash above; re-verify this stays
  // true if Google repoints the alias to a different generation.
  "gemini-flash-latest": { inputPerMillionUsd: 0.75, outputPerMillionUsd: 3.75 },
};

export function estimateCostUsd(
  model: string,
  inputTokens: number,
  outputTokens: number,
): number | null {
  const pricing = PRICING[model];
  if (!pricing) return null;

  return (
    (inputTokens / 1_000_000) * pricing.inputPerMillionUsd +
    (outputTokens / 1_000_000) * pricing.outputPerMillionUsd
  );
}
