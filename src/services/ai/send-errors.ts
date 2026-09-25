// Thrown for both "we chose not to attempt this" (not approved, window
// closed) and "the API call failed" cases. Callers decide what to do with
// it: manual server actions catch it and return a friendly
// `{ success: false }` result. Split out of send-service.ts so
// retry-policy.ts can check `instanceof SendMessageError` without a
// circular import (send-service.ts uses the retry policy too).
export class SendMessageError extends Error {}
