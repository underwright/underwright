#!/usr/bin/env bash
# install-ai-agents.sh
# Install, authenticate, verify, and inspect quota/usage for:
#   Codex CLI, Claude Code, Google Antigravity (agy), Kimi Code CLI,
#   OpenCode, Command Code, Cline CLI, Grok Build CLI, and Cursor Agent.
#
# Security model:
#   - This script never asks for, reads, prints, writes, or copies API keys/tokens.
#   - Authentication is delegated to each vendor's official CLI/browser/device flow.
#   - If you choose API-key authentication, set the vendor-documented environment
#     variable in your shell or enter it only in the vendor CLI's own prompt.
#   - The script sets umask 077 for any temporary files it creates.
#
# Target: Bash on macOS, Linux, or Windows Subsystem for Linux (WSL).
# Native Windows users should run the vendors' PowerShell installers instead.

set -uo pipefail
IFS=$'\n\t'
umask 077

SCRIPT_NAME=${0##*/}
ACTION="all"
ASSUME_YES=0
FORCE_INSTALL=0
INTERACTIVE_QUOTA=0
OPEN_DASHBOARDS=0
SELECTED_CSV="all"
FAILURES=0

ALL_AGENTS=(codex claude antigravity kimi opencode command-code cline grok cursor)
SELECTED_AGENTS=()

# Official references, also printed by `sources`.
URL_CODEX_DOCS="https://developers.openai.com/codex/"
URL_CODEX_USAGE="https://chatgpt.com/codex"
URL_OPENAI_API_USAGE="https://platform.openai.com/usage"
URL_CLAUDE_DOCS="https://code.claude.com/docs/en/"
URL_CLAUDE_USAGE="https://claude.ai/settings/usage"
URL_ANTIGRAVITY_DOCS="https://antigravity.google/docs/cli/"
URL_KIMI_DOCS="https://www.kimi.com/code/docs/en/"
URL_KIMI_USAGE="https://www.kimi.com/code/console"
URL_OPENCODE_DOCS="https://opencode.ai/docs/"
URL_OPENCODE_AUTH="https://opencode.ai/auth"
URL_COMMAND_CODE_DOCS="https://commandcode.ai/docs/"
URL_COMMAND_CODE_STUDIO="https://commandcode.ai/studio"
URL_CLINE_DOCS="https://docs.cline.bot/"
URL_CLINE_ACCOUNT="https://app.cline.bot/"
URL_GROK_DOCS="https://docs.x.ai/build/overview"
URL_XAI_CONSOLE="https://console.x.ai/"
URL_CURSOR_DOCS="https://cursor.com/docs/cli/overview"
URL_CURSOR_DASHBOARD="https://cursor.com/dashboard"

# Add common user-level installer locations to this process only.
export PATH="$HOME/.local/bin:$HOME/.claude/bin:$HOME/.cursor/bin:$PATH"

if [[ -t 1 ]] && [[ ${TERM:-dumb} != dumb ]]; then
  BOLD=$'\033[1m'; DIM=$'\033[2m'; GREEN=$'\033[32m'; YELLOW=$'\033[33m'; RED=$'\033[31m'; RESET=$'\033[0m'
else
  BOLD=""; DIM=""; GREEN=""; YELLOW=""; RED=""; RESET=""
fi

say()  { printf '%s\n' "$*"; }
info() { printf '%s[i]%s %s\n' "$DIM" "$RESET" "$*"; }
ok()   { printf '%s[OK]%s %s\n' "$GREEN" "$RESET" "$*"; }
warn() { printf '%s[!]%s %s\n' "$YELLOW" "$RESET" "$*" >&2; }
err()  { printf '%s[X]%s %s\n' "$RED" "$RESET" "$*" >&2; }
section() { printf '\n%s== %s ==%s\n' "$BOLD" "$*" "$RESET"; }

usage() {
  cat <<'EOF'
Usage:
  ./install-ai-agents.sh [action] [options]

Actions:
  all       Install, guide authentication, verify, then report quota/usage (default)
  install   Install or update selected agents
  auth      Guide authentication using each agent's native secure flow
  verify    Show versions and verify authentication where the CLI exposes a safe check
  quota     Check/report quota and usage for every selected agent
  doctor    Run non-destructive installation and authentication diagnostics
  list      List supported agent IDs
  sources   Print official documentation and account/usage URLs
  help      Show this help

Options:
  --agents LIST        Comma-separated IDs, or "all"
                       IDs: codex,claude,antigravity,kimi,opencode,
                            command-code,cline,grok,cursor
  -y, --yes            Skip install/update confirmation prompts
  --force              Run installers even when an agent is already installed
  --interactive-quota  Open native TUIs for slash-command quota panels, one at a time
  --open-dashboards    Open account/provider dashboards when no universal CLI quota exists
  --no-open            Do not open dashboards (the URLs are still printed)
  -h, --help           Show this help

Recommended test sequence:
  chmod +x install-ai-agents.sh
  ./install-ai-agents.sh install
  ./install-ai-agents.sh auth
  ./install-ai-agents.sh verify
  ./install-ai-agents.sh quota --interactive-quota --open-dashboards

Examples:
  ./install-ai-agents.sh all
  ./install-ai-agents.sh install --agents codex,claude,cursor
  ./install-ai-agents.sh auth --agents antigravity,kimi,opencode
  ./install-ai-agents.sh quota --interactive-quota

Notes:
  * Interactive slash commands cannot be safely scraped without depending on unstable
    private credential files. With --interactive-quota, this script launches the official
    TUI and tells you which read-only command to enter.
  * OpenCode and Cline can use many providers. Their quotas belong to the selected provider,
    so there is no single universal remaining-quota number. The script lists configured
    providers and directs you to the applicable provider dashboard.
  * Browser/API-key authentication remains owned by each vendor CLI. This script never
    receives or stores your credentials.
EOF
}

agent_label() {
  case "$1" in
    codex) echo "Codex CLI" ;;
    claude) echo "Claude Code" ;;
    antigravity) echo "Google Antigravity (agy)" ;;
    kimi) echo "Kimi Code CLI" ;;
    opencode) echo "OpenCode" ;;
    command-code) echo "Command Code" ;;
    cline) echo "Cline CLI" ;;
    grok) echo "Grok Build CLI" ;;
    cursor) echo "Cursor Agent" ;;
    *) echo "$1" ;;
  esac
}

is_known_agent() {
  local candidate=$1 item
  for item in "${ALL_AGENTS[@]}"; do
    [[ $candidate == "$item" ]] && return 0
  done
  return 1
}

parse_selected_agents() {
  local raw item
  if [[ $SELECTED_CSV == all ]]; then
    SELECTED_AGENTS=("${ALL_AGENTS[@]}")
    return
  fi
  IFS=',' read -r -a raw <<< "$SELECTED_CSV"
  SELECTED_AGENTS=()
  for item in "${raw[@]}"; do
    item=${item//[[:space:]]/}
    if ! is_known_agent "$item"; then
      err "Unknown agent ID: $item"
      usage
      exit 2
    fi
    SELECTED_AGENTS+=("$item")
  done
  [[ ${#SELECTED_AGENTS[@]} -gt 0 ]] || { err "--agents cannot be empty"; exit 2; }
}

confirm() {
  local prompt=$1 answer
  (( ASSUME_YES )) && return 0
  if [[ ! -t 0 ]]; then
    warn "Non-interactive input: refusing '$prompt'. Re-run with --yes if intentional."
    return 1
  fi
  read -r -p "$prompt [y/N] " answer
  [[ $answer == y || $answer == Y || $answer == yes || $answer == YES ]]
}

have() { command -v "$1" >/dev/null 2>&1; }

resolve_bin() {
  case "$1" in
    codex) command -v codex 2>/dev/null || true ;;
    claude) command -v claude 2>/dev/null || true ;;
    antigravity) command -v agy 2>/dev/null || true ;;
    kimi) command -v kimi 2>/dev/null || true ;;
    opencode) command -v opencode 2>/dev/null || true ;;
    command-code)
      command -v command-code 2>/dev/null || command -v cmd 2>/dev/null || command -v cmdc 2>/dev/null || true
      ;;
    cline) command -v cline 2>/dev/null || true ;;
    grok) command -v grok 2>/dev/null || true ;;
    cursor) command -v agent 2>/dev/null || true ;;
  esac
}

safe_version() {
  local agent=$1 bin output
  bin=$(resolve_bin "$agent")
  [[ -n $bin ]] || { warn "$(agent_label "$agent") is not installed or not on PATH."; return 1; }
  case "$agent" in
    grok) output=$("$bin" version 2>&1 | head -n 2) || output=$("$bin" --version 2>&1 | head -n 2) ;;
    *) output=$("$bin" --version 2>&1 | head -n 2) ;;
  esac
  ok "$(agent_label "$agent"): ${output:-installed} [$bin]"
}

require_curl() {
  if ! have curl; then
    err "curl is required for official install scripts. Install curl and retry."
    return 1
  fi
}

require_npm_and_node() {
  local min_major=$1 label=$2 major
  if ! have node || ! have npm; then
    err "$label requires Node.js $min_major+ and npm. Install a current Node.js LTS, then retry."
    return 1
  fi
  major=$(node -p 'Number(process.versions.node.split(".")[0])' 2>/dev/null || echo 0)
  if (( major < min_major )); then
    err "$label requires Node.js $min_major+; found $(node --version 2>/dev/null || echo unknown)."
    return 1
  fi
}

run_official_installer() {
  local label=$1 url=$2 tmpdir installer rc
  require_curl || return 1
  tmpdir=$(mktemp -d 2>/dev/null || mktemp -d -t ai-agent-install)
  installer="$tmpdir/installer.sh"
  info "Downloading official installer: $url"
  if ! curl --proto '=https' --tlsv1.2 --location --fail --silent --show-error "$url" -o "$installer"; then
    err "$label installer download failed."
    rm -rf "$tmpdir"
    return 1
  fi
  chmod 700 "$installer"
  info "Running downloaded installer in a temporary directory (credentials are not involved)."
  bash "$installer"
  rc=$?
  rm -rf "$tmpdir"
  return "$rc"
}

install_agent() {
  local agent=$1 label bin
  label=$(agent_label "$agent")
  section "Install: $label"
  bin=$(resolve_bin "$agent")
  if [[ -n $bin ]] && (( ! FORCE_INSTALL )); then
    safe_version "$agent" || true
    confirm "Run the official installer to update/reinstall $label?" || { info "Skipped $label."; return 0; }
  elif [[ -z $bin ]]; then
    confirm "Install $label?" || { info "Skipped $label."; return 0; }
  fi

  case "$agent" in
    codex) run_official_installer "$label" "https://chatgpt.com/codex/install.sh" ;;
    claude) run_official_installer "$label" "https://claude.ai/install.sh" ;;
    antigravity) run_official_installer "$label" "https://antigravity.google/cli/install.sh" ;;
    kimi) run_official_installer "$label" "https://code.kimi.com/kimi-code/install.sh" ;;
    opencode) run_official_installer "$label" "https://opencode.ai/install" ;;
    command-code)
      require_npm_and_node 22 "$label" || return 1
      npm install --global command-code@latest
      ;;
    cline)
      require_npm_and_node 20 "$label" || return 1
      npm install --global cline
      ;;
    grok) run_official_installer "$label" "https://x.ai/cli/install.sh" ;;
    cursor) run_official_installer "$label" "https://cursor.com/install" ;;
  esac
  local rc=$?
  hash -r 2>/dev/null || true
  if (( rc == 0 )); then
    ok "$label installer completed."
    safe_version "$agent" || warn "$label installed, but its binary is not visible yet. Open a new shell or add ~/.local/bin to PATH."
  else
    err "$label installation failed (exit $rc)."
    return "$rc"
  fi
}

installed_or_skip() {
  local agent=$1 bin
  bin=$(resolve_bin "$agent")
  if [[ -z $bin ]]; then
    warn "$(agent_label "$agent") is not installed; skipping this step."
    return 1
  fi
  printf '%s' "$bin"
}

launch_tui_instruction() {
  local label=$1 bin=$2 instruction=$3
  say "The official CLI will now take over the terminal."
  say "  Enter: $instruction"
  say "  Then exit the CLI to return to this script."
  if [[ ! -t 0 ]]; then
    warn "A TTY is required. Run manually: $bin  (then enter $instruction)"
    return 1
  fi
  read -r -p "Press Enter to launch, or Ctrl-C to stop... " _
  "$bin"
}

auth_agent() {
  local agent=$1 label bin rc=0
  label=$(agent_label "$agent")
  section "Authenticate: $label"
  bin=$(installed_or_skip "$agent") || return 0
  say "Credentials remain inside $label's native secure login flow; this script does not capture them."

  case "$agent" in
    codex)
      say "Recommended: browser/device sign-in with your ChatGPT account."
      "$bin" login || rc=$?
      ;;
    claude)
      say "Recommended: browser login with your Claude account."
      "$bin" auth login || rc=$?
      ;;
    antigravity)
      say "agy uses the OS secure keyring and opens Google OAuth on first launch."
      say "For SSH it prints a device URL/code. For Gemini API-key mode, configure the official CLI yourself; do not paste a key into this script."
      launch_tui_instruction "$label" "$bin" "complete the displayed sign-in; after the TUI opens, use /usage to verify, then /exit" || rc=$?
      ;;
    kimi)
      say "Kimi supports OAuth device-code login or API-key entry inside its own /login panel."
      launch_tui_instruction "$label" "$bin" "/login (complete the flow), then /usage, then /exit" || rc=$?
      ;;
    opencode)
      say "Choose a provider in OpenCode's native prompt. Provider credentials are stored by OpenCode, not this script."
      "$bin" auth login || rc=$?
      ;;
    command-code)
      say "Command Code opens a browser for OAuth; its own prompt also supports an account API key."
      "$bin" login || rc=$?
      ;;
    cline)
      say "Cline's native auth wizard lets you choose Cline, ClinePass, BYOK cloud providers, or local models."
      "$bin" auth || rc=$?
      ;;
    grok)
      say "Grok opens browser OAuth. In a headless session, run 'grok login --device-auth'."
      "$bin" login || rc=$?
      ;;
    cursor)
      say "Cursor opens its browser login. Set NO_OPEN_BROWSER=1 yourself for a printed URL in headless environments."
      "$bin" login || rc=$?
      ;;
  esac

  if (( rc == 0 )); then ok "$label authentication flow completed or returned successfully."; else warn "$label authentication flow exited with status $rc."; fi
  return "$rc"
}

print_env_presence() {
  local name=$1
  if [[ -n ${!name:-} ]]; then
    ok "$name is set in the current environment (value intentionally hidden)."
  else
    info "$name is not set in the current environment."
  fi
}

verify_auth_agent() {
  local agent=$1 label bin rc=0
  label=$(agent_label "$agent")
  section "Verify authentication: $label"
  bin=$(installed_or_skip "$agent") || return 0
  safe_version "$agent" || true

  case "$agent" in
    codex)
      "$bin" login status || rc=$?
      print_env_presence OPENAI_API_KEY
      ;;
    claude)
      "$bin" auth status || rc=$?
      print_env_presence ANTHROPIC_API_KEY
      ;;
    antigravity)
      print_env_presence GEMINI_API_KEY
      say "Account OAuth has no documented non-interactive status command. A successful /usage panel is the safe end-to-end verification."
      ;;
    kimi)
      if "$bin" provider list >/dev/null 2>&1; then
        "$bin" provider list || true
        ok "Kimi provider configuration is readable. Use /usage for an authenticated quota refresh."
      else
        say "Kimi has no documented non-interactive account-status command. Use /usage for verification."
      fi
      ;;
    opencode)
      "$bin" auth list || rc=$?
      ;;
    command-code)
      "$bin" status --json || "$bin" status || rc=$?
      ;;
    cline)
      say "Cline does not document a universal read-only auth-status command across all providers."
      say "Configured provider health is checked by its native wizard and by the provider's first request."
      if "$bin" doctor --help >/dev/null 2>&1; then
        info "Cline doctor is available: run 'cline doctor' for local diagnostics."
      fi
      ;;
    grok)
      if "$bin" models >/dev/null 2>&1; then
        "$bin" models | head -n 30
        ok "Grok returned the available model list."
      else
        rc=$?
        warn "Grok could not list models; run 'grok login' (or 'grok login --device-auth') and retry."
      fi
      print_env_presence XAI_API_KEY
      ;;
    cursor)
      "$bin" status || rc=$?
      print_env_presence CURSOR_API_KEY
      ;;
  esac

  if (( rc != 0 )); then warn "$label authentication verification did not succeed (exit $rc)."; fi
  return "$rc"
}

open_url() {
  local url=$1
  (( OPEN_DASHBOARDS )) || return 0
  if have open; then open "$url" >/dev/null 2>&1 &
  elif have xdg-open; then xdg-open "$url" >/dev/null 2>&1 &
  elif have wslview; then wslview "$url" >/dev/null 2>&1 &
  else warn "No supported browser opener found. Open manually: $url"; return 1
  fi
  ok "Opened: $url"
}

quota_tui() {
  local agent=$1 command=$2 label bin
  label=$(agent_label "$agent")
  bin=$(installed_or_skip "$agent") || return 0
  if (( INTERACTIVE_QUOTA )); then
    launch_tui_instruction "$label" "$bin" "$command"
  else
    say "Run: $bin"
    say "Then enter: $command"
    say "Tip: add --interactive-quota to let this script launch the TUI."
  fi
}

quota_agent() {
  local agent=$1 label bin
  label=$(agent_label "$agent")
  section "Quota/usage: $label"
  bin=$(resolve_bin "$agent")
  [[ -n $bin ]] || { warn "$label is not installed; quota cannot be checked yet."; return 0; }

  case "$agent" in
    codex)
      say "ChatGPT-plan usage: Codex exposes account/session status in the interactive /status panel."
      quota_tui "$agent" "/status"
      say "ChatGPT Codex: $URL_CODEX_USAGE"
      say "API-key billing/usage (only if you use OPENAI_API_KEY): $URL_OPENAI_API_USAGE"
      open_url "$URL_CODEX_USAGE" || true
      ;;
    claude)
      say "Claude Code exposes plan/session limits in its read-only /usage panel."
      quota_tui "$agent" "/usage"
      say "Claude usage page: $URL_CLAUDE_USAGE"
      open_url "$URL_CLAUDE_USAGE" || true
      ;;
    antigravity)
      say "Antigravity /usage (alias /quota) refreshes backend quotas and shows remaining requests/tokens per model."
      quota_tui "$agent" "/usage"
      ;;
    kimi)
      say "Kimi /usage shows token usage, context consumption, and quota information."
      quota_tui "$agent" "/usage"
      say "Kimi Code console: $URL_KIMI_USAGE"
      open_url "$URL_KIMI_USAGE" || true
      ;;
    opencode)
      say "OpenCode is provider-agnostic, so it has no single universal remaining-quota value."
      say "Authenticated providers:"
      "$bin" auth list || true
      say "For OpenCode Models/account billing: $URL_OPENCODE_AUTH"
      say "For any other provider, use that provider's own usage dashboard."
      open_url "$URL_OPENCODE_AUTH" || true
      ;;
    command-code)
      say "Command Code /usage displays credits, plan, and usage metrics."
      quota_tui "$agent" "/usage"
      say "Command Code Studio: $URL_COMMAND_CODE_STUDIO"
      open_url "$URL_COMMAND_CODE_STUDIO" || true
      ;;
    cline)
      say "Cline can use Cline credits, ClinePass, BYOK cloud providers, or local models."
      say "There is no universal CLI quota across those providers; check the provider selected by 'cline auth'."
      say "Cline account: $URL_CLINE_ACCOUNT"
      say "Cline provider documentation: ${URL_CLINE_DOCS}getting-started/cline-provider"
      open_url "$URL_CLINE_ACCOUNT" || true
      ;;
    grok)
      say "Grok Build does not document a standalone remaining-quota CLI command."
      say "Opening its documented agent dashboard command (when requested) and printing the xAI console URL."
      if (( OPEN_DASHBOARDS )); then "$bin" dashboard >/dev/null 2>&1 || open_url "$URL_XAI_CONSOLE" || true; fi
      say "xAI API usage/billing: $URL_XAI_CONSOLE"
      ;;
    cursor)
      say "Cursor CLI documents auth status but not a standalone remaining-quota command."
      "$bin" status || true
      say "Cursor account/usage dashboard: $URL_CURSOR_DASHBOARD"
      open_url "$URL_CURSOR_DASHBOARD" || true
      ;;
  esac
}

print_sources() {
  cat <<EOF
Official references used by this script:
  Codex CLI:          $URL_CODEX_DOCS
  Claude Code:        $URL_CLAUDE_DOCS
  Antigravity CLI:    $URL_ANTIGRAVITY_DOCS
  Kimi Code CLI:      $URL_KIMI_DOCS
  OpenCode:           $URL_OPENCODE_DOCS
  Command Code:       $URL_COMMAND_CODE_DOCS
  Cline CLI:          $URL_CLINE_DOCS
  Grok Build CLI:     $URL_GROK_DOCS
  Cursor CLI:         $URL_CURSOR_DOCS
EOF
}

run_for_agents() {
  local function_name=$1 agent
  for agent in "${SELECTED_AGENTS[@]}"; do
    if ! "$function_name" "$agent"; then
      FAILURES=$((FAILURES + 1))
    fi
  done
}

doctor() {
  section "Environment"
  say "OS: $(uname -s 2>/dev/null || echo unknown)"
  say "Architecture: $(uname -m 2>/dev/null || echo unknown)"
  say "Shell: ${SHELL:-unknown}"
  say "PATH includes ~/.local/bin: $(case ":$PATH:" in *":$HOME/.local/bin:"*) echo yes;; *) echo no;; esac)"
  have curl && ok "curl: $(curl --version | head -n 1)" || warn "curl not found"
  have node && ok "Node.js: $(node --version)" || warn "Node.js not found (needed by Command Code and Cline)"
  have npm && ok "npm: $(npm --version)" || warn "npm not found (needed by Command Code and Cline)"
  run_for_agents safe_version
  run_for_agents verify_auth_agent
}

# Parse action and options.
if [[ $# -gt 0 && ${1:-} != -* ]]; then
  ACTION=$1
  shift
fi
while [[ $# -gt 0 ]]; do
  case "$1" in
    --agents)
      [[ $# -ge 2 ]] || { err "--agents requires a value"; exit 2; }
      SELECTED_CSV=$2; shift 2 ;;
    --agents=*) SELECTED_CSV=${1#*=}; shift ;;
    -y|--yes) ASSUME_YES=1; shift ;;
    --force) FORCE_INSTALL=1; shift ;;
    --interactive-quota) INTERACTIVE_QUOTA=1; shift ;;
    --open-dashboards) OPEN_DASHBOARDS=1; shift ;;
    --no-open) OPEN_DASHBOARDS=0; shift ;;
    -h|--help) usage; exit 0 ;;
    *) err "Unknown option: $1"; usage; exit 2 ;;
  esac
done

case "$ACTION" in
  all|install|auth|verify|quota|doctor|list|sources|help) ;;
  *) err "Unknown action: $ACTION"; usage; exit 2 ;;
esac

parse_selected_agents

case "$ACTION" in
  help) usage ;;
  list)
    for agent in "${ALL_AGENTS[@]}"; do printf '%-15s %s\n' "$agent" "$(agent_label "$agent")"; done
    ;;
  sources) print_sources ;;
  install) run_for_agents install_agent ;;
  auth) run_for_agents auth_agent ;;
  verify) run_for_agents verify_auth_agent ;;
  quota) run_for_agents quota_agent ;;
  doctor) doctor ;;
  all)
    section "Security notice"
    say "Authentication stays inside each vendor's official CLI/browser flow."
    say "This script never accepts or stores credentials."
    run_for_agents install_agent
    run_for_agents auth_agent
    run_for_agents verify_auth_agent
    run_for_agents quota_agent
    ;;
esac

section "Finished"
if (( FAILURES > 0 )); then
  warn "$FAILURES selected step(s) reported a failure. Review the messages above."
  exit 1
fi
ok "Completed action '$ACTION' for ${#SELECTED_AGENTS[@]} agent(s)."
