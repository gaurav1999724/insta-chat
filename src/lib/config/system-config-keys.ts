// Just the key names — zero imports, safe to pull into a client bundle
// (the "use client" settings form needs this list to render the fields,
// but must never drag in `system-config.ts`'s prisma/env imports).
export const SYSTEM_CONFIG_KEYS = [
  "SOCIALAPI_TOKEN",
  "SOCIALAPI_WEBHOOK_SECRET",
  "GEMINI_API_KEY",
  "OPENAI_API_KEY",
] as const;

export type SystemConfigKey = (typeof SYSTEM_CONFIG_KEYS)[number];
