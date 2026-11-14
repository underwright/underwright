# ADR-0007: Watchdog — cheap supervisor loop, LLM escalation on judgment

Status: proposed · 2026-11-08 · task-d158a976

## Context

Between human check-ins the fleet goes idle. Agents are session-scoped and
follow a "work until idle, then exit" loop (AGENTS.md rule 7). Once the last
session exits, nothing produces, routes or verifies work until a human comes
back. Requirements are in the task's spec artifacts R1–R7. In summary: a
resident loop that costs nothing while idle, checks in-flight progress
deterministically, and calls a model only when a decision needs judgment.

Forces and constraints:

- **Zero-token idle.** The resident part must be SQL plus arithmetic. A
  resident LLM, or a cron job that launches an LLM to "look around", burns
  quota on every wake. Usually it finds nothing to do.
- **Stateless HTTP control plane (ADR-0001).** The only clock-driven actor
  is the in-process sweeper (`src/sweeper.ts`, 60 s). All loop state must
  survive restarts in SQLite. No in-memory counters may be load-bearing.
- **Every mutation goes through `Store` and the audit log.** The watchdog is
  an actor (`watchdog`) like `lease-sweeper`. It has no private side channel.
- **At-most-once for unknown outcomes (ADR-0006 decision 2).** The watchdog
  must never auto-retry `lease_lost/outcome_unknown`. Only failures whose
  outcome is *known* may be requeued.
- **Mailbox is pull-only (ADR-0004, ADR-0006 decision 5).** A
  `send_message` nudge reaches an agent only if that agent is still alive
  and polling. A nudge does not revive a dead session.
- **Agents, not LLM calls (R7).** A raw `claude -p` spawn has no MCP tool
  surface. It once ran jobs to `done` while their tasks stayed `open`. Board
  work needs a substrate with tools, memory and context.
  - **Legacy runner plane.** Omnigent is the substrate here:
    `agentInvocation` resolves `backend: "omnigent"`, and
    `extractOmnigentSession` links the transcript.
  - **Node plane.** `launch-agent` currently runs the node-approved harness
    binary directly (`src/node-executors.ts:97`). It does not go through
    omnigent. It does get a task-scoped board tool surface through worker
    tokens (`workerTool`, `src/store.ts`), so it has tools but no session
    memory.
- **Heterogeneous billing (R6b).** Some harnesses are subscriptions:
  exhaustion is visible as `quota.state` in the node capability inventory.
  Others bill per invocation: exhaustion means spend crossing a cap, and
  needs gh-44 cost evidence.
- **Existing parts to reuse:** sweeper cadence; `selectNode` and
  `nodeSpecAllowed`/`nodePolicyAllows` (capability freshness, `auth_status`,
  `quota.state`); `getHarnessMatrix` (agents + omnigent coverage);
  `dispatchNext`/`dispatchCandidates`; `board()` (`agent_activity`,
  `unread_messages`); `digest`; task templates with a `prompt` field;
  `sendHumanNotification`.

Non-goals: leader election or federation (task-1ffb60b5), multi-CP
consensus, Byzantine agents.

## Options considered

### A. Where the loop runs

| Option | For | Against |
|---|---|---|
| (a) separate `underwright watch` daemon | isolation; can run on another host | another unit to install and keep alive; must reach the CP over HTTP; duplicates policy loading |
| **(b) in `serve`, next to the sweeper, with its own interval** | already under systemd `Restart`; direct `Store` access; one process | a bug in watch could stall the sweeper's tick. Mitigated by giving watch its own timer and error boundary. |
| (c) scheduled cloud/cron agent | no code | every wake is an LLM wake, which breaks zero-token idle |

**Decision: (b).** Add a new `src/watch.ts` with `startWatch(store, policy)`.
It uses its own `setInterval` (`watch.interval_seconds`, default 120). It
runs one tick at startup *after* the first sweep, so reclaimed claims are
already visible. It is not folded into `startLeaseSweeper`, so a slow watch
tick cannot delay lease expiry.

It uses the sweeper's `running` guard: a tick that is still in flight when
the next interval fires causes that interval to be skipped, not queued.

### B. Supervisor shape

| Option | For | Against |
|---|---|---|
| (a) resident LLM supervisor session | judgment always on hand | tokens on every wake; context rot; single point of quota exhaustion |
| (b) deterministic only | free, predictable | cannot decide *what* to work on when the board is empty or stuck in an odd way |
| **(c) deterministic tier + escalation tier** | free while idle; judgment only on explicit triggers | two layers to reason about; needs a clear boundary (below) |

**Decision: (c).**

### C. How judgment gets invoked

| Option | For | Against |
|---|---|---|
| (a) direct API call from serve | simple | violates R7: no tools, no board access, no memory |
| **(b) supervisor *task* + `launch-agent` node job through omnigent** (needs the §5 node-executor omnigent path, slice 3; not available today) | uses the real agent substrate; output is artifacts on a task; cost is attributable through the session id | needs an online node that can launch an omnigent-covered harness |
| (c) message a human | always works | that is today's behaviour, and it is the problem being solved |

**Decision: (b), with (c) as the fallback** when no node can launch a
supervisor.

## Decision

### 1. Policy block and autonomy modes (R5)

```jsonc
"watch": {
  "mode": "observe",              // off | observe | continue | keep-going | full
  "interval_seconds": 120,
  "stall_minutes": 20,            // claim alive but claimant silent this long
  "underutilized_wakes": 5,       // consecutive wakes with idle capacity + open work
  "escalation_cooldown_minutes": 60,
  "supervisor_template": "supervisor",
  "failure_signatures": {         // regex -> class; built-ins below, policy extends
    "quota": ["rate.?limit", "quota", "usage limit", "429"],
    "auth":  ["unauthori[sz]ed", "401", "login required", "invalid api key"]
  },
  "budget_usd": { "per_invocation_daily": 20 }   // R6b; omitted = no cap
}
```

If the `watch` block is missing, the effective mode is `off`, which is
today's behaviour. `underwright init` writes `mode: "observe"`.

Each mode gates which checks may **act**. All modes except `off` still
**observe**: they record what they would have done as `watch_observed`
events and count stalls on `board`.

| Check | observe | continue | keep-going | full |
|---|---|---|---|---|
| S1 stalled claim → nudge | log | act | act | act |
| S2 dead claimant → resume session | log | act | act | act |
| S3 queued node job stranded on offline node → reroute | log | act | act | act |
| S4 known-outcome quota/auth failure → harness failover | log | act | act | act |
| S5 idle capacity + open eligible work → dispatch + launch | log | — | act | act |
| S6 budget crossed → clamp to `continue`, notify | log | act | act | act |
| E1–E3 LLM escalation | log | — | — | act |

`continue` finishes in-flight work and never starts a new task.
`keep-going` also starts new tasks. Only `full` spends tokens on
supervision.

**Mode precedence.** `policy.watch.mode` is the human-set **ceiling**.
Editing the policy file is the only way to raise posture. A runtime
override lives in `watch_state` (key `mode_override`). It can **only ever
lower** the effective mode, so the effective mode is
`min(ceiling, override, budget_clamp)`. Lowering through the tool is safe
for any caller; raising it is not.

- The override is set through a new `set_watch_mode` MCP tool, which
  delegates to `Store.setWatchMode`.
- Actor ids on the MCP surface are self-asserted strings
  (`src/server.ts`), so the tool cannot tell a human from an agent. For that
  reason, *raising* an override back toward the ceiling, or clearing it, is
  accepted only from a CLI-local call: `underwright watch mode <m>`, which
  runs in-process against the store, the same trust boundary as editing the
  policy file. It is not accepted over MCP.
- The S6 budget clamp is a **separate** key (`budget_clamp`), not the
  override slot. It applies regardless of any override. Only the next
  UTC-day reset, or a CLI-local `underwright watch budget reset`, lifts it.
- Every change logs `watch_mode_changed {from, to, actor, via, reason}`,
  where `via` is `mcp` or `cli`.

### 2. Stall taxonomy and the deterministic tier (R1, R4)

Each tick runs one `Store.watchTick(now)`. It reads the board-level
aggregates: claims with `lease_expires`, `agent_activity`,
`unread_messages`, node presence and slots, and recent failed jobs. It
returns a list of candidate actions, gated by mode, and the store applies
them in the same transaction. Every action carries a **dedupe key**,
`watch:<check>:<entity>:<window>`, stored in `watch_state`.

- **Requirement:** the dedupe-key insert (`INSERT … ON CONFLICT DO
  NOTHING`, then act only if a row was inserted) and the action's writes
  must commit in the **same transaction**.
- The `running` guard is per process, so with two pstore replicas both
  replicas tick. This transactional dedupe is what stops a restart or a
  second replica from acting twice.

- **S1 — stalled claim.** The claim lease is alive, but the claimant's
  last event is older than `stall_minutes`. Also fires when the claimant has
  an unread message older than `stall_minutes`.
  - Both conditions are computed by direct per-claimant queries:
    `MAX(events.created_at) WHERE actor=?` and
    `MIN(messages.created_at) WHERE to_agent=? AND read=0`.
  - They are not read from `board`, whose `agent_activity` is capped at 50
    actors and whose `unread_messages` holds counts only.
  - Action: one `send_message` nudge per stall window. The nudge carries the
    `{{state}}` snapshot (§4).
  - A second consecutive window with no activity escalates to S2 if S2
    applies. Otherwise it waits for the lease to expire. The watchdog never
    deletes a live claim, because the lease is the fence (ADR-0004).
- **S2 — dead claimant with a resumable session.** S1 holds, *and* the
  claim was itself **produced by a watchdog or dispatcher launch**, *and*
  that launch's job is **terminal** (`done`/`failed` with a known outcome).
  - "Produced by a launch" means the claim was made through the worker
    token of a `launch-agent` job, or under the `agent_id` of a legacy
    `agent` job, and `watch_state` records that job id against the claim.
  - Terminal means the process has exited, so resuming cannot run two
    copies at once.
  - A claim taken by a human-started session has no recorded launch job, so
    S2 never resumes it. It gets the S1 nudge only, then lease expiry.
  - Action: submit `launch-agent` for the same `agent_id`, harness and
    omnigent session (§5). The claim stays put, so the resumed session keeps
    working under it.
  - If the last job is still `running`, or its outcome is `outcome_unknown`,
    do nothing and let the lease lapse.
- **S3 — stranded queued node job.** A node job that is `queued`, has never
  been leased, and has a `target_node_id` that is `offline`/`stale`, while
  `selectNode` finds a different eligible online node with a free slot.
  - Action, in one transaction:
    1. `UPDATE jobs SET status='failed', outcome_reason='rerouted' WHERE
       id=? AND status='queued' AND lease_expires IS NULL`.
    2. Only if that changed one row, insert the successor with `retry_of`,
       routed by `selectNode`.

    A node that comes back mid-reroute cannot lease the original, because
    the guarded update fences it. This is safe because a job that was never
    leased never started. No new `cancelled` status is needed: `failed`
    with `outcome_reason='rerouted'` is enough, and it keeps the existing
    status CHECK constraint.
  - **Pinned jobs are never rerouted.** This needs a new
    `jobs.target_pinned` flag, set when the caller passed `target_node_id`
    explicitly. Today `submitNodeTask` stores the resolved target either way,
    so pinned and auto-routed jobs cannot be told apart.
  - S3 retires once the ADR-0006 decision 3(c) pull queue ships, because
    unpinned jobs then route themselves.
- **S4 — known-outcome harness failure → failover.** An agent or
  `launch-agent` job is `failed` with a known outcome: the process exited.
  Its tail matches a `failure_signatures` class (`quota`/`auth`), or the
  node inventory now shows `quota.state ∉ {available, unknown}` or
  `auth_status ≠ ready` for that harness.
  - Action: requeue with `retry_of` on the **next harness in failover
    order** for the same task.
  - Failover order is the harness_matrix agents eligible for the task's
    type. They are filtered by fresh ready capability (the same predicate as
    `nodePolicyAllows`) and by omnigent coverage (R7, §6). They are sorted
    **subscription before per-invocation** (R6b), then by matrix order
    (free-tier first, gh-53).
  - Attempts are capped by a new `watch.failover_max_attempts` setting
    (default 2). It is deliberately **not** `dispatcher.node_retry`:
    ADR-0006 forbids listing `launch-agent` there, because that setting
    governs *blind* retry of unknown outcomes. The chain is followed through
    `retry_of`.
  - `retry_of` today accepts only node jobs, so failover chains are
    node-plane only. Legacy `agent` jobs that fail with a quota or auth
    error get a `sendHumanNotification` instead.
  - Never applied to `lease_lost` or `outcome_unknown`.
  - Failures the watchdog or the policy caused itself
    (`outcome_reason` ∈ {`rerouted`, `policy_denied`, `failover`}) are
    excluded from both S4 and E3.
  - Any other failure with no matching signature goes to E3.
  - S4 applies only to a **launch-linked claim**, the same condition as S2.
    It never releases a claim held by a session a human started.
  - **Claim handoff.** The successor runs as a different `agent_id`, and
    claims, worker tokens and `complete_task` are all keyed to the
    claimant. So, in the same transaction as the successor insert, S4:
    1. Releases the failed agent's claim through a new
       `Store.watchReleaseClaim(taskId, expectedAgentId)`. It deletes the
       claim only if it is still held by `expectedAgentId`, logs
       `watch_release` with actor `watchdog` and the claimant in `data`, and
       does **not** call `dispatchNext`, so no new task is handed to the dead
       agent. Plain `releaseTask` is not used here: it would log under the
       claimant's id and redispatch to it. This is safe because the failed
       job is terminal.
    2. Posts a `handoff` artifact on the task naming the failure class and
       the successor.
    3. Submits the successor bound to the new `agent_id`.

    The successor claims through its own worker token. If another agent
    claims the task first, the successor's `claim_task` fails and it exits,
    because the claim is the fence.
  - The model is never consulted.
- **S5 — idle capacity, open work.** There are open, ready, unblocked
  tasks, no undelivered `your next task` messages, and launchable capacity:
  a harness_matrix agent with no active claim, under `max_tasks_per_agent`,
  with an eligible online node that has a free slot.
  - Action: call a new public `Store.dispatchIdle(agentId)`. Today's
    `dispatchNext` and `dispatchCandidates` are private and expect a
    complete/release trigger plus an excluded task id, so they are
    refactored to share the ranking logic. `dispatchIdle` sends the
    `your next task` message and, in the same transaction, submits the
    `launch-agent`.
  - If the launch submit is rejected (for example a 403 on stale
    capability), the claim and the message are rolled back with it. No
    claim is left orphaned until TTL.
  - On pstore, the claim, message and node-job writes must share one
    `nodeTransaction`.
  - S5 is how idle time turns into work.
  - **Known limit.** `agentWorkload` counts every completion ever recorded,
    so with `max_tasks_per_agent > 0` an agent id eventually runs out of
    eligibility permanently. Watchdog-driven fleets must either use `0` (no
    cap) or wait for slice 5, which changes the count to completions in the
    last `idle_minutes × N` window.
- **S6 — budget.** Per-invocation spend comes from gh-44 cost evidence,
  summed per UTC day by harness billing class. When it crosses
  `budget_usd`, S6 writes `budget_clamp = continue` and calls
  `sendHumanNotification`. Because the clamp is a separate key (§1), a
  human override cannot switch it off. Subscription exhaustion needs no budget: it is
  already `quota.state` and handled by S4 and launch eligibility.

### 3. Escalation boundary (R2)

The deterministic tier handles everything it can **classify**. Escalation
fires only in `full` mode, and only on these triggers:

- **E1 — stuck board.** There is open work and zero active claims. S5 has
  already tried and produced no successful launch for
  `underutilized_wakes` consecutive wakes. Typical causes: every eligible
  task is blocked, mis-triaged (no estimate), or needs a harness nobody has.
- **E2 — sustained underutilization.** There is idle capacity for
  `underutilized_wakes` consecutive wakes and **no open ready work**. The
  board needs triage or new tasks proposed, which takes judgment.
- **E3 — unclassified failure.** An agent or node job failed with a known
  outcome but no signature matched, or a task has more than 2 `blocked`
  artifacts with no newer activity.

Escalation means creating, or reusing, **one** supervisor task (type
`triage`) from the `supervisor` task template. Its `prompt` is the
supervisor brief, and `{{state}}` is injected into it. Then the watchdog
launches it as in §5.

- Only one supervisor task may be open at a time (dedupe key
  `watch:escalate`). There is a cooldown of `escalation_cooldown_minutes`
  after it completes.
- The supervisor writes its findings as artifacts on its task: kind `note`
  or `design`, plus `create_task`/`update_task` calls. It does not use chat.
- It completes with `review` evidence like any triage task. It does **not**
  claim or perform implementation work itself.
- If no node can launch an omnigent-covered harness, the escalation falls
  back to `sendHumanNotification` with the trigger and the `{{state}}`
  blob.

Counters for consecutive wakes live in `watch_state`, keyed by trigger, so a
restart does not reset them to zero.

### 4. Execution-state injection: `{{state}}` (R3)

Add `state` to the known placeholders. The snapshot is built **server-side**
by `Store.stateSnapshot()` and contains:

- tasks by status (ids, titles, priority)
- claims with lease freshness and claimant activity age
- node liveness and free slots
- unread counts
- the last 20 events
- the effective watch mode

It is compact text, capped at 8 KB, and trimmed oldest-events-first.

- It is expanded **at lease time**, not submit time, so a job that sat in
  the queue still gets the current world. The node plane expands it in
  `leaseNodeJob`. The legacy plane expands it in `next_job`.
- Expansion applies only to the copy returned to the worker. The stored
  `node_spec`/`agent_spec` keeps the literal `{{state}}`, because
  `sweepExpiredNodeJobs` copies `node_spec` into successors and must not
  carry a stale snapshot forward.
- Task titles, artifact text and messages inside the snapshot were written
  by agents. The snapshot wraps them in a fenced
  `<untrusted-board-data>` block. The supervisor template instructs the
  model to treat that block as data, never as instructions. This limits
  prompt injection from one agent into the supervisor.
- `agentInvocation`'s regex grows to include `state`. If the value is
  missing, the placeholder expands to an empty string.
- The same blob is exposed as `digest({ state: true })` and
  `underwright digest --state`.

Rationale: every wake is a fresh process. Durable memory lives in the store,
in artifacts, and in the omnigent session. The prompt carries only the
current-world delta, never a transcript.

### 5. Omnigent session resume path

- **Today only legacy `agent` jobs run through omnigent** and record
  `omnigent session: <id>` (`executeLeasedJob` → `extractOmnigentSession`).
  `launch-agent` spawns the node-approved harness binary directly.
- **Prerequisite (slice 3).** Give the node executor an omnigent path. A
  node `harnesses` entry may declare `"backend": "omnigent"`. The
  `launch-agent` executor then builds `omni run --harness H [--resume S] -p
  <prompt>` and reuses `extractOmnigentSession` on the job output. The
  session id is returned in the job's `result_metadata`.
- The watchdog records the latest session per `(agent_id, task_id)`, and
  for the supervisor under `watch_state.supervisor_session`.
- Resume (S2, and repeat escalations) passes the session id in a new
  optional `launch-agent` payload field, `session`. The prompt is a short
  "continue; current state: {{state}}".
- **Requirement on omnigent:** a resume flag. Until it exists, or if the
  session has been evicted, the executor starts a fresh session. Continuity
  then comes from `get_task` artifacts plus `{{state}}`. This is degraded
  but correct, because the board, not the session, is the source of truth.

### 6. Substrate check (R7)

- The watchdog launches only through a substrate that provides memory as
  well as tools.
  - **Legacy plane:** `agentInvocation` must resolve to `omnigent`.
  - **Node plane:** the target node's capability inventory must advertise
    the harness with `backend: "omnigent"` (§5 prerequisite).
  - Worker-token tool access alone is not enough. It gives board tools but
    no session memory, so S2 has nothing to resume.
- When neither condition holds, the watchdog will not launch:
  - It logs `watch_misconfig {agent_id, harness, plane}` once per day per
    agent.
  - It drops that agent from S2, S4 and S5 candidates.
- `uw-runner` keeps the raw path for non-board jobs (`test`/`build`). It
  prints a one-line warning when an `agent` job resolves to raw.
- Today this excludes `grok`, `agy`, `kimi` and `cmdc` from watchdog
  launches until omnigent coverage lands. Those agents still work the board
  when a human starts them.

### 7. Multi-instance capacity (R6a)

- A harness_matrix agent entry may declare `"instances": N`. The watchdog
  expands it to independent ids: `claude@minipc`, `claude-2@minipc`, …,
  `claude-N@minipc`.
- Claims, jobs, mail and `max_tasks_per_agent` are already keyed per
  `agent_id`, so each instance is independent capacity.
- Launch eligibility also requires a free node slot
  (`max_concurrency − current_slots`). Instances never oversubscribe a node.

### 8. Storage and surface

- New table, in `src/schema.ts`:
  `watch_state(key TEXT PRIMARY KEY, value_json TEXT, expires_at TEXT,
  updated_at TEXT)`. It holds counters, dedupe keys, the mode override,
  `budget_clamp`, launch-job ↔ claim links, and supervisor session/task ids.
  - Dedupe keys expire at `window end + 1 day`, not on a fixed 7-day prune,
    so a long window cannot re-fire early.
- New `jobs.target_pinned` column (S3).
- New `IStore` methods: `watchTick`, `stateSnapshot`, `setWatchMode`,
  `dispatchIdle`.
- New MCP tool: `set_watch_mode`.
- `board` gains `watch: { mode, effective_mode, last_tick_at, stalls }`.
- Events, all with actor `watchdog`: `watch_observed`, `watch_nudge`,
  `watch_resume`, `watch_reroute`, `watch_failover`, `watch_dispatch`,
  `watch_escalate`, `watch_budget_clamp`, `watch_misconfig`,
  `watch_mode_changed`.

## Consequences

- **The fleet makes progress unattended up to the chosen posture.**
  - `continue` finishes in-flight work across agent deaths and quota
    exhaustion.
  - `keep-going` also pulls new work onto idle capacity.
  - `full` adds bounded judgment, at one supervisor session per cooldown.
- **Token spend is proportional to judgment, not to wall-clock time.** A
  quiet fleet costs SQL queries every `interval_seconds`.
- **Quota shift is purely deterministic.** S4 reads the same capability
  freshness and `quota.state` that `launch-agent` already enforces, so the
  watchdog cannot route to a harness that the submit path would reject.
  Stale capability makes a node ineligible. It does not trigger a guess.
- **Failover re-runs agent work on another harness.** This is safe for the
  task state machine (ADR-0003). It can leave partial edits in a shared
  working tree. Branch-per-task worktree isolation (ADR-0006) is still the
  mitigation, and S4 refuses `outcome_unknown`.
- **Supervisor quality depends on the template prompt.** It is versioned in
  policy `templates`, so it can be improved without code changes.
- **Watchdog launches need omnigent coverage.** This makes R7 a hard
  dependency: until `grok`/`agy`/`kimi`/`cmdc` gain coverage, the
  autonomous fleet is codex and claude-sdk only.
- **S3 is temporary.** It goes away once the pull queue (ADR-0006 3c)
  ships.
- **S6 depends on gh-44.** Without cost evidence, per-invocation spend is
  unknown. S6 then stays dormant, and the docs tell operators to keep
  per-invocation harnesses out of the matrix when the mode is
  `keep-going`/`full`.

## Implementation slices (follow-up tasks)

1. `watch_state` table, `watch` policy parsing, `startWatch`, mode
   precedence (lower-only over MCP, raise via CLI), `set_watch_mode`, and
   `board.watch` in `observe` only.
2. `{{state}}`: `stateSnapshot`, lease-time expansion (not persisted), the
   untrusted-data fence, and `digest --state`.
3. An omnigent backend for the node `launch-agent` executor, plus the
   `session` payload field. Then S1/S2 (nudge, session resume).
4. S4 failure classification, failover order and claim handoff. S3
   reroute and `target_pinned`.
5. S5 `dispatchIdle` with transactional launch and rollback, a windowed
   `agentWorkload`, `instances`, and the R7 substrate check.
6. E1–E3 escalation, the `supervisor` builtin template, and the
   human-notify fallback.
7. S6 budget clamp (blocked on gh-44).
