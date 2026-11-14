# ADR-0012: Omnigent session topology — thin coupling, customer-side centralization

Status: proposed · 2026-11-14

## Context

ADR-0011 fixes the deployment boundary: the control plane handles
coordination metadata, workers execute in the customer environment, and an
omnigent transcript is execution-side data — it contains file contents,
diffs, commands, sometimes secrets. Hosting transcripts in the vendor
plane would collapse the "a daemon that polls" security story.

That leaves a real question: where do omnigent sessions live so that
transcript linkage (gh-116), cross-node fork, and usage rollups work
without weakening the boundary? Two properties make the answer cheap:

- **`omni run --server` already splits server from runner.** The remote
  mode spawns a *local* runner that tunnels to the server — session state
  centralizes while execution stays on the node. That is the same split
  Underwright makes between plane and worker.
- **Underwright↔omnigent coupling is deliberately thin.** The plane wants
  a session id plus a usage readback — nothing more. Whether a session
  lives on the executing node or a central store must not change a single
  line of dispatch logic; that is the test of getting this right.

## Decision

The omnigent endpoint is **configuration, not architecture.** A `server`
field in node-executors config (attested in capabilities so the board
knows where sessions live) selects the topology per node; all variants
below are the same product with different values. Session ids and usage
metadata cross the plane boundary; transcripts never do.

### Variant table

| # | Variant | Session store | Execution | Fits |
|---|---|---|---|---|
| 0 | **Per-node local** (default) | Each node's `~/.omnigent` | Same node | OSS floor — zero moving parts. Fork works while the source node is alive; the ledger preamble (gh-112) covers node death. |
| 1 | **Databricks App** | Customer's workspace (Lakebase/UC volume — never the ephemeral app fs) | Nodes, wherever they run | The bundle deployment: sessions stay inside the customer's UC perimeter alongside their board data. |
| 2 | **Private tailnet host** | One host on the tailnet (e.g. minipc) | Nodes via local runner tunnels | Our own dev fleet: shared sessions across machines, no public IP, ACLs via the tailnet. |
| 3 | **Customer-set endpoint** | Their infra (VM/k8s/bastion) | Their nodes | Enterprise/BYO — treated as pure configuration. |
| 4 | **Replicated session store** | Per-node + shipped backup to customer-owned storage | Nodes | Durability without a live server: restore-and-fork rather than live-fork. Cheap middle rung. |
| 5 | **Credential gateway** *(orthogonal)* | Central | Nodes | A separate axis: omnigent's `SESSION_SCOPED_CONFIG`/`OMNIGENT_CREDENTIAL` model can vend vendor auth centrally — kills per-node auth setup but concentrates secrets into a crown-jewel host. Decided separately, never bundled in. |

Variants 1–3 are the supported centralization shapes; 0 is the default;
4 is a durability option composable with any of them; 5 is a distinct
decision pending its own analysis.

### Consequences

- **For our fleet:** variant 2 now — one tailnet host runs
  `omnigent server` under systemd with `~/.omnigent` backups; nodes set
  `server=` and execute locally via runner tunnels. A machine's death no
  longer strands its sessions.
- **For the Databricks bundle:** variant 1 — the omnigent server is an
  optional component in `databricks.yml`; session state must land on
  Lakebase or a UC volume, or app recycles silently eat every session.
- **For product:** variant 3 is the enterprise answer and requires no
  code — the endpoint is config, consistent with gh-117's data-driven
  direction.
- **Invariants that must survive every future feature:**
  - the plane stores session *ids* and usage *metadata* only — no
    transcript content in `jobs.result_metadata`, the ledger, or
    artifacts by default;
  - the omnigent endpoint is a node-config/policy value, never a
    hardcoded constant;
  - fork/resume logic (gh-116) treats the session store as possibly
    unreachable and falls back to the ledger preamble — centralization is
    an enhancement, never a dependency.
- **Relation to ADR-0011:** that ADR fixes what crosses the boundary;
  this one fixes where session state lives *within* the execution side.
  They compose: a customer may run variant 0 today, adopt variant 1 or 3
  later, and the plane's contract is unchanged throughout.
