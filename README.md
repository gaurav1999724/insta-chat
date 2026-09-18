# InstaMate AI

A personal AI assistant for managing Instagram conversations through Meta's
official Instagram APIs, generating natural Hinglish replies via Google
Gemini. Full build spec: `InstaMate_AI_Master_Prompt.txt`. Current status
and architecture: `PROJECT_ANALYSIS.md`.

## Stack

Next.js 15 (App Router, TypeScript strict) · Tailwind CSS v3 + shadcn/ui ·
PostgreSQL + Prisma · Auth.js v5 · Zod · Google Gemini.

> Tailwind v3 (not v4) and Next.js 15 (not 16) are pinned because this
> environment runs Node 18.20.8 — see `PROJECT_ANALYSIS.md` §10.

## Getting started

1. `cp .env.example .env` and fill in real values (a working `DATABASE_URL`
   and `ENCRYPTION_KEY` are required to boot; everything else is optional
   until its integration phase).
2. `npm install`
3. `npm run prisma:migrate` — applies `prisma/migrations/` to your database
   (generates the Prisma Client as a side effect; re-run after schema
   changes)
4. `npm run prisma:seed` — loads the 10 built-in chat modes plus one demo
   conversation (no real Instagram data)
5. `npm run dev` — http://localhost:3000

Automatic background processing is intentionally disabled. The manual
"AI Generate"/"Analyze conversation"/"Send" buttons in `/conversations`
continue to work, and rate limiting uses a simple in-memory counter.

## Scripts

- `npm run dev` / `build` / `start`
- `npm run lint` / `typecheck` / `format` / `format:check`
- `npm run test` / `test:watch` / `test:e2e`
- `npm run prisma:generate` / `prisma:migrate` / `prisma:migrate:deploy` /
  `prisma:studio` / `prisma:seed`

## Docker

```bash
cp .env.docker.example .env.docker   # fill in real values
docker compose --env-file .env.docker up -d postgres
npm run prisma:migrate:deploy        # from the host, against the exposed port
docker compose --env-file .env.docker up --build app
```

Full walkthrough, production environment variable notes, and why
migrations run from the host rather than inside the container:
`docs/DEPLOYMENT.md`.

## Docs

See `docs/` for setup guides (Instagram, Gemini, database, webhooks,
security, deployment, testing) and `SECURITY_REVIEW.md` for the
final security review (spec §87). `PROJECT_ANALYSIS.md` is the current
source of truth for implementation status.
