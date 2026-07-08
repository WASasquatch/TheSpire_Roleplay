#!/usr/bin/env bash
# Launches the server fully detached so it survives the parent shell exiting.
# Logs go to /tmp/thekeep-server.log; PID goes to /tmp/thekeep-server.pid.
set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
exec bash "$DIR/../../../scripts/detached.sh" start server "$DIR/.." npx tsx watch src/index.ts
