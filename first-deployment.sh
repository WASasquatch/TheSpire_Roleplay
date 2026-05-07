#!/usr/bin/env bash
# first-deployment.sh — bootstrap a fresh Fly.io deployment of The Spire.
#
# Use this ONCE per fresh Fly app. After it succeeds, use ./remote-deploy.sh
# or `pnpm ship` for routine deploys (those keep SKIP_DEFAULT_SEED=1 so
# admin-renamed default rooms don't spawn duplicates on every boot).
#
# Idempotent: every step checks whether it's already been done. Safe to
# rerun if a previous attempt failed partway through.
#
# What it does:
#   1. Verify prerequisites (flyctl, openssl, git on main, working tree clean)
#   2. Read app name + primary region from fly.toml
#   3. Create the Fly app if it doesn't exist
#   4. Generate + stage SESSION_SECRET if not already set (32 bytes hex)
#   5. Create the persistent SQLite volume if not already present
#   6. Clear any leftover SKIP_DEFAULT_SEED secret so default rooms WILL
#      be seeded on first boot
#   7. Run `flyctl deploy --remote-only` (Fly's builders, no local Docker)
#   8. Print follow-up instructions (register first account, customize, etc.)

set -euo pipefail

cd "$(dirname "$0")"

# ----- prereqs -----
command -v flyctl >/dev/null || {
  echo "flyctl not found. Install:  curl -L https://fly.io/install.sh | sh" >&2
  exit 1
}
command -v openssl >/dev/null || {
  echo "openssl not found - required to generate SESSION_SECRET." >&2
  exit 1
}
if ! flyctl auth whoami >/dev/null 2>&1; then
  echo "Not logged in to Fly. Run:  flyctl auth login" >&2
  exit 1
fi

if [[ ! -f fly.toml ]]; then
  echo "fly.toml not found at repo root. Are you running this from the project directory?" >&2
  exit 1
fi

BRANCH="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "")"
if [[ "$BRANCH" != "main" ]]; then
  echo "Current branch is '$BRANCH'. Switch to main before the first deploy:" >&2
  echo "  git checkout main" >&2
  exit 1
fi

# Working tree must be clean - the deploy uploads the repo state to Fly's
# builder, so uncommitted changes ship without a paper trail. Refuse rather
# than risk that on a first deploy where the source-of-truth matters most.
if ! git diff --quiet HEAD || ! git diff --cached --quiet; then
  echo "Working tree has uncommitted changes. Commit or stash before first deploy." >&2
  git status --short >&2
  exit 1
fi

# ----- read fly.toml -----
APP_NAME="$(awk -F'"' '/^app[[:space:]]*=/ { print $2; exit }' fly.toml)"
PRIMARY_REGION="$(awk -F'"' '/^primary_region[[:space:]]*=/ { print $2; exit }' fly.toml)"

if [[ -z "$APP_NAME" || -z "$PRIMARY_REGION" ]]; then
  echo "Could not parse 'app' and 'primary_region' from fly.toml." >&2
  exit 1
fi

echo "==> First deployment for app '$APP_NAME' in region '$PRIMARY_REGION'"
echo "    Logged in to Fly as: $(flyctl auth whoami)"
echo

# ----- 1. Fly app -----
# `flyctl status --app NAME` exits non-zero with "Could not find App" when
# the app doesn't exist. Use that as the existence test instead of parsing
# `flyctl apps list` (which paginates and changes format across versions).
if flyctl status --app "$APP_NAME" >/dev/null 2>&1; then
  echo "==> Fly app '$APP_NAME' already exists, skipping creation."
else
  echo "==> Creating Fly app '$APP_NAME'..."
  # If the name is taken globally, this fails fast with a clear error
  # message. The user then has to edit fly.toml to use a different name.
  flyctl apps create --name "$APP_NAME"
fi

# ----- 2. SESSION_SECRET -----
# `flyctl secrets list` includes a column for the digest, not the value
# (Fly never exposes secret values after they're set). We just need to
# know whether the name is in the list.
if flyctl secrets list --app "$APP_NAME" 2>/dev/null | awk 'NR>1 {print $1}' | grep -qx "SESSION_SECRET"; then
  echo "==> SESSION_SECRET already set on '$APP_NAME', skipping."
else
  echo "==> Generating + staging SESSION_SECRET (32-byte hex)..."
  # --stage queues the secret for the next deploy without triggering a
  # release on its own (we'll deploy at the end and pick it up then).
  flyctl secrets set --app "$APP_NAME" --stage \
    "SESSION_SECRET=$(openssl rand -hex 32)" >/dev/null
  echo "    SESSION_SECRET staged. It will activate on the deploy below."
fi

# ----- 3. Volume -----
# `volumes list` output: ID  STATE  NAME  SIZE  REGION ...
# We match on the NAME column. If a previous attempt created one in a
# different region, we leave it alone and let the deploy figure it out -
# better than silently creating a second volume.
if flyctl volumes list --app "$APP_NAME" 2>/dev/null | awk 'NR>1 {print $3}' | grep -qx "thespire_data"; then
  echo "==> Volume 'thespire_data' already exists, skipping."
else
  echo "==> Creating 1GB volume 'thespire_data' in '$PRIMARY_REGION'..."
  # -y skips the "single-region volume" confirmation prompt. For a starter
  # deploy, single region is what fly.toml expects (one mount, one machine).
  flyctl volumes create thespire_data \
    --app "$APP_NAME" \
    --size 1 \
    --region "$PRIMARY_REGION" \
    -y >/dev/null
fi

# ----- 4. Clear SKIP_DEFAULT_SEED if present -----
# Routine deploys (./remote-deploy.sh) set this to keep custom rooms
# untouched. For the FIRST deploy we want the opposite: let the seed
# create The_Spire / Tavern / Library / Garden / Bazaar so the app
# isn't an empty room list after register.
if flyctl secrets list --app "$APP_NAME" 2>/dev/null | awk 'NR>1 {print $1}' | grep -qx "SKIP_DEFAULT_SEED"; then
  echo "==> Clearing leftover SKIP_DEFAULT_SEED so default rooms get seeded on boot..."
  flyctl secrets unset --app "$APP_NAME" --stage SKIP_DEFAULT_SEED >/dev/null
fi

# ----- 5. Deploy -----
echo
echo "==> Deploying (remote builder, default-room seeding ENABLED)..."
echo
flyctl deploy --remote-only --app "$APP_NAME"

# ----- post-deploy info -----
APP_URL="https://${APP_NAME}.fly.dev/"
cat <<EOF

✓ First deployment complete.
  App URL: $APP_URL

Next steps:
  1. Open $APP_URL and REGISTER THE FIRST ACCOUNT.
     The first registered user is auto-promoted to admin (the "keymaster" -
     they cannot be demoted by anyone, see apps/server/src/commands/builtins/mod.ts).

  2. Sign in, open the Admin panel (banner -> Admin) and customize:
     - Branding tab: site name, logo, banner cover, welcome message,
       SEO description, optional analytics snippet.
     - Settings tab: retention windows, capacity caps, theme defaults.
     - Rules tab: house rules + privacy notice rendered in the Rules modal.

  3. Once you've renamed or customized any default rooms, every future
     deploy should use:

         ./remote-deploy.sh

     which sets SKIP_DEFAULT_SEED=1 to stop the boot-time seed from
     re-creating same-named default rooms (would otherwise spawn
     duplicates next to your renamed copies).

  4. To re-seed (e.g. you wiped the DB and want defaults back), use:

         pnpm ship "msg" --reseed --remote-only

EOF
