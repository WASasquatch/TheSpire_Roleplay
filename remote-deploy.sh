#!/usr/bin/env bash
# remote-deploy.sh - ship to fly.io via the remote builder.
#
# Two modes, picked by argument count:
#
#   No arguments — legacy redeploy:
#     ./remote-deploy.sh
#     Hands off to `ship.sh --deploy-only`. Re-deploys whatever's
#     already on origin/main without making a new commit. Use when
#     fly machines need to roll forward but no new code is shipping.
#
#   With arguments — full ship flow:
#     ./remote-deploy.sh --commit "fix admin overview" --bump patch
#     ./remote-deploy.sh -m "ship forum mode" --bump minor
#     ./remote-deploy.sh "quick fix"                # message as positional
#     ./remote-deploy.sh --commit "1.0 release" --bump major
#     ./remote-deploy.sh --commit commit.md --bump minor   # message from file
#     Bumps the version (if --bump given), typechecks, commits the
#     staged-by-default tree (apps/ + packages/ + README.md), pushes
#     origin main, then deploys. All arguments forward straight to
#     ship.sh — see `bash scripts/ship.sh --help` for the full set.
#
#     The --commit / -m / --message value can be either a literal string
#     OR a path to a regular file; when it's a file, ship.sh reads the
#     file's contents as the commit message. Keeping a running log in
#     commit.md and shipping it with `--commit commit.md` is the
#     intended use.
#
# Both paths hardcode:
#   --remote-only : build on fly's builders so this dev box doesn't
#                   need cross-platform Docker.
#   --no-seed     : keep SKIP_DEFAULT_SEED=1 staged so admin-renamed
#                   default rooms don't get recreated on next boot.

set -euo pipefail
cd "$(dirname "$0")"

if [[ $# -eq 0 ]]; then
  exec bash scripts/ship.sh --deploy-only --no-seed --remote-only
fi

exec bash scripts/ship.sh --remote-only --no-seed "$@"
