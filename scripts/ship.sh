#!/usr/bin/env bash
# ship.sh - one-shot commit + push + flyctl deploy for The Spire.
#
# Default flow:
#   1. Refuse to run from a non-main branch (use git directly for PR work)
#   2. Type-check shared / server / web (catch obvious mistakes pre-deploy)
#   3. Stage apps/ + packages/ (deliberately narrow - skips dotfiles,
#      SECURITY-AUDIT.md, /tmp scratch, etc.)
#   4. Commit with the supplied message (skipped if there's nothing staged)
#   5. Push origin main
#   6. flyctl deploy
#
# Usage:
#   ./scripts/ship.sh "your commit message"
#   ./scripts/ship.sh -m "your commit message"
#   pnpm ship "your commit message"           # via the root package.json alias
#
# Flags:
#   -m, --message TEXT   Commit message (positional arg also works).
#   --no-typecheck       Skip the pre-commit typecheck pass (faster, riskier).
#   --no-push            Commit locally only, do not push.
#   --no-deploy          Push but skip flyctl deploy.
#   --remote-only        Pass --remote-only to flyctl deploy (build on Fly's
#                        builders instead of locally - useful from WSL where
#                        cross-platform Docker can be slow or absent).
#   --deploy-only        Skip commit + push, just run flyctl deploy. Lets you
#                        re-deploy whatever's already on origin/main without
#                        making a new commit.
#   -h, --help           Show this help text.

set -euo pipefail

# Mirror the path setup in apps/{server,web}/scripts/start-detached.sh -
# the system Node 18 on this dev box can't run better-sqlite3 (built against
# v22) so any typecheck involving the server package fails ABI checks.
# Harmless if v22 is the default.
if [[ -d "/home/was/.nvm/versions/node/v22.22.2/bin" ]]; then
  export PATH="/home/was/.nvm/versions/node/v22.22.2/bin:$PATH"
fi

cd "$(dirname "$0")/.."

# ----- args -----
MSG=""
SKIP_TYPECHECK=0
SKIP_PUSH=0
SKIP_DEPLOY=0
DEPLOY_ONLY=0
REMOTE_BUILD=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    -m|--message)
      MSG="$2"; shift 2 ;;
    --no-typecheck)
      SKIP_TYPECHECK=1; shift ;;
    --no-push)
      SKIP_PUSH=1; shift ;;
    --no-deploy)
      SKIP_DEPLOY=1; shift ;;
    --deploy-only)
      DEPLOY_ONLY=1; shift ;;
    --remote-only)
      REMOTE_BUILD=1; shift ;;
    -h|--help)
      sed -n '2,30p' "$0"
      exit 0 ;;
    -*)
      echo "ship: unknown flag: $1" >&2
      echo "try: $0 --help" >&2
      exit 1 ;;
    *)
      if [[ -z "$MSG" ]]; then
        MSG="$1"
      else
        echo "ship: unexpected extra argument: $1" >&2
        exit 1
      fi
      shift ;;
  esac
done

# ----- branch guard -----
BRANCH="$(git rev-parse --abbrev-ref HEAD)"
if [[ "$BRANCH" != "main" ]]; then
  echo "ship: refusing to deploy from non-main branch '$BRANCH'." >&2
  echo "      Switch to main first, or use git/flyctl directly for branch work." >&2
  exit 1
fi

# ----- deploy-only short-circuit -----
if [[ "$DEPLOY_ONLY" -eq 1 ]]; then
  echo "==> Deploying current origin/main (skipping commit + push)..."
  if [[ "$REMOTE_BUILD" -eq 1 ]]; then
    flyctl deploy --remote-only
  else
    flyctl deploy
  fi
  echo "ship: done."
  exit 0
fi

# ----- typecheck -----
if [[ "$SKIP_TYPECHECK" -eq 0 ]]; then
  echo "==> Type-checking..."
  pnpm --filter @thekeep/shared exec tsc --noEmit
  pnpm --filter @thekeep/server exec tsc --noEmit
  pnpm --filter @thekeep/web exec tsc --noEmit
fi

# ----- stage + commit -----
# Whether we have anything to commit determines whether MSG is required.
HAS_CHANGES=0
if ! git diff --quiet HEAD || ! git diff --cached --quiet; then
  HAS_CHANGES=1
fi
# Also count untracked files inside apps/ or packages/ as a "change" - they'd
# get staged below.
if [[ -n "$(git ls-files --others --exclude-standard apps packages)" ]]; then
  HAS_CHANGES=1
fi

if [[ "$HAS_CHANGES" -eq 1 ]]; then
  if [[ -z "$MSG" ]]; then
    echo "ship: working tree has changes; commit message required." >&2
    echo "      pass it as the first argument: $0 \"my message\"" >&2
    exit 1
  fi
  echo "==> Staging apps + packages..."
  git add apps packages
  if git diff --cached --quiet; then
    echo "ship: nothing was staged (changes were outside apps/ and packages/?)." >&2
    echo "      stage them manually with 'git add' and re-run." >&2
    exit 1
  fi
  echo "==> Committing..."
  git commit -m "$MSG"
else
  echo "==> Nothing to commit; proceeding to push + deploy."
fi

# ----- push -----
if [[ "$SKIP_PUSH" -eq 0 ]]; then
  # Skip the push if local main is already in sync with origin/main (no
  # commits ahead). git push would no-op anyway but the noise is annoying.
  AHEAD="$(git rev-list --count @{u}..HEAD 2>/dev/null || echo 0)"
  if [[ "$AHEAD" == "0" ]]; then
    echo "==> origin/main is up-to-date; nothing to push."
  else
    echo "==> Pushing $AHEAD commit(s) to origin main..."
    git push origin main
  fi
fi

# ----- deploy -----
if [[ "$SKIP_DEPLOY" -eq 0 ]]; then
  echo "==> Deploying to fly.io..."
  if [[ "$REMOTE_BUILD" -eq 1 ]]; then
    flyctl deploy --remote-only
  else
    flyctl deploy
  fi
fi

echo "ship: done."
