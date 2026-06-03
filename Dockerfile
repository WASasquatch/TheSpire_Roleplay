# syntax=docker/dockerfile:1.6
#
# Multi-stage build for The Spire on Fly.io (or any Docker host).
#
#   Stage 1 (builder): install all deps + build the web bundle
#   Stage 2 (runtime): trimmed image that runs `tsx src/index.ts`
#
# We deliberately ship the server's TypeScript source and run it under tsx
# instead of pre-compiling. The codebase isn't large enough for the build
# pipeline to be worth maintaining, and the cold-start cost is one-time.

# -------------------------------------------------------------------
# Stage 1 — build the web bundle and resolve all workspace deps
# -------------------------------------------------------------------
FROM node:22-alpine AS builder
# Native build tooling for better-sqlite3 + argon2.
RUN apk add --no-cache python3 make g++
RUN corepack enable

WORKDIR /app

# Copy manifests first so the dep install layer caches independently of
# source changes — most builds only touch source files, not lockfiles.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/server/package.json ./apps/server/
COPY apps/web/package.json ./apps/web/
COPY packages/shared/package.json ./packages/shared/

RUN pnpm install --frozen-lockfile

# Source.
COPY . .

# Build the web bundle. The server runs from source via tsx so it doesn't
# need a build step, but the SPA does — Vite emits hashed asset filenames
# and an HTML shell that the server serves at runtime.
RUN pnpm --filter @thekeep/web run build

# -------------------------------------------------------------------
# Stage 2 — runtime
# -------------------------------------------------------------------
FROM node:22-alpine AS runtime
RUN apk add --no-cache tini
RUN corepack enable

WORKDIR /app

# Copy the entire built workspace from the builder. We could be more
# surgical (drop devDependencies, prune apps/web/src, etc.) but the image
# size delta is small and the simpler copy survives refactors better.
COPY --from=builder /app /app

ENV NODE_ENV=production
ENV PORT=8080
# WEB_ORIGIN="" disables CORS — the bundle is served same-origin in prod.
ENV WEB_ORIGIN=""
# Persistent SQLite path. Fly.io mounts a volume at /data; in plain Docker
# you can `-v thespire_data:/data`. Named SQLITE_PATH (not DATABASE_URL)
# because flyctl flags any var named DATABASE_URL as "potentially
# sensitive" — its heuristic assumes a Postgres-style connection string
# with credentials, but our value is just a filesystem path. The server
# still falls back to DATABASE_URL for anyone with an existing local
# .env, so this rename is purely cosmetic on the dev side.
ENV SQLITE_PATH=/data/thekeep.sqlite

EXPOSE 8080

# tini reaps zombies and forwards signals so SIGTERM from Fly's machine
# lifecycle reaches the Node process cleanly.
ENTRYPOINT ["/sbin/tini", "--"]

# Boot sequence on every container start:
#   1. Ensure /data exists (Fly volume mount).
#   2. If the admin Backups tab staged a pending full-DB restore on
#      the previous boot, atomically swap it into place BEFORE
#      anything opens the SQLite file. The pending file lives next
#      to the canonical DB on the same filesystem so the rename is
#      atomic. The WAL/SHM sidecars of the OLD database are also
#      removed in the same step — leaving them would let SQLite
#      replay stale WAL pages onto the freshly-restored file and
#      silently corrupt it. The restore is one-shot: after the
#      rename, the marker file no longer exists, so a subsequent
#      benign restart can't loop the swap.
#   2b. If the same restore also staged a pending uploads tree
#       (.thekeep-pending-uploads/), swap it over the canonical
#       /data/uploads directory. Done in the SAME step as the .sqlite
#       swap so the post-boot DB rows reference the post-boot upload
#       files. Order matters relative to step 3 only — the migrations
#       runner doesn't touch uploads, so either order works there.
#   3. Run pending migrations against the (possibly just-restored)
#      DB. apply-migrations.mjs is fast on a fully-applied DB (one
#      SELECT per file) so the overhead is negligible.
#   4. Exec the server.
CMD ["sh", "-c", "mkdir -p /data && if [ -f /data/.thekeep-pending-restore.sqlite ]; then echo '[boot] applying pending full-DB restore'; rm -f /data/thekeep.sqlite /data/thekeep.sqlite-wal /data/thekeep.sqlite-shm; mv /data/.thekeep-pending-restore.sqlite /data/thekeep.sqlite; fi && if [ -d /data/.thekeep-pending-uploads ]; then echo '[boot] applying pending uploads tree'; rm -rf /data/uploads; mv /data/.thekeep-pending-uploads /data/uploads; fi && node apps/server/scripts/apply-migrations.mjs && exec pnpm --filter @thekeep/server run start"]
