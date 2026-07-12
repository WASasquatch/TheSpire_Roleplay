#!/usr/bin/env bash
# Stop-hook: enforce the changelog closing step.
#
# Reads the Claude Code Stop-hook JSON on stdin. BLOCKS the stop (emits a
# {"decision":"block","reason":...} JSON) when there are uncommitted code
# changes under apps/ or packages/ AND commit.md is empty/whitespace-only —
# i.e. code changed but the user-facing changelog wasn't updated. Otherwise it
# passes silently (exit 0).
#
# Never hard-traps:
#   - honors `stop_hook_active` (if our own previous block caused this stop, we
#     pass — so at most ONE nudge, and a purely-internal change can bypass by
#     stopping again),
#   - defaults to PASS on any error (missing git, detached state, etc.).
set +e

input="$(cat 2>/dev/null)"

# Loop-breaker: if we already blocked and got re-invoked, let it pass.
printf '%s' "$input" | grep -q '"stop_hook_active"[[:space:]]*:[[:space:]]*true' && exit 0

# Resolve repo root from this script's location (scripts/..).
cd "$(dirname "$0")/.." 2>/dev/null || exit 0

# Any uncommitted change under apps/ or packages/? (tracked edits/deletes OR new files)
changed=""
git diff --quiet HEAD -- apps packages 2>/dev/null || changed=1
if [ -z "$changed" ] && [ -n "$(git ls-files --others --exclude-standard apps packages 2>/dev/null | head -1)" ]; then
  changed=1
fi
[ -z "$changed" ] && exit 0

# commit.md has real (non-whitespace) content? → assume it's being maintained, pass.
if [ -s commit.md ] && grep -q '[^[:space:]]' commit.md 2>/dev/null; then
  exit 0
fi

# Code changed but commit.md is empty → nudge.
cat <<'JSON'
{"decision":"block","reason":"Code changed under apps/ or packages/ but commit.md is empty. Before finishing: update commit.md with user-facing entries (line 1 = pipe-joined verb titles like 'Add x | Patch y'; then one verb-prefixed bullet each), and updates.md if a player would notice. NO internal/refactor/tooling/lint/test notes — only what a user or admin can actually see or use. If this change is purely internal with nothing user-facing, just stop again to bypass this one-time reminder."}
JSON
exit 0
