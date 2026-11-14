# ADR-0011: Deployment boundary — hosted control plane, customer-deployed workers

Status: proposed · 2026-11-14

## Context

The paid tiers ([gtm.md](../gtm.md)) are a hosted control plane; ADR-0010
settles the tenancy model behind it. That ADR deliberately leaves open the
question customers actually ask first: *what runs in our environment, and
what crosses the boundary?* This ADR settles the deployment boundary —
the split between the control plane (coordination) and the worker plane
(execution).

The node protocol already embodies most of the answer (gh-57, ADR-0006):
enrollment, sessions, outbound poll/heartbeat/finish, and task specs that
name *capabilities* (`harness`, `workspace_id`, `script` id) which the
node's local executor config maps to executables and paths. This ADR
records why that shape is the product's deployment contract, and what must
stay true as the hosted tier is built.

## Decision

1. **The boundary is coordination vs. execution.** The hosted plane owns
   coordination metadata: tasks, claims, leases, ledger events, evidence,
   artifacts, usage rollups, audit. Workers own everything sensitive:
   source checkouts, vendor credentials, omnigent sessions, workspace
   files, and the processes that touch them.

2. **Code never leaves the customer network.** Job specs carry task ids,
   prompts, and capability ids — never repo contents or filesystem paths.
   Results are bounded (`NODE_RESULT_LIMIT`) and carry status, output
   tails, and agent-authored artifacts, not checkouts.

3. **Connectivity is outbound-only.** Nodes poll the plane; nothing dials
   into the customer network. No inbound firewall rules, VPN, or tailnet
   is *required* — the current tailnet deployment is one transport choice,
   not a protocol requirement. This is what makes the hosted plane
   deployable through ordinary corporate egress.

4. **Vendor credentials stay local.** Harness auth (claude, codex, etc.)
   lives on the node and is never sent to the plane. The plane sees only
   attestation state (`auth_status`, quota `state`/`resets_at`) in
   capabilities — enough to route, never enough to invoke.

5. **Dispatch names capabilities, not commands.** `submit_node_task`
   cannot carry executables or paths; it can only name ids the node's
   approved local config already maps. A compromised or malicious control
   plane cannot turn enrolled nodes into arbitrary-command runners. This
   is an enforced invariant in `node-executors.ts`, and it stays one.

6. **Two hosted shapes, one boundary.** The plane may run as vendor SaaS
   (pro) or as an app inside the customer's own platform (the Databricks
   Apps bundle named by the whitepaper roadmap — plane *and* state inside
   the customer's UC perimeter). The worker side is identical either way;
   the boundary properties above hold for both. Enterprise/VPC customers
   may additionally host the plane inside their own network.

7. **What the customer runs: one boring fragment.** Per machine: the node
   daemon plus a single enroll token. Org policy, prompts, and workflow
   configuration live in the plane (per gh-117's config-driven direction)
   and are pushed down; the node's only required local file is the
   executor config that maps capability ids to executables. Upgrades are
   self-applying (gh-73), so the fleet does not become an ops burden.

8. **The honest caveat — coordination metadata is not source-free by
   construction.** Ledger summaries, artifact bodies, and result tails are
   agent-authored and can incidentally contain code fragments. The plane
   is rated for "coordination metadata," not "no code ever." Customers
   with hard exfiltration requirements get the VPC/self-hosted shape from
   §6 rather than a promise the protocol cannot keep.

## Consequences

- **Protocol invariants that must survive** every future feature:
  capability-only specs, bounded results, worker-scoped credentials, no
  source-bearing payload fields in any node task type, and no credential
  material persisted to the plane.
- **Product boundary:** pro sells operation, governance, and analytics of
  the plane — not features withheld from OSS. The self-hosted path keeps
  full parity because the boundary is a deployment choice, not a license
  gate (ADR-0005, ADR-0010 §5).
- **Review posture:** the security story reduces to one auditable claim —
  "the only thing on their network is a daemon that polls." Every new
  node task type or finish field must be checked against §Decision 2–5.
- **Relation to ADR-0010:** tenancy decides *whose* board a token opens;
  this ADR decides *where* execution happens and what may cross. They
  compose: a `uwws_` token gates the plane; node credentials gate the
  workers; neither grants the other plane's powers.
