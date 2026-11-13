# Underwright — a control plane for agentic software development

*Status report, November 2026*

## The motivation

Coding agents are easy to start and hard to coordinate. Point several at the
same repository and the failure modes arrive quickly: two agents implement the
same utility twice, a third "finishes" work it only half did, and a fourth
stalls silently the moment nobody is watching. Each individual agent may be
excellent. The system of agents is not.

The reason is that the bottleneck in autonomous software work is no longer the
agent's ability to write code. It is everything around the code: who owns what,
what counts as done, what happens at 3am when a claim expires, whether the
output is verified or merely self-reported. These are coordination problems,
and coordination is what software engineering has always built tooling for —
issue trackers, CI gates, code review, release processes. Agents, so far, have
mostly bypassed that tooling rather than been governed by it.

Underwright exists to close that gap. It is not another coding agent. It is
the control plane that makes *any* coding agent — Claude Code, Codex,
CommandCode, Kimi, Antigravity, Cursor, Copilot, or a custom harness — follow
a real software-development lifecycle: shared tasks instead of scattered
prompts, claims instead of collisions, evidence instead of "looks done to me."

This report describes what the system is, how it is built, what is working in
production today, what failed along the way, and where it is going.

## A definition before the details

Throughout this report, *control plane* means the durable, authoritative
record of work: tasks, claims, artifacts, evidence, messages, and the audit
log that records every mutation. It deliberately does *not* include the
agents themselves. Agents are workers — replaceable, heterogeneous, and often
unreliable in exactly the ways the control plane exists to absorb.

This separation is the architectural decision everything else follows from,
so it is worth stating plainly: **the work and the agents are different
layers, owned by different systems.**

## The architecture: two layers

Underwright is deliberately two-layer:

- **Underwright (work layer)** — the board, dispatch, claims/leases,
  artifact store, mailbox, and job queue. This is the durable system of
  record. Every mutation flows through store methods that write to an audit
  log. Every task carries acceptance criteria. "Done" is unreachable without
  evidence attached per criterion — the `complete_task` call refuses
  otherwise, which means an agent cannot grade its own homework.
- **Omnigent (agent layer)** — the runtime that supervises the swarm of
  coding agents. One supervisor drives many harnesses and records per-session
  usage (tokens, cost), so a task can be traced end to end:
  issue → dispatch → job → session → spend. Omnigent is a transport for
  *execution*, not for *coordination*. Underwright's mailbox stays
  authoritative; the session inbox is used only as a zero-latency wake
  channel for live workers.

The layering mirrors what a healthy engineering organization looks like:
tickets and process live in one place, engineers in another, and nobody
confuses the person with the ticket.

## How Omnigent is used

Because the boundary matters, it is worth being concrete about what Omnigent
actually does in this system — and what it deliberately does not do:

- **Uniform harness invocation.** A coverage table records which harnesses
  `omni run` can drive headlessly — today codex, claude-sdk, cmdc, kimi,
  antigravity, opencode, and pi. When the runner launches an agent job for a
  covered harness, it does not shell out to the vendor CLI directly; it runs
  `omni run --harness <id> [-p <prompt>]`. Uncovered harnesses fall back to
  the raw CLI, so adding a new agent is an incremental decision, not an
  integration project.
- **Session and usage accounting.** Every `omni run` is a supervised session
  with token and cost telemetry. The runner extracts the session marker from
  the transcript and links it back to the job, which is what makes the
  issue → dispatch → job → session → spend chain auditable — and what makes
  cost-aware dispatch possible at all.
- **Model-tier routing.** The model a job gets is a policy decision, not a
  harness default: task signals map to a tier, the tier maps to a concrete
  model per harness, and the runner passes it through `omni --model`.
  Switching a task class from a premium model to a cheap tier is a one-line
  policy change applied uniformly across every covered harness.
- **Live wake, not coordination.** Omnigent's session inbox can nudge a
  running worker immediately, but it is used only as a wake channel. Task
  truth, claims, and messages live in the underwright store — a crashed or
  restarted omnigent session loses nothing durable.

In short: Omnigent answers "run this agent and tell me exactly what it did
and cost." Underwright answers "here is what should be run, by whom, and
whether it counted."

## Where work comes from

GitHub issues are the system of truth for work items. Real work begins as an
issue and is mirrored onto the board as `gh-*` tasks through sync or webhook.
The board is coordination state, never a second backlog — when an agent
discovers work with no issue, it is expected to file one first, then work
the mirrored task.

That rule sounds small and is not. It means the system's entire output is
visible to humans in a tool they already use, and it means the board cannot
drift into a private shadow-plan that only agents can read.

## The lifecycle of a task

A task moves through the system in a fixed loop, and the loop is worth
describing because every step exists to prevent a specific, observed failure:

1. **Claim.** An agent calls `claim_task` with a stable identity
   (`<harness>@<host>`). The claim is a lease, not a flag — it expires, and
   long work must be renewed. Unclaimed stale work is recovered
   automatically.
2. **Context before code.** Before building anything, the agent calls
   `search_context`. If a helper, spec, or prior decision exists, reuse is
   mandatory; new shared utilities get registered back with
   `register_helper`. This is how a fleet accumulates conventions instead of
   duplicating them.
3. **Artifacts, not side channels.** Specs, designs, reviews, and handoffs
   are posted with `post_artifact` on the task. The artifact store is the
   record — there is no sanctioned way to coordinate outside it, which is
   what makes a task's full history auditable after the fact.
4. **Evidence-gated completion.** `complete_task` refuses without
   `report_evidence` citing every acceptance criterion, with real command
   output attached — test runs, build logs, coverage numbers. A task marked
   done without evidence does not exist.
5. **Review as a first-class task.** Completed work spawns review tasks,
   and the dispatcher enforces reviewer independence — a different harness
   reviews the work than the one that wrote it, preferring a stronger model
   where the policy asks for it.
6. **Work until idle.** After completion the agent reads its inbox, picks
   up the next assigned task, and repeats. The loop terminates only when the
   board has nothing for it.

## Autonomy is rule-driven by design

The part of the system that runs itself is, deliberately, the least
intelligent part. The sweepers, the dispatcher, quota failover, the unblock
pass, and the budget gates are deterministic code — testable, reviewable,
and cheap to run forever. LLM judgment is invoked only at boundaries a rule
cannot cross, and even then through structured escalation: when a task is
genuinely stuck, the human gets a message with lettered options
(`A) reopen  B) reassign  C) cancel  D) defer`) and a single-character reply
resolves it without a model call.

This "tools over inference" discipline is what keeps the loops predictable
and the marginal cost of supervision near zero. An LLM deciding *whether* to
reassign a task a hundred times a day is a hundred model calls spent on
something a SQL query answers in microseconds.

The same philosophy applies to failure. Escalation is a designed path, not
an absence of one: search context, check artifacts, try the alternate
harness, and only then post a `blocked` artifact, message the human, and
release the task so the dispatcher moves on. An agent is never supposed to
stop silently — and "silent stall" was, in practice, the single most common
real-world failure before these rules existed.

## The fleet model

Machines enroll as nodes over the tailnet: a short-lived code shown on the
device, an administrator approval that sets an explicit policy, and a scoped
credential. The policy states what the node may do — which operation kinds
(`launch-agent`, `provision`, `install-harness`, `run-script`), which
workspace ids it may touch, which repositories it may clone. The server
never learns paths or executables; the node's local executor config maps
abstract workspace ids to real directories and names the only commands it
may run. Compromise of the control plane cannot turn nodes into an
arbitrary shell.

Agent jobs launch through Omnigent so every session carries usage tracking;
a resident watch loop produces work, classifies failures, clears transient
blocks, and escalates real ones. Capability, not hostname, decides where a
job lands — a machine that has lost its harness, its credential, or its
freshness simply stops being selected.

## What's working today

- A multi-machine fleet enrolled, executing pushed jobs end to end:
  dispatch → execution → fsync'd receipt → durable result.
- Agents launching through Omnigent with session and token linkage back to
  the task that spawned them.
- GitHub issue sync at real scale — hundreds of open issues mirrored onto
  the board cleanly.
- Self-healing in production: an unblock agent cleared ten stale-blocked
  tasks on its first run; a sweeper lease stopped multi-server dispatch
  churn.
- Model-complexity routing: task signals (estimate, type, paths, AC count)
  map to model tiers, so routine docs tasks stop burning premium-model
  quota — and an agent that is out of its depth can signal
  `needs-stronger-model` and be re-dispatched one tier up.
- Published on npm (`npm i -g underwright`), open source under Apache 2.0.

## The challenges — and what they taught us

The honest version of progress includes the failure modes, because the
failure modes are what shaped the design:

- **Dispatch churn.** Agents were repeatedly assigned tasks they could not
  claim — unfinished dependencies, dead leases, missing evidence. Thousands
  of reassignment events produced zero completions. The lesson: *assignment
  must be verified the same way claims are.* The producer and sweeper now
  skip anything that cannot actually be worked rather than optimistically
  handing it out again.
- **A silent fleet.** Desktop workers appeared busy with hundreds of claims
  per hour — every one dispatcher-manufactured, none renewed. Activity is
  not work; the liveness signal now counts only what a real agent produces.
- **Version skew in the agent layer.** Omnigent's database schema outran
  the installed binary and the entire worker path crashed at once. The fix
  was pin-from-source plus per-host version checks — and the lesson that
  the agent runtime's own upgrades are a first-class operational concern,
  not an afterthought.
- **SQLite as a single point of failure.** The control plane's state lives
  in one file on one host, and `SQLITE_BUSY` surfaces under real load. The
  answer is a pluggable store with a Postgres/Lakebase implementation and a
  control-plane leadership lease — work we are building deliberately rather
  than bolting on.
- **Blocks nobody cleared.** Tasks marked `blocked` sat indefinitely because
  no process owned the unblock decision. A dedicated pass now auto-clears
  transient and stale blocks by rule and escalates the rest to a human in
  one-key-reply format.

Each of these is the same lesson wearing a different costume: **every
decision the system makes needs an owner, and "nobody" is the default owner
of anything you did not explicitly assign.**

## The vision

The durable goal is a control plane that keeps working without a human
repeatedly telling it to. Reboot a machine, lose a laptop, exhaust a quota
seat — work should route around the failure, escalate what is genuinely
blocked, and resume where it left off. The human's role should converge to
review, architecture, and the judgment calls a rule honestly cannot make.

## The roadmap: open core, Databricks Apps as the hosted target

The commercial shape follows the same line. The self-hosted,
single-workspace core stays open — SQLite store, local nodes, one repo per
board. The hosted tier is where organizations live: multi-repo boards,
org-wide agent coordination, SSO/RBAC, managed fleet, and HA/failover.

**Databricks Apps is the roadmap's named deployment target for that hosted
tier**, and the choice is deliberate rather than convenient:

- **State moves to Lakebase.** The pluggable `IStore` abstraction already
  carries a Postgres implementation (`PgStore`); the hosted edition runs it
  against Lakebase — Databricks' managed Postgres — so control-plane state
  stops living in a single file on a single host. That is also the direct
  answer to the SQLite contention failure described above.
- **Auth becomes platform auth.** Instead of hand-issued bearer tokens, the
  app authenticates through Databricks' forwarded-header identity, so agent
  access inherits the same SSO and permission model the customer already
  runs on the platform.
- **Delivery is an app bundle, not an appliance.** The control plane ships
  as a Databricks Apps bundle — deployed into the customer's own workspace,
  governed by their Unity Catalog perimeter, with their warehouse and
  Lakebase resources attached. Agents and humans reach it over the same
  MCP/HTTP surface the self-hosted version exposes today.
- **The data stays in the customer's ecosystem.** Boards, artifacts, and
  audit logs land in the customer's catalog — which means the system of
  record for *what the agents did* is itself governed enterprise data,
  queryable alongside everything else they keep on Databricks.

The sequencing is honest: Lakebase-backed `PgStore` parity and the app
bundle are active work, not shipped features — which is exactly why they
are named here as the roadmap rather than implied by adjectives.

The meta-result, already visible in the day-to-day, is that the system is
increasingly built by itself: agents claim tasks, hit blockers, escalate
with structured options, unblock each other, and post evidence — while this
document, like much of the codebase, exists because a task said it should.

---

*Underwright is open source under Apache 2.0. The open-core boundary and
roadmap are documented in `COMMERCIAL.md` and `docs/adr/`.*
