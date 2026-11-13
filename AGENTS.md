# Agent rules for this repo

Underwright is built by agents, through its own control plane. If you are an
agent working in this repo, follow these rules — they are not suggestions.

## Coordination

1. **Check the board first.** Call `board` (or `underwright board`) before
   starting work. Pick up an open task or propose a new one via `create_task`.
2. **Claim before work.** Call `claim_task` with a stable `agent_id` naming
   your harness+host (e.g. `claude@minipc`, `kimi@laptop-2`). Renew the lease
   on long work. Release if you stop.
3. **Search before building.** Call `search_context` before writing any new
   shared utility, pattern, or config. If a helper exists, reuse it. When you
   create something reusable, call `register_helper`.
4. **Communicate through artifacts.** Post specs, designs, and handoffs with
   `post_artifact` on the task. No side channels — the artifact store is the
   record.
5. **Done requires evidence.** `complete_task` refuses without
   `report_evidence` citing every `ac_id` on the task. Run the build/tests,
   attach real output.
6. **Long work goes to the queue.** `submit_job` for test suites, builds, and
   anything slow. Don't block your context waiting on processes.
7. **Work the board until idle.** The loop is: complete the task, read
   `inbox`, claim the assigned task, repeat until the board is empty.
   A message `your next task: <id>` is the assignment. The dispatcher
   claims it for your `agent_id` when you are under the policy cap. If
   you do not hold that claim, `claim_task` it yourself. Stop when no
   next-task message arrives — you are idle.

Dispatcher policy lives in `underwright.policy.json` under `dispatcher`.
`enabled` turns assignment on or off. `max_tasks_per_agent` caps how many
tasks one agent is given (completions plus active claims; `0` means no cap).
`idle_minutes` is how long a next-task message may sit before the sweeper
reassigns that task if it is still unclaimed, or logs `dispatch_idle` when
nobody else can take it.

## Where work comes from

GitHub issues are the system of truth for work items. Board tasks exist to
coordinate execution of an issue, not as a separate backlog. Under normal
flow a board item is a `gh-*` task synced from an issue via
`underwright github sync` (or the repo webhook). When you discover work that
has no issue — a bug, a gap, follow-up work — raise it:

1. `gh issue create` in the affected repo with a clear title and scope.
2. `underwright github sync --repo <owner/name>` to pull it onto the board
   as a `gh-<n>` task (webhook-synced repos skip this — the task appears on
   its own).
3. Claim and work the board task as usual; link the issue in artifacts.

Use `create_task` directly only for board-internal bookkeeping that does not
belong on the issue tracker (review tasks, probes, ephemeral coordination).
If in doubt, it belongs on GitHub.

## Anti-escalation

Escalation is a last resort and goes through the mailbox. Never stop silently.

Before escalating:

1. Call `search_context` for helpers, specs, and prior decisions.
2. Check artifacts and handoffs already posted on the task. `get_task` returns them.
3. Try the alternate harness CLI path (claude, codex, grok, agy, or cmdc; see `docs/multi-harness.md`).
4. If still blocked, `post_artifact` with kind `blocked` recording what was tried, `send_message` the human, then `release_task` so the dispatcher assigns the next task. Read `inbox` and continue. Do not go idle.

**Wrong model for the job?** Agent jobs run at a model tier routed from the
task (`model_routing` in the policy: estimate S/docs → light, architecture,
design review, L, or core-store paths → heavy). If the task is beyond your
model, do not thrash. Post a `blocked` artifact whose content includes
`needs-stronger-model` and says why, then `release_task`. The watch
re-dispatches the task one tier heavier. At the heavy tier it goes to the
human instead.

## Git hygiene

Work happens on branches, never as dirty files on `main`:

1. **Branch before editing.** Work in a `feat/gh-<n>-*` branch or a `uw-*`
   worktree — never accumulate uncommitted changes in the `main` checkout.
   `git status` on `main` must be empty when you stop for the day.
2. **Push when done.** When a task completes, commit and push its branch (or
   the merge to `main` when that's the flow). Do not leave finished work
   local-only — an unpushed commit is undelivered work.
3. **No orphans.** Uncommitted work you're not finishing right now goes to a
   named branch or a labeled stash with a `post_artifact` noting where it
   lives. Never leave files dirty on `main` with no record.
4. **Stale branches are board items.** If you create or find a stale
   `feat/*`/`worktree-*` branch, note it in a handoff artifact so the
   hygiene sweep can classify it.

## Stack

- TypeScript, Node 18+, ESM (`Node16` modules — import with `.js` extensions)
- `npm run build` to compile, `npm test` when tests exist
- better-sqlite3 for the store; MCP SDK for the protocol surface
- Schema lives in `src/schema.ts` (single source — no .sql files)

## Conventions

- All mutations flow through `Store` methods which write to the audit log
- New MCP tools: zod schema + `server.tool()` in `src/server.ts`, thin
  delegation to a `Store` method
- Stateless HTTP mode: no per-request state — everything durable goes in SQLite
