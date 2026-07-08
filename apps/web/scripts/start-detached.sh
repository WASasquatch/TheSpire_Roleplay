#!/usr/bin/env bash
# Launches the Vite dev server fully detached.
set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
# Bind to 0.0.0.0 so it's reachable from Windows host via localhost forwarding
exec bash "$DIR/../../../scripts/detached.sh" start web "$DIR/.." npx vite --host 0.0.0.0 --port 5173
