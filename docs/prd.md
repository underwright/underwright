# PRD — Underwright

Status: draft v0.2 · 2026-11-11 · tracks [#52](https://github.com/underwright/underwright/issues/52)
Supersedes v0.1 (2026-11-04), which predated the open-core decision and
multi-machine coordination.

This is the product view. Decisions live in the [ADRs](adr/). Packaging and
pricing live in [gtm.md](gtm.md). How the running system fits together lives
in [process-flow.md](process-flow.md). Work items live in
[GitHub issues](https://github.com/underwright/underwright/issues). When this
doc and one of those disagree, the more specific doc wins. Update this one.

## Problem

Teams that run several AI coding agents get duplicated work, no shared state,
"done" claims nobody can check, and no process. Agent harnesses multiply
faster than the SDLC around them. More agents makes it worse: coordination by
chat breaks down after about three agents, and every agent grades its own
work.

## Product

Underwright is a control plane, not an agent. It makes any agent, on any
harness and any machine, follow a real SDLC:

- a shared task registry, synced from the issue tracker
- claim/lease coordination with ownership scopes
- communication through artifacts, not chat
- a searchable helper and code index
- an evidence-gated Definition of Done
- an async job queue and remote execution nodes
- an append-only audit log

Agents reach it over MCP (stdio or stateless HTTP). Humans see it through the
dashboard, the CLI, the mailbox and GitHub.

## Thesis

1. **Tools over inference.** Every "smart" behavior that can be a
   deterministic check is one: lease expiry, evidence gates, ownership
   scopes, dispatch, failure classification, the sweeper. Model judgment is
   for ambiguity only. The control plane makes no model calls, and costs
   nothing while idle ([ADR-0007](adr/0007-watchdog-supervisor.md)).
2. **Evidence-gated completion.** `complete_task` refuses until every
   declared acceptance criterion has cited evidence and the task type's DoD
   passes: required evidence kinds, TDD ordering, coverage floor, and a
   reviewer who is not the claim holder. Enforcement ratchets observe → warn
   → block ([ADR-0003](adr/0003-evidence-gated-done.md),
   [lifecycle.md](lifecycle.md)).
3. **Artifacts, not chat.** Coordination state lives in the store, where every
   agent and every human reviewer can read it
   ([ADR-0004](adr/0004-claims-leases-artifacts.md)).
4. **Wait on processes, not inference.** Builds and test suites go to the job
   queue, so agents don't burn context polling.
5. **Issues are the system of truth.** GitHub issues own the backlog. Board
   tasks (`gh-*`) coordinate the execution of an issue. They are not a second
   backlog.
6. **Local-first.** One SQLite file per workspace, no service required.
   Hosting is an option, not a prerequisite
   ([ADR-0002](adr/0002-pluggable-store.md)).

## How work flows

The full loop is in [process-flow.md](process-flow.md). In short:

1. **Intake.** `underwright github sync` or the webhook pulls an issue onto
   the board as a `gh-<n>` task ([webhook.md](webhook.md)). Triage sets type,
   estimate and `ac_ids`. The DoR gate blocks claims until triage is done.
2. **Dispatch.** The dispatcher sends `your next task: <id>` to an idle
   agent's mailbox and claims the task for it, within the
   `max_tasks_per_agent` cap. The sweeper reclaims expired leases and
   reassigns idle dispatches every 60 s. Policy lives in
   `underwright.policy.json` under `dispatcher`.
3. **Execution.** Agents claim, `search_context` before writing shared code,
   post artifacts and push slow work to `submit_job`. Jobs run on runners
   (`uw-runner`, optionally through Omnigent) or on enrolled **nodes**: remote
   machines whose daemon pulls capability-routed jobs
   ([node-daemon.md](node-daemon.md), [node-executors.md](node-executors.md),
   [ADR-0006](adr/0006-fleet-resilience-matrix.md)).
4. **Verification.** Evidence and review tasks, ideally from a different
   harness, gate `complete_task`. Status is mirrored back to the issue
   ([github-status.md](github-status.md)).
5. **Repeat.** The agent reads its inbox, takes the next assignment, and stops
   only when none arrives. Before it escalates to a human it must work through
   the anti-escalation steps in AGENTS.md (#38).

### Agent model: one-shot, resident, supervised

- **One-shot (today's default).** Every dispatched task starts a fresh harness
  process: `claude -p`, `codex exec`, `grok`, `cmdc`, `agy`, `kimi`,
  `opencode` and others ([multi-harness.md](multi-harness.md),
  [harness-registry.md](harness-registry.md)). It is simple, but it re-learns
  the repo every time.
- **Resident sessions** (#40). A leased, audited session registry lets an
  agent resume one conversation across tasks in the same workspace. Context is
  split into three tiers: a byte-stable static prefix, session context (a
  cache that can be lost), and the board (permanent)
  ([resident-agents.md](resident-agents.md)).
- **Watchdog supervisor** ([ADR-0007](adr/0007-watchdog-supervisor.md)). A
  resident loop runs on SQL and arithmetic. It notices stalls
  deterministically and calls a model only when a decision needs judgment.
  `uw-watch.mjs` is the prototype.

### Multi-machine coordination

One control plane serves many hosts over stateless HTTP with bearer auth
([ADR-0001](adr/0001-stateless-http-mcp.md),
[tls-reverse-proxy.md](tls-reverse-proxy.md)). An `agent_id` names
harness@host. Agents keep nothing in memory that matters: claims, leases,
artifacts and the mailbox are the shared state. That way the fleet survives
reboots, and a dead driver's work gets reclaimed
([ADR-0006](adr/0006-fleet-resilience-matrix.md)). Nodes enroll with a
device code, and the control plane approves them under an explicit policy.

## Users

| Segment | Need | Tier |
|---|---|---|
| Solo devs running 2+ agents across machines and harnesses | No duplicate work, checkable "done", work keeps moving while away | Community (today) |
| Teams running agents across a few repos | One board per repo, hosted, cross-repo visibility | Team (hosted beta) |
| Regulated or large orgs | Proof of process for AI-written code, SSO, retention, fleet policy | Enterprise |

## Open core: what's free and what's paid

The decision is [ADR-0005](adr/0005-open-core-apache.md). The feature matrix
and tiers are in [gtm.md](gtm.md) (#27). The repo rule is in
[COMMERCIAL.md](../COMMERCIAL.md). This section summarizes them and must stay
consistent with them. If they disagree, gtm.md wins.

**Principle.** Anything a single agent or a small team needs to *adopt and
trust* the system is free. Anything an organization needs to *run it at scale
or prove governance* is paid. Coordination is worth more as the number of
agents grows, so the paid tier charges the buyer (engineering leadership),
not the individual developer.

**OSS core: this repo, Apache-2.0, free forever**

- Task registry, ownership globs, templates, DoR/DoD and the lifecycle state
  machine
- Claim/lease semantics and resource locks
- Evidence-gated completion and review tasks
- Artifacts, mailbox, helper index, `search_context`
- Code index (symbols, references, blast radius)
- Job queue, remote fleet runner, node daemon (self-managed)
- Dispatcher, sweeper, digest, webhook notifications
- GitHub issue sync and commit/issue status
- Per-workspace audit log
- Basic dashboard (single-workspace board, task detail, inbox)
- Self-hosted single workspace: stdio or stateless HTTP, SQLite or Postgres
- Generic seams that a hosted layer plugs into but self-hosters also want:
  the pluggable auth hook (Databricks mode uses it), a store-scoped policy
  source, read-only scope, and `export`/`import`
  ([ADR-0010 §5](adr/0010-hosted-control-plane.md))

**Paid: the private `underwright-pro` repo, which depends on this package**

- Hosted control plane: multi-repo and multi-workspace, with a tenant router
  and a database per workspace ([ADR-0010](adr/0010-hosted-control-plane.md),
  #30)
- Org dashboard and analytics: cross-repo throughput, agent and harness
  efficiency, evidence coverage trends ([org-analytics.md](org-analytics.md),
  #31)
- Compliance and audit reporting: exportable evidence packs, retention,
  traceability reports
- SSO/RBAC: SAML/OIDC, org roles, per-workspace permissions
- Fleet management: managed runners, central node policy, capacity and cost
  controls
- Usage metering, plan limits, billing
- Support with an SLA (the OSS core gets community support)

**Rules.**

- If a self-hosted, single-workspace user would want it, it goes in OSS,
  built as a seam. The multi-tenant implementation behind that seam goes in
  pro.
- Do not cripple the core to create upsell pressure. No license-gated feature
  flags and no proprietary code in this repo.
- Do not build a paid component before the GTM step that needs it.
- Migration in both directions is a copy, not a transform: self-hosted ⇄
  hosted with the same NDJSON. There is no lock-in.

## Hosting paths

| Path | Store | Auth | Tier |
|---|---|---|---|
| Local stdio | SQLite file | process-local | OSS |
| Self-hosted HTTP (systemd service, Docker) | SQLite or Postgres | bearer token, TLS proxy | OSS |
| **Databricks App** ([databricks-app.md](databricks-app.md), #51) | Lakebase Postgres | workspace login via the Apps proxy (`auth.mode = "databricks"`), bearer for machines | OSS for a single workspace |
| Hosted Underwright (Team / Enterprise) | Postgres schema per workspace | workspace tokens, then SSO | paid |

The Databricks App path is the first managed-infrastructure deployment. The
customer runs it in their own Databricks workspace, with platform auth and a
managed Postgres, and it uses only OSS seams. Multi-workspace hosting on
Databricks would be a pro deployment of the ADR-0010 router.

## Non-goals

- Not a coding agent, IDE or model router. Model and harness choice is a
  dispatch policy input (#53, #54), not something the product is built around.
- Not a spec language. It is Spec Kit compatible instead.
- Not GitHub-only. GitLab, ADO and Bitbucket are first-class through
  adapters. GitHub is just the first one.
- Not a chat system. Humans talk to agents through the mailbox and
  artifacts.
- No model calls in the control plane's request path.

## Success metrics

- Duplicate work prevented: helper-index hits before writes, and claim
  collisions avoided
- Share of completions with full DoD evidence, tracked as the warn → block
  ratchet moves
- Inference-vs-wait ratio (job time vs in-context time)
- Agents claiming concurrently without collisions, across hosts
- Tasks finished per human check-in (autonomy between check-ins)
- Cost per completed task, by harness (#44, #61)
- Commercial (gtm.md): OSS installs and active workspaces, then paying design
  partners on the hosted beta

## Roadmap

Phases follow the GTM sequence. Issues are the tracker. This list only groups
them.

1. **OSS core — done (v0.1).** Local SQLite, stdio and HTTP MCP, the DoD
   engine, claims and leases, artifacts, the helper and code index, the job
   queue, Spec Kit import.
2. **Team layer and fleet — mostly done, in progress.**
   - Done: GitHub adapter and webhook sync (#2, #10, #29), CI evidence action
     (#11), dependency edges (#17), templates (#18), agent attestation (#20),
     mailbox and dispatcher (#15, #32, #37), anti-escalation (#38), remote
     runner (#34), resident agents (#40), programmatic SDLC (#56), peer review
     (#55).
   - Open epics: [#57](https://github.com/underwright/underwright/issues/57)
     node daemon,
     [#35](https://github.com/underwright/underwright/issues/35) Omnigent
     integration,
     [#39](https://github.com/underwright/underwright/issues/39) dogfood on
     an external codebase.
   - Open: multi-repo federation (#22), Postgres CI matrix (#28),
     cost-aware and complexity routing (#53, #54), enforced issue lifecycle
     (#58), non-MCP REST surface (#60), quota and cost accounting (#61),
     GitHub status reporting (#62), scheduled activities (#64), release
     pipeline (#65), harness roster and dogfooding (#45–#50).
3. **Hosted beta (paid, `underwright-pro`).** Hosted control plane
   ([#30](https://github.com/underwright/underwright/issues/30) design,
   ADR-0010), org dashboard (#31 design), and the Databricks Apps path
   ([#51](https://github.com/underwright/underwright/issues/51), epic).
   Exit criterion: paying design partners.
4. **Enterprise.** SSO/RBAC, compliance reporting, fleet management and
   contracted support, driven by design-partner demand.

## Decision records

| ADR | Decision |
|---|---|
| [0001](adr/0001-stateless-http-mcp.md) | Stateless MCP over HTTP |
| [0002](adr/0002-pluggable-store.md) | Pluggable `IStore`: SQLite by default, Postgres/Lakebase for hosting |
| [0003](adr/0003-evidence-gated-done.md) | Evidence-gated completion and per-type DoD |
| [0004](adr/0004-claims-leases-artifacts.md) | Claims, leases and artifacts instead of chat |
| [0005](adr/0005-open-core-apache.md) | Open core under Apache-2.0 |
| [0006](adr/0006-fleet-resilience-matrix.md) | Fleet resilience: failure → recovery matrix (proposed) |
| [0007](adr/0007-watchdog-supervisor.md) | Watchdog: cheap supervisor loop, LLM only for judgment (proposed) |
| [0010](adr/0010-hosted-control-plane.md) | Hosted control plane: a database per workspace behind a tenant router (proposed) |
