import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

// spec §52: structured logging for important operations. Plain
// JSON-per-line to stdout/stderr — this project has no log aggregation
// service configured, so console output (captured by whatever the
// deployment platform collects) is the right amount of infrastructure for
// now, not a new database table. `AuditLog` (user-facing history) and
// `APIError` (persisted error records) already cover the two things that
// genuinely need to survive a restart; this is for operational
// visibility only.
//
// Deliberately a fixed, narrow field set — spec §52 also says "never log
// secrets or access tokens", and the easiest way to guarantee that is to
// make it structurally impossible to pass one through: there's no
// catch-all `metadata`/`extra` field here for a caller to absent-mindedly
// dump a token into.
export type LogFields = {
  requestId?: string;
  userId?: string;
  instagramAccountId?: string;
  conversationId?: string;
  messageId?: string;
  operation: string;
  status: "success" | "failure";
  durationMs?: number;
  errorCode?: string;
  // Deliberately named fields, not a catch-all `metadata` — a caller must
  // explicitly choose to log a request/response body. Reserved for
  // SocialAPI.AI call logging; callers MUST redact secrets before passing
  // these — see `redactSocialApiPayload()` in
  // `src/services/instagram/instagram-service.ts`. Never pass a raw,
  // unredacted body here.
  requestBody?: unknown;
  responseBody?: unknown;
};

export function logOperation(fields: LogFields): void {
  const line = JSON.stringify({ timestamp: new Date().toISOString(), ...fields });

  if (fields.status === "failure") {
    console.error(line);
  } else {
    console.log(line);
  }

  appendToLocalLogFile(line);
}

// Local-dev convenience only: mirrors every operation log line into
// `logs/app.txt` so they can be read without a terminal scrollback or a
// log-aggregation service. Skipped on Vercel (`process.env.VERCEL` is set
// by the platform itself, never in local dev) — its filesystem is
// read-only/ephemeral outside `/tmp`, so writing there would silently
// fail or vanish on the next cold start anyway.
let logDirReady = false;

function appendToLocalLogFile(line: string): void {
  if (process.env.VERCEL) return;

  try {
    if (!logDirReady) {
      mkdirSync(join(process.cwd(), "logs"), { recursive: true });
      logDirReady = true;
    }

    appendFileSync(join(process.cwd(), "logs", "app.txt"), line + "\n");
  } catch {
    // Best-effort only — never let local log-file writing break a request.
  }
}
