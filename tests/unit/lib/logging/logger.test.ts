import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { logOperation } from "@/lib/logging/logger";

describe("logOperation (spec §52)", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-17T12:00:00Z"));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("writes a success operation to console.log as structured JSON", () => {
    logOperation({
      userId: "user-1",
      conversationId: "conv-1",
      operation: "ai.generate_response",
      status: "success",
      durationMs: 123,
    });

    expect(console.error).not.toHaveBeenCalled();
    expect(console.log).toHaveBeenCalledTimes(1);

    const logged = JSON.parse((console.log as ReturnType<typeof vi.fn>).mock.calls[0][0]);
    expect(logged).toEqual({
      timestamp: "2026-09-17T12:00:00.000Z",
      userId: "user-1",
      conversationId: "conv-1",
      operation: "ai.generate_response",
      status: "success",
      durationMs: 123,
    });
  });

  it("writes a failure operation to console.error, not console.log", () => {
    logOperation({
      operation: "instagram.send_message",
      status: "failure",
      errorCode: "RATE_LIMIT_ERROR",
    });

    expect(console.log).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledTimes(1);

    const logged = JSON.parse(
      (console.error as ReturnType<typeof vi.fn>).mock.calls[0][0],
    );
    expect(logged.errorCode).toBe("RATE_LIMIT_ERROR");
  });

  it("only ever contains the fixed, enumerated field set — no catch-all metadata field exists on the type", () => {
    logOperation({ operation: "webhook.process_message", status: "success" });

    const logged = JSON.parse((console.log as ReturnType<typeof vi.fn>).mock.calls[0][0]);
    const allowedKeys = new Set([
      "timestamp",
      "requestId",
      "userId",
      "instagramAccountId",
      "conversationId",
      "messageId",
      "operation",
      "status",
      "durationMs",
      "errorCode",
    ]);
    for (const key of Object.keys(logged)) {
      expect(allowedKeys.has(key)).toBe(true);
    }
  });
});
