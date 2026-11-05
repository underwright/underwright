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

```bash
npm install
npm run build
```

Point any MCP-capable agent at the server:

```json
{
  "mcpServers": {
    "underwright": {
      "command": "node",
      "args": ["/path/to/underwright/dist/cli.js", "serve"],
      "env": { "UNDERWRIGHT_DB": "/path/to/workspace/underwright.db" }
    }
  }
}
```

Or run the CLI directly:

```bash
underwright serve              # MCP server over stdio (local agent)
underwright serve --http H:P   # shared MCP over HTTP (/mcp) — multi-machine
underwright run                # execute queued jobs locally
underwright board              # print the task board
underwright github sync --repo o/n   # sync GitHub issues ⇄ tasks
```

For shared HTTP use, set `UNDERWRIGHT_TOKEN` — `/mcp` then requires
`Authorization: Bearer <token>` (`/health` stays open).

Both server modes sweep expired task claims on startup and every 60 seconds.
Each expiration removes the claim, reopens the task if it is still `claimed`,
records a `lease_expired` audit event with the former holder and expiry, and
notifies task watchers. Active or renewed leases are left alone, and task states
such as `in_review`, `blocked`, and `done` are preserved. Sweeps are transactional
and safe to run from multiple server processes; failed sweeps are logged to
stderr and retried on the next interval.

Docker (ghcr.io/underwright/underwright, published on tags):

```bash
docker run -v $(pwd)/.uw:/data -p 8741:8741 \
  -e UNDERWRIGHT_TOKEN=$TOKEN ghcr.io/underwright/underwright
```

## Tool surface

| Tool | Purpose |
|---|---|
| `board` | Task board: statuses, claim holders, job counts |
| `create_task` / `list_tasks` / `get_task` | Task lifecycle |
| `claim_task` / `release_task` / `renew_lease` | Atomic claims with expiring leases |
| `post_artifact` | Specs, designs, handoffs, reviews — durable, searchable |
| `search_context` | FTS over helpers + artifacts — call before writing shared code |
| `register_helper` | Publish a reusable util/pattern/config |
| `report_evidence` | Attach test/CI/review proof citing acceptance criteria |
| `complete_task` | Refuses unless every AC has cited evidence |
| `submit_job` / `job_status` | Async job queue — wait on processes, not inference |
| `audit_log` | Who did what, when |

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
