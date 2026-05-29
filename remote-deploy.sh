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
#     origin main, then deploys. All arguments (except --update-msg,
#     handled here) forward straight to ship.sh — see
#     `bash scripts/ship.sh --help` for the full set.
#
#     The --commit / -m / --message value can be either a literal string
#     OR a path to a regular file; when it's a file, ship.sh reads the
#     file's contents as the commit message. Keeping a running log in
#     commit.md and shipping it with `--commit commit.md` is the
#     intended use.
#
#   --update-msg "what's in this release":
#     Short admin-authored note (one sentence) that rides along with the
#     post-deploy "please refresh" banner each user sees when their
#     loaded bundle drifts behind the server. Surfaces below the version
#     lines so users get a hint of what changed before they refresh.
#     The flag is consumed here and stripped before the remaining args
#     are forwarded to ship.sh.
#
#     The message is staged as the fly secret `UPDATE_MESSAGE`. EVERY
#     invocation of this script sets that secret — to the provided text
#     when --update-msg is given, or to the empty string when not — so a
#     message from yesterday's deploy doesn't linger across today's
#     deploy. Empty value reads as "no message" on the server.
#
#     Example:
#       ./remote-deploy.sh --commit "patch login race" --bump patch \
#         --update-msg "fixes the rare login spinner"
#
# Both paths hardcode:
#   --remote-only : build on fly's builders so this dev box doesn't
#                   need cross-platform Docker.
#   --no-seed     : keep SKIP_DEFAULT_SEED=1 staged so admin-renamed
#                   default rooms don't get recreated on next boot.
#
# Item-template force-reseed:
#   Every invocation of this script stages a fresh
#   `FORCE_ITEM_TEMPLATES_RESEED` fly secret with the current
#   timestamp. The server boot sequence reads that value and, when
#   it's set, re-asserts the `{icon}` placeholder on every item's
#   `/give` / `/throw` / `/drop` message template idempotently —
#   so an admin who removed `{icon}` via the admin UI gets it
#   restored on the next deploy.
#
#   SCOPE — read this carefully if you're touching this script.
#   The reseed touches the `items` table ONLY, and only the three
#   message-JSON columns (`give_messages_json`, `throw_messages_json`,
#   `drop_messages_json`) on it. It does NOT touch:
#
#     items.name / description / icon_url / price / stack_limit /
#       aliases_json / category / enabled / for_sale / order
#       — these are item content/admin-tunables. Admins can rename
#         "Cookie" to "Biscuit", repoint the icon to /uploads/…,
#         change pricing, or pull an item from sale via the admin
#         Items panel and those edits are preserved across deploys.
#     ranks / rank_tiers
#       — admin-set rank labels, XP thresholds, sigil URLs, border
#         image URLs, border costs. Migration 0075 even gates each
#         UPDATE on the OLD default value so admin-tuned thresholds
#         survive its one-time run.
#     name_styles / user_owned_name_styles /
#     character_owned_name_styles
#       — admin-authored CSS templates + costs, plus every user's
#         per-style color/config picks. Migration 0070's CSS rewrite
#         already ran once on every existing remote; subsequent
#         admin edits via the admin Name Styles tab are permanent.
#     themes / rooms / worlds / custom_commands / site_settings /
#     user_active_cosmetics / character_earning / borders ownership
#       — everything else admin-customizable.
#
#   The general safety contract: anything seeded by a migration file
#   (rooms 0001-…, ranks/rank_tiers/name_styles in 0065, name-style
#   CSS in 0070-0093, items in 0094/0099/0100/0101/0102/0104/0106/
#   0108, etc.) flows through `apply-migrations.mjs`'s `_migrations`
#   table tracking and runs ONCE per DB. Existing remote installs
#   that already recorded those migrations never re-run them; admin
#   edits via the UI persist across every future deploy. If you
#   want to ship a content refresh for ranks, borders, name styles,
#   or anything else admin-customizable, add a NEW migration file
#   (idempotent UPDATE, ideally gated on old values like 0075) —
#   NOT a force-reseed of this kind.
#
#   The toggle is keyed by timestamp (not a sticky 1/0 flag) so a
#   plain machine restart that DIDN'T come from this script — auto-
#   restart after an OOM, manual `fly machine restart`, etc. — does
#   NOT re-trigger the reseed. Only an actual deploy via this
#   script bumps the value, which is what "force update remote
#   deploy" reads as.

set -euo pipefail
cd "$(dirname "$0")"

# Extract --update-msg before forwarding the rest to ship.sh. ship.sh's
# parser rejects unknown flags hard, so we strip this one here. Every
# OTHER arg is preserved verbatim and order is maintained.
#
# Supported forms:
#   --update-msg "text..."
#   --update-msg=text...
UPDATE_MSG=""
REST=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --update-msg)
      if [[ $# -lt 2 ]]; then
        echo "remote-deploy: --update-msg requires a value." >&2
        exit 1
      fi
      UPDATE_MSG="$2"; shift 2 ;;
    --update-msg=*)
      UPDATE_MSG="${1#--update-msg=}"; shift ;;
    *)
      REST+=("$1"); shift ;;
  esac
done

# Stage the item-templates force-reseed flag for the next deploy.
# `--stage` queues the value with flyctl without triggering its own
# extra restart; ship.sh's flyctl deploy below picks it up cleanly.
# Failure is non-fatal — flyctl might be missing on this box (the
# user runs the deploy on a different machine) or the user might be
# on a network-isolated dev rerun. The deploy path itself will fail
# loudly later if flyctl is actually required, so a soft skip here
# is fine.
TS="$(date +%s)"
if command -v flyctl >/dev/null 2>&1; then
  echo "==> Staging FORCE_ITEM_TEMPLATES_RESEED=$TS (force-reseed item templates on next boot)..."
  flyctl secrets set "FORCE_ITEM_TEMPLATES_RESEED=$TS" --stage >/dev/null || true
  # Always set UPDATE_MESSAGE — to the provided text or to empty —
  # so a leftover from a previous deploy can't linger past the
  # release it described. Server treats empty as "no message" and
  # the stale-version banner renders the version lines alone.
  if [[ -n "$UPDATE_MSG" ]]; then
    echo "==> Staging UPDATE_MESSAGE=\"$UPDATE_MSG\" (shown on the post-deploy refresh banner)..."
  else
    echo "==> Staging UPDATE_MESSAGE=\"\" (no release note this deploy)..."
  fi
  flyctl secrets set "UPDATE_MESSAGE=$UPDATE_MSG" --stage >/dev/null || true
fi

if [[ ${#REST[@]} -eq 0 ]]; then
  exec bash scripts/ship.sh --deploy-only --no-seed --remote-only
fi

exec bash scripts/ship.sh --remote-only --no-seed "${REST[@]}"
