#!/usr/bin/env bash
# install.sh — Install bloomberg command globally on Linux / macOS
# Run once: bash scripts/install.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
SCRIPT_SRC="$SCRIPT_DIR/bloomberg.sh"

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; NC='\033[0m'

echo -e "${CYAN}Bloomberg Terminal — Global Install${NC}"
echo    "────────────────────────────────────"

# ── Detect OS ─────────────────────────────────────────────────────────────────
OS=$(uname -s)

# ── Choose install target ─────────────────────────────────────────────────────
# Prefer ~/.local/bin (no sudo), fallback to /usr/local/bin (needs sudo)
if [[ ":$PATH:" == *":$HOME/.local/bin:"* ]] || [[ -d "$HOME/.local/bin" ]]; then
    INSTALL_DIR="$HOME/.local/bin"
elif [[ -d "/usr/local/bin" ]] && [[ -w "/usr/local/bin" ]]; then
    INSTALL_DIR="/usr/local/bin"
else
    INSTALL_DIR="$HOME/.local/bin"
    mkdir -p "$INSTALL_DIR"
fi

SYMLINK_PATH="$INSTALL_DIR/bloomberg"

# ── Make script executable ────────────────────────────────────────────────────
chmod +x "$SCRIPT_SRC"
echo -e "  ${GREEN}[OK]${NC} Made executable: $SCRIPT_SRC"

# ── Create symlink ────────────────────────────────────────────────────────────
if [[ -L "$SYMLINK_PATH" ]]; then
    rm "$SYMLINK_PATH"
fi

ln -s "$SCRIPT_SRC" "$SYMLINK_PATH"
echo -e "  ${GREEN}[OK]${NC} Symlink: $SYMLINK_PATH -> $SCRIPT_SRC"

# ── Ensure install dir is in PATH ─────────────────────────────────────────────
add_to_path() {
    local profile_file="$1"
    local path_line='export PATH="$HOME/.local/bin:$PATH"'
    if [[ -f "$profile_file" ]] && grep -q "$INSTALL_DIR" "$profile_file"; then
        echo -e "  ${GREEN}[OK]${NC} $INSTALL_DIR already in PATH ($profile_file)"
    else
        echo "" >> "$profile_file"
        echo "# bloomberg-terminal" >> "$profile_file"
        echo "$path_line" >> "$profile_file"
        echo -e "  ${YELLOW}[..]${NC} Added PATH to $profile_file"
    fi
}

if [[ "$INSTALL_DIR" == "$HOME/.local/bin" ]]; then
    if [[ "$OS" == "Darwin" ]]; then
        add_to_path "$HOME/.zshrc"
        [[ -f "$HOME/.bash_profile" ]] && add_to_path "$HOME/.bash_profile"
    else
        add_to_path "$HOME/.bashrc"
        [[ -f "$HOME/.zshrc" ]] && add_to_path "$HOME/.zshrc"
    fi
fi

# ── Env var setup hint ────────────────────────────────────────────────────────
RC_FILE="$HOME/.zshrc"
[[ "$OS" != "Darwin" ]] && RC_FILE="$HOME/.bashrc"

ENVBLOCK='
# Bloomberg Terminal env vars
export CLIPPINGS_DIR="${CLIPPINGS_DIR:-$HOME/obsidian/Clippings}"
export THESES_DIR="${THESES_DIR:-$HOME/obsidian/wiki/theses}"
export SOURCES_DIR="${SOURCES_DIR:-$HOME/obsidian/wiki/sources}"
export OLLAMA_URL="${OLLAMA_URL:-http://localhost:11434}"'

if ! grep -q "Bloomberg Terminal env vars" "$RC_FILE" 2>/dev/null; then
    echo "$ENVBLOCK" >> "$RC_FILE"
    echo -e "  ${YELLOW}[..]${NC} Added env vars to $RC_FILE (edit paths if needed)"
else
    echo -e "  ${GREEN}[OK]${NC} Env vars already in $RC_FILE"
fi

# ── Create logs dir ───────────────────────────────────────────────────────────
mkdir -p "$PROJECT_ROOT/logs"
echo -e "  ${GREEN}[OK]${NC} Logs dir: $PROJECT_ROOT/logs"

echo ""
echo -e "  ${GREEN}Installation complete!${NC}"
echo -e "  Reload shell: ${CYAN}source $RC_FILE${NC}"
echo -e "  Then run:     ${CYAN}bloomberg start${NC}"
echo ""
echo    "  Available commands:"
echo    "    bloomberg start    — start in background"
echo    "    bloomberg stop     — stop all"
echo    "    bloomberg status   — check status"
echo    "    bloomberg logs     — view logs"
echo    "    bloomberg restart  — restart"
echo    "    bloomberg open     — open browser"
