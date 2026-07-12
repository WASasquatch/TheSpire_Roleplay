# The Spire

A roleplay-focused, real-time chat and community platform. Master accounts with
multiple characters, public rooms and threaded forums, direct messages, per-user
world wikis, long-form fiction, and a granular admin/moderation toolkit. Run your
own community: multiple servers, organized room categories with icons, staff-only
info rooms whose history never expires, role-gated rooms with self-select roles,
your world's lore built in, rich text chat, custom emoji & commands, its own
economy.

**Live:** <https://thespire.games/>

This README covers standing the project up and running it. End-user and feature
documentation lives in the app under **Help**.

## Stack & layout

- **apps/server** — Fastify 5 + Socket.IO + better-sqlite3 (Drizzle ORM). SQLite storage.
- **apps/web** — Vite + React + TypeScript + Tailwind.
- **packages/shared** — cross-package types (events, commands, profile shapes).

```
TheSpire/
├── apps/
│   ├── server/          Fastify + Socket.IO + Drizzle (SQLite)
│   └── web/             Vite + React + TypeScript + Tailwind
├── packages/
│   └── shared/          Shared types
├── scripts/             ship.sh (commit+push+deploy), bump.sh
├── first-deployment.sh  one-time Fly.io bootstrap
├── remote-deploy.sh     routine Fly.io deploy wrapper
├── local-deploy.sh      boot the stack locally (dev, or built prod)
├── Dockerfile
└── fly.toml
```

## Requirements

- **Node 22** — better-sqlite3's prebuilt binary targets it; older majors can fail
  to boot with a `NODE_MODULE_VERSION` mismatch.
- **pnpm 9+**.

## Local development

```sh
pnpm install
cp apps/server/.env.example apps/server/.env   # then set SESSION_SECRET (min 32 chars)
pnpm db:push                                   # create + migrate apps/server/data/thekeep.sqlite
pnpm dev                                        # server :3001, web :5173
```

Open <http://localhost:5173>. Vite proxies API and socket routes to the Fastify
server on `:3001` (see [`apps/web/vite.config.ts`](apps/web/vite.config.ts)).

`./local-deploy.sh` does the same in one command, but forces Node 22 onto PATH and
runs any pending migrations first. `./local-deploy.sh --prod` builds the SPA and
serves it from the server under `NODE_ENV=production`, mirroring Fly.

### Environment

Set in `apps/server/.env` (see `.env.example` for the annotated list):

| Var | Purpose |
| --- | --- |
| `SESSION_SECRET` | **Required.** Min 32 chars. Generate with `openssl rand -hex 32`. |
| `PORT` | Server port. Dev `3001`, Fly `8080`. |
| `SQLITE_PATH` | SQLite file path (relative to `apps/server/`). In prod, an absolute path on a mounted volume. |
| `WEB_ORIGIN` | CORS allow-list. Dev: the Vite origin. Prod: empty string (same-origin). |
| `LOG_LEVEL` | pino level: `trace`…`fatal`. |
| `NODE_ENV` | `production` enables static SPA serving + SPA fallback in the server. |

## Production (single process)

One Node process serves both the API and the built web bundle on `PORT`:

```sh
pnpm --filter @thekeep/web run build          # build the SPA bundle once
NODE_ENV=production \
PORT=8080 \
SESSION_SECRET=$(openssl rand -hex 32) \
SQLITE_PATH=/data/thekeep.sqlite \
WEB_ORIGIN="" \
pnpm --filter @thekeep/server run start        # serves bundle + API on PORT
```

Migrations apply idempotently on every server boot, before it starts listening.

## Deploy (Fly.io)

**One-time bootstrap** — creates the app, sets `SESSION_SECRET`, provisions the
volume, and runs the first seeded deploy (idempotent; skips finished steps):

```sh
./first-deployment.sh
```

Then register the first account at `https://<app>.fly.dev/` — that user is
auto-promoted to admin. (Install `flyctl` and log in first.)

**Routine deploys** go through `remote-deploy.sh` (builds on Fly's remote builder;
refuses non-`main` branches):

```sh
./remote-deploy.sh "commit message" --bump patch   # bump, typecheck, commit, push, deploy
./remote-deploy.sh --commit commit.md --bump minor # read the commit message from a file
./remote-deploy.sh                                  # redeploy current origin/main, no new commit
```

Both wrappers forward to `scripts/ship.sh` — run `bash scripts/ship.sh --help` for
the full flag set (e.g. `--no-seed` to freeze default-room seeding once you've
customized rooms). `fly.toml` runs the container on internal port `8080` (Fly maps
external `80`/`443`), mounts a 1 GB volume at `/data` for the SQLite file, and
health-checks `/health`.
