import { InstagramApiError } from "@/lib/instagram/errors";
import { SendMessageError } from "@/services/ai/send-errors";

// Bounds automatic retry of a FAILED AI-reply send (spec follow-up: "should
// a previously-failed reply retry automatically?" — yes, but bounded).
export const MAX_SEND_ATTEMPTS = 3;

// Minutes to wait before each retry, indexed by the attempt number that just
// failed (attempts is 1-based: the first failed attempt uses index 0).
// Exponential-ish, mirroring the spirit of gemini-service.ts's backoff but
// scaled for a background retry instead of an in-request one.
const RETRY_DELAY_MINUTES = [1, 5, 15];

export function computeNextRetryAt(attemptsSoFar: number): Date | null {
  if (attemptsSoFar >= MAX_SEND_ATTEMPTS) return null;

  const delayMinutes = RETRY_DELAY_MINUTES[attemptsSoFar - 1] ?? RETRY_DELAY_MINUTES.at(-1)!;
  return new Date(Date.now() + delayMinutes * 60_000);
}

function getHttpStatus(error: InstagramApiError): number | undefined {
  const details = error.details;
  if (details && typeof details === "object" && "httpStatus" in details) {
    const status = (details as { httpStatus?: unknown }).httpStatus;
    return typeof status === "number" ? status : undefined;
  }
  return undefined;
}

// Only transient failures are worth retrying automatically: a 5xx or 429
// from SocialAPI.AI, or a raw network error (fetch itself threw, never got
// a response). Everything else is permanent for this message and retrying
// it later won't help:
//  - a SendMessageError not wrapping an InstagramApiError means we decided
//    not to attempt the send at all (messaging window closed, account not
//    connected, draft not approved) — see assertSendEligible() in
//    send-service.ts.
//  - an InstagramApiError with a 4xx other than 429 (bad request, invalid
//    recipient, auth/permission failure) reflects something that needs a
//    person to fix, not a passage of time.
export function isRetryableSendError(error: unknown): boolean {
  if (error instanceof InstagramApiError) {
    // AUTH/PERMISSION errors (missing token, revoked scope) need a person
    // to reconnect the account — retrying on a timer won't fix them.
    if (error.category !== "INSTAGRAM_API_ERROR") return false;

    const status = getHttpStatus(error);
    return status === undefined || status === 429 || status >= 500;
  }
  if (error instanceof SendMessageError) return false;

  // A genuine network-level failure (fetch rejected before we got a
  // Response) — not wrapped in InstagramApiError, so worth a retry.
  return true;
}
