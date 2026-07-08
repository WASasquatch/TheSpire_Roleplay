#!/usr/bin/env bash
# Register a brand-new user and immediately promote to admin.
# Usage: ./register-and-promote.sh <username> <password>
set -euo pipefail

U="${1:-AdminSmoke$RANDOM}"
PW="${2:-hunter2hunter2}"
EMAIL="$(echo "$U" | tr '[:upper:]' '[:lower:]')@t.local"

# Source node-env.sh with the repo root resolved from THIS script's location
# BEFORE the cd below. A relative $0/BASH_SOURCE resolved after the cd would
# point at the repo's parent and miss scripts/node-env.sh (aborting under set -e).
source "$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)/scripts/node-env.sh"
export PATH="$NODE_V22_BIN:$PATH"

cd "$(dirname "$0")/.."

echo "Registering $U ($EMAIL)…"
curl -sS -X POST http://127.0.0.1:3001/auth/register \
  -H 'Content-Type: application/json' \
  -d "{\"email\":\"$EMAIL\",\"username\":\"$U\",\"password\":\"$PW\"}"
echo
echo
node scripts/promote-admin.mjs "$U"
echo
echo "User $U is now admin. Password: $PW"
