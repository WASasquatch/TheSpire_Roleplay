#!/usr/bin/env bash
set -euo pipefail
PIDFILE="/tmp/thekeep-web.pid"
if [[ ! -f "$PIDFILE" ]]; then
  echo "no pidfile"
  exit 0
fi
PID="$(cat "$PIDFILE")"
if kill -0 "$PID" 2>/dev/null; then
  kill -- "-$PID" 2>/dev/null || kill "$PID"
  echo "killed pid=$PID"
else
  echo "stale pidfile, pid=$PID not running"
fi
rm -f "$PIDFILE"
