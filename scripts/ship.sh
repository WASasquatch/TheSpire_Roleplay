#!/usr/bin/env bash
# ship.sh - one-shot commit + push + flyctl deploy for The Spire.
#
# Default flow:
#   1. Refuse to run from a non-main branch (use git directly for PR work)
#   2. Type-check shared / server / web (catch obvious mistakes pre-deploy)
#   3. Stage apps/ + packages/ + README.md (deliberately narrow - skips
#      dotfiles, SECURITY-AUDIT.md, /tmp scratch, etc.); README is included
#      so deploy/changelog notes ship alongside code. Use --all to also pick
#      up other root-level files (fly.toml, Dockerfile, scripts/, etc.).
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
#   -a, --all            Stage with `git add -A` instead of the narrow
#                        apps/+packages/+README.md default. Use when
#                        shipping changes to other root-level files
#                        (fly.toml, Dockerfile, scripts/, etc.). .gitignore
#                        still filters.
#   --no-typecheck       Skip the pre-commit typecheck pass (faster, riskier).
#   --no-push            Commit locally only, do not push.
#   --no-deploy          Push but skip flyctl deploy.
#   --remote-only        Pass --remote-only to flyctl deploy (build on Fly's
#                        builders instead of locally - useful from WSL where
#                        cross-platform Docker can be slow or absent).
#   --deploy-only        Skip commit + push, just run flyctl deploy. Lets you
#                        re-deploy whatever's already on origin/main without
#                        making a new commit.
#   --no-seed            Stage SKIP_DEFAULT_SEED=1 as a Fly secret before
#                        deploying so the next boot SKIPS recreating default
#                        rooms (use after admins have renamed/customized
#                        them). The flag is sticky - it persists across
#                        deploys until cleared with --reseed. Has no effect
#                        when --no-deploy is also passed.
#   --reseed             Stage removal of the SKIP_DEFAULT_SEED secret so the
#                        next deploy reseeds missing default rooms again.
#                        Mutually exclusive with --no-seed.
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
STAGE_ALL=0
SEED_TOGGLE=""   # "off" → set SKIP_DEFAULT_SEED=1; "on" → unset; "" → leave alone

while [[ $# -gt 0 ]]; do
  case "$1" in
    -m|--message)
      MSG="$2"; shift 2 ;;
    -a|--all)
      STAGE_ALL=1; shift ;;
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
    --no-seed)
      if [[ "$SEED_TOGGLE" == "on" ]]; then
        echo "ship: --no-seed and --reseed are mutually exclusive." >&2
        exit 1
      fi
      SEED_TOGGLE="off"; shift ;;
    --reseed)
      if [[ "$SEED_TOGGLE" == "off" ]]; then
        echo "ship: --no-seed and --reseed are mutually exclusive." >&2
        exit 1
      fi
      SEED_TOGGLE="on"; shift ;;
    -h|--help)
      sed -n '2,42p' "$0"
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

# ----- seed-toggle helper -----
# Stages the SKIP_DEFAULT_SEED secret so the *next* deploy picks it up.
# Skipped when --no-deploy is set (no point staging a secret if we're not
# deploying). Uses --stage so flyctl doesn't trigger its own redeploy here.
apply_seed_toggle() {
  if [[ -z "$SEED_TOGGLE" || "$SKIP_DEPLOY" -eq 1 ]]; then return; fi
  if [[ "$SEED_TOGGLE" == "off" ]]; then
    echo "==> Staging SKIP_DEFAULT_SEED=1 (default-room reseed will be skipped)..."
    flyctl secrets set SKIP_DEFAULT_SEED=1 --stage
  else
    echo "==> Staging removal of SKIP_DEFAULT_SEED (default-room reseed will run again)..."
    flyctl secrets unset SKIP_DEFAULT_SEED --stage || true
  fi
}

# ----- deploy-only short-circuit -----
if [[ "$DEPLOY_ONLY" -eq 1 ]]; then
  apply_seed_toggle
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
# With --all, "changes" means anything in the working tree (respecting
# .gitignore via --exclude-standard); without it, narrow to apps/+packages/.
HAS_CHANGES=0
if ! git diff --quiet HEAD || ! git diff --cached --quiet; then
  HAS_CHANGES=1
fi
if [[ "$STAGE_ALL" -eq 1 ]]; then
  if [[ -n "$(git ls-files --others --exclude-standard)" ]]; then
    HAS_CHANGES=1
  fi
else
  # README.md is tracked already so it shows up via the diff check above;
  # untracked-file detection only needs to scan apps/ and packages/.
  if [[ -n "$(git ls-files --others --exclude-standard apps packages)" ]]; then
    HAS_CHANGES=1
  fi
fi

if [[ "$HAS_CHANGES" -eq 1 ]]; then
  if [[ -z "$MSG" ]]; then
    echo "ship: working tree has changes; commit message required." >&2
    echo "      pass it as the first argument: $0 \"my message\"" >&2
    exit 1
  fi
  if [[ "$STAGE_ALL" -eq 1 ]]; then
    echo "==> Staging all tracked + untracked changes (.gitignore filters)..."
    git add -A
  else
    echo "==> Staging apps + packages + README.md..."
    git add apps packages
    # README.md is included so deploy/changelog notes ride along with code
    # changes. The conditional avoids a fatal error on a brand-new clone
    # where README hasn't been touched.
    if [[ -f README.md ]]; then git add README.md; fi
  fi
  if git diff --cached --quiet; then
    if [[ "$STAGE_ALL" -eq 1 ]]; then
      echo "ship: nothing was staged after 'git add -A' (working tree clean?)." >&2
    else
      echo "ship: nothing was staged (changes were outside apps/, packages/, or README.md?)." >&2
      echo "      retry with --all to include other root-level files, or 'git add' manually." >&2
    fi
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
  apply_seed_toggle
  echo "==> Deploying to fly.io..."
  if [[ "$REMOTE_BUILD" -eq 1 ]]; then
    flyctl deploy --remote-only
  else
    flyctl deploy
  fi
fi

echo "ship: done."
