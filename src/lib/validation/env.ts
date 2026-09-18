import { z } from "zod";

const envSchema = z.object({
  DATABASE_URL: z.string().url(),

  NEXTAUTH_SECRET: z.string().min(1),
  NEXTAUTH_URL: z.string().url(),

  // Email provider (Auth.js magic link). Optional in development: when unset,
  // the sign-in link is logged to the console instead of being emailed.
  EMAIL_SERVER: z.string().optional(),
  EMAIL_FROM: z.string().optional(),

  META_APP_ID: z.string().optional(),
  META_APP_SECRET: z.string().optional(),
  // Verified against developers.facebook.com/docs/graph-api/changelog on
  // 2026-09-17: v26.0 is current (v20.0 is being deprecated 2026-09-24).
  // Re-check before assuming this is still current — Meta ships a new
  // version roughly quarterly (spec §39).
  META_GRAPH_API_VERSION: z.string().default("v26.0"),
  META_WEBHOOK_VERIFY_TOKEN: z.string().optional(),

  GEMINI_API_KEY: z.string().optional(),
  // Verified against ai.google.dev/gemini-api/docs/models on 2026-09-17:
  // "gemini-flash-latest" is Google's alias for the current stable Flash
  // model (spec §30 — "do not hardcode a model name if the current
  // SDK/API recommends another stable model"), verified live against the
  // real API. Pinned versions like "gemini-3.8-flash" get retired without
  // warning (gemini-2.0-flash, this project's original default, already
  // 404s) and can hit real capacity 503s the alias doesn't. Re-verify
  // before assuming this is still current.
  GEMINI_MODEL: z.string().default("gemini-flash-latest"),

  ENCRYPTION_KEY: z.string().min(32, "ENCRYPTION_KEY must be at least 32 characters"),
});

export type Env = z.infer<typeof envSchema>;

function loadEnv(): Env {
  const parsed = envSchema.safeParse(process.env);

  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `  - ${issue.path.join(".")}: ${issue.message}`)
      .join("\n");

    throw new Error(
      `Invalid environment configuration. Check your .env against .env.example:\n${issues}`,
    );
  }

  return parsed.data;
}

export const env = loadEnv();
