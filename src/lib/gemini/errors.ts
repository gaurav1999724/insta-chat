// Thrown by GeminiService and caught at the call site (a server action or
// route handler), which logs the technical detail server-side (APIError,
// category GEMINI_ERROR) and shows the user only a friendly message
// (spec §51).
export class GeminiApiError extends Error {
  readonly details?: unknown;

  constructor(message: string, details?: unknown) {
    super(message);
    this.name = "GeminiApiError";
    this.details = details;
  }
}
