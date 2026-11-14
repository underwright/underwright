# Harness registry

Status: draft · 2026-11-09 · tracks [#45](https://github.com/underwright/underwright/issues/45)
(child task `task-67170863`, AC `harness-registry`)

The supported roster is the ten harnesses that `scripts/install-agents.sh`
provisions: the original nine plus GitHub Copilot CLI (`copilot`, installed with
`npm install -g @github/copilot`). This page lists how to drive each one
headless against the shared board. For provisioning and the script's exit
codes, see [node-executors.md](node-executors.md).

**Sources.** Cells without a marker come from this repo:
`scripts/install-agents.sh`, [multi-harness.md](multi-harness.md),
`underwright.policy.json` → `harness_matrix`, and `src/runner.ts`
`OMNIGENT_HARNESS_SUPPORT`. Cells marked † are vendor CLI behavior that has
not been checked in this repo. Verify them before relying on them, then
remove the †.

## Invocation

| Harness (installer id) | Binary | Headless | Permission bypass | Resume |
|---|---|---|---|---|
| codex | `codex` | `codex exec PROMPT` | `--dangerously-bypass-approvals-and-sandbox` † (or `--full-auto` †) | `codex exec resume <id>` / `--last` † |
| claude | `claude` | `claude -p PROMPT` | Pre-seeded allowlist via `underwright` harness prep (`src/harness-permissions.ts`); `--dangerously-skip-permissions` † | `--resume <id>` / `-c` † |
| antigravity | `agy` | `agy --print PROMPT` (alias `-p`) | unknown | unknown |
| kimi | `kimi` | `kimi --print PROMPT` † | unknown | unknown |
| opencode | `opencode` | `opencode run PROMPT` † | unknown | `--continue` / `--session <id>` † |
| command-code | `cmdc` | `cmdc -p PROMPT` | `--yolo` (required for edits/shell in `-p` mode) | `-c` / `--resume` (per #40) † |
| cline | `cline` | unknown | unknown | unknown |
| grok | `grok` | `grok --single PROMPT` (alias `-p`) | unknown | `-c` / `--continue` (per #40) † |
| cursor | `agent` | `agent -p PROMPT` † | `--force` † | `--resume <id>` † |
| copilot | `copilot` | `copilot -p PROMPT` † | `--allow-all-tools` † | `--continue` / `--resume` † |

## Auth, quota, MCP, omnigent

| Harness | Auth check (non-interactive) | Quota check | MCP config method | Omnigent | Board proof |
|---|---|---|---|---|---|
| codex | `codex login status` | TUI `/status`; chatgpt.com/codex | `~/.codex/config.toml` `[mcp_servers]` / `codex mcp add` † | **yes** | ✅ (per #45) |
| claude | `claude auth status` | TUI `/usage`; claude.ai/settings/usage | Project `.mcp.json` (pre-approved via `enabledMcpjsonServers`) or `claude mcp add` | **yes** (as `claude-sdk`) | ✅ (per #45) |
| antigravity | none documented; `GEMINI_API_KEY` presence | TUI `/usage` (alias `/quota`) | own settings † | no (omni needs `GEMINI_API_KEY`, not OAuth, per gh-35) | ✅ (per #45) |
| kimi | `kimi provider list` (config only) | TUI `/usage`; Kimi Code console | own settings † | no (quota/trust issues, per gh-35) | ⏳ task-16744cce |
| opencode | `opencode auth list` | Provider-specific; `opencode auth list` | `opencode.json` `mcp` block † | no | ⏳ task-16744cce |
| command-code | `cmdc status --json` | TUI `/usage`; Command Code Studio | Project `.mcp.json` (multi-harness.md) | pending (`coverage.cmdc=false`) | ✅ (per #45) |
| cline | none universal; `cline doctor` | Provider-specific; app.cline.bot | own settings † | no | ⏳ task-16744cce |
| grok | `grok models` (lists models when authed) | No CLI command; console.x.ai, `grok dashboard` | own settings † | no (not supported, per gh-35) | ✅ (per #45) |
| cursor | `agent status` | No CLI command; cursor.com/dashboard | `.cursor/mcp.json` † | no | ⏳ task-16744cce |
| copilot | none documented; `COPILOT_GITHUB_TOKEN`/`GH_TOKEN`/`GITHUB_TOKEN` presence (TUI `/login`) | TUI `/usage`; github.com/settings/copilot | `~/.copilot/mcp-config.json` † | no | ⏳ task-16744cce |

Omnigent status is the effective `harness_matrix.coverage` (policy overrides
the built-in table in `src/runner.ts`). A harness not marked `true` launches raw.

## Rules that apply to every harness

- `agent_id` is `<harness>@<host>`: stable, one live worker per id.
- Clients connect over HTTP to the shared server with a bearer token. Never use
  a local stdio `serve` on a client (see multi-harness.md, "Don't run a local
  stdio database on a remote machine").
- Prefer the narrowest permission grant that lets the harness edit the
  worktree and call `mcp__underwright`. Use a full bypass flag only in a
  sandbox or a disposable worktree.
- Cost tiers for dispatch are in multi-harness.md, "Cost tiers".

## Keeping this current

When a harness completes its first real board task, mark ✅ with the task id.
When a † cell is verified against the installed CLI, drop the †. Adding a
harness means adding a row here, an entry in `install-agents.sh`
`ALL_AGENTS` (plus its install/auth/verify/quota cases and the id list in
`test/install-agents.test.ts`), and an omnigent coverage entry if one applies.
