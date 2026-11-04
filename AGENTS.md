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
