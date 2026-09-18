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
};

export function logOperation(fields: LogFields): void {
  const line = JSON.stringify({ timestamp: new Date().toISOString(), ...fields });

  if (fields.status === "failure") {
    console.error(line);
  } else {
    console.log(line);
  }
}
