# Troubleshooting

## Local environment

- **Node version:** this project targets Node 18.20.8 compatibility
  (Next.js 15.x, Tailwind v3). If you upgrade to Node 20+, Next.js 16 and
  Tailwind v4 become options again — see `PROJECT_ANALYSIS.md` §10.
- **Env validation error on boot:** `src/lib/validation/env.ts` throws a
  listed error naming every missing/invalid var. Compare your `.env`
  against `.env.example`.
- **Magic-link sign-in in dev:** with `EMAIL_SERVER` unset, the sign-in
  link is printed to the terminal running `npm run dev` — check there, not
  your inbox.

More entries are added as later phases introduce new failure modes
(webhooks, queues, Gemini, Docker).
