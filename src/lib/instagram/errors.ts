// Subset of spec §51's error categories that Instagram integration code can
// raise. Callers at the route boundary catch this, log the technical detail
// server-side (APIError), and show the user only a friendly message.
export type InstagramErrorCategory =
  "INSTAGRAM_AUTH_ERROR" | "INSTAGRAM_PERMISSION_ERROR" | "INSTAGRAM_API_ERROR";

export class InstagramApiError extends Error {
  readonly category: InstagramErrorCategory;
  readonly details?: unknown;

  constructor(message: string, category: InstagramErrorCategory, details?: unknown) {
    super(message);
    this.name = "InstagramApiError";
    this.category = category;
    this.details = details;
  }
}
