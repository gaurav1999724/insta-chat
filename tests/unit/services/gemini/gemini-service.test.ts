import { beforeEach, describe, expect, it, vi } from "vitest";

const { generateContentMock, GoogleGenAIMock } = vi.hoisted(() => {
  const generateContentMock = vi.fn();
  const GoogleGenAIMock = vi.fn().mockImplementation(() => ({
    models: { generateContent: generateContentMock },
  }));
  return { generateContentMock, GoogleGenAIMock };
});
vi.mock("@google/genai", () => ({
  GoogleGenAI: GoogleGenAIMock,
  FinishReason: { STOP: "STOP", MAX_TOKENS: "MAX_TOKENS", SAFETY: "SAFETY" },
  Type: { OBJECT: "OBJECT", ARRAY: "ARRAY", STRING: "STRING", NUMBER: "NUMBER" },
}));

const { envMock } = vi.hoisted(() => ({
  envMock: { GEMINI_API_KEY: "test-gemini-api-key", GEMINI_MODEL: "gemini-3.8-flash" },
}));
vi.mock("@/lib/validation/env", () => ({ env: envMock }));

const { prismaMock } = vi.hoisted(() => ({
  prismaMock: {
    message: { findMany: vi.fn() },
    conversationSummary: { create: vi.fn() },
  },
}));
vi.mock("@/lib/db/prisma", () => ({ prisma: prismaMock }));

const { getAIGenerationContext } = vi.hoisted(() => ({
  getAIGenerationContext: vi.fn(),
}));
vi.mock("@/lib/conversations/get-ai-context", () => ({ getAIGenerationContext }));

const { GeminiApiError } = await import("@/lib/gemini/errors");
const { generateResponse, extractMemory, analyzeCommunicationStyle } =
  await import("@/services/gemini/gemini-service");

const baseContext = {
  chatMode: null,
  language: "HINGLISH" as const,
  responseLength: "NORMAL" as const,
  emojiLevel: "MEDIUM" as const,
  customInstructions: null,
  contactProfile: {
    preferredName: null,
    relationshipLabel: null,
    username: "someuser",
    displayName: null,
  },
  memories: [],
  conversationSummary: null,
  recentMessages: [{ senderType: "CONTACT", direction: "INBOUND", text: "Hey!" }],
  model: "gemini-3.8-flash",
  temperature: 0.9,
  maxContextMessages: 20,
  totalMessageCount: 1,
  latestSummary: null,
};

describe("generateResponse", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    envMock.GEMINI_API_KEY = "test-gemini-api-key";
    getAIGenerationContext.mockResolvedValue(baseContext);
  });

  it("returns a validated reply with token usage and a confidence score", async () => {
    generateContentMock.mockResolvedValue({
      text: "Haan bilkul, kal milte hain!",
      candidates: [{ avgLogprobs: -0.1, finishReason: "STOP" }],
      usageMetadata: {
        promptTokenCount: 120,
        candidatesTokenCount: 15,
        totalTokenCount: 135,
      },
    });

    const result = await generateResponse("conversation-1");

    expect(result.text).toBe("Haan bilkul, kal milte hain!");
    expect(result.model).toBe("gemini-3.8-flash");
    expect(result.promptTokens).toBe(120);
    expect(result.completionTokens).toBe(15);
    expect(result.totalTokens).toBe(135);
    expect(result.confidence).toBeCloseTo(Math.exp(-0.1), 5);
  });

  it("lowers confidence when the finish reason isn't STOP and no logprobs are given", async () => {
    generateContentMock.mockResolvedValue({
      text: "cut off respo",
      candidates: [{ finishReason: "MAX_TOKENS" }],
      usageMetadata: {},
    });

    const result = await generateResponse("conversation-1");
    expect(result.confidence).toBe(0.4);
  });

  it("throws when there's no conversation history to respond to", async () => {
    getAIGenerationContext.mockResolvedValue({ ...baseContext, recentMessages: [] });

    await expect(generateResponse("conversation-1")).rejects.toThrow(
      "No conversation history to respond to.",
    );
    expect(generateContentMock).not.toHaveBeenCalled();
  });

  it("throws when Gemini returns an empty response", async () => {
    generateContentMock.mockResolvedValue({ text: "   " });

    await expect(generateResponse("conversation-1")).rejects.toThrow(
      "Gemini returned an empty response.",
    );
  });

  it("throws when the response fails spec §47 validation (e.g. leaks a system-prompt marker)", async () => {
    generateContentMock.mockResolvedValue({
      text: "Per BASE_SYSTEM_PROMPT, here you go",
    });

    await expect(generateResponse("conversation-1")).rejects.toThrow(/failed validation/);
  });

  it("throws GeminiApiError when GEMINI_API_KEY isn't configured", async () => {
    envMock.GEMINI_API_KEY = "";

    await expect(generateResponse("conversation-1")).rejects.toThrow(GeminiApiError);
    expect(generateContentMock).not.toHaveBeenCalled();
  });

  it("wraps a raw SDK failure in a GeminiApiError instead of leaking it", async () => {
    generateContentMock.mockRejectedValue(new Error("503 Service Unavailable"));

    await expect(generateResponse("conversation-1")).rejects.toThrow(GeminiApiError);
  });
});

describe("extractMemory (spec §19)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    envMock.GEMINI_API_KEY = "test-gemini-api-key";
  });

  it("returns an empty array when there's no conversation history yet", async () => {
    prismaMock.message.findMany.mockResolvedValue([]);

    const facts = await extractMemory("conversation-1");
    expect(facts).toEqual([]);
    expect(generateContentMock).not.toHaveBeenCalled();
  });

  it("parses and returns Zod-validated structured facts", async () => {
    prismaMock.message.findMany.mockResolvedValue([
      { direction: "INBOUND", text: "I love biryani" },
    ]);
    generateContentMock.mockResolvedValue({
      text: JSON.stringify({
        facts: [
          {
            category: "preference",
            key: "favorite_food",
            value: "biryani",
            confidence: 0.9,
          },
        ],
      }),
    });

    const facts = await extractMemory("conversation-1");
    expect(facts).toEqual([
      { category: "preference", key: "favorite_food", value: "biryani", confidence: 0.9 },
    ]);
  });

  it("throws when Gemini's JSON output doesn't match the expected schema", async () => {
    prismaMock.message.findMany.mockResolvedValue([
      { direction: "INBOUND", text: "hello" },
    ]);
    generateContentMock.mockResolvedValue({ text: JSON.stringify({ nope: true }) });

    await expect(extractMemory("conversation-1")).rejects.toThrow(
      /didn't match the expected shape/,
    );
  });

  it("throws when Gemini's output isn't valid JSON at all", async () => {
    prismaMock.message.findMany.mockResolvedValue([
      { direction: "INBOUND", text: "hello" },
    ]);
    generateContentMock.mockResolvedValue({ text: "not json" });

    await expect(extractMemory("conversation-1")).rejects.toThrow(/malformed JSON/);
  });
});

describe("analyzeCommunicationStyle (spec §21)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    envMock.GEMINI_API_KEY = "test-gemini-api-key";
  });

  it("only ever queries the Contact's inbound messages, never outbound ones", async () => {
    prismaMock.message.findMany.mockResolvedValue([{ text: "hey there" }]);
    generateContentMock.mockResolvedValue({
      text: JSON.stringify({
        averageMessageLength: "short",
        emojiUsage: "low",
        languageMix: "mostly English",
        punctuationStyle: "minimal",
        formality: "informal",
        commonExpressions: ["lol"],
      }),
    });

    await analyzeCommunicationStyle("conversation-1");

    expect(prismaMock.message.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ direction: "INBOUND" }),
      }),
    );
  });

  it("throws when there are no inbound messages from the contact yet", async () => {
    prismaMock.message.findMany.mockResolvedValue([]);

    await expect(analyzeCommunicationStyle("conversation-1")).rejects.toThrow(
      "No messages from this contact yet to analyze.",
    );
  });
});
