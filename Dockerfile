# spec §71: Dockerfile + docker-compose.yml (app, postgres, redis).
#
# Multi-stage build producing a small runtime image via Next.js's
# `output: "standalone"` (next.config.ts) — the standalone build traces
# only the `node_modules` the server actually needs at runtime, instead of
# shipping the full dev-time `node_modules` tree.
#
# `node:20-bookworm-slim` (Debian, not Alpine) on purpose: Prisma's native
# query engine binary is built per-libc, and using the same Debian/glibc
# base for both the build and runtime stages avoids an Alpine
# (musl-libc)/Debian (glibc) binary mismatch — a common, easy-to-hit Prisma
# + Docker gotcha. Node 20 (not this project's pinned dev-environment
# Node 18) because a container image doesn't have this repo's local
# Node-18-compatibility constraints (see PROJECT_ANALYSIS.md §10) — those
# exist only because *this development environment* can't be upgraded, not
# because the app needs Node 18 in production.
ARG NODE_VERSION=20-bookworm-slim

# ---- deps: install once, reused by the builder stage ----
FROM node:${NODE_VERSION} AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

# ---- builder: generate the Prisma client, then build Next.js ----
FROM node:${NODE_VERSION} AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npx prisma generate
# Build-time environment validation (`src/lib/validation/env.ts`) needs
# *some* value for every required var — these are placeholders `next
# build`'s static analysis/type-checking never actually connects with;
# real values are supplied at container run time via docker-compose's
# `environment:` (see docker-compose.yml).
ENV DATABASE_URL="postgresql://placeholder:placeholder@localhost:5432/placeholder"
ENV NEXTAUTH_SECRET="placeholder-build-time-value-only"
ENV NEXTAUTH_URL="http://localhost:3000"
ENV ENCRYPTION_KEY="placeholder-build-time-value-only-32ch"
RUN npm run build

# ---- runner: the actual production image ----
FROM node:${NODE_VERSION} AS runner
WORKDIR /app
ENV NODE_ENV=production
# Never run the server as root inside the container.
RUN groupadd --system --gid 1001 nodejs \
  && useradd --system --uid 1001 --gid nodejs nextjs

# Next.js's standalone server + only the production node_modules it traced.
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=builder --chown=nextjs:nodejs /app/public ./public
# The standalone trace doesn't reliably pick up Prisma's generated query
# engine (a known Next.js + Prisma gap) — copy it explicitly rather than
# hoping tracing caught it. Only `@prisma/client` + its generated `.prisma`
# output are needed to *run* the app (execute queries); the separate
# `prisma` CLI package (used for `migrate deploy`) is deliberately NOT
# copied here — see docs/DEPLOYMENT.md for why migrations are run as a
# host-side step instead of from inside this minimal runtime image.
COPY --from=builder --chown=nextjs:nodejs /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=builder --chown=nextjs:nodejs /app/node_modules/@prisma/client ./node_modules/@prisma/client

USER nextjs

EXPOSE 3000
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

CMD ["node", "server.js"]
