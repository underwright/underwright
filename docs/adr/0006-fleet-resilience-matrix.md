# ADR-0006: Fleet resilience — failure→recovery matrix

Status: accepted (rev 3) · 2026-11-13 · task-1ffb60b5

Rev 2 addresses the independent design review by codex@minipc
(art-5066d3b0 / art-a4c1eb43, verdict *reject*). Rev 1 overstated three
guarantees: claim fencing, recovery bounds, and keyed node retry. Each one is
now qualified against the code, and the two implementation defects are tracked
as #79 and #80. Rev 3 applies the re-review corrections
(art-f8c00243, verdict *approve-with-changes*).

## Context

Near-term requirement: the fleet survives reboots. If the driving agent dies,
its work still finishes. New work gets picked up. Agents that don't know about
each other do little duplicate work. Messaging carries the handoffs.

Forces and constraints:

- **Stateless HTTP control plane (ADR-0001).** All recovery state sits in
  SQLite. The only clock-driven actor is the in-process lease sweeper
  (`src/sweeper.ts`, a startup tick then every 60 s). The tick is
  leadership-gated (`src/sweeper.ts:24`; `src/store.ts:942-951`). After a CP
  restart the first sweep can wait for a previous leader's 90 s lease to run
  out. The sweep runs `sweepExpiredClaims`, `sweepIdleDispatches` and
  `sweepExpiredNodeJobs`.
- **Leases, not membership (ADR-0004).** Liveness is inferred from leases
  expiring and from recent agent-driven audit events. Nobody deregisters.
- **Evidence-gated done (ADR-0003).** Re-running work is safe for the *task*
  state machine. It is not necessarily safe for the *side effects* of a job.
- **Two job planes with different guarantees.** Legacy runner jobs
  (`next_job`/`uw-runner`) and node jobs (`submit_node_task`/`node run`).
  Node jobs carry a private attempt journal and receipt digests
  (`src/node-journal.ts`).
- Agents are heterogeneous harnesses (claude, codex, grok, agy, cmdc…). Each
  has its own process lifetime. None runs a daemon we control.

**Vocabulary.** *Fenced* means the control plane refuses a stale actor's
write. *Exclusive* means only one process executes. The control plane can
provide fencing. It cannot provide exclusivity: a cut-off process keeps
running until it notices, and cancellation cannot undo external side effects.

## Failure→recovery matrix

All "durable" claims below mean *committed SQLite mutations on intact
storage*. WAL is not a backup. Webhooks (`claim_reclaimed`, …) are
best-effort, fired after commit, and not durably delivered.

| Failure | Detection | Automatic recovery today | Guarantee | Residual gap |
|---|---|---|---|---|
| **Control plane down / host reboot** | systemd `Restart=on-failure` for `serve`, unit enabled at boot, lingering attempted (`src/service.ts:110-112,193-196,208-214`) | CP restarts. The sweeper runs at startup once it holds leadership. An old leader's lease can block it for up to 90 s, plus up to one 60 s tick before the next attempt. Expired claims are removed. Tasks still `claimed` are reopened (`src/store.ts:959-966`). | Committed board state survives. Leases keep running in wall-clock time, so a long outage expires claims on restart. | Agents mid-call see errors and must retry. Reopened tasks are re-dispatched only under the conditions in rows 2–3. |
| **Agent dies holding a claim** | Claim `lease_expires` passes | `sweepExpiredClaims` deletes the claim, reopens the task, logs `lease_expired`, messages watchers, and fires `claim_reclaimed` asynchronously (`src/store.ts:956-987`). For a *dispatched* task with an outstanding stale `your next task` message, `sweepIdleDispatches` picks an alternate, claims the task for it, and messages it (`src/store.ts:1203-1307`). | At most one *claim row* per task. Posted artifacts and evidence survive and are visible through `get_task`. Reopening is bounded by TTL plus sweep granularity plus leader delay, *assuming a healthy running sweeper, an intact DB, and no stale renewal* (#80 lets an expired, unswept claim be extended). **Successful reassignment is not bounded.** | (a) A *self-claimed* task reopens, but nobody is pushed to it. (b) If no alternate is eligible, the message is marked `no_alternate_agent`/`dispatch_idle` once and never rescanned (`src/store.ts:1209-1214,1297`), so the task can wait indefinitely. (c) Claims are not fully fenced: see the Partition row and #80. |
| **Agent dies with no claim (idle / between tasks)** | A `your next task` message stays unhandled past `idle_minutes` | Same reassignment path as above. Candidates are limited to agents with agent-driven `completed`/`lease_renewed`/`released` events within `max(idle_minutes*2, 30)` min. Synthetic dispatcher `claimed` events are excluded (`src/store.ts:1237-1253,1281`). `dispatchNext` pre-claims assignments (`src/store.ts:1158-1170`), so a dead assignee usually holds a claim and recovers through row 2 (claim expiry), not after `idle_minutes` alone. | Best-effort reassignment to a recently active agent. | An idle agent with no outstanding message causes no recovery action and needs none. When no alternate exists, recovery is a terminal log entry with no retry. |
| **Runner (`uw-runner`) dies mid-job** | Job lease (default 60 s, `nextJob` `ttlSeconds`) lapses | `next_job` atomically re-leases expired `running` jobs with a new token (`src/store.ts:1608-1622`). `host`/`target_agent_id` filters still apply, so only a compatible runner can pick the job up. A *living* runner that loses its lease kills its child with TERM, then KILL (`src/runner.ts:129-163`). | **At-least-once redelivery**, assuming a compatible runner returns. Results are fenced: `finishJob` checks runner id, token and a live deadline (`src/store.ts:1637-1642`). | No attempt cap or `retry_of` chain, so `deploy`/`agent` jobs can repeat side effects. A *dead* runner's orphaned child may keep running until the host or supervisor cleans it up. |
| **Runner host reboot** | Same as above | `service install runner` renders the unit with `Restart=always`, enables and starts it, and attempts lingering (`src/service.ts:71-76,111,193-214`). | Same as above, once the unit is installed and the runner has its credentials and connectivity. | Work pinned by `host`/`target_agent_id` to a host that never returns is stranded. |
| **Node (`node run`) dies / reboots mid-job** | Node job lease lapses. Presence derived from `last_seen_at` goes `stale`/`offline` (`src/node-protocol.ts:98-109`). | `sweepExpiredNodeJobs` fails the job with `lease_lost/outcome_unknown`. If `dispatcher.node_retry` lists the kind and the depth is under `max_attempts`, it inserts a successor (`retry_of`, `lease_lost/requeued`) pinned to the same `target_node_id` (`src/store.ts:316-344`). On daemon start, `AttemptJournal.reconcile()` kills identity-matched orphan process groups and marks started attempts `uncertain` (`src/node-run.ts:129`; `src/node-journal.ts:26-35`). | **At-most-once per job/attempt**, given intact journal state on the node: the journal refuses to replay a recorded attempt (`src/node-run.ts:237-264`). Finish receipts make identical replays idempotent (`src/store.ts:435-447`). | **Bug #79:** when a retry-eligible job has a `dedupe_key`, the successor INSERT runs before the original is failed, which violates `jobs_active_dedupe` (`src/schema.ts:68-71`; same ordering in `src/pstore.ts:410-422`). The whole sweep transaction rolls back and every expired job in that sweep stays `running`. The successor is pinned to the dead node (decision 3). `retry_of` is optional on manual submits and only checked for existence (`src/store.ts:226-243`). Dedupe is not logical-operation idempotency. |
| **Partition (agent/node ↔ CP)** | Renewals fail. Leases expire on the CP side. | Same as the "dies" rows on the CP side. Worker daemons cancel their child at the lease deadline, with scheduling and kill grace (`src/runner.ts:147-163`; `src/node-run.ts:242-256`). | **Job results are fenced:** legacy finishes by lease token (`src/store.ts:1637-1642`); node calls by token, session epoch, deadline and receipt digest (`src/store.ts:174-183,279-298,430-455`). **Task claims are not fully fenced (bug #80):** `complete_task` passes when no claim exists and rejects only another agent's claim (`src/store.ts:1043-1048`). `renewLease` checks the agent id but not expiry, so it can revive an expired, not-yet-swept claim (`src/store.ts:933-938`). | A stale agent can complete a task after its claim lapsed, or while a new claimant with the same id holds it. Agents on the far side keep editing files until their next call fails. Nothing fences the working tree. |
| **SQLite file loss** | n/a | No automatic recovery | Manual restore from a prior `export` snapshot (`src/snapshot.ts:101-109,233-240`) recovers state up to that snapshot. Without a snapshot there is no recovery. | Backup/replication belongs with pluggable store (ADR-0002). |

## Options considered and decisions

### 1. Runner/node always-up deployment

- *Options:* (a) document manual `systemctl` units; (b) `service install run|runner|node` renders and enables units; (c) fold into `underwright init`.
- **Decision:** (b) shipped. `Restart=always` for `run`/`runner`, `on-failure` for the CP, lingering attempted with a warning on failure. **Follow-up:** `init` prints the `service install` command for each role it configures. It does not install automatically, because that needs the user's consent and differs by host.

### 2. Node-job retry for `lease_lost` / `outcome_unknown`

- *Options:* (a) mandatory `retry_of` always (safe, needs a human/agent in the loop); (b) auto-retry every kind (live, risks double execution); (c) opt-in auto-retry per kind with an attempt cap.
- **Decision:** (c), `dispatcher.node_retry { kinds, max_attempts }`, **default off**. The cap is an *automatic* retry budget per `retry_of` chain (`nodeRetryDepth`, consulted only by the sweeper). Manual retries submitted with `retry_of` count toward that budget, but manual submissions themselves are not capped, and neither are resubmits that omit `retry_of`. This repo enables `run-script` with `max_attempts: 2`.
- **Caveats the review raised, accepted:**
  - A kind being listed does not make it idempotent. `run-script` executes arbitrary scripts. Enabling the kind is an operator assertion that *every* script routed through it is safe to repeat, or carries its own idempotency key. Until per-script contracts exist, list only scripts that meet this bar.
  - "Never list `provision`/`install-harness`/`launch-agent`" is guidance. Policy accepts any kind string (`src/policy.ts:230-238`). **Follow-up:** enforce a denylist in policy validation.
  - Auto-retry is **not shipped for keyed jobs** until #79 is fixed. The fix must fail the original (UPDATE) before inserting the successor, in the same atomic transaction, so the active-key entry is released first. A per-job savepoint is *additional* failure isolation, so one bad job cannot roll back the whole sweep. A savepoint alone does not fix the conflict.
  - `docs/node-executors.md` must carry a per-executor retry-safety table that agrees with the "retry needs deliberate `retry_of`" guidance already there (`:51-54`).
- **Follow-up (legacy plane):** attempt counter, cap and `retry_of` chain, with `deploy`/`agent` defaulting to 1 attempt. When the cap is hit the job must reach a terminal `failed`/`outcome_unknown` state and the submitter must be messaged. It must not stay as a permanently expired `running` row. Losing that work is the deliberate trade. The manual path is to resubmit with `retry_of`.

### 3. Any-node capability routing

- *Options:* (a) target required; (b) push-route at submit time (`selectNode` ranks online+free > online-busy > non-online, `src/node-protocol.ts:204-221`); (c) pull-based unassigned queue that any eligible node leases.
- **Decision:** (b) shipped as the MVP. **Adopt (c) next**, with this contract:
  - A job with an explicit `target_node_id` stays pinned. Unpinned jobs keep `target_node_id NULL` plus their capability requirement.
  - Leasing reserves eligibility and capacity atomically in one transaction. Today's lease path is pinned and serial (`src/store.ts:355-368`), so advertised `max_concurrency` is not yet authoritative.
  - Capability freshness: a node's advertised capabilities (especially `launch-agent` harness readiness, `src/node-protocol.ts:190-196`) and its workspace/repository availability must be current at lease time.
  - Selection skips jobs the polling node can't run. An incompatible head of the queue must not block later work.
  - A job no node can run surfaces a diagnostic (`no_eligible_node`) on the board instead of starving silently.
  - A cross-node retry relies on *external* idempotency. The original node's journal is private and cannot dedupe on another host.

### 4. Agent presence beyond claim leases

- *Options:* (a) leases only; (b) recency of agent-driven audit events; (c) explicit heartbeat (`agents` table with `last_seen_at`, harness, host, capacity).
- **Current state (corrected):** (b) already exists inside the dispatcher. `knownAgentWorkloads(liveWithinMinutes)` uses `completed`/`lease_renewed`/`released` events within `max(idle_minutes*2, 30)` min for idle-sweep and review dispatch (`src/store.ts:1237-1253,1281`). Separately, `board.agent_activity` shows the latest event of any kind for the 50 most recent actors (`src/store.ts:1737-1744`). The two disagree. Board activity counts synthetic dispatcher claims, and neither view counts read-only calls (`inbox`, `board`, `get_task`).
- **Decision:** extend (b), don't add it from scratch. Define one *agent-driven last-seen* predicate and use it for both dispatch paths and for `board.agent_activity`. Include `post_artifact`, `report_evidence` and `claim_task` by the agent itself, and exclude dispatcher-made events. Make the window a policy key (`presence_minutes`) instead of the hard-coded formula. Recency is a heuristic, not proof that a process is alive. False negatives (a new agent, or one that only reads) are cleared on the agent's next mutation. Defer (c) until those false negatives cause measurable misdispatch.

### 5. Messaging

- *Options:* inbox only; unread counts on board; watcher broadcast; pub/sub push or long-poll.
- **Decision:** keep the pull mailbox (ADR-0004, ADR-0009). Stateless HTTP does not by itself rule out long polling (node polling already waits through repeated durable reads, `src/store.ts:397-406`). The reason to stay pull-only is operational: agents already poll `inbox` at every loop boundary, and a held connection buys nothing for a harness that exits when idle. `board.unread_messages` is shipped.
- **Known limitation:** `inbox` marks messages read on fetch (`src/store.ts:898-903`), so the unread count is not an acknowledgement. Reading does **not** suppress recovery, though: `staleNextTasks` has no read predicate (`src/store.ts:1203-1220`). If the agent crashes after reading `your next task`, the idle sweep waits for the pre-claim to expire and then reassigns using that original message (`src/store.ts:1266-1307`). Claim expiry without a qualifying dispatcher message re-dispatches nothing today. That is the gap below.
- **Gap-closer (follow-up):** a stale-assignment re-dispatch that covers both row-2(a) self-claimed tasks and row-2(b) one-shot `dispatch_idle`:
  - When `sweepExpiredClaims` reopens a task, it is re-dispatched in the same transaction through the same gates (review harness rule, `max_tasks_per_agent`, presence).
  - Concurrent sweeps and already-outstanding assignments are deduped.
  - Only tasks the sweep reopened are eligible, never `blocked`/`in_review`/`done` ones. Eligibility is recorded as durable pending-redispatch state (cleared on claim or status change), so later backoff sweeps still find a task that is still open.
  - A task with no eligible alternate is retried on later sweeps, with backoff, instead of being marked once and dropped.
  - Watcher notifications stay visibility only. They do not guarantee a live executor is launched.

## Consequences

- "Durable" now has a qualified definition per failure mode:
  - Committed board state survives CP restarts on intact storage.
  - Task claims self-heal: with a healthy sweeper, reopening is bounded by TTL plus sweep and leader delay. Reassignment is best-effort and can wait indefinitely when no agent is eligible.
  - Task claims are **not** fenced against a stale holder until #80 adds a live-claim check to `complete_task`/`renew_lease` (and, ideally, a claim generation token).
  - Job *results* are fenced on both planes. Job *execution* is not exclusive.
  - Legacy jobs: at-least-once redelivery. Node jobs: at-most-once per attempt unless a kind opts into capped retry. Keyed node retry is broken until #79.
- Auto-retry trades double-execution risk for liveness. The trade is made per kind in policy, never globally, and listing a kind asserts it is idempotent.
- Operators who want faster failover shorten claim TTLs and renew more often, at the cost of more writes.
- A claim guarantees only one claim row per task. Until #80 it does not fence a stale holder's board writes, and it never fences the filesystem. Worktree isolation per claim (`isolation: worktree`, branch-per-task) remains the filesystem mitigation.

### Follow-up tasks

1. **#80** — `complete_task`/`renew_lease` require a live, unexpired claim held by the caller (plus a generation token).
2. **#79** — fix keyed node-retry ordering. Isolate per-job failures in the sweep.
3. Legacy runner jobs: attempt counter and cap, `retry_of` chain, `deploy`/`agent` default to 1, terminal `outcome_unknown` with a notification.
4. Pull-based unpinned node queue with the decision-3 contract.
5. Unified agent-driven last-seen predicate plus a `presence_minutes` policy key (decision 4).
6. Stale-assignment re-dispatch covering self-claimed tasks and `dispatch_idle` retry (decision 5).
7. Per-executor retry-safety table in `docs/node-executors.md`, and a policy denylist for non-idempotent kinds in `node_retry`.
8. `init` prints `service install run|runner|node` hints.
