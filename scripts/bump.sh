#!/usr/bin/env bash
# bump.sh - increment the SemVer-ish version in packages/shared/src/version.ts.
#
# Usage:
#   ./scripts/bump.sh patch   # 0.6.0 -> 0.6.1   (bug fixes, small adjustments)
#   ./scripts/bump.sh minor   # 0.6.0 -> 0.7.0   (milestone progress pre-1.0)
#   ./scripts/bump.sh major   # 0.6.0 -> 1.0.0   (feature-complete / API settled)
#   pnpm bump:patch / pnpm bump:minor / pnpm bump:major  (root aliases)
#
# Or pipe through ship.sh: `pnpm ship "msg" --bump patch` bumps + commits +
# pushes + deploys in one shot so the version landing on prod is the same
# version that's marked in the commit history.
#
# Idempotent on the file format - we sed-replace the literal `VERSION = "x.y.z"`
# token. If the format ever changes (e.g. a build-info object) this script
# needs updating too; that's intentional - the version file is small and the
# bump is the one operation we want to be unambiguous.

set -euo pipefail

cd "$(dirname "$0")/.."

LEVEL="${1:-}"
case "$LEVEL" in
  patch|minor|major) ;;
  "")
    echo "bump: missing level. usage: $0 patch|minor|major" >&2
    exit 1
    ;;
  *)
    echo "bump: unknown level '$LEVEL'. expected patch|minor|major" >&2
    exit 1
    ;;
esac

FILE="packages/shared/src/version.ts"
if [[ ! -f "$FILE" ]]; then
  echo "bump: $FILE not found - run from the repo root" >&2
  exit 1
fi

# Pull the current version out of the file. The grep regex is intentionally
# narrow (anchored to `VERSION = "..."`) so any other `0.6.0`-shaped string
# in comments doesn't get picked up.
CURRENT=$(grep -oE 'VERSION[[:space:]]*=[[:space:]]*"[0-9]+\.[0-9]+\.[0-9]+"' "$FILE" \
  | head -1 \
  | grep -oE '[0-9]+\.[0-9]+\.[0-9]+')

if [[ -z "$CURRENT" ]]; then
  echo "bump: could not parse current version from $FILE" >&2
  exit 1
fi

IFS='.' read -r MAJ MIN PAT <<< "$CURRENT"

case "$LEVEL" in
  patch) PAT=$((PAT + 1)) ;;
  minor) MIN=$((MIN + 1)); PAT=0 ;;
  major) MAJ=$((MAJ + 1)); MIN=0; PAT=0 ;;
esac

NEW="$MAJ.$MIN.$PAT"

# In-place edit. The expression matches `VERSION = "..."` with flexible
# whitespace and writes back with single-space canonical form.
sed -i -E "s/VERSION[[:space:]]*=[[:space:]]*\"[0-9]+\.[0-9]+\.[0-9]+\"/VERSION = \"$NEW\"/" "$FILE"

echo "$CURRENT -> $NEW"
