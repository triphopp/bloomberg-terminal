#!/usr/bin/env bash
# bloomberg.sh — Bloomberg Terminal launcher (Linux / macOS)
# Usage: bloomberg [start|stop|status|logs|restart|open]
# Install globally: bash scripts/install.sh

set -euo pipefail

# ── Paths ─────────────────────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
PID_FILE="${TMPDIR:-/tmp}/bloomberg-terminal.pids"
LOG_DIR="$PROJECT_ROOT/logs"
BACKEND_LOG="$LOG_DIR/backend.log"
FRONTEND_LOG="$LOG_DIR/frontend.log"

# ── Env vars (edit to match your machine) ────────────────────────────────────
CLIPPINGS_DIR="${CLIPPINGS_DIR:-$HOME/obsidian/Clippings}"
THESES_DIR="${THESES_DIR:-$HOME/obsidian/wiki/theses}"
SOURCES_DIR="${SOURCES_DIR:-$HOME/obsidian/wiki/sources}"
OLLAMA_URL="${OLLAMA_URL:-http://localhost:11434}"

# ── Colors ────────────────────────────────────────────────────────────────────
GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; CYAN='\033[0;36m'; NC='\033[0m'
ok()   { echo -e "  ${GREEN}[OK]${NC} $1"; }
err()  { echo -e " ${RED}[ERR]${NC} $1"; }
info() { echo -e "  ${YELLOW}[..]${NC} $1"; }

# ── Detect OS ─────────────────────────────────────────────────────────────────
detect_os() {
    case "$(uname -s)" in
        Darwin*) echo "macos" ;;
        Linux*)  echo "linux" ;;
        *)       echo "unknown" ;;
    esac
}
OS=$(detect_os)

# ── Python / npm detection ────────────────────────────────────────────────────
find_python() {
    for cmd in python3 python; do
        if command -v "$cmd" &>/dev/null; then echo "$cmd"; return; fi
    done
    err "Python not found"; exit 1
}
PYTHON=$(find_python)

# ── PID helpers ───────────────────────────────────────────────────────────────
save_pid() { echo "$1=$2" >> "$PID_FILE"; }
clear_pids() { rm -f "$PID_FILE"; }

get_pid() {
    [[ -f "$PID_FILE" ]] && grep "^$1=" "$PID_FILE" | cut -d= -f2 || echo ""
}

is_running() {
    local pid="$1"
    [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null
}

# ── start ─────────────────────────────────────────────────────────────────────
cmd_start() {
    local backend_pid frontend_pid
    backend_pid=$(get_pid "backend")
    frontend_pid=$(get_pid "frontend")

    if is_running "$backend_pid" && is_running "$frontend_pid"; then
        info "Already running. Use 'bloomberg status' to check."
        return
    fi

    mkdir -p "$LOG_DIR"
    clear_pids

    info "Starting backend  (port 8000) ..."
    (
        cd "$PROJECT_ROOT/backend"
        export CLIPPINGS_DIR THESES_DIR SOURCES_DIR OLLAMA_URL
        nohup "$PYTHON" -m uvicorn main:app --port 8000 --reload \
            >> "$BACKEND_LOG" 2>&1 &
        echo $! > /tmp/bloomberg-backend.pid
    )
    local bpid
    bpid=$(cat /tmp/bloomberg-backend.pid)
    save_pid "backend" "$bpid"
    ok "Backend PID: $bpid"

    sleep 2

    info "Starting frontend (port 3000) ..."
    (
        cd "$PROJECT_ROOT"
        nohup npm run dev >> "$FRONTEND_LOG" 2>&1 &
        echo $! > /tmp/bloomberg-frontend.pid
    )
    local fpid
    fpid=$(cat /tmp/bloomberg-frontend.pid)
    save_pid "frontend" "$fpid"
    ok "Frontend PID: $fpid"

    sleep 3
    ok "Bloomberg Terminal running at http://localhost:3000"
    info "Logs: $LOG_DIR"
    info "Run 'bloomberg open' to launch in browser"
}

# ── stop ──────────────────────────────────────────────────────────────────────
cmd_stop() {
    for service in backend frontend; do
        local pid
        pid=$(get_pid "$service")
        if [[ -n "$pid" ]]; then
            if is_running "$pid"; then
                # Kill process group to also kill children (uvicorn --reload spawns workers)
                kill -TERM -- "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null
                sleep 1
                is_running "$pid" && kill -KILL "$pid" 2>/dev/null
                ok "Stopped $service (PID $pid)"
            else
                info "$service (PID $pid) was not running"
            fi
        fi
    done
    clear_pids
    ok "Bloomberg Terminal stopped"
}

# ── status ────────────────────────────────────────────────────────────────────
cmd_status() {
    echo -e "\n  ${CYAN}Bloomberg Terminal Status${NC}"
    echo    "  ──────────────────────────"

    for service in backend frontend; do
        local pid status_str mem=""
        pid=$(get_pid "$service")

        if [[ -z "$pid" ]]; then
            status_str="${RED}STOPPED${NC} (not started)"
        elif is_running "$pid"; then
            if [[ "$OS" == "macos" ]]; then
                mem=$(ps -o rss= -p "$pid" 2>/dev/null | awk '{printf "%.0fMB", $1/1024}' || echo "?")
            else
                mem=$(cat /proc/"$pid"/status 2>/dev/null | grep VmRSS | awk '{printf "%.0fMB", $2/1024}' || echo "?")
            fi
            status_str="${GREEN}RUNNING${NC}  PID=$pid  MEM=$mem"
        else
            status_str="${RED}STOPPED${NC}  PID=$pid (stale)"
        fi

        printf "  %-12s %b\n" "$service" "$status_str"
    done

    echo    "  ──────────────────────────"
    echo    "  Frontend: http://localhost:3000"
    echo    "  Backend:  http://localhost:8000/health"
    echo -e "  Logs:     $LOG_DIR\n"
}

# ── logs ──────────────────────────────────────────────────────────────────────
cmd_logs() {
    local service="${1:-both}"
    local lines="${2:-40}"

    if [[ "$service" == "backend" || "$service" == "both" ]]; then
        echo -e "${YELLOW}── BACKEND (last $lines lines) ─────────────────────────────${NC}"
        if [[ -f "$BACKEND_LOG" ]]; then tail -n "$lines" "$BACKEND_LOG"
        else info "No backend log yet"; fi
    fi
    if [[ "$service" == "frontend" || "$service" == "both" ]]; then
        echo -e "${CYAN}── FRONTEND (last $lines lines) ────────────────────────────${NC}"
        if [[ -f "$FRONTEND_LOG" ]]; then tail -n "$lines" "$FRONTEND_LOG"
        else info "No frontend log yet"; fi
    fi
}

# ── open ──────────────────────────────────────────────────────────────────────
cmd_open() {
    local url="http://localhost:3000"
    case "$OS" in
        macos) open "$url" ;;
        linux) xdg-open "$url" 2>/dev/null || sensible-browser "$url" 2>/dev/null || info "Open: $url" ;;
        *)     info "Open: $url" ;;
    esac
}

# ── help ──────────────────────────────────────────────────────────────────────
cmd_help() {
    echo -e "${CYAN}"
    cat <<EOF
  bloomberg — Bloomberg Terminal launcher

  Commands:
    bloomberg start    Start backend + frontend in background (default)
    bloomberg stop     Stop all processes
    bloomberg status   Show running status + memory usage
    bloomberg logs     Show recent logs (both services)
    bloomberg logs backend   Show backend logs only
    bloomberg restart  Stop then start
    bloomberg open     Open http://localhost:3000 in browser
    bloomberg help     Show this help

  Logs:  $LOG_DIR
  PIDs:  $PID_FILE
EOF
    echo -e "${NC}"
}

# ── Main ──────────────────────────────────────────────────────────────────────
COMMAND="${1:-start}"
shift 2>/dev/null || true

case "$COMMAND" in
    start)   cmd_start   ;;
    stop)    cmd_stop    ;;
    status)  cmd_status  ;;
    logs)    cmd_logs "$@" ;;
    restart) cmd_stop; sleep 1; cmd_start ;;
    open)    cmd_open    ;;
    help|--help|-h) cmd_help ;;
    *) err "Unknown command: $COMMAND"; cmd_help; exit 1 ;;
esac
