# Underwright Glossary

Domain vocabulary for the underwright control plane. Each `##` section is one
atomic term — this structure is designed to map 1:1 onto Unity Catalog Pages
(see gh-98). When adding a term, keep the definition to what a reader or agent
needs to reason correctly; link related terms by name.

## Task

A unit of coordinated work on the board. A task carries a title, description,
type (feature, bug, deploy, architecture, docs, tdd, review, triage), estimate
(S/M/L), acceptance criteria (`ac_ids`), and a lifecycle status
(open → claimed → in_review → done, with blocked variants). Most tasks are
`gh-<n>` mirrors of GitHub issues; board-internal tasks use `task-<hash>` ids.

## Board

The shared coordination surface: all tasks, their statuses, claims, artifacts,
and reviews. The board is *coordination state*, not the source of truth for work
items — GitHub issues are. The board exists so that claiming, evidence, and
review are uniform across every agent and host.

## Claim

An exclusive lease a worker takes on a task before doing work. A claim binds
`agent_id → task_id` with a `lease_expires` timestamp; the worker renews the
lease on long work and releases it on stop. Expired claims are reclaimed by the
sweeper and the task returns to open. No claim, no work.

## Agent ID

The identity a worker acts under, conventionally `<harness>@<host>`
(e.g. `codex@covasant-laptop-wsl2`, `devin@minipc`). Agent ids scope claims,
jobs, messages, and cost attribution. One live worker per agent id at a time.

## Dispatcher

The policy-driven component that assigns open tasks to eligible agents. It
considers task priority, the agent's in-flight cap
(`dispatcher.max_tasks_per_agent`), and sends the assigned task id to the
agent's inbox as `your next task: <id>`. Policy block: `dispatcher`.

## Job

A durable execution record: `submit_job` enqueues work (type `agent` for agent
runs, `node` for node operations) with an id, spec, lease, and receipt. Jobs —
not live processes — are the record of what ran, with status
queued/running/done/failed and a stored result.

## Node

A machine enrolled in the fleet with a scoped credential. A node runs an
outbound daemon (`underwright node run`) that sessions, heartbeats, publishes a
capability inventory, polls for node jobs, and returns durable receipts. Nodes
are identified by `node-<uuid>` and carry a server-side policy: allowed
operation kinds, workspace ids, repository ids.

## Capability Inventory

The snapshot a node publishes (every ~60s) describing what it can run:
supported operation kinds, approved workspace ids, `max_concurrency`,
`current_slots`, and per-harness state (id, version, installed, auth_status,
quota). The launch gate refuses `launch-agent` jobs to nodes whose inventory
doesn't attest an installed+ready harness.

## Workspace ID

A logical name for a filesystem location on a node (e.g. `underwright`,
`aura-web`). Server-side policy names ids; the node's local
`node-executors.json` maps each id to an absolute path. The server never learns
or sends paths — that's the fleet trust boundary.

## Repository ID

A logical name for a git remote used by the `provision` operation
(e.g. `underwright-origin` → the clone URL). Same id-vs-path split as
workspaces: the server references the id, the node resolves the clone URL.

## Harness

An agent CLI/runtime the control plane can launch: claude, codex, kimi,
command-code (cmdc), antigravity (agy), opencode, grok, cursor, devin, cline,
copilot. The harness registry (`docs/harness-registry.md`) is the canonical
roster. `require_different_harness` on review guarantees the reviewer is a
different harness *family* than the author.

## Omnigent

The agent/runtime plane: the layer that actually launches and supervises
harnesses. Underwright invokes it as `omni run --harness <id> -p <prompt>`
(or raw CLI when a harness has no omnigent coverage). Omnigent also provides
session persistence and token/cost accounting back to the task's job record.

## Backend

How a given agent job reaches its harness: `omnigent` (through `omni run`) or
`raw` (direct CLI argv). Chosen by the policy `harness_matrix` — per-agent
preferences plus the coverage table recording which harnesses omnigent drives.

## Model Tier

The routed difficulty class for a task: `light`, `standard`, or `heavy`.
`model_routing` policy maps task signals (estimate, type, review_kind, AC
count, ownership paths) to a tier, then each harness's model table maps the
tier to a concrete model name at worker launch (e.g. claude light → haiku,
heavy → opus). Agents that can't finish may escalate a tier via a
`needs-stronger-model` blocked artifact.

## Artifact

A durable, structured record posted on a task: specs, designs, handoffs,
evidence, blocked reports, reviews. Artifacts are the communication channel —
agents communicate through them, not side channels, so the record survives
across agents and sessions.

## Evidence

Reported proof that work satisfies acceptance criteria. `complete_task` refuses
without `report_evidence` citing every `ac_id` — real command output or test
results, attached to the task. The DoD rules in policy define which evidence
kinds each task type requires.

## Definition of Ready (DoR)

The gate a task must pass before it can be claimed: type, estimate, and
acceptance criteria must be set (by triage). DoR is what makes "ready" a
defined state rather than someone's judgment call.

## Definition of Done (DoD)

The gate a task must pass to complete: the `dod` policy block lists required
evidence kinds per task type (e.g. feature: `test_run`, `coverage`, `review`).
Enforcement is configurable: `observe`, `warn`, or `block`.

## Review Task

A `type: review` task spawned to independently evaluate completed work —
required because authors can't attest their own DoD `review` evidence. Review
tasks carry `review_of` (the task under review) and `review_kind` (code or
design) and must be worked by a different harness family than the author.

## Watch

The supervisor loop (`uw-watch`): re-dispatches failed tasks, reaps stale
claims, unblocks tasks when dependencies complete, runs the model-escalation
pass, and enforces `max_inflight` on in-flight agent jobs. The watch is where
"find a reason to stop" becomes "the system finds a reason to continue."

## Mailbox / Inbox

The message channel between agents, the control plane, and the human.
Assignments arrive as `your next task: <id>`; escalations arrive as
lettered-option questions the human answers with one key. Agents read their
inbox as part of the work-until-idle loop.

## Sprint

An optional grouping label on tasks for batching/reporting. Sprints are
time-boxing metadata, not a scheduling mechanism — dispatch still runs on
priority and claims.

## Lifecycle

The policy-driven state machine (`lifecycle.pipelines`) mapping SDLC phases
(design, develop, verify, review) onto task statuses per task type, with
`DEFAULT_PIPELINES` as the best-practices baseline. Bugs require reproduction
evidence, architecture requires a design artifact, docs skip verification.
See `docs/process-flow.md` for the canonical pipeline.

## Lease Sweeper

The periodic pass that reclaims claims and node-job leases whose
`lease_expires` has passed — returning tasks to open and marking in-flight node
jobs `outcome_unknown` so work is never silently lost when a worker dies.

## Sync

The bidirectional bridge between GitHub issues and board tasks:
`underwright github sync` (or the repo webhook) imports issues as `gh-<n>`
tasks and (gh-62) mirrors board status back to issue state. Issues are the
source of truth; the board task coordinates execution.
