import { z } from "zod";

const envSchema = z.object({
  DATABASE_URL: z.string().url(),

  NEXTAUTH_SECRET: z.string().min(1),
  NEXTAUTH_URL: z.string().url(),

  // Email provider (Auth.js magic link). Optional in development: when unset,
  // the sign-in link is logged to the console instead of being emailed.
  EMAIL_SERVER: z.string().optional(),
  EMAIL_FROM: z.string().optional(),

  // SocialAPI.AI (social-api.ai) — replaced direct Meta Graph API access
  // 2026-09-21. One project-wide API key authenticates every call; the
  // real Meta OAuth token for each connected Instagram account lives
  // entirely on SocialAPI.AI's infrastructure, never on ours (see
  // docs/INSTAGRAM_SETUP.md).
  SOCIALAPI_TOKEN: z.string().optional(),
  // Returned once by `POST /webhooks` when the webhook endpoint is first
  // registered (a one-time manual setup step — see docs/INSTAGRAM_SETUP.md)
  // — used to verify the `X-SocialAPI-Signature-V2` HMAC header on every
  // incoming webhook call.
  SOCIALAPI_WEBHOOK_SECRET: z.string().optional(),

  // Authenticates requests to /api/cron/* — Vercel Cron sends this
  // automatically as `Authorization: Bearer $CRON_SECRET` for jobs defined
  // in vercel.json once the env var is set. Optional so local dev without a
  // configured cron doesn't need it; the route itself refuses to run
  // unauthenticated if it's set.
  CRON_SECRET: z.string().optional(),

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
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_MODEL: z.string().default("gpt-4o-mini"),
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
