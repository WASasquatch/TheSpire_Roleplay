#!/usr/bin/env bash
# Launches the server fully detached so it survives the parent shell exiting.
# Logs go to /tmp/thekeep-server.log; PID goes to /tmp/thekeep-server.pid.
set -euo pipefail

export PATH="/home/was/.nvm/versions/node/v22.22.2/bin:$PATH"

cd "$(dirname "$0")/.."

LOG="/tmp/thekeep-server.log"
PIDFILE="/tmp/thekeep-server.pid"

if [[ -f "$PIDFILE" ]] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
  echo "already running, pid=$(cat "$PIDFILE")"
  exit 0
fi

setsid nohup npx tsx watch src/index.ts > "$LOG" 2>&1 < /dev/null &
PID=$!
echo "$PID" > "$PIDFILE"
disown
echo "started, pid=$PID, log=$LOG"
