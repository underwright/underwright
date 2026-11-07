# underwright

**Control plane for agentic software development.** Agents that underwrite their work.

Underwright is not another coding agent — it's the layer that makes *any* coding
agents (Claude Code, Copilot, Codex, Devin, or your own) follow a real SDLC:
shared tasks instead of scattered prompts, claims instead of collisions,
evidence instead of "looks done to me."

## The problem it solves

Run two agents on the same repo and they duplicate work, write competing
utilities, and grade their own homework. Underwright gives them a shared
control plane:

- **Work registry** — tasks with ownership (file globs/symbols), acceptance
  criteria, and a spec reference
- **Claim/lease semantics** — one agent claims a task atomically; others are
  told who's holding it and until when. Stale claims are reclaimable.
- **Helper index** — agents publish reusable utilities/patterns; `search_context`
  is the required pre-flight check before writing new shared code
- **Artifact communication** — specs, designs, handoffs posted to tasks. Agents
  coordinate through durable artifacts, not chat
- **Evidence gate** — a task cannot be marked done until every declared
  acceptance criterion has attached evidence (test run, CI check, review)
- **Async jobs** — `submit_job` queues tests/builds/deploys; agents de-register
  and do other work instead of burning inference on polling
- **Audit log** — every mutation is an event. The compliance trail is free.

## Quick start

Install globally or run directly with `npx`:

```bash
npm i -g underwright
```

Point any MCP-capable agent at the server:

```json
{
  "mcpServers": {
    "underwright": {
      "command": "npx",
      "args": ["-y", "underwright", "serve"],
      "env": { "UNDERWRIGHT_DB": "/path/to/workspace/underwright.db" }
    }
  }
}
```

Scaffold a new workspace in one command:

```bash
underwright init                              # AGENTS.md, .mcp.json, policy, .gitignore + triage task
underwright init --remote http://host:8741    # http .mcp.json variant (Bearer ${UNDERWRIGHT_TOKEN})
underwright init --force                      # regenerate files that already exist
```

`init` skips existing files unless `--force` is passed and is safe to rerun —
it never duplicates the triage task or repeated ignore entries. The `http`
variant expects `UNDERWRIGHT_TOKEN` on the server and every agent host; start
the server with `UNDERWRIGHT_TOKEN=<token> underwright serve --http <host:port>`.

Or build from a local checkout:

```bash
npm install
npm run build
```

Or run the CLI directly:

```bash
underwright init               # scaffold a workspace (AGENTS.md, .mcp.json, policy, triage task)
underwright serve              # MCP server over stdio (local agent)
underwright serve --http H:P   # shared MCP over HTTP (/mcp) — multi-machine
underwright run                # execute queued jobs locally
underwright board              # print the task board
underwright digest --since 24h # standup summary of board delta [--to AGENT] [--text]
underwright create --template feature --title "Add search"   # create a task from a template
underwright templates          # list builtin + policy-defined templates
underwright speckit import --path .specify --task TASK_ID    # import Spec Kit docs & link ac_ids
underwright github sync --repo o/n   # sync GitHub issues ⇄ tasks
```

For shared HTTP use, set `UNDERWRIGHT_TOKEN` — `/mcp` then requires
`Authorization: Bearer <token>` (`/health` stays open).

Every `serve --http` instance also serves a read-only HTML board at `/board`
(or `/`): tasks, claims, leases, active resource locks, open jobs, and recent
events, auto-refreshing every few seconds. It is observability only — all
mutations stay on `/mcp`. With `UNDERWRIGHT_TOKEN` set, pass the token via
`Authorization: Bearer` or `?token=`.

`serve --http` also exposes `POST /github/webhook`. Set
`UNDERWRIGHT_GITHUB_WEBHOOK_SECRET` and point a repository webhook at that
path so check runs, issue edits, and pull-request reviews update tasks and
evidence without polling. Setup steps are in [docs/webhook.md](docs/webhook.md).
The webhook authenticates with HMAC. The bearer token stays on `/mcp`.

Tasks can declare `blocked_by: [task_ids]` in `create_task` or `update_task`.
Updating this field replaces the dependency list; `[]` clears it, while omitting
it preserves existing edges. Task reads, lists, and the board expose `blocked_by`,
reverse `blocks`, and `unfinished_blockers`. Open tasks with unfinished blockers
appear as `blocked`, and cannot be claimed until every blocker is `done`, even
without a DoR policy. Missing blockers, self-dependencies, and cycles are rejected.
Each blocker completion records a progress event and notifies dependent task
watchers. When the last blocker finishes, the dependent becomes open and an `unblocked`
audit event and watcher notification are recorded. Edges remain for traceability;
reopening a blocker blocks its open dependents again. Manually blocked tasks
keep their status until explicitly changed.

Both server modes sweep expired task claims on startup and every 60 seconds.
Each expiration removes the claim, reopens the task if it is still `claimed`,
records a `lease_expired` audit event with the former holder and expiry, and
notifies task watchers. Active or renewed leases are left alone, and task states
such as `in_review`, `blocked`, and `done` are preserved. Sweeps are transactional
and safe to run from multiple server processes; failed sweeps are logged to
stderr and retried on the next interval.

How to point Claude Code, Cursor, Cline, OpenCode, Codex, Kimi, Grok,
Command Code, and agy at one shared server — and how not to open a private
database by mistake — is in [docs/multi-harness.md](docs/multi-harness.md).

Docker (ghcr.io/underwright/underwright, published on tags):

```bash
docker run -v $(pwd)/.uw:/data -p 8741:8741 \
  -e UNDERWRIGHT_TOKEN=$TOKEN ghcr.io/underwright/underwright
```

Releases are published to npm with provenance on `v*` tags (`.github/workflows/release.yml`):

```bash
npm version patch   # or minor / major — runs tests, rebuilds dist/, tags vX.Y.Z
git push origin main --follow-tags
```

## Tool surface

| Tool | Purpose |
|---|---|
| `board` | Task board: statuses, claim holders, job counts |
| `digest` | Summarize board delta since a timestamp (`--since`, optional `to_agent` mailbox delivery) |
| `create_task` / `list_tasks` / `get_task` | Task lifecycle |
| `list_templates` | Builtin + policy-defined task templates (AC scaffold, DoR checklist) |
| `claim_task` / `release_task` / `renew_lease` | Atomic claims with expiring leases |
| `post_artifact` | Specs, designs, handoffs, reviews, and blocked escalations — durable, searchable |
| `import_speckit` | Import Spec Kit `constitution.md`/`spec.md`/`plan.md`/`tasks.md` as spec artifacts and link `ac_ids` |
| `search_context` | FTS over helpers + artifacts — call before writing shared code |
| `register_helper` | Publish a reusable util/pattern/config |
| `report_evidence` | Attach test/CI/review proof citing acceptance criteria |
| `complete_task` | Refuses unless every AC has cited evidence |
| `submit_job` / `job_status` | Async job queue — wait on processes, not inference |
| `audit_log` | Who did what, when |

## Task templates

Requirements-gathering should be structured, not a blank text box. A task
created from a template carries the shape agents need: an acceptance-criteria
scaffold, a task type, and a Definition-of-Ready checklist.

Builtins ship for `feature`, `bug`, `architecture`, and `tdd`. `create_task`
takes a `template` id; explicit `ac_ids` or `type` still win:

```bash
underwright create --template feature --title "Add search"      # or --ac a,b --type TYPE
```

Add or override templates from the policy file (`underwright.policy.json`) —
they are resolved by id alongside the builtins:

```json
{
  "templates": [
    { "id": "spike", "type": "feature", "ac_ids": ["spike-goal"],
      "description": "## Spike", "dor_checklist": ["Timebox set"] }
  ]
}
```

The template body lands in the task description with a `## Definition of Ready`
checklist for the triager to complete before the task is claimable.

## Design principles

- **Tools over inference.** Every "smart" behavior is a deterministic check:
  lease expiry, evidence gates, ownership scopes. Model judgment is for
  ambiguity only.
- **Independent verification.** The evidence record is separate from the
  worker's claims; completion is enforced structurally.
- **Artifacts, not chat.** Coordination state lives in the store, where every
  agent — and every human reviewer — can inspect it.
- **Local-first.** One SQLite file per workspace; no service required.
  A hosted, multi-repo control plane is the roadmap, not the prerequisite.

## Status

Early development. Roadmap: git-platform adapters (GitHub/GitLab/ADO),
Spec Kit–compatible spec pipeline, code indexing for the helper index,
hosted multi-repo coordination.

## Validation

Run `npm run build` and `npm test`, then `npm run test:contract` to test the
compiled CLI over HTTP. The contract matrix boots a scratch server in both
unauthenticated and bearer-authenticated modes, initializes MCP clients, and
exercises every advertised tool, shared state, and rejection paths. It uses
temporary SQLite databases (ignoring `DATABASE_URL` and the workspace policy),
then stops its servers and removes the temporary files. CI runs all three commands.

### Remote fleet runner

Start the shared control plane with `underwright serve --http 0.0.0.0:8741` and
run a supervisor from each host's workspace directory:

```sh
UNDERWRIGHT_URL=https://control.example/mcp \
UNDERWRIGHT_TOKEN=your-token \
uw-runner --host minipc --agent-id codex-2@minipc
```

`uw-runner` polls the MCP endpoint, runs one job at a time in its current working
directory, and reconnects after transport failures. Use `--poll-ms 2000` to set
the idle interval and `--once` to process at most one job. `SIGINT`/`SIGTERM`
stops the active process group and reports failure. Execution times out after
ten minutes. Stdout and stderr stream locally and are uploaded in heartbeat
snapshots; the final 64,000 characters are retained by `finish_job`.

Agent jobs (`type: "agent"`) may set `backend: "omnigent"` to launch through
Omnigent (`omni run --harness H -p PROMPT`, plus `--server` for a remote
control plane) instead of the raw harness CLI; the runner falls back to the
raw CLI when `omni` or the harness is unavailable. Preferences are pinned in
`underwright.policy.json` under `harness_matrix`. See
[docs/multi-harness.md](docs/multi-harness.md#omnigent-backend-uw-runner) for
the coverage table and the session-link captured into job results.

`submit_job` accepts optional `host` and `target_agent_id` affinity; both must
match when supplied. `agent_id` remains the submitter identity. Unpinned jobs
can run on any idle runner. `next_job` atomically claims a 60-second lease
(configurable `ttl_seconds`), returning `runner_id`, `lease_token`, and
`lease_expires`. `renew_job` and `finish_job` require that runner identity and
attempt token. Expired jobs can be reclaimed; stale attempts cannot finish or
renew them. Supervisors renew during execution and terminate their process
group if they lose ownership. Leases provide at-least-once execution after
host failure, so deploy commands should tolerate retries.

Agent jobs pass a prompt directly to a harness CLI without shell expansion:

```json
{
  "agent_id": "dispatcher@control",
  "task_id": "gh-34",
  "type": "agent",
  "host": "minipc",
  "target_agent_id": "codex-2@minipc",
  "agent": {
    "executable": "codex",
    "args": ["exec", "{{prompt}}"],
    "prompt": "You are {{agent_id}} on {{host}}. Read AGENTS.md strictly and work the board until idle. Before escalating, search_context for helpers, check artifacts and handoffs on the task, and try the alternate harness CLI. If still blocked, post_artifact kind=blocked with what was tried, send_message to the human, then release_task and read inbox for your next task — do not idle. Claim {{task_id}}, implement it, report evidence, then read inbox and continue. Job: {{job_id}}."
  }
}
```

For other installed harnesses, use `"executable": "grok", "args": ["--single"]`
or `"executable": "agy", "args": ["--print"]`. The expanded prompt is appended
as one argument when `{{prompt}}` is absent. Only `{{task_id}}`, `{{agent_id}}`,
`{{host}}`, and `{{job_id}}` inside the prompt are expanded. The launched harness
is responsible for claiming its task; a job lease does not claim that task.
After `complete_task`, read inbox. A message `your next task: <id>` is the
next assignment. Work the board until idle.

A host can supervise the process with systemd (set the workspace, executable
path, and URL for your installation; put `UNDERWRIGHT_TOKEN` in the environment
file):

```ini
[Unit]
Description=Underwright fleet runner
After=network-online.target
Wants=network-online.target

[Service]
WorkingDirectory=/home/alan/code/uw-fleet-runner
Environment=UNDERWRIGHT_URL=https://control.example/mcp
EnvironmentFile=/home/alan/.config/underwright/runner.env
ExecStart=/usr/bin/node /home/alan/code/uw-fleet-runner/dist/uw-runner.js --host minipc --agent-id codex-2@minipc
Restart=always
RestartSec=5
TimeoutStopSec=15

[Install]
WantedBy=default.target
```

Runners execute commands with the host user's permissions. Use the existing
bearer-token HTTP authentication and TLS setup when connecting across hosts.

### Cross-machine digest & human webhook notifications

Summarize board activity since a timestamp (ISO8601 or relative shorthand like `24h`, `30m`, `7d`) from the CLI or the `digest` MCP tool, and optionally deliver the standup summary into an agent's mailbox:

```bash
underwright digest --since 24h --to lead@laptop --text
```

To push real-time notifications to Slack, Discord, or any generic webhook when tasks are completed or expired claims are reclaimed, configure `human_notify` (or `human-notify` / `notifications`) in `underwright.policy.json`:

```json
{
  "human_notify": {
    "enabled": true,
    "webhook_url": "https://hooks.slack.com/services/T000/B000/X000",
    "events": ["task_completed", "claim_reclaimed"]
  }
}
```

Each POST sends JSON containing `text` (Slack), `content` (Discord), and structured fields (`event`, `task_id`, `title`, `agent_id`, `timestamp`).
