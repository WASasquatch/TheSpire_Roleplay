#!/usr/bin/env bash
# Launches the Vite dev server fully detached.
set -euo pipefail

export PATH="/home/was/.nvm/versions/node/v22.22.2/bin:$PATH"

cd "$(dirname "$0")/.."

LOG="/tmp/thekeep-web.log"
PIDFILE="/tmp/thekeep-web.pid"

if [[ -f "$PIDFILE" ]] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
  echo "already running, pid=$(cat "$PIDFILE")"
  exit 0
fi

# Bind to 0.0.0.0 so it's reachable from Windows host via localhost forwarding
setsid nohup npx vite --host 0.0.0.0 --port 5173 > "$LOG" 2>&1 < /dev/null &
PID=$!
echo "$PID" > "$PIDFILE"
disown
echo "started, pid=$PID, log=$LOG"
