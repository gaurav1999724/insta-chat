import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { isWithinMessagingWindow } from "@/lib/instagram/send-eligibility";

describe("isWithinMessagingWindow (spec §41)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-17T12:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns false when there's no inbound message at all", () => {
    expect(isWithinMessagingWindow(null)).toBe(false);
  });

  it("returns true just inside the 24-hour window", () => {
    const lastInbound = new Date("2026-09-16T12:00:01Z");
    expect(isWithinMessagingWindow(lastInbound)).toBe(true);
  });

  it("returns true exactly at the 24-hour boundary", () => {
    const lastInbound = new Date("2026-09-16T12:00:00Z");
    expect(isWithinMessagingWindow(lastInbound)).toBe(true);
  });

  it("returns false just outside the 24-hour window", () => {
    const lastInbound = new Date("2026-09-16T11:59:59Z");
    expect(isWithinMessagingWindow(lastInbound)).toBe(false);
  });

  it("returns false for a message from days ago", () => {
    const lastInbound = new Date("2026-09-10T12:00:00Z");
    expect(isWithinMessagingWindow(lastInbound)).toBe(false);
  });
});
