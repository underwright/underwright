# Resident agents: context playbook

Status: draft · 2026-11-09 · tracks [#40](https://github.com/underwright/underwright/issues/40)
(child task `task-3ae4e98a`, AC `context-playbook`)

Today every dispatched task starts a fresh harness process (`claude -p`,
`codex exec`, `grok --single`, `cmdc -p`, `agy --print`). Each run re-reads
AGENTS.md, re-discovers the repo layout, and re-learns the Store API. This doc
covers where context should live so resident sessions can reuse it, and how
the control plane will track those sessions.

## Three tiers of context

| Tier | Lives in | Lifetime | Shared with | What belongs here |
|---|---|---|---|---|
| **Static prefix** | Harness system prompt / first user turn | Stable across tasks and agents | Every agent on the workspace (prompt cache) | AGENTS.md, MCP tool descriptions, server instructions, stack conventions. Nothing per-task, per-agent, or time-stamped. |
| **Session context** | Harness conversation (resumed with `-c` / `--resume`) | One agent, one workspace, until the session dies | That agent only | Repo layout learned while working, files already read, local build/test quirks, the agent's in-flight reasoning on the current task. |
| **Board** | Artifacts, evidence, helpers, audit log (SQLite) | Permanent | All agents, all hosts, humans | Decisions, specs, handoffs, blockers, triage notes, reusable helpers, proof of done. Anything a *different* agent would otherwise have to re-derive. |

### Rules

1. **If a successor needs it, it goes on the board.** Session context is a
   cache and can be lost at any time (process crash, host reboot, context
   compaction). Anything that matters beyond this session gets
   `post_artifact` (decisions, findings, blockers) or `register_helper`
   (reusable code).
2. **The static prefix must be byte-stable.** Prompt caches match on exact
   prefixes. Put per-job values (`task_id`, `agent_id`, `host`, `job_id`,
   timestamps) at the **end** of the prompt, never at the start. Today's
   `LAUNCH_PROMPT` in `src/dispatcher.ts` starts with
   `You are {{agent_id}} on {{host}}`, so no two launches share a prefix.
   `task-96ea1745` fixes this.
3. **Don't copy board content into session context.** Read it with
   `get_task` / `search_context` when you need it. Pasting it into a
   long-lived prompt goes stale and wastes tokens.
4. **Session context is per workspace.** Never resume a session in a
   different repo or workspace. Its learned layout would be wrong.
5. **Learned conventions get promoted.** If a session finds a convention
   every agent should follow, propose it as an AGENTS.md change (static
   prefix) instead of leaving it in one agent's memory.

### Cache-friendly prompt shape

```
[static]   AGENTS.md + tool docs + server instructions      ← cached, shared
[static]   Fleet loop instructions (claim → work → evidence → inbox)
[dynamic]  "You are <agent_id> on <host>. Task: <task_id>. Job: <job_id>."
```

On a resumed session the dynamic tail is all that gets sent:
`your next task: <task_id>` (the same body as the dispatcher's mailbox message).

## Session lifecycle (design for `task-61007fa8`, `task-96ea1745`)

Sessions are registered the way claims are: leased, audited, and visible on the board.

**Registry (`agent_sessions`):** `agent_id`, `host`, `workspace`, `harness`,
`backend` (`raw` | `omnigent`), `session_id` (harness conversation id or
omnigent conversation), `started_at`, `last_active`, `status`
(`live` | `dead`), and nullable `tokens_in`, `tokens_out`, `cost_usd` for
gh-35 cost rollups.

- `register_session`: the runner or agent records the session id after the first turn.
  For omnigent, `extractOmnigentSession` in `src/runner.ts` already parses it
  from output.
- `touch_session`: bumps `last_active` on every job finish or heartbeat.
- `end_session` / sweeper: marks the session `dead` on explicit end, on process
  exit with a non-resumable status, or once `last_active` is older than an idle
  TTL (policy `dispatcher.session_idle_minutes`).
- `board`: lists live sessions grouped by agent and host.

**Dispatch:** when the dispatcher assigns task n+1 to an agent:

1. If the agent has a `live` session on a host that can run it and the harness
   supports resume, queue a resume-mode agent job: the harness resume flag
   plus the short `your next task: <id>` prompt.
2. Otherwise, cold-start with the full prompt and register the new session.
3. If a resume fails (unknown session, expired), mark the session `dead` and
   retry once cold.

Mailbox-driven agents that are already running (like this one) need no job.
They read `inbox` and continue in the same conversation. The registry still
records them so the board shows who is live.

## Harness resume support

| Harness | Cold start | Resume | Portable across hosts |
|---|---|---|---|
| claude | `claude -p PROMPT` | `claude -p --resume <session-id> PROMPT` or `-c` (most recent in cwd) | No (local transcript) |
| codex | `codex exec PROMPT` | `codex exec resume <session-id> PROMPT` or `--last` | No |
| grok | `grok --single PROMPT` | `grok -c` / `--continue` (per #40, not verified) | No |
| cmdc | `cmdc -p --yolo PROMPT` | `cmdc -c` / `--resume` (per #40, not verified) | No |
| agy | `agy --print PROMPT` | Unknown, treat as cold-start only | No |
| omnigent | `omni run --harness H [--server S] -p PROMPT` | `omni run --resume <conv> -p PROMPT` | **Yes**, with `--server` (gh-35 session-portability) |

Raw harnesses can only resume on the host that started the session. To move
a session between hosts (minipc ↔ alandesktop), use omnigent with
`--server`. Verify each flag before enabling it in the runner's resume table.

## Measuring it

`task-9494af04` compares tokens per task, cold-start vs resident, on a repeat
task, using gh-35 cost evidence. Expected wins: cache hits on the static prefix,
and no repeated repo discovery. Expected risk: context growth across many
tasks. Watch for compaction and per-turn cost creeping up, and cap tasks per
session if it does.
