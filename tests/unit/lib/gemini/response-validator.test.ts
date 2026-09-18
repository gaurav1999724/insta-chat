import { describe, expect, it } from "vitest";

import { validateAIResponse } from "@/lib/gemini/response-validator";

describe("validateAIResponse", () => {
  it("accepts a normal Hinglish reply", () => {
    expect(validateAIResponse("Haan yaar, kal milte hain! 😄", "HINGLISH")).toEqual({
      valid: true,
    });
  });

  it("rejects an empty response", () => {
    const result = validateAIResponse("   ", "HINGLISH");
    expect(result).toEqual({ valid: false, reason: "empty", detail: expect.any(String) });
  });

  it("rejects a response over the length cap", () => {
    const result = validateAIResponse("a".repeat(2001), "HINGLISH");
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toBe("too_long");
  });

  it("rejects a response that leaks an internal prompt marker", () => {
    const result = validateAIResponse(
      "Following BASE_SYSTEM_PROMPT, here is my reply",
      "HINGLISH",
    );
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toBe("system_prompt_leak");
  });

  it("rejects a response containing something shaped like a Google API key", () => {
    const result = validateAIResponse(`Here: AIzaSyD${"a".repeat(30)}12`, "HINGLISH");
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toBe("looks_like_secret");
  });

  it("rejects raw JSON output", () => {
    const result = validateAIResponse('{"text": "hi"}', "HINGLISH");
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toBe("structured_output");
  });

  it("rejects control characters", () => {
    const result = validateAIResponse("hello\x01world", "HINGLISH");
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toBe("malformed_content");
  });

  it("rejects unexpected Devanagari script when language isn't HINDI", () => {
    const result = validateAIResponse("यह एक परीक्षण है", "HINGLISH");
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toBe("unexpected_script");
  });

  it("allows Devanagari script when the conversation language is HINDI", () => {
    expect(validateAIResponse("यह एक परीक्षण है", "HINDI")).toEqual({ valid: true });
  });
});
