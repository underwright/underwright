# Multi-harness MCP setup

One board, many harnesses. Underwright's store is a single SQLite file
opened by one server process. Claude Code, Cursor, Cline, OpenCode, Codex,
Kimi Code, Grok, Command Code (`cmdc`), and agy all talk to that process.
They do not each open the database.

The shared server for this workspace is already running:

| | |
|---|---|
| MCP URL | `http://100.120.201.70:8741/mcp` |
| Health | `http://100.120.201.70:8741/health` (no auth) |
| Auth | `Authorization: Bearer <UNDERWRIGHT_TOKEN>` on `/mcp` |

`/health` returns `{"ok":true}`. `/mcp` without the bearer returns `401`
with `www-authenticate: Bearer`. The token is the `UNDERWRIGHT_TOKEN` of
the process that owns the database. Put it in an environment variable on
each client. Do not commit it, and do not paste it into a project file
that gets pushed.

HTTP mode is stateless (ADR-0001). Every request opens the store, runs one
tool call, and finishes. Claims, artifacts, evidence, and the board are the
shared state. There is no MCP session to resume on another machine.

## Local stdio vs remote HTTP

**Stdio** is one agent on the machine that owns the database.

```bash
underwright serve
```

The client spawns that process and speaks MCP on stdin/stdout. The process
opens `UNDERWRIGHT_DB`, default `./underwright.db` relative to the client's
working directory (`src/cli.ts`). The committed `.mcp.json` is this shape:

```json
{
  "mcpServers": {
    "underwright": {
      "command": "node",
      "args": ["dist/cli.js", "serve"],
      "env": { "UNDERWRIGHT_DB": "underwright.db" }
    }
  }
}
```

That config is valid for a single local agent whose current directory is
this checkout and whose `underwright.db` is the real board. It is the wrong
config for every other machine, and the wrong config for a second checkout
on this machine. See [the trap](#dont-run-a-local-stdio-database-on-a-remote-machine).

**HTTP** is the shared plane. One host runs the server against an absolute
database path and binds an address other machines can reach (the Tailscale
address above is that host):

```bash
export UNDERWRIGHT_TOKEN="$(openssl rand -hex 24)"   # once; reuse the same value
export UNDERWRIGHT_DB=/absolute/path/to/underwright.db
underwright serve --http 0.0.0.0:8741
```

`/mcp` then requires `Authorization: Bearer $UNDERWRIGHT_TOKEN`. Clients
send that header and do not set `UNDERWRIGHT_DB`. Docker is the same
contract: publish `8741` and pass `UNDERWRIGHT_TOKEN` (see the README).

Every snippet below points at `http://100.120.201.70:8741/mcp` and sends
the bearer. Replace the URL only if the server moves. Export
`UNDERWRIGHT_TOKEN` in the environment of the harness before launching it.

## Per-harness HTTP config

### Claude Code

Project `.mcp.json` (Claude's key is `type`, not Command Code's `transport`):

```json
{
  "mcpServers": {
    "underwright": {
      "type": "http",
      "url": "http://100.120.201.70:8741/mcp",
      "headers": { "Authorization": "Bearer ${UNDERWRIGHT_TOKEN}" }
    }
  }
}
```

User or project scope from the CLI:

```bash
claude mcp add --transport http --scope user \
  --header "Authorization: Bearer ${UNDERWRIGHT_TOKEN}" \
  underwright http://100.120.201.70:8741/mcp
```

A checked-in `.mcp.json` is loaded by every clone. Prefer `--scope user`
(or a gitignored local override) so a fresh clone does not silently switch
this repo back to stdio. The file in git today is the stdio example above.

### Cursor

`.cursor/mcp.json` in the project, or the global MCP config:

```json
{
  "mcpServers": {
    "underwright": {
      "url": "http://100.120.201.70:8741/mcp",
      "headers": { "Authorization": "Bearer ${env:UNDERWRIGHT_TOKEN}" }
    }
  }
}
```

An entry with `url` is Streamable HTTP. An entry with `command` is stdio
and will open a private database.

### Cline

`cline_mcp_settings.json` (CLI: `~/.cline/data/settings/cline_mcp_settings.json`,
or `CLINE_MCP_SETTINGS_PATH`). Set `type` to `streamableHttp`. If `type` is
omitted, Cline treats the URL as legacy SSE and the session will not speak
this server's protocol.

```json
{
  "mcpServers": {
    "underwright": {
      "type": "streamableHttp",
      "url": "http://100.120.201.70:8741/mcp",
      "headers": { "Authorization": "Bearer ${UNDERWRIGHT_TOKEN}" },
      "disabled": false
    }
  }
}
```

```bash
cline mcp add underwright http://100.120.201.70:8741/mcp \
  --transport http \
  --header "Authorization: Bearer ${UNDERWRIGHT_TOKEN}" \
  --yes
```

### OpenCode

`opencode.json` (project) or `~/.config/opencode/opencode.json`. Remote
servers use `type: "remote"` under `mcp`, and `oauth: false` so OpenCode
sends the bearer instead of starting an OAuth flow. `{env:NAME}` is
expanded from the environment.

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "underwright": {
      "type": "remote",
      "url": "http://100.120.201.70:8741/mcp",
      "enabled": true,
      "oauth": false,
      "headers": { "Authorization": "Bearer {env:UNDERWRIGHT_TOKEN}" }
    }
  }
}
```

```bash
opencode mcp add underwright \
  --url http://100.120.201.70:8741/mcp \
  --header "Authorization=Bearer ${UNDERWRIGHT_TOKEN}"
```

### agy

```bash
agy mcp add --header "Authorization: Bearer ${UNDERWRIGHT_TOKEN}" \
  underwright http://100.120.201.70:8741/mcp
```

An `http://` URL selects the HTTP transport. Flags go before the server name.

### Kimi Code

Current Kimi Code CLI stores servers in `~/.kimi/mcp.json`. A `url` without
`transport` means HTTP. `bearerTokenEnvVar` reads the token from the
environment so the file stays free of the secret.

```json
{
  "mcpServers": {
    "underwright": {
      "url": "http://100.120.201.70:8741/mcp",
      "bearerTokenEnvVar": "UNDERWRIGHT_TOKEN"
    }
  }
}
```

```bash
kimi mcp add --transport http \
  --header "Authorization: Bearer ${UNDERWRIGHT_TOKEN}" \
  underwright http://100.120.201.70:8741/mcp
```

The `kimi` binary that only prints "kimi-cli is no longer maintained" is the
old client. It does not load this file. Install Kimi Code CLI, then add the
server.

### Codex

```bash
codex mcp add underwright \
  --url http://100.120.201.70:8741/mcp \
  --bearer-token-env-var UNDERWRIGHT_TOKEN
```

That writes a Streamable HTTP server into `~/.codex/config.toml` and reads
the bearer from `UNDERWRIGHT_TOKEN` at launch. `--env` is for stdio
servers only; do not use it to point Codex at a local `UNDERWRIGHT_DB`.

### Grok

```bash
grok mcp add --transport http --scope user \
  --header "Authorization: Bearer ${UNDERWRIGHT_TOKEN}" \
  underwright http://100.120.201.70:8741/mcp
```

`--scope user` writes `~/.grok/config.toml` (every project). `--scope project`
writes `./.grok/config.toml` in the checkout. User scope is the right
default: a project file would travel with the clone.

### Command Code (`cmdc`)

On Windows the binary is `cmdc` (`cmd` is the shell). It reads the same
project `.mcp.json` shape as its own docs, with `transport`:

```json
{
  "mcpServers": {
    "underwright": {
      "transport": "http",
      "url": "http://100.120.201.70:8741/mcp",
      "headers": { "Authorization": "Bearer ${UNDERWRIGHT_TOKEN}" }
    }
  }
}
```

```bash
cmdc mcp add --transport http --scope user \
  --header "Authorization: Bearer ${UNDERWRIGHT_TOKEN}" \
  underwright http://100.120.201.70:8741/mcp
```

Claude Code and Command Code both auto-load `.mcp.json`, and they spell the
transport field differently (`type` vs `transport`). A single checked-in
HTTP block will not satisfy both. Keep HTTP config in each harness's user
scope, and leave the repo `.mcp.json` as a local-stdio illustration rather
than the shared-plane config.

## `agent_id`: harness at host

`claim_task` takes a stable `agent_id` of the form `<harness>@<host>`.

```text
grok@alandesktop
agy@alandesktop
claude@minipc
codex@laptop-2
kimi@laptop-2
cmdc@winbox
```

The host is the machine running the harness, not the machine running the
HTTP server. Two checkouts that both call themselves `codex@laptop-2` are
the same claimant: the store keys the lease by `agent_id`, and a second
process with that id can refresh or replace the lease. One live worker per
`agent_id`. A second concurrent session on the same host needs its own id
(`grok-2@alandesktop`).

Use the same id for `claim_task`, `renew_lease`, `post_artifact`,
`report_evidence`, and `complete_task`. A different id is a different agent:
it cannot complete a task someone else still holds, and a `review` evidence
row must come from an id other than the claim holder when the policy
requires review.

Renew the lease on long work (`renew_lease`, default claim TTL is 30
minutes). Release the claim if you stop.

## Worktree vs separate clone

Git layout and the control plane are different problems.

**Worktree** — extra working directory on the same machine, sharing one
object database:

```bash
git worktree add ../underwright-feat feat/some-topic
```

Use a worktree when one host should have two branches checked out at once
(an author and a reviewer, or two tasks that must not share a working
tree). The worktree has its own index, its own HEAD, and its own current
directory. It does not have its own board. A relative `underwright.db`
inside the worktree is a new, empty file. Point the harness at the HTTP
URL. Commit on `feat/<topic>`. Leave `main` untouched.

**Separate clone** — a full second repository, required on any machine that
cannot see this disk (Tailscale gives you HTTP, not a shared filesystem):

```bash
git clone <origin-url> underwright
cd underwright
git checkout -b feat/some-topic
```

Push the feature branch to `origin`. The other machine pulls it. Claims,
artifacts, and evidence move through `http://100.120.201.70:8741/mcp`, not
through the git objects. Do not copy `underwright.db` between clones. Two
files are two boards, and SQLite locks do not extend across machines.

| | Worktree | Separate clone |
|---|---|---|
| Where | Same host, `git worktree add` | Another directory or another machine |
| Git objects | Shared with the primary checkout | Independent `.git` |
| Code isolation | Own branch, index, and untracked files | Own branch, index, `node_modules`, `dist` |
| Control plane | HTTP URL | HTTP URL |
| `agent_id` | `<harness>@<this-host>` | `<harness>@<the-clone's-host>` |

Build in the checkout you are editing (`npm install && npm run build`) so
`dist/cli.js` exists if anything on that machine still uses stdio. HTTP
clients do not need the server build locally; they need the URL and the token.

## Headless invocation

Run these from the checkout, with `UNDERWRIGHT_TOKEN` exported and the HTTP
server configured for that harness. The prompt carries the `agent_id` and
points at `AGENTS.md`. The harness works the board until idle: call `board`,
claim, implement, report evidence, complete, then read `inbox` and claim the
assigned task. A message `your next task: <id>` is that assignment. Repeat
until no next task arrives.

The same line belongs on a fleet agent job. The runner does not claim the
task; the launched harness does, then keeps going:

```json
"prompt": "You are {{agent_id}} on {{host}}. Read AGENTS.md strictly and work the board until idle. Before escalating, search_context for helpers, check artifacts and handoffs on the task, and try the alternate harness CLI. If still blocked, post_artifact kind=blocked with what was tried, send_message to the human, then release_task and read inbox for your next task — do not idle. Claim {{task_id}}, implement it, report evidence, then read inbox and continue. Job: {{job_id}}."
```

```bash
claude -p "You are claude@minipc. Read AGENTS.md and follow it. Work the board until idle."

codex exec "You are codex@laptop-2. Read AGENTS.md and follow it. Work the board until idle."

grok --single "You are grok@alandesktop. Read AGENTS.md and follow it. Work the board until idle."

cmdc -p --yolo "You are cmdc@winbox. Read AGENTS.md and follow it. Work the board until idle."

agy --print "You are agy@alandesktop. Read AGENTS.md and follow it. Work the board until idle."
```

`claude -p` is Claude Code's non-interactive print mode.
`codex exec` is Codex's non-interactive run.
`grok --single` (alias `-p`) prints one turn and exits.
`agy --print` (alias `-p`) does the same for agy.
`cmdc -p` is Command Code print mode. Print mode blocks file writes and
shell commands unless the process is also started with `--yolo` (permission
bypass for that run). A headless Command Code worker that must edit the
tree uses both flags: `cmdc -p --yolo`.

## Don't run a local stdio database on a remote machine

This is the failure that looks like a working control plane.

A remote clone contains `.mcp.json` with `command: node`, `args:
["dist/cli.js", "serve"]`, and `UNDERWRIGHT_DB=underwright.db`. Claude Code
or Command Code starts that process on the remote machine. `serve` without
`--http` opens `./underwright.db` in the clone. The file is created on first
use. `board` returns the empty local file. `claim_task` succeeds because
nobody else has that file. The agent edits, commits, and calls
`complete_task`. The shared server at `100.120.201.70` never sees the claim,
the artifact, or the evidence. A second agent on the real board takes the
same task.

The same split happens without a second machine:

- Two git worktrees, each with the stdio config, open
  `../wt-a/underwright.db` and `../wt-b/underwright.db`.
- Two harnesses on one host, if each spawns its own stdio server on a
  relative path, do not share a board. Two processes can also contend for
  one SQLite file if they are pointed at the same path; the supported
  share is one HTTP server, many clients.
- Copying `underwright.db` to "sync" a laptop forks the audit log. Later
  writes do not merge.

Rules:

1. Only the host that owns the board runs `underwright serve`. For more
   than one client, that process is `serve --http`, with an absolute
   `UNDERWRIGHT_DB` and `UNDERWRIGHT_TOKEN` set.
2. Every other harness, worktree, and machine uses
   `http://100.120.201.70:8741/mcp` plus the bearer. Those configs have a
   URL and no `command`.
3. Do not set `UNDERWRIGHT_DB` on a client.
4. Before trusting a session, call `board` and confirm the task you expect
   is the one the shared server shows. An empty board on a machine that
   should see open tasks means the session opened a private file.
5. `curl -s http://100.120.201.70:8741/health` must print `{"ok":true}`
   from the client machine before a headless run. `curl` of `/mcp` with no
   header must be `401`. A connection refused means the HTTP server is
   down; falling back to stdio does not reconnect you to the board.

## Checklist

- [ ] One `serve --http` process, absolute `UNDERWRIGHT_DB`, `UNDERWRIGHT_TOKEN` set
- [ ] Client config is HTTP to `http://100.120.201.70:8741/mcp` with the bearer header
- [ ] Client config has no `command` / stdio `serve` and no `UNDERWRIGHT_DB`
- [ ] `agent_id` is `<harness>@<host>`, stable, one live worker per id
- [ ] Code lives in a worktree or a separate clone on a `feat/<topic>` branch
- [ ] Headless entrypoint matches the harness (`claude -p`, `codex exec`, `grok --single`, `cmdc -p --yolo`, `agy --print`)
- [ ] `main` is not the branch being committed

## Cost tiers (dispatch guidance for #53)

Observed economics — update as quotas/pricing change. The dispatcher
should prefer the cheapest harness that satisfies task complexity (#54).

| Tier | Harnesses | Notes |
|---|---|---|
| free | devin (swe-2), cmdc (command-code), opencode (free models) | devin@swe-2 has no marginal cost; cmdc/opencode have usable free tiers |
| low | codex, grok | subscription/quota-bound |
| high | claude, agy (Gemini), kimi | reserve for design/epics/review |

Free tier does not mean unreviewed: free/low-tier implementations still
need independent review evidence before merge (peer-review policy).
Review tasks route to a different harness than the implementer, preferring
a stronger tier. Design reviews prefer a high-tier harness.
