#!/usr/bin/env bash
set -u

# ============================================================
# AI Coding Agent Installer
#
# Installs:
#   - Codex CLI
#   - Claude Code
#   - Google Antigravity CLI (agy)
#   - Kimi CLI
#   - OpenCode
#   - Command Code (cmdc)
#   - Cline CLI
#   - Grok CLI
#   - Cursor Agent
#
# Usage:
#   chmod +x install-ai-agents.sh
#   ./install-ai-agents.sh
#
# Force reinstall:
#   FORCE=1 ./install-ai-agents.sh
# ============================================================

FORCE="${FORCE:-0}"

green="\033[0;32m"
yellow="\033[0;33m"
red="\033[0;31m"
cyan="\033[0;36m"
reset="\033[0m"

info() { printf "${cyan}==>${reset} %s\n" "$*"; }
ok()   { printf "${green} OK ${reset} %s\n" "$*"; }
warn() { printf "${yellow}WARN${reset} %s\n" "$*"; }
fail() { printf "${red}FAIL${reset} %s\n" "$*"; }

have() {
  command -v "$1" >/dev/null 2>&1
}

run_install() {
  local name="$1"
  local command_name="$2"
  shift 2

  printf "\n"
  info "Installing ${name}"

  if have "$command_name" && [[ "$FORCE" != "1" ]]; then
    ok "${name} already installed: $(command -v "$command_name")"
    return 0
  fi

  if "$@"; then
    hash -r

    if have "$command_name"; then
      ok "${name}: $(command -v "$command_name")"
    else
      warn "${name} installer completed, but '${command_name}' is not on PATH."
    fi
  else
    fail "${name} installation failed."
  fi
}


# ============================================================
# Prerequisites
# ============================================================

info "Checking prerequisites"

if ! have curl; then
  fail "curl is required."
  exit 1
fi


# ------------------------------------------------------------
# Node.js / npm
# ------------------------------------------------------------

if ! have npm; then
  warn "npm is not installed."

  if have brew; then
    info "Installing Node.js with Homebrew..."
    brew install node

  elif have apt-get; then
    info "Installing Node.js/npm with apt..."
    sudo apt-get update
    sudo apt-get install -y nodejs npm

  else
    warn "Could not automatically install Node.js."
    warn "Install Node.js before running npm-based installers."
  fi
fi


# ------------------------------------------------------------
# uv
# ------------------------------------------------------------

if ! have uv; then
  info "Installing uv..."
  curl -LsSf https://astral.sh/uv/install.sh | sh || true

  export PATH="$HOME/.local/bin:$HOME/.cargo/bin:$PATH"
  hash -r
fi


# ============================================================
# Codex CLI
# ============================================================

install_codex() {
  npm install -g @openai/codex@latest
}

run_install \
  "Codex CLI" \
  "codex" \
  install_codex


# ============================================================
# Claude Code
# ============================================================

install_claude() {
  curl -fsSL https://claude.ai/install.sh | bash
}

run_install \
  "Claude Code" \
  "claude" \
  install_claude


# ============================================================
# Google Antigravity CLI / agy
# ============================================================

install_agy() {
  curl -fsSL https://antigravity.google/cli/install.sh | bash
}

run_install \
  "Antigravity CLI (agy)" \
  "agy" \
  install_agy


# ============================================================
# Kimi CLI
# ============================================================

install_kimi() {
  if have uv; then
    uv tool install kimi-cli
  else
    fail "uv is required to install Kimi CLI."
    return 1
  fi
}

run_install \
  "Kimi CLI" \
  "kimi" \
  install_kimi


# ============================================================
# OpenCode
# ============================================================

install_opencode() {
  curl -fsSL https://opencode.ai/install | bash
}

run_install \
  "OpenCode" \
  "opencode" \
  install_opencode


# ============================================================
# Command Code / cmdc
# ============================================================

install_cmdc() {
  npm i -g command-code@latest
}

run_install \
  "Command Code (cmdc)" \
  "cmdc" \
  install_cmdc


# ============================================================
# Cline CLI
# ============================================================

install_cline() {
  npm install -g cline
}

run_install \
  "Cline CLI" \
  "cline" \
  install_cline


# ============================================================
# Grok CLI
# ============================================================

install_grok() {
  curl -fsSL https://x.ai/cli/install.sh | bash
}

run_install \
  "Grok CLI" \
  "grok" \
  install_grok


# ============================================================
# Cursor Agent
# ============================================================

install_cursor_agent() {
  curl -fsSL https://cursor.com/install | bash
}

run_install \
  "Cursor Agent" \
  "cursor-agent" \
  install_cursor_agent


# ============================================================
# Refresh PATH
# ============================================================

export PATH="$HOME/.local/bin:$HOME/.cargo/bin:$HOME/.npm-global/bin:$PATH"

hash -r


# ============================================================
# Verification
# ============================================================

printf "\n"
info "============================================================"
info " AI Coding Agent Installation Summary"
info "============================================================"
printf "\n"

agents=(
  "codex"
  "claude"
  "agy"
  "kimi"
  "opencode"
  "cmdc"
  "cline"
  "grok"
  "cursor-agent"
)

failed=0

for agent in "${agents[@]}"; do

  if have "$agent"; then
    printf "${green}%-16s${reset} %s\n" \
      "$agent" \
      "$(command -v "$agent")"
  else
    printf "${red}%-16s${reset} NOT FOUND\n" "$agent"
    failed=$((failed + 1))
  fi

done

printf "\n"

if [[ "$failed" -eq 0 ]]; then
  ok "All AI coding agents are installed."
else
  warn "${failed} agent(s) were not found."
fi


# ============================================================
# Next Steps
# ============================================================

cat <<'EOF'


============================================================
 Authentication / Initial Setup
============================================================

Run each CLI to initialize or authenticate it:

  codex
  claude
  agy
  kimi
  opencode
  cmdc
  cline
  grok
  cursor-agent


============================================================
 Security
============================================================

These tools may be capable of:

  - Reading your source code
  - Editing files
  - Executing shell commands
  - Running tests
  - Accessing Git repositories
  - Making external network requests
  - Calling external APIs

Review each agent's permissions and sandbox configuration before
allowing autonomous execution.

============================================================

EOF
