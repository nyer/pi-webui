#!/usr/bin/env bash
# pi-webui control script
#
#   ./start.sh start     start in the background (default)
#   ./start.sh stop      stop the running instance
#   ./start.sh restart   stop then start
#   ./start.sh status    show status + health
#   ./start.sh logs      tail the log file
#
# Extra arguments are forwarded to server.mjs, e.g.
#   ./start.sh restart --session ~/.pi/agent/sessions/xxx.jsonl
set -eo pipefail

APP="pi-webui"
cd "$(dirname "$0")"
ROOT="$PWD"
SERVER="$ROOT/server.mjs"
RUN_DIR="$ROOT/.run"
PID_FILE="$RUN_DIR/$APP.pid"
PORT_FILE="$RUN_DIR/$APP.port"
HOST_FILE="$RUN_DIR/$APP.host"
LOG_FILE="$RUN_DIR/$APP.log"
NODE_BIN="${NODE_BIN:-node}"
PORT="${PI_WEBUI_PORT:-8787}"
HOST="${PI_WEBUI_HOST:-127.0.0.1}"

mkdir -p "$RUN_DIR"

usage() {
  cat <<EOF
Usage: ./start.sh <command> [server options]

Commands:
  start      Start $APP in the background (default)
  stop       Stop the running instance (and any stray server.mjs)
  restart    Stop then start
  status     Show pid, URL, and health
  logs       Tail $LOG_FILE

Server options are forwarded to server.mjs, e.g. --port, --host,
--session, --provider, --model, --thinking.

Environment:
  PI_WEBUI_PORT          listen port           (default 8787)
  PI_WEBUI_HOST          bind host             (default 127.0.0.1)
  PI_WEBUI_SESSIONS_ROOT sessions directory    (default ~/.pi/agent/sessions)
  PI_WEBUI_FORK=1        always fork PI_SESSION_FILE into a new session
                         (default: reuse this project's newest session)
  PI_SESSION_FILE        session to fork for context (auto-detected)
  PI_PROVIDER            provider              (auto-detected)
  PI_MODEL               model                 (auto-detected)
  PI_REASONING_LEVEL     thinking level        (auto-detected)
  NODE_BIN               node binary           (default: node)

Examples:
  ./start.sh
  ./start.sh restart
  PI_WEBUI_PORT=9000 ./start.sh restart
  ./start.sh start --session ~/.pi/agent/sessions/xxx.jsonl
EOF
}

# ---------------------------------------------------------------- helpers

pid_of() { cat "$PID_FILE" 2>/dev/null || true; }

is_running() {
  local pid
  pid="$(pid_of)"
  [ -n "$pid" ] || return 1
  kill -0 "$pid" 2>/dev/null
}

# server.mjs processes not tracked by our pid file (started by hand, etc.)
stray_pids() { pgrep -f "node .*server\.mjs" 2>/dev/null || true; }

health() { curl -fsS "http://${HOST}:${PORT}/health" 2>/dev/null || true; }

# status/logs should reflect the port/host the instance was actually started with
load_runtime_env() {
  if [ -f "$PORT_FILE" ]; then PORT="$(cat "$PORT_FILE")"; fi
  if [ -f "$HOST_FILE" ]; then HOST="$(cat "$HOST_FILE")"; fi
}

wait_gone() { # pid
  local pid="$1" i
  for i in $(seq 1 25); do
    kill -0 "$pid" 2>/dev/null || return 0
    sleep 0.2
  done
  return 1
}

kill_tree() { # pid  [signal]
  local pid="$1" sig="${2:-TERM}"
  pkill -"$sig" -P "$pid" 2>/dev/null || true   # child: pi --mode rpc
  kill -"$sig" "$pid" 2>/dev/null || true
}

# ---------------------------------------------------------------- commands

do_start() {
  if is_running; then
    echo "[$APP] already running (pid $(pid_of)) -> http://${HOST}:${PORT}"
    return 0
  fi
  rm -f "$PID_FILE"

  # let --port in the forwarded args drive the health check too
  local prev="" a
  for a in "$@"; do
    [ "$prev" = "--port" ] && PORT="$a"
    prev="$a"
  done

  local args=()

  # Reuse this project's most recent session instead of forking a fresh copy on
  # every restart (which piled up duplicate fork chains). Set PI_WEBUI_FORK=1 to
  # force a new fork of PI_SESSION_FILE.
  local proj_dir_name sessions_dir newest
  proj_dir_name="--$(printf '%s' "$ROOT" | sed 's#^/##; s#/#-#g')--"
  sessions_dir="${PI_WEBUI_SESSIONS_ROOT:-$HOME/.pi/agent/sessions}/$proj_dir_name"
  newest="$(ls -t "$sessions_dir"/*.jsonl 2>/dev/null | head -n 1 || true)"

  if [ "${PI_WEBUI_FORK:-0}" = "1" ] && [ -n "${PI_SESSION_FILE:-}" ]; then
    args+=(--fork "$PI_SESSION_FILE")
  elif [ -n "$newest" ]; then
    args+=(--session "$newest")
  elif [ -n "${PI_SESSION_FILE:-}" ]; then
    args+=(--fork "$PI_SESSION_FILE")
  fi

  if [ -n "${PI_PROVIDER:-}" ];        then args+=(--provider "$PI_PROVIDER"); fi
  if [ -n "${PI_MODEL:-}" ];           then args+=(--model "$PI_MODEL"); fi
  if [ -n "${PI_REASONING_LEVEL:-}" ]; then args+=(--thinking "$PI_REASONING_LEVEL"); fi

  echo "[$APP] starting on ${HOST}:${PORT}"
  PI_WEBUI_PORT="$PORT" PI_WEBUI_HOST="$HOST" \
    nohup "$NODE_BIN" "$SERVER" "${args[@]}" "$@" >"$LOG_FILE" 2>&1 &
  local pid=$!
  echo "$pid" >"$PID_FILE"
  echo "$PORT" >"$PORT_FILE"
  echo "$HOST" >"$HOST_FILE"

  local i
  for i in $(seq 1 40); do
    if ! kill -0 "$pid" 2>/dev/null; then
      echo "[$APP] failed to start. Last log lines:"
      tail -n 20 "$LOG_FILE" 2>/dev/null || true
      rm -f "$PID_FILE" "$PORT_FILE" "$HOST_FILE"
      return 1
    fi
    if [ -n "$(health)" ]; then
      echo "[$APP] started (pid $pid) -> http://${HOST}:${PORT}"
      echo "[$APP] log: $LOG_FILE"
      return 0
    fi
    sleep 0.2
  done
  echo "[$APP] started (pid $pid) but health check timed out; see $LOG_FILE"
}

do_stop() {
  local stopped=0 pid sp

  if is_running; then
    pid="$(pid_of)"
    echo "[$APP] stopping (pid $pid)"
    kill_tree "$pid" TERM
    if ! wait_gone "$pid"; then
      echo "[$APP] force killing (pid $pid)"
      kill_tree "$pid" KILL
    fi
    stopped=1
  fi
  rm -f "$PID_FILE" "$PORT_FILE" "$HOST_FILE"

  sp="$(stray_pids)"
  if [ -n "$sp" ]; then
    echo "[$APP] stopping stray instance(s): $(echo $sp | tr '\n' ' ')"
    for pid in $sp; do kill_tree "$pid" TERM; done
    sleep 1
    sp="$(stray_pids)"
    if [ -n "$sp" ]; then for pid in $sp; do kill_tree "$pid" KILL; done; fi
    stopped=1
  fi

  if [ "$stopped" = 1 ]; then echo "[$APP] stopped"; else echo "[$APP] not running"; fi
}

do_status() {
  load_runtime_env
  if is_running; then
    echo "[$APP] running (pid $(pid_of))"
    echo "  url:    http://${HOST}:${PORT}"
    local h; h="$(health)"
    echo "  health: ${h:-unreachable}"
    echo "  log:    $LOG_FILE"
  else
    echo "[$APP] stopped"
    local sp; sp="$(stray_pids)"
    if [ -n "$sp" ]; then
      echo "  note: untracked server.mjs running: $(echo $sp | tr '\n' ' ')"
    fi
  fi
}

do_logs() {
  load_runtime_env
  [ -f "$LOG_FILE" ] || { echo "[$APP] no log yet ($LOG_FILE)"; return 1; }
  tail -n 50 -f "$LOG_FILE"
}

# ---------------------------------------------------------------- dispatch

CMD="${1:-start}"
if [ $# -gt 0 ]; then shift; fi

case "$CMD" in
  start)   do_start "$@" ;;
  stop)    do_stop ;;
  restart) do_stop; do_start "$@" ;;
  status)  do_status ;;
  logs)    do_logs ;;
  -h|--help|help) usage ;;
  *) echo "[$APP] unknown command: $CMD"; echo; usage; exit 1 ;;
esac
