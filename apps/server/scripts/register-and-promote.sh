#!/usr/bin/env bash
# Register a brand-new user and immediately promote to admin.
# Usage: ./register-and-promote.sh <username> <password>
set -euo pipefail

U="${1:-AdminSmoke$RANDOM}"
PW="${2:-hunter2hunter2}"
EMAIL="$(echo "$U" | tr '[:upper:]' '[:lower:]')@t.local"

cd "$(dirname "$0")/.."
export PATH="/home/was/.nvm/versions/node/v22.22.2/bin:$PATH"

echo "Registering $U ($EMAIL)…"
curl -sS -X POST http://127.0.0.1:3001/auth/register \
  -H 'Content-Type: application/json' \
  -d "{\"email\":\"$EMAIL\",\"username\":\"$U\",\"password\":\"$PW\"}"
echo
echo
node scripts/promote-admin.mjs "$U"
echo
echo "User $U is now admin. Password: $PW"
