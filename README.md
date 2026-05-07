# The Spire

A roleplay-focused chat system. Node/React reimagining of RPGHost/NexxusChat theKeep which is subsequently based on phpMyChat. First-class character profiles, slash-command parity, and an admin command authoring layer.

### Live Demo

[https://thespire.fly.dev/](https://thespire.fly.dev/)

## Layout

```
TheSpire/
├── apps/
│   ├── server/   Fastify + Socket.IO + Drizzle (SQLite)
│   └── web/      Vite + React + TypeScript + Tailwind
├── packages/
│   └── shared/   Cross-package types (events, commands, profile shapes)
├── Dockerfile
└── fly.toml
```

## Development

Two processes, two ports, Vite proxies API calls from one to the other. The following commands will start the development servers for codename `thekeep` (The Spire):

```sh
pnpm install
cp apps/server/.env.example apps/server/.env   # then set SESSION_SECRET
pnpm --filter @thekeep/server run db:push      # creates apps/server/data/thekeep.sqlite
pnpm dev                                       # server :3001, web :5173
```

Open <http://localhost:5173>. The Vite dev-server proxies `/auth`, `/admin`, `/site`, `/users`, `/socket.io`, etc. to the Fastify backend on :3001 (see `apps/web/vite.config.ts`).

## Production

A single Node process serves both the API and the built web bundle on one port. The server picks up `PORT` from env (defaults to 3001), so the same binary runs on 80 / 8080 / whatever your host wants.

```sh
NODE_ENV=production \
PORT=80 \
SESSION_SECRET=$(openssl rand -hex 32) \
DATABASE_URL=/var/lib/thespire/thekeep.sqlite \
WEB_ORIGIN="" \
pnpm --filter @thekeep/web run build           # build the SPA bundle once
pnpm --filter @thekeep/server run start        # serves bundle + API on PORT
```

In production mode the server registers `@fastify/static` against `apps/web/dist/` and adds an SPA fallback so client-side routes serve `index.html`. CORS is disabled (same origin), and `WEB_ORIGIN=""` makes that explicit.

## Deploying to Fly.io

### One-time setup

```sh
flyctl launch --no-deploy
flyctl secrets set SESSION_SECRET=$(openssl rand -hex 32)
flyctl volumes create thespire_data --size 1 --region <your-region>
flyctl deploy
```

### Day-to-day publishing

A `pnpm ship` wrapper script bundles typecheck → commit → push to `origin/main` → `flyctl deploy` so a routine publish is one command:

```sh
pnpm ship "your commit message"          # full flow (typecheck, commit, push, deploy)
pnpm ship -m "msg" --remote-only         # build on Fly's builders (handy from WSL)
pnpm ship "msg" --all                    # also stage root files (fly.toml, Dockerfile, scripts/)
pnpm ship "msg" --no-typecheck           # faster, riskier
pnpm ship "msg" --no-deploy              # commit + push only
pnpm deploy                              # alias for `ship --deploy-only` (no commit)
```

By default the script stages `apps/`, `packages/`, and `README.md` only — root-level files require `--all`. `.gitignore` is honored either way. Run `bash scripts/ship.sh --help` for the full flag reference.

### Preserving admin customizations across deploys

Server boot calls `ensureSystemSeeds`, which idempotently re-creates the default rooms (`The_Spire`, `Tavern`, `Library`, `Garden`, `Bazaar`) by exact-name match. If an admin **renames** a default room, the seed sees the original name as missing and re-creates it — leaving a duplicate next to the renamed copy.

To freeze the seed once you've customized rooms, ship with `--no-seed`:

```sh
pnpm ship "msg" --no-seed                # stages SKIP_DEFAULT_SEED=1 as a Fly secret, then deploys
pnpm ship "msg" --reseed                 # clears it so default rooms get re-seeded again
```

The flag is sticky — once set, every subsequent deploy honors it until cleared with `--reseed`. The system sentinel user and the site-settings singleton are still ensured (both insert-if-missing only; they never overwrite admin customization), so this is safe to leave on permanently for production installs.

### What `fly.toml` does

- Runs the container on internal port **8080**, with Fly's edge mapping external **80** and **443** (HTTPS forced) to it. End users hit `https://<app>.fly.dev` with no port suffix.
- Mounts a 1 GB volume at `/data`, where the SQLite file lives. Survives deploys and machine restarts.
- Wires `/health` as the health check and keeps at least one machine warm (chat needs persistent WebSocket connections).

The `Dockerfile` builds the web bundle, then runs the server with `tsx`. Migrations apply on every boot (idempotent) before the server starts listening.

## Concepts

- **Master account** — login identity. The first registered user is auto-promoted to admin (the keymaster); subsequent registrations are regular users until promoted via `/promoteadmin` or the Admin → Users tab.
- **Character** — display name + bio (limited HTML) + structured stats (age, race, etc.). Set active with `/char switch Name`. Per-account cap is admin-configurable (default 100).
- **`/me` + aliases** (`/he`, `/she`, `/they`, `/it`, `/em`) — renders `Name <action>` with no brackets/colon.
- **Custom commands** — admins author additional commands with a small template language (variables, math, choose, if/else) at runtime.
- **Privacy** — admins can list private/password rooms and their occupants but *cannot* read their messages. Whispers are filtered out of all backlog and admin views regardless of room type.
