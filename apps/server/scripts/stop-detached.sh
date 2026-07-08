#!/usr/bin/env bash
set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
exec bash "$DIR/../../../scripts/detached.sh" stop server
