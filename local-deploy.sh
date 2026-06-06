#!/usr/bin/env bash
# local-deploy.sh, boot the local stack (Vite + Fastify in dev, or
# Fastify-only serving the built SPA in prod).
#
# Wraps `pnpm dev` (or `pnpm --filter @thekeep/server run start` with
# NODE_ENV=production) with the workarounds this dev box needs:
#
#   1. Force Node v22 onto PATH. The system default on this WSL is
#      v18, but `better-sqlite3` is compiled against v22 (the version
#      pinned in package.json's engines field). Without this prefix
#      the server crashes on first boot with
#      `NODE_MODULE_VERSION 109 vs 127`. `ship.sh` already has the same
#      override; we mirror it here so `local-deploy.sh` and the deploy
#      pipeline don't drift on Node version.
#
#   2. Park the server in the foreground so Ctrl+C cleanly stops it
#      (and, in dev, both workspace processes: apps/server tsx-watch +
#      apps/web vite). `pnpm -r --parallel` (what `pnpm dev` aliases
#      to at the root) handles the fan-out + signal propagation in
#      dev; in prod there's only one process.
#
#   3. Pre-flight migrate by default. New schema columns can roll
#      into the repo without the local SQLite file picking them up;
#      the next server boot then dies on a `no such column` error.
#      `pnpm db:push` runs before the boot so the local DB always
#      catches up, cheap when already current (the apply script
#      skips files recorded in `_migrations`). `--no-migrate`
#      skips the step for the rare case where you want to boot
#      against a deliberately stale DB.
#
#   4. In --prod mode: build the web SPA (`pnpm --filter @thekeep/web
#      run build`) so apps/web/dist exists, then boot the server with
#      NODE_ENV=production. The server's fastify-static plugin serves
#      the built dist directly, no Vite, no proxy. This mirrors what
#      Fly.io runs and is the right setup for testing production-only
#      code paths (CSP nonces, prerendered SEO, asset hashing,
#      WebSocket upgrade without Vite in the middle, etc.).
#
# Usage:
#   ./local-deploy.sh                  # migrate (if needed) + boot dev
#   ./local-deploy.sh --prod           # migrate + build web + boot prod
#   ./local-deploy.sh --no-migrate     # boot dev without touching the DB
#   ./local-deploy.sh --prod --no-migrate
#                                       # boot prod without migrating
#   ./local-deploy.sh --migrate-only   # apply migrations and exit
#                                       # (handy after pulling main)
#   ./local-deploy.sh --typecheck      # run repo-wide tsc, no boot
#   bash local-deploy.sh               # same, explicit bash
#
# Ports:
#   dev  , Vite at http://localhost:5173 (proxies API to Fastify on 3001)
#   prod , Fastify on http://localhost:3001 serves everything itself

set -euo pipefail

# Resolve to repo root no matter where the script was invoked from.
cd "$(dirname "$0")"

# MODE picks WHAT to do; DO_MIGRATE is independent so --prod and
# --no-migrate compose in any order. `--migrate` stays as a no-op
# alias for the legacy explicit-opt-in workflow.
MODE="dev"
DO_MIGRATE=1
for arg in "$@"; do
  case "$arg" in
    --migrate)      DO_MIGRATE=1 ;;
    --no-migrate)   DO_MIGRATE=0 ;;
    --migrate-only) MODE="migrate-only" ;;
    --typecheck)    MODE="typecheck" ;;
    --prod)         MODE="prod" ;;
    -h|--help)
      sed -n '2,52p' "$0"
      exit 0 ;;
    *)
      echo "local-deploy: unknown flag: $arg" >&2
      echo "try: $0 --help" >&2
      exit 1 ;;
  esac
done

# Mirror ship.sh's Node-v22 override. If the nvm directory disappeared
# (fresh machine, reinstall), fall through with a warning so the user
# gets a clear hint rather than a silent module-version mismatch.
NODE_V22_BIN="/home/was/.nvm/versions/node/v22.22.2/bin"
if [[ -d "$NODE_V22_BIN" ]]; then
  export PATH="$NODE_V22_BIN:$PATH"
else
  echo "local-deploy: WARN  Node v22 nvm install not found at $NODE_V22_BIN" >&2
  echo "local-deploy:       Falling back to whatever \`node\` is on PATH." >&2
  echo "local-deploy:       If better-sqlite3 fails to load, run:" >&2
  echo "local-deploy:         nvm install 22 && nvm use 22 && pnpm install" >&2
fi

echo "==> Node: $(node --version)"

if [[ "$MODE" == "typecheck" ]]; then
  echo "==> Running repo-wide typecheck..."
  exec pnpm -r run typecheck
fi

if [[ "$DO_MIGRATE" == "1" ]]; then
  echo "==> Applying pending DB migrations (pnpm db:push)..."
  pnpm db:push
fi

if [[ "$MODE" == "migrate-only" ]]; then
  echo "local-deploy: migrate complete; --migrate-only requested, exiting."
  exit 0
fi

if [[ "$MODE" == "prod" ]]; then
  # Rebuild the SPA every time so the served dist always matches the
  # current source. Skipping the rebuild would silently serve stale
  # JS/CSS on the next boot, the kind of "I changed it but nothing's
  # different" footgun that's worse than a few extra seconds here.
  echo "==> Building web SPA (pnpm --filter @thekeep/web run build)..."
  pnpm --filter @thekeep/web run build

  PORT="${PORT:-3001}"
  export PORT
  export NODE_ENV=production
  echo "==> Booting Fastify in production mode (NODE_ENV=production)..."
  echo "==> App will be at http://localhost:${PORT}"
  echo "==> Ctrl+C here stops it."
  exec pnpm --filter @thekeep/server run start
fi

echo "==> Booting Vite (web) + tsx watch (server) via 'pnpm dev'..."
echo "==> Web will be at http://localhost:5173"
echo "==> Ctrl+C here stops both."
exec pnpm dev
