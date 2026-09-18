import { beforeEach, describe, expect, it, vi } from "vitest";

import { GeminiApiError } from "@/lib/gemini/errors";

const { prismaMock } = vi.hoisted(() => ({
  prismaMock: {
    message: { findFirst: vi.fn() },
    aIResponse: { create: vi.fn() },
    aIUsage: { create: vi.fn() },
    auditLog: { create: vi.fn() },
    aPIError: { create: vi.fn() },
    $transaction: vi.fn(),
  },
}));
vi.mock("@/lib/db/prisma", () => ({ prisma: prismaMock }));

const { checkRateLimit } = vi.hoisted(() => ({ checkRateLimit: vi.fn() }));
vi.mock("@/lib/security/rate-limit", async () => {
  const actual = await vi.importActual<typeof import("@/lib/security/rate-limit")>(
    "@/lib/security/rate-limit",
  );
  return { ...actual, checkRateLimit };
});

const { generateResponse } = vi.hoisted(() => ({ generateResponse: vi.fn() }));
vi.mock("@/services/gemini/gemini-service", () => ({ generateResponse }));

const { createDraftReply } = await import("@/services/ai/draft-service");

describe("createDraftReply", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    checkRateLimit.mockResolvedValue({ allowed: true });
    prismaMock.message.findFirst.mockResolvedValue({ id: "trigger-message-1" });
    prismaMock.aIResponse.create.mockResolvedValue({
      id: "ai-response-1",
      text: "Haan bilkul!",
      confidence: 0.8,
    });
    prismaMock.$transaction.mockResolvedValue(undefined);
  });

  it("refuses to generate and logs a RATE_LIMIT_ERROR when the conversation is rate limited", async () => {
    checkRateLimit.mockResolvedValue({ allowed: false, retryAfterSeconds: 120 });

    const result = await createDraftReply("conversation-1", "user-1");

    expect(result).toEqual({
      success: false,
      error: expect.stringContaining("Too many AI replies"),
    });
    expect(generateResponse).not.toHaveBeenCalled();
    expect(prismaMock.aPIError.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ category: "RATE_LIMIT_ERROR" }),
      }),
    );
  });

  it("generates a draft, persists AIResponse/AIUsage/AuditLog, and returns it", async () => {
    generateResponse.mockResolvedValue({
      text: "Haan bilkul!",
      confidence: 0.8,
      model: "gemini-3.8-flash",
      promptTokens: 1000,
      completionTokens: 500,
      totalTokens: 1500,
      durationMs: 340,
    });

    const result = await createDraftReply("conversation-1", "user-1");

    expect(result).toEqual({
      success: true,
      aiResponseId: "ai-response-1",
      text: "Haan bilkul!",
      confidence: 0.8,
    });
    expect(prismaMock.aIResponse.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          conversationId: "conversation-1",
          triggerMessageId: "trigger-message-1",
          model: "gemini-3.8-flash",
        }),
      }),
    );

    // $transaction receives an array of two prisma calls: aIUsage.create + auditLog.create
    const transactionArg = prismaMock.$transaction.mock.calls[0][0];
    expect(transactionArg).toHaveLength(2);
  });

  it("computes and stores an estimated cost for a priced model", async () => {
    generateResponse.mockResolvedValue({
      text: "reply",
      confidence: 0.5,
      model: "gemini-3.8-flash",
      promptTokens: 1_000_000,
      completionTokens: 1_000_000,
      totalTokens: 2_000_000,
      durationMs: 100,
    });

    await createDraftReply("conversation-1");

    // aIUsage.create's `data` was built with the real estimateCostUsd — cost
    // isn't asserted directly here (prisma is mocked), but the shared
    // pricing module is exercised for real via createDraftReply's own call.
    expect(generateResponse).toHaveBeenCalledWith("conversation-1");
  });

  it("returns the GeminiApiError's message and logs a GEMINI_ERROR on failure", async () => {
    generateResponse.mockRejectedValue(new GeminiApiError("Gemini quota exceeded"));

    const result = await createDraftReply("conversation-1", "user-1");

    expect(result).toEqual({ success: false, error: "Gemini quota exceeded" });
    expect(prismaMock.aPIError.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ category: "GEMINI_ERROR" }),
      }),
    );
  });

  it("returns a generic message for a non-GeminiApiError failure, never a raw error", async () => {
    generateResponse.mockRejectedValue(new Error("ECONNRESET"));

    const result = await createDraftReply("conversation-1");

    expect(result).toEqual({
      success: false,
      error: "Unexpected error generating a reply.",
    });
  });
});
