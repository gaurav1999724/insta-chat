# Deployment

Status: **Phase 14 implemented.** Docker/Docker Compose, production
environment variables, and Prisma migration deployment steps (spec §71/§72).

**Caveat up front:** this dev environment has no Docker installed (same
class of gap as no reachable Postgres/no public HTTPS URL — see
`PROJECT_ANALYSIS.md` §10), so the Dockerfile/`docker-compose.yml` below
have been written carefully and reviewed line by line, but **never actually
built or run**. `docker-compose.yml`'s YAML syntax was validated with a
parser (`js-yaml`), and the Dockerfile's logic was traced by hand against
the installed `prisma`/`@prisma/client`/Next.js versions' actual file
layouts — but "parses correctly" and "reasoned through carefully" is not
the same as "built and ran a container." **Before relying on this: run
`docker compose --env-file .env.docker up --build` for real and fix
whatever it finds** — the same standing caveat every external-dependency
gap in this project has carried since Phase 2.

## Docker Compose (recommended for self-hosting)

Two services: `app` (this Next.js app) and `postgres` (16-alpine).

```bash
cp .env.docker.example .env.docker
# edit .env.docker: set POSTGRES_PASSWORD, NEXTAUTH_SECRET, ENCRYPTION_KEY
# at minimum (see .env.docker.example's comments for how to generate each)

docker compose --env-file .env.docker up -d postgres

# Migrations and seeding run from the HOST, not inside the `app` container
# — the production image (see Dockerfile) is Next.js's minimal standalone
# build and deliberately doesn't ship the `prisma` CLI or `tsx`. Point
# DATABASE_URL at postgres's exposed port (5432 by default) in your local
# .env, or pass it inline:
DATABASE_URL="postgresql://instamate:<your-password>@localhost:5432/instamate?schema=public" \
  npm run prisma:migrate:deploy
DATABASE_URL="postgresql://instamate:<your-password>@localhost:5432/instamate?schema=public" \
  npm run prisma:seed   # optional — 10 built-in chat modes + demo data

docker compose --env-file .env.docker up --build app
```

The app is then reachable at `http://localhost:3000` (or `$APP_PORT`).

### Why migrations run from the host, not `docker compose exec app ...`

The `app` image is built from Next.js's `output: "standalone"` mode
(`next.config.ts`) specifically to stay small: it's `server.js` plus only
the `node_modules` Next.js's file tracer determined the running server
actually imports. The `prisma` CLI package (needed for `migrate deploy`)
and `tsx` (needed for the seed script) aren't part of that traced set —
they're dev-time tools, not something the running Next.js server itself
imports — so they're not in the runtime image. Re-adding them just for
migrations would mean copying `prisma`'s own transitive dependencies
(`@prisma/engines`, `@prisma/config`, ...) into the image by hand, which is
exactly the kind of fragile, easy-to-get-subtly-wrong Docker/Prisma
integration this project would rather avoid than half-verify without being
able to actually build the image here. Running `prisma migrate
deploy`/`prisma db seed` from the host (where the full `node_modules,`
including dev dependencies, already exists) against the Postgres port
Compose publishes is simpler and just as correct for a self-hosted,
single-instance deployment.

### Rebuilding after a code change

```bash
docker compose --env-file .env.docker up --build app
```

`postgres` doesn't need rebuilding — only `app` changes between releases
of this codebase.

### Local development without Docker

Everything above is for deploying/self-hosting. For day-to-day development,
`npm run dev` against a locally-installed Postgres (see `docs/DATABASE.md`)
is still the normal path. Docker Compose's `postgres` service is equally
usable: `docker compose up -d postgres`, then run `npm run dev` as usual.

## Environment variables (production)

Same variables as `.env.example`, with production-specific notes:

| Variable                                                        | Production note                                                                                                                                                                                                                                                                                 |
| --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`                                                  | A real, backed-up Postgres. Never point production at a database you can't restore.                                                                                                                                                                                                             |
| `NEXTAUTH_SECRET`                                               | Generate with `npx auth secret`; a distinct value per environment (dev/staging/prod), never reused.                                                                                                                                                                                             |
| `NEXTAUTH_URL`                                                  | **Must** be the real `https://` URL. Auth.js's cookie `secure` flag and the Instagram OAuth state cookie's `secure` flag (`src/lib/instagram/oauth.ts`) both key off this starting with `https://` — an `http://` value in production means session/CSRF-state cookies are sent over plaintext. |
| `EMAIL_SERVER` / `EMAIL_FROM`                                   | Must both be set in production — leaving `EMAIL_SERVER` unset makes sign-in links print to the server's stdout/logs instead of emailing them, which is a deliberate **local-dev-only** fallback (`src/lib/auth/auth.ts`), not something acceptable once real users exist.                       |
| `META_APP_ID` / `META_APP_SECRET` / `META_WEBHOOK_VERIFY_TOKEN` | From your Meta developer app — see `docs/INSTAGRAM_SETUP.md`. The webhook needs a real public HTTPS URL to register with Meta (this dev environment has never had one — see `PROJECT_ANALYSIS.md` §10).                                                                                         |
| `GEMINI_API_KEY`                                                | A real key with billing configured — see `docs/GEMINI_SETUP.md` for cost estimates.                                                                                                                                                                                                             |
| `ENCRYPTION_KEY`                                                | 32+ random characters (`openssl rand -base64 32`), used to encrypt stored Instagram access tokens (spec §49). Losing this key makes every already-connected Instagram account's stored token permanently undecryptable — back it up as carefully as the database itself.                        |

**Never commit `.env` or `.env.docker` with real values** — both are
gitignored (`.gitignore`'s `.env*` pattern, with explicit `!.env.example`/
`!.env.docker.example` exceptions so the templates themselves stay
committed).

## Prisma migrations in production (spec §72)

- **Always** `prisma migrate deploy` — never `prisma migrate dev` (which
  can prompt interactively and generates new migrations from schema
  drift) and never `prisma migrate reset` (drops and recreates the
  database) against a database with real data.
- Migrations are already committed under `prisma/migrations/` — `deploy`
  only applies ones not yet recorded as run; it never generates a new one.
- Run `prisma:migrate:deploy` (added this phase) before starting a new
  version of the app that depends on a new migration, not after — the app
  assumes its expected schema already exists the moment it starts serving
  requests.
- No automatic rollback command exists in Prisma for an already-applied
  migration; the documented recovery path for a bad migration is a new,
  forward-fixing migration, not reverting — plan schema changes
  accordingly (see `docs/DATABASE.md`).

## What's NOT covered by this doc

- A managed-hosting-specific guide (Vercel, Railway, Fly.io, etc.) — this
  app's Phase 9 automatic-processing design (in-process BullMQ workers
  started via `src/instrumentation.ts`, not a separate worker dyno/process)
  assumes a **long-running Node process**, which rules out Vercel's
  serverless functions for anything beyond the manual-button-only mode.
  A container platform (this Dockerfile) or a persistent Node host is the
  right target, not a serverless one.
- TLS/reverse-proxy termination — put this app behind whatever
  already-trusted reverse proxy/load balancer terminates HTTPS in your
  environment (nginx, Caddy, a cloud load balancer); this app's own server
  only speaks plain HTTP on `$PORT`.
- CI/CD pipeline configuration — not requested by the spec; not built this
  phase.
