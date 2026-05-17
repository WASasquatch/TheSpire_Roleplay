#!/usr/bin/env bash
# local-deploy.sh — boot the local dev stack (Vite + Fastify).
#
# Wraps `pnpm dev` with the workarounds this dev box needs:
#
#   1. Force Node v22 onto PATH. The system default on this WSL is
#      v18, but `better-sqlite3` is compiled against v22 (the version
#      pinned in package.json's engines field). Without this prefix
#      the server crashes on first boot with
#      `NODE_MODULE_VERSION 109 vs 127`. `ship.sh` already has the same
#      override; we mirror it here so `local-deploy.sh` and the deploy
#      pipeline don't drift on Node version.
#
#   2. Park the dev server in the foreground so Ctrl+C cleanly stops
#      both workspace processes (apps/server tsx-watch + apps/web vite).
#      `pnpm -r --parallel` (what `pnpm dev` aliases to at the root)
#      handles the fan-out + signal propagation; we just sit on top.
#
#   3. Optional pre-flight migrate. New schema columns can roll into
#      the repo without the local SQLite file picking them up; the
#      next server boot then dies on a `no such column` error. The
#      `--migrate` flag runs `pnpm db:push` first so the local DB
#      catches up before we exec pnpm dev. Cheap when the schema is
#      already current (drizzle-kit no-ops).
#
# Usage:
#   ./local-deploy.sh                  # boot both server + web
#   ./local-deploy.sh --migrate        # apply pending schema changes,
#                                       # then boot
#   ./local-deploy.sh --migrate-only   # apply migrations and exit
#                                       # (handy after pulling main)
#   bash local-deploy.sh               # same, explicit bash
#
# Ports (Vite picks `5173`, Fastify reads `PORT` from env, defaulting
# to 8080 in development unless an .env overrides). Open
# http://localhost:5173 in a browser; the Vite proxy forwards API
# calls to the server.

set -euo pipefail

# Resolve to repo root no matter where the script was invoked from.
cd "$(dirname "$0")"

MODE="dev"  # one of: dev | migrate-then-dev | migrate-only | typecheck
for arg in "$@"; do
  case "$arg" in
    --migrate)      MODE="migrate-then-dev" ;;
    --migrate-only) MODE="migrate-only" ;;
    --typecheck)    MODE="typecheck" ;;
    -h|--help)
      sed -n '2,40p' "$0"
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

if [[ "$MODE" == "migrate-then-dev" || "$MODE" == "migrate-only" ]]; then
  echo "==> Applying pending DB migrations (pnpm db:push)..."
  pnpm db:push
fi

if [[ "$MODE" == "migrate-only" ]]; then
  echo "local-deploy: migrate complete; --migrate-only requested, exiting."
  exit 0
fi

echo "==> Booting Vite (web) + tsx watch (server) via 'pnpm dev'..."
echo "==> Web will be at http://localhost:5173"
echo "==> Ctrl+C here stops both."
exec pnpm dev
