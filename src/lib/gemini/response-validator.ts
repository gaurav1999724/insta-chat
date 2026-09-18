import type { Language } from "@prisma/client";

// spec §47: checks run before an AI draft is ever shown to the user or
// sent anywhere. Any failure means "do not send, log the failure" — the
// caller is responsible for logging; this module only decides pass/fail.
export type ValidationFailureReason =
  | "empty"
  | "too_long"
  | "system_prompt_leak"
  | "looks_like_secret"
  | "structured_output"
  | "malformed_content"
  | "unexpected_script";

export type ValidationResult =
  { valid: true } | { valid: false; reason: ValidationFailureReason; detail: string };

const MAX_RESPONSE_LENGTH = 2000;

// Substrings that should never appear in a real reply — their presence
// means the model echoed part of its own instructions back (spec §47 "no
// accidental system prompt leakage").
const SYSTEM_PROMPT_MARKERS = [
  "base_system_prompt",
  "system instruction",
  "you are instamate",
  "chat_mode_prompt",
  "conversation_context",
];

// Common secret/API-key shapes (spec §47 "no API keys").
const SECRET_PATTERNS = [
  /AIza[0-9A-Za-z_-]{35}/, // Google API key
  /sk-[A-Za-z0-9]{20,}/, // OpenAI-style key
  /\b[A-Za-z0-9+/]{40,}={0,2}\b/, // long base64-ish blob
];

// spec §13 rule 3: "Do not randomly switch to Devanagari." Only meaningful
// when the conversation's language isn't explicitly HINDI (which may
// intentionally use Devanagari).
const DEVANAGARI_PATTERN = /[ऀ-ॿ]/;

export function validateAIResponse(text: string, language: Language): ValidationResult {
  const trimmed = text.trim();

  if (trimmed.length === 0) {
    return {
      valid: false,
      reason: "empty",
      detail: "Response was empty after trimming.",
    };
  }

  if (trimmed.length > MAX_RESPONSE_LENGTH) {
    return {
      valid: false,
      reason: "too_long",
      detail: `Response was ${trimmed.length} characters (max ${MAX_RESPONSE_LENGTH}).`,
    };
  }

  const lower = trimmed.toLowerCase();
  const leakedMarker = SYSTEM_PROMPT_MARKERS.find((marker) => lower.includes(marker));
  if (leakedMarker) {
    return {
      valid: false,
      reason: "system_prompt_leak",
      detail: `Response contained internal marker "${leakedMarker}".`,
    };
  }

  const secretPattern = SECRET_PATTERNS.find((pattern) => pattern.test(trimmed));
  if (secretPattern) {
    return {
      valid: false,
      reason: "looks_like_secret",
      detail: "Response contained a string shaped like an API key or token.",
    };
  }

  if (
    (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
    (trimmed.startsWith("[") && trimmed.endsWith("]"))
  ) {
    return {
      valid: false,
      reason: "structured_output",
      detail: "Response looked like raw JSON instead of a conversational reply.",
    };
  }

  if (/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(trimmed)) {
    return {
      valid: false,
      reason: "malformed_content",
      detail: "Response contained control characters.",
    };
  }

  if (language !== "HINDI" && DEVANAGARI_PATTERN.test(trimmed)) {
    return {
      valid: false,
      reason: "unexpected_script",
      detail: "Response used Devanagari script when Roman script was expected.",
    };
  }

  return { valid: true };
}
