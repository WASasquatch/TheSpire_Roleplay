#!/usr/bin/env bash
# Parameterized detached-process manager shared by the server/web dev scripts.
# Usage:
#   detached.sh start <name> <workdir> <cmd...>   # launch fully detached
#   detached.sh stop  <name>                      # stop a previously started process
# Logs go to /tmp/thekeep-<name>.log; PID goes to /tmp/thekeep-<name>.pid.
set -euo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/node-env.sh"
export PATH="$NODE_V22_BIN:$PATH"

ACTION="$1"
NAME="$2"

LOG="/tmp/thekeep-${NAME}.log"
PIDFILE="/tmp/thekeep-${NAME}.pid"

case "$ACTION" in
  start)
    WORKDIR="$3"
    shift 3
    cd "$WORKDIR"

    if [[ -f "$PIDFILE" ]] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
      echo "already running, pid=$(cat "$PIDFILE")"
      exit 0
    fi

    setsid nohup "$@" > "$LOG" 2>&1 < /dev/null &
    PID=$!
    echo "$PID" > "$PIDFILE"
    disown
    echo "started, pid=$PID, log=$LOG"
    ;;
  stop)
    if [[ ! -f "$PIDFILE" ]]; then
      echo "no pidfile"
      exit 0
    fi
    PID="$(cat "$PIDFILE")"
    if kill -0 "$PID" 2>/dev/null; then
      # kill the whole process group (setsid created one)
      kill -- "-$PID" 2>/dev/null || kill "$PID"
      echo "killed pid=$PID"
    else
      echo "stale pidfile, pid=$PID not running"
    fi
    rm -f "$PIDFILE"
    ;;
  *)
    echo "usage: detached.sh {start <name> <workdir> <cmd...>|stop <name>}" >&2
    exit 1
    ;;
esac
