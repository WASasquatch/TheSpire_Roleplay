#!/usr/bin/env bash
# ship.sh - one-shot commit + push + flyctl deploy for The Spire.
#
# Default flow:
#   1. Refuse to run from a non-main branch (use git directly for PR work)
#   2. Type-check shared / server / web (catch obvious mistakes pre-deploy)
#   3. Stage all tracked-file modifications (`git add -u` across the whole
#      repo) PLUS new untracked files under apps/ + packages/. The -u
#      pass catches edits to root-level deploy / build infra
#      (fly.toml, Dockerfile, .dockerignore, pnpm-workspace.yaml,
#      tsconfig.base.json, scripts/*.sh, remote-deploy.sh,
#      local-deploy.sh, first-deployment.sh) so those changes always
#      ship without having to remember --all. Untracked-file gating
#      stays in place for the project root, so a stray .env or scratch
#      file there can't sneak into a commit. Use --all to also pick up
#      NEW untracked root-level files (e.g. a brand-new Dockerfile.dev).
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
#                        If TEXT is the path to an existing regular file,
#                        the file's contents are used as the message,
#                        handy for keeping a multi-paragraph log in
#                        commit.md and shipping it with --commit commit.md.
#   --commit TEXT        Alias for --message. Reads more naturally when
#                        called via remote-deploy.sh (`--commit "msg"`
#                        or `--commit commit.md`).
#   -a, --all            Stage with `git add -A` instead of the narrow
#                        apps/+packages/+README.md default. Use when
#                        shipping changes to other root-level files
#                        (fly.toml, Dockerfile, scripts/, etc.). .gitignore
#                        still filters.
#   --no-typecheck       Skip the pre-commit typecheck pass (faster, riskier).
#   --no-test            Skip the pre-commit test suite (faster, riskier).
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
#   --bump LEVEL         Bump the version in packages/shared/src/version.ts
#                        before staging. LEVEL is one of: patch, minor, major.
#                        The edit is included in the same commit so the
#                        version landing on prod matches the commit history.
#                        Ignored when --deploy-only is also set (no commit
#                        happens in that mode).
#   -h, --help           Show this help text.

set -euo pipefail

# Mirror the path setup in apps/{server,web}/scripts/start-detached.sh -
# the system Node 18 on this dev box can't run better-sqlite3 (built against
# v22) so any typecheck involving the server package fails ABI checks.
# Harmless if v22 is the default.
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/node-env.sh"
if [[ -d "$NODE_V22_BIN" ]]; then
  export PATH="$NODE_V22_BIN:$PATH"
fi

cd "$(dirname "$0")/.."

# ----- args -----
MSG=""
SKIP_TYPECHECK=0
SKIP_TEST=0
SKIP_PUSH=0
SKIP_DEPLOY=0
DEPLOY_ONLY=0
REMOTE_BUILD=0
STAGE_ALL=0
SEED_TOGGLE=""   # "off" → set SKIP_DEFAULT_SEED=1; "on" → unset; "" → leave alone
BUMP_LEVEL=""    # "patch" / "minor" / "major" or "" to skip the version bump

while [[ $# -gt 0 ]]; do
  case "$1" in
    -m|--message|--commit)
      MSG="$2"; shift 2 ;;
    -a|--all)
      STAGE_ALL=1; shift ;;
    --no-typecheck)
      SKIP_TYPECHECK=1; shift ;;
    --no-test)
      SKIP_TEST=1; shift ;;
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
    --bump)
      case "${2:-}" in
        patch|minor|major) BUMP_LEVEL="$2"; shift 2 ;;
        "")
          echo "ship: --bump requires a level (patch|minor|major)." >&2
          exit 1 ;;
        *)
          echo "ship: --bump level must be patch|minor|major (got '${2}')." >&2
          exit 1 ;;
      esac ;;
    -h|--help)
      sed -n '2,64p' "$0"
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

# ----- message-from-file -----
# If the supplied message is a path to a regular file, slurp the file's
# contents as the commit message. Lets `--commit commit.md` work the
# same way `git commit -F commit.md` would. The detection is "exists +
# is a file"; anything else (including a literal message that contains
# spaces, punctuation, or a path that doesn't exist) is treated as a
# verbatim message. Empty / whitespace-only files are rejected so a
# stale or never-written commit.md doesn't produce a blank commit.
if [[ -n "$MSG" && -f "$MSG" ]]; then
  MSG_SRC="$MSG"
  MSG="$(cat "$MSG_SRC")"
  if [[ -z "${MSG//[[:space:]]/}" ]]; then
    echo "ship: --commit file '$MSG_SRC' is empty (or whitespace-only)." >&2
    exit 1
  fi
  echo "==> Using commit message from $MSG_SRC ($(wc -l <"$MSG_SRC" | tr -d ' ') line(s))."
fi

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

# ----- version bump -----
# Done BEFORE typecheck + staging so the bumped version.ts is part of the
# same commit as the changes it represents. The bump script is a tiny
# string substitution that can't fail typecheck, but running typecheck
# after it (rather than before) means the committed state is what we
# actually validated.
if [[ -n "$BUMP_LEVEL" ]]; then
  echo "==> Bumping version ($BUMP_LEVEL)..."
  bash scripts/bump.sh "$BUMP_LEVEL"
fi

# ----- typecheck -----
if [[ "$SKIP_TYPECHECK" -eq 0 ]]; then
  echo "==> Type-checking..."
  pnpm --filter @thekeep/shared exec tsc --noEmit
  pnpm --filter @thekeep/server exec tsc --noEmit
  pnpm --filter @thekeep/web exec tsc --noEmit
fi

# ----- tests (BLOCKING gate) -----
# The Node test suite (apps/server/test/*.test.ts) must pass before a deploy.
# Only the server package has tests today; add other packages' `test` scripts
# here as they gain suites. --no-test skips for the rare emergency redeploy.
if [[ "$SKIP_TEST" -eq 0 ]]; then
  echo "==> Running tests..."
  pnpm --filter @thekeep/server run test
fi

# ----- lint + format check (NON-BLOCKING, informational) -----
# Governance surface (plan_ext.md §5/§6): lint is warn-only and Prettier is
# report-only for now, so neither aborts a deploy — they just surface drift.
# `|| true` keeps `set -e` from treating a nonzero exit as fatal.
echo "==> Lint (warnings are non-blocking)..."
pnpm lint || echo "ship: lint reported issues (non-blocking; run 'pnpm lint')."
echo "==> Prettier check (non-blocking)..."
pnpm format:check >/dev/null 2>&1 \
  && echo "ship: formatting clean." \
  || echo "ship: some files aren't Prettier-formatted (non-blocking; run 'pnpm format')."

# ----- stage + commit -----
# Whether we have anything to commit determines whether MSG is required.
# With --all, "changes" means anything in the working tree (respecting
# .gitignore via --exclude-standard); without it, narrow to apps/+packages/
# (+ README.md + pnpm-lock.yaml + root package.json, which are all tracked
# so the initial `git diff HEAD` already catches edits to them).
HAS_CHANGES=0
if ! git diff --quiet HEAD || ! git diff --cached --quiet; then
  HAS_CHANGES=1
fi
if [[ "$STAGE_ALL" -eq 1 ]]; then
  if [[ -n "$(git ls-files --others --exclude-standard)" ]]; then
    HAS_CHANGES=1
  fi
else
  # README.md, pnpm-lock.yaml, and root package.json are tracked already
  # so they show up via the diff check above; untracked-file detection
  # only needs to scan apps/ and packages/.
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
    # Narrow stage with two complementary passes:
    #
    #   1. `git add -u`, stages MODIFICATIONS + DELETIONS for every
    #      tracked file in the repo. Catches edits to root-level
    #      deploy / build infra (fly.toml, Dockerfile, .dockerignore,
    #      pnpm-workspace.yaml, tsconfig.base.json, scripts/*.sh,
    #      remote-deploy.sh, local-deploy.sh, first-deployment.sh)
    #      so an admin who tunes any of those for a deploy doesn't
    #      have to remember --all every time. Untracked files at
    #      root are still gated to --all so a stray .env or scratch
    #      file in the project root never sneaks into a commit.
    #
    #   2. `git add apps packages`, picks up NEW untracked files
    #      under apps/+packages/ (the only places where new source
    #      should land). New files at root keep needing --all.
    #
    # The combo means any tracked file's modifications always ship,
    # which closes the silent-skip gap that bit deploy-infra edits
    # in the past.
    echo "==> Staging tracked-file modifications + new files in apps/packages..."
    git add -u
    git add apps packages
    # README.md is included so deploy/changelog notes ride along with
    # code changes. Already covered by `git add -u` when modified;
    # the explicit add handles the brand-new-clone edge case where the
    # file exists but isn't yet tracked.
    if [[ -f README.md ]]; then git add README.md; fi
    # pnpm-lock.yaml + root package.json, already covered by
    # `git add -u` when modified. Kept here as explicit no-ops so the
    # intent ("workspace edits ALWAYS ship with their lockfile bump")
    # stays loud in the script. Without the matching lockfile,
    # Docker's `pnpm install --frozen-lockfile` fails the deploy.
    if [[ -f pnpm-lock.yaml ]]; then git add pnpm-lock.yaml; fi
    if [[ -f package.json ]]; then git add package.json; fi
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
  # DON'T clear commit.md here. Its contents are now in the commit, but if the
  # push or deploy below crashes we'd have wiped the running change-log while
  # the work sits committed-but-undeployed — and a retry would have no message
  # to ship (this exact bug lost a batch once). Defer the clear to the very end
  # of the script, after push + deploy BOTH succeed (`set -e` aborts before
  # then on any failure). Just remember we committed from a file so the
  # end-of-script step knows to clear it. (A literal `-m` message sets no
  # MSG_SRC, so there's nothing to clear.)
  if [[ -n "${MSG_SRC:-}" && -f "$MSG_SRC" ]]; then
    CLEAR_MSG_SRC_ON_SUCCESS=1
  fi
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

# Everything above succeeded (`set -e` would have aborted the script on any
# failure). ONLY NOW is it safe to empty the running change-log so the next
# batch starts clean — deferred from the commit step so a push/deploy crash
# never wipes commit.md while the work is committed-but-undeployed. gitignored,
# so truncating never dirties the tree.
if [[ "${CLEAR_MSG_SRC_ON_SUCCESS:-0}" -eq 1 && -n "${MSG_SRC:-}" && -f "${MSG_SRC}" ]]; then
  : > "$MSG_SRC"
  echo "==> Cleared $MSG_SRC for the next batch."
fi

echo "ship: done."
