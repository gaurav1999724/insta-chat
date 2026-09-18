import { describe, expect, it } from "vitest";

import { estimateCostUsd } from "@/lib/gemini/pricing";

describe("estimateCostUsd", () => {
  it("computes cost for a priced model from its per-million-token rates", () => {
    expect(estimateCostUsd("gemini-3.8-flash", 1_000_000, 1_000_000)).toBeCloseTo(4.5, 6);
  });

  it("returns 0 for zero tokens", () => {
    expect(estimateCostUsd("gemini-3.8-flash", 0, 0)).toBe(0);
  });

  it("scales linearly with token count", () => {
    const cost = estimateCostUsd("gemini-3.8-flash", 500_000, 0);
    expect(cost).toBeCloseTo(0.375, 6);
  });

  it("returns null for a model with no pricing row, rather than guessing", () => {
    expect(estimateCostUsd("some-future-model", 1000, 1000)).toBeNull();
  });

  it("prices gemini-flash-latest — env.ts's actual default", () => {
    expect(estimateCostUsd("gemini-flash-latest", 1_000_000, 1_000_000)).toBeCloseTo(
      4.5,
      6,
    );
  });
});
