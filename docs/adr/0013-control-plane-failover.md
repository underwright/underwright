# ADR-0013: Postgres control-plane failover with a fenced leader lease

Status: proposed · 2026-11-14

Task: `task-06cc4148` · implementation target: `underwright-pro`.

## Context and scope

[ADR-0001](0001-stateless-http-mcp.md) makes HTTP MCP requests stateless;
[ADR-0002](0002-pluggable-store.md) selects `PgStore` with `DATABASE_URL`.
Two processes can therefore share durable tasks, claims, node sessions, job
leases, artifacts, evidence, messages, and audit records. That alone does not
make them safe active/standby instances: today `serveHttp()` starts a sweeper
unconditionally, `/health` reports process liveness, and request paths can
perform maintenance and dispatch as well as their advertised operation.

This ADR specifies a future HA controller, not an implemented failover feature.
The OSS core retains single-instance self-hosting, Postgres support, and manual
recovery/repointing described in [the transport guide](../tls-reverse-proxy.md).
Automated promotion, endpoint management, and managed HA belong in the private
`underwright-pro` package, consistent with [COMMERCIAL.md](../../COMMERCIAL.md).
No HA runtime, migration, or new public configuration is added by this ADR.

## Decision

### Topology and durable state

Run two CP instances against **one writable Postgres primary**. Each process
gets a fresh random instance ID on startup; a hostname is not an incarnation ID.
One instance is active, the other standby. Both load the same application
version, workspace policy, admin authentication material, and node credential
validation configuration. Request/session data stays in Postgres; connections,
health observations, and timers may remain in memory.

Use one `cp_leader` row per coordination domain (initially one workspace/board).
The proposed pro-owned migration records:

| Field | Meaning |
| --- | --- |
| `domain_id` (primary key) | Isolates elections for unrelated boards |
| `holder_id` | Unique process incarnation; nullable when released |
| `generation` (bigint) | Monotonically increasing fencing token |
| `lease_expires_at` (timestamptz) | Expiry measured by Postgres time |

Do not add a second schema source in OSS. If a reusable Store hook is needed,
review it separately; any core schema changes must follow `src/schema.ts` and
backend parity conventions. The pro package owns its election migration.

Current `PgStore.connect()` runs bootstrap DDL/migrations during every startup.
HA must first separate schema bootstrap from runtime opening: apply core and pro
migrations once in a deployment job under one domain/database migration advisory
lock, then start instances with version validation and bootstrap disabled. The
lock covers the complete migration sequence, including core DDL; serializing
only the pro table is insufficient. Reject incompatible schemas before election.
Any core bootstrap hook required for this must be reviewed separately.

### Election and heartbeat

1. Create the domain row idempotently. Every acquire/renew/release transaction
   locks that row (`SELECT ... FOR UPDATE`); competing instances serialize on it.
2. After acquiring the lock, compare expiry using fresh database wall time
   (`clock_timestamp()`), not process clocks or transaction-start `now()`.
3. A contender may acquire only an unowned or expired row. Acquisition updates
   holder, increments generation, and sets expiry to database time plus TTL in
   that same transaction. Exactly one contender receives a committed lease.
4. Renewal requires matching holder **and** generation and an unexpired lease;
   it extends expiry without changing generation. An expired holder must reacquire
   as a contender with a new generation, even if nobody else has promoted yet.
5. Suggested initial settings are a 30-second TTL, a heartbeat every 5 seconds,
   and a 5-second local admission safety margin. These are tunable starting
   values, to be validated under production latency rather than an SLA.
   Start with a dedicated heartbeat pool (`max: 1`) excluded from requests,
   separate from the existing application pool (`max: 5`); do not take a slot
   from that pool. Two instances therefore need 12 connections plus at least
   four reserved for migrations/operations (16 total before other DB consumers).
   Bound application admission to five concurrent DB operations and at most 20
   queued operations per instance; overflow returns retryable unavailable.
   Initially bound lock waits to 1 second and statements, idle transactions, and
   total guarded transactions to 5 seconds, subject to load validation. A spare
   heartbeat connection cannot bypass a leader-row lock held by request work;
   saturation can still delay renewal, fenced writes, and promotion. Jitter
   standby checks and measure the complete contention/connection budget.
6. Publish active readiness only after acquisition commits and a database probe
   succeeds. A failed or uncertain renewal immediately removes readiness, stops
   new admissions, and pauses scheduled work. Local elapsed-time checks use a
   monotonic clock; they are conservative hints, never authority to write.
   Stop admissions when conservatively measured remaining time reaches the
   margin, even without an error. A late successful renewal after withdrawal
   does not restore readiness until a fresh DB holder/generation/expiry check
   succeeds; monitor flapping rather than hiding uncertain authority.

State transitions are `standby -> acquiring -> active -> draining -> standby`.
A restart always begins as standby. After expiry, the standby attempts the same
atomic acquisition; there is no separate administrative promotion write. An old
primary that returns does not preempt a healthy new primary. Graceful shutdown
first withdraws readiness, drains bounded in-flight work, stops timers, and then
conditionally releases its own generation; a crash relies on TTL expiry.

### Fence writes, not just the timer

A timer checking a cached `isLeader` boolean is insufficient: a paused process
can wake after another instance has promoted. Every active-only Store mutation
must validate the holder, generation, and unexpired lease **inside the same
Postgres transaction** as its domain changes and audit writes, retaining the
leader-row lock through commit. Validation occurs after acquiring the lock
and uses `clock_timestamp()`, never transaction-start `now()`. HA must also write
all durable claim, resource-lock, job, worker-session, and credential expiry
values from database time and compare them against fresh database time. Current
`PgStore` paths mix process `Date.now()` expiry creation with `now()` comparisons;
these require a time-source audit before enabling HA, not just a new leader row.
Database wall-clock corrections remain an infrastructure risk: monitor DB time
and avoid discontinuous clock steps.

Many existing mutators (including job submission/renewal/finish) use autocommit
statements and audit writes on the outer connection. Each must be wrapped in an
explicit guarded transaction, passing the same transaction-scoped connection
through mutation, audit, and outbox helpers. An outer fence check followed by
independent autocommit calls does not provide the stated guarantee.
Acquisition and renewal take that same lock. Thus a transaction from an old
leader cannot commit after a successor has acquired the row: either the old
transaction commits before promotion, or it observes the new generation and
fails without changing domain state.

An admitted transaction can hold the row past wall-clock expiry, delaying
promotion until it commits or aborts. Bound transactions with statement and
idle-in-transaction timeouts below the TTL; do not hold this lock during a long
poll, an HTTP request body upload, a harness invocation, or a network side effect.
Cancel/abort database work on demotion where possible. If an unresponsive
connection retains a lock, failover waits for Postgres to terminate it; the lease
TTL alone is not a guarantee of a bounded recovery time. The simple row lock
also serializes writes; measure throughput before considering a more concurrent
fencing protocol.

The pro integration must cover all mutation entry points, including:

- MCP tools, dashboard forms, GitHub webhooks and sync, and worker-scoped tools;
- node enrollment, poll/dispatch, heartbeat, finish, and job lease operations;
- `startLeaseSweeper()` startup tick and every subsequent tick, covering
  `sweepExpiredClaims`, `sweepIdleDispatches`, and `sweepExpiredNodeJobs`;
- inline maintenance in `PgStore.leaseNodeJob()` and pull-through dispatch,
  completion/release-triggered assignment, plus any separate watch/dispatch loop.

One guard around a multi-step tick is not enough if individual Store calls open
new transactions. Each mutation transaction must carry and revalidate its fence.
The current `leaseNodeJob()` runs an expiry sweep on every poll iteration, and
that sweep takes a coarse `jobs` table lock. Before HA, move expiry maintenance
to the active scheduled sweeper and replace the per-poll sweep/table-lock path;
verify retry/expiry semantics with real Postgres contention tests. Empty long-poll
checks must avoid both the leader fence and coarse table locks. Only the short
transaction that actually attempts a lease/dispatch or another mutation acquires
the fence; no wait or sleep retains it. A node long poll must revalidate immediately
before committing any leased job. Standby denies domain mutations with a
retryable unavailable result. Even apparently read-like APIs such as `inbox`
may mark rows read; `next_job` can re-lease expired work, and watcher notification
paths also write messages. Classify by actual writes. Admin reads can remain available
on standby if they do not trigger maintenance and clients understand that they
are not active readiness probes.

For externally visible asynchronous work, persist an outbox intent atomically
with the fenced state change and a stable deduplication key. Deliver only from
the active generation, retry uncertain deliveries, and have the receiver enforce
idempotency (and generation fencing where supported). A generation attached to
an HTTP request alone cannot retract a side effect already sent by the old
leader. Do not claim exactly-once execution; non-idempotent effects require a
receipt/reconciliation protocol or manual resolution. Inventory the existing
post-commit `sendHumanNotification` calls in claim sweeping and task completion,
along with digest sends and any webhook/comment integrations. Replace direct
sends with durable outbox intents: for example, `(event_id, recipient, channel)`
for a human notification and `(domain_id, digest_window, recipient)` for a digest.
Retain identity across promotion, reconcile uncertain receipts, and test a crash
between send and acknowledgement. Watcher mailbox writes belong in the guarded
DB transaction, not the external delivery path. This is an implementation
prerequisite, not a property provided by the current audit log.

### Endpoint continuity and retry behavior

Prefer one stable TLS/tailnet service name whose proxy checks an authenticated
or internally restricted **readiness** endpoint. Route MCP, node, dashboard, and
webhook traffic to the same ready active instance; no sticky sessions are needed.
The existing open `/health` remains a process-liveness probe and must not select
a leader. Proposed pro readiness verifies database reachability and the current
unexpired holder/generation; standby and demoted instances return unavailable.
DNS caching or a stale proxy route must never bypass database fencing.

Where a stable endpoint is unavailable, configure an ordered list of trusted CP
origins in the pro agent/node client. Both origins must serve the same domain,
authentication contract, and Postgres state. Preserve TLS/tailnet identity checks;
do not forward bearer credentials to arbitrary redirect targets. On connection
failure or unavailable readiness, try the next origin with bounded exponential
backoff and jitter. Keep the original `agent_id`, node identity, session, task
claim, and job lease token: CP failover is not worker reenrollment.

A timeout can mean a write committed but its response was lost. Retry reads and
idempotent operations automatically; reuse an operation ID when supported
(e.g. `record_progress`). For other mutations, query the durable receipt/state or
reconcile before retrying. Transport failover must not blindly replay job
submission, claim release, or completion. Worker job leases continue independently
of the CP election lease. After an outage, a late worker must still pass the
existing job lease/session/token checks; failover grants no lease extension or
permission to rerun an unknown-outcome job.

### Failure handling and observability

| Failure | Required behavior |
| --- | --- |
| Active process crashes | Its lease expires; standby acquires a higher generation, becomes ready, then resumes maintenance |
| Active pauses or loses DB connectivity | Withdraw readiness and fail closed; a resumed old process cannot mutate under its old generation |
| Network partition between CP instances | No peer quorum is needed; the one writable DB arbitrates; disconnected instances cannot write |
| CP host clock skew/jump | Election fences and all durable expiries use fresh DB time; local clocks cannot expire work early or admit stale results |
| Postgres unavailable | Neither CP is ready or may promote locally; preserve state and back off until the DB returns |
| Old leader has an open transaction | Promotion waits for its lock or a configured database timeout; no overlapping fenced commits |
| Worker result response is lost | Reconcile the persisted job receipt; do not create a duplicate attempt solely because CP changed |
| Proxy/DNS still routes to old active | Old instance rejects writes; client retries a trusted ready endpoint |

Emit lease acquisition/renewal/loss/release events with domain, instance,
generation, reason, and timing; never credentials. Track active readiness,
heartbeat latency/failures, lease remaining time, promotion latency, rejected
stale writes, sweep duration, outbox backlog, and unknown-outcome deliveries.
Alert on no ready leader beyond TTL plus the measured routing budget, repeated
promotion, old-generation writes, and database lock contention. Expected RTO is
remaining TTL + lock/DB recovery + election/probe + routing/retry delay. RPO
covers acknowledged commits only under the selected Postgres durability policy;
CP redundancy cannot repair lost DB commits.

## Rollout and validation contract

Before enabling HA in pro, inventory and fence every writer; do not deploy the
second instance until guarded Store methods, outbox handling, and readiness are
in place. Apply the pro migration, provision matching configuration, start the
first candidate, then the standby, and point the stable endpoint at readiness.
Rollback withdraws the standby, drains the active, and returns to one writer;
never disable fencing while two instances can still accept writes.

Run against real Postgres with two independently paused/killed processes:

1. Race acquisitions: one winner and one generation increment; race renewals,
   expiry, release, and reacquisition with deterministic database-time boundaries.
2. Kill the active: one promotion, preserved tasks/artifacts/claims/job receipts,
   and one fenced maintenance pass; verify startup and inline sweep paths too.
3. Pause the active beyond TTL, promote, then resume it: reject every old-generation
   mutation, timer tick, node result write, and queued outbox delivery.
4. Partition each CP from the DB and disconnect/recover the DB: neither can gain
   authority from a cached lease; verify fail-closed readiness and recovery.
5. Hold a transaction across expiry: successor cannot promote through its lock;
   timeouts clear the blocker without stale commits after promotion.
6. Exercise stable proxy routing and origin-list clients, including stale DNS,
   response loss after commit, duplicate webhooks, long polls, node heartbeats,
   credential continuity, and bounded retries without duplicate execution.
7. Skew/jump each CP clock while retaining a stable DB clock: verify election,
   claim/job/session expiry, and late-result acceptance all use fresh DB time.
   Saturate empty polls and application connections while renewing/promoting;
   verify pool/admission budgets and the absence of per-poll sweep locks.
8. Race simultaneous startup against the migration job: bootstrap executes once,
   incompatible versions fail before election, and auth/policy parity, independent
   domains, rolling-version compatibility, and rollback remain valid.

Acceptance for this design is a durable design artifact (`design-artifact`) and
a review (`review`) covering fencing safety, availability limits, client retry
semantics, and the commercial boundary. Passing these design checks does not
constitute runtime HA evidence.

## Alternatives and consequences

- **Manual repointing:** remains the core recovery path; stop the previous writer
  before starting its replacement. It requires no automated election or pro service.
- **Active/active:** deferred; dispatch, external effects, and maintenance need a
  broader concurrency protocol than stateless HTTP alone supplies.
- **Process-only leader flags or advisory locks alone:** rejected because they do
  not provide the durable generation/fencing contract across reconnects and pauses.
- **A separate consensus service:** deferred; Postgres already arbitrates the
  durable mutations. Its own primary election, backup/restore, replication
  guarantees, regional recovery, and proxy availability remain infrastructure
  responsibilities outside this CP failover design.

The benefit is relocatable coordination with explicit split-brain protection.
The costs are a pro migration/controller, guarded transaction plumbing, a write
serialization point, and operational dependence on the shared DB and endpoint.
No automatic failback or availability guarantee is implied by this proposal.
