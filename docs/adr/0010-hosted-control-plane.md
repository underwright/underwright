# ADR-0010: Hosted control plane — database-per-workspace behind a tenant router

Status: proposed · 2026-11-09 · gh-30 ([#30](https://github.com/underwright/underwright/issues/30))

Numbering: 0008 is already used twice on open branches (event/workflow and
multi-repo federation), so this ADR takes 0010.

## Context

The paid Team tier ([gtm.md](../gtm.md)) is a hosted, multi-repo,
multi-workspace control plane. This ADR is design only. It settles the
tenancy model, auth, billing boundary, and migration path before any paid
code is written. The spike in `spikes/hosted-tenancy/` proves the thin slice.

Forces:

- **The OSS core is single-workspace by design.** `schema.ts` says "one SQLite
  file per workspace". Every table (`tasks`, `claims`, `events`, `jobs`,
  `nodes`, ...) has no tenant column, and every `Store` method assumes a
  single workspace. Threading `workspace_id` through ~100 `IStore` methods,
  both backends, and every query would add tenancy bugs to the free product
  so the paid one can exist. gtm.md forbids that ("do not cripple the core").
- **`IStore` is already the seam (ADR-0002).** `openStore()` returns one
  store per database. A new backend is "one more class, no refactor".
- **Stateless HTTP (ADR-0001).** Any request can land on any replica. Tenant
  resolution must come from the request alone (the token), not from session
  state.
- **Licensing (ADR-0005, COMMERCIAL.md).** Premium code lives in the private
  `underwright-pro` repo and consumes this package. This repo gets no
  license-gated flags.
- **Existing auth.** There is one shared `UNDERWRIGHT_TOKEN` bearer, plus
  node tokens and Databricks forwarded identity (`platform-auth.ts`). A
  request principal is stamped on audit events (`principal.ts`).
- **Multi-repo federation (gh-22, on branch `worktree-gh-22-multi-repo`)**
  adds `repo_id` to tasks and artifacts, so one workspace can span several
  repos. That is the axis *inside* a workspace. Tenancy is the axis *across*
  workspaces. The two compose and do not compete.

## Decision

### 1. Tenancy model: database-per-workspace, shared control DB

```
                 ┌──────────────── control DB (pro) ────────────────┐
 Bearer uwws_…  →│ tenants · workspaces · workspace_tokens · usage   │
                 └──────────────┬───────────────────────────────────┘
                                │ resolve token → workspace → store_ref
                     ┌──────────┴──────────┐
                     ▼                     ▼
              IStore (ws A)          IStore (ws B)     ← unmodified OSS store
```

- **Tenant** = billing org. **Workspace** = one OSS workspace (one board,
  one audit log, one policy). It usually maps to a repo or, with gh-22, a
  group of repos.
- A small **control DB** owns tenants, workspaces, tokens, memberships,
  and usage counters. Only the hosted layer reads it.
- Each workspace's data lives in its **own store**, the unchanged OSS
  `IStore`. Hosted Postgres uses one schema per workspace in a shared
  cluster (`search_path` set per connection, from the `store_ref`).
  Enterprise VPC can use one database per workspace. Dev and the spike use
  one SQLite file per workspace.
- The **tenant router** resolves the bearer token to a workspace, picks
  that workspace's store from a bounded LRU pool, and runs the existing
  `createServer(store)` request path inside `runAsPrincipal(...)`.

**Per-workspace policy is the one required OSS change.** `SqliteStore`
calls the process-global `loadPolicy()` (cwd or `UNDERWRIGHT_POLICY`) for
claims, the dispatcher, DoD and templates. If one process serves many
workspaces, they would all share a single policy. The fix is an OSS seam: a
store-scoped policy source (constructor option, defaulting to today's
`loadPolicy()`). The hosted layer gives each workspace its own policy,
stored in the control DB. Migration (§4) carries `underwright.policy.json`
along with the data. Until that seam lands, a hosted process must not serve
two workspaces with different policies.

Rejected: **shared tables with a `workspace_id` column** (row-level tenancy).
It packs tenants more densely, but it touches every query in both backends,
makes cross-tenant leaks one missing `WHERE` away, and pushes tenant
concepts into the OSS core. Postgres RLS reduces the risk of a leak but not
the size of the refactor. If density ever becomes the constraint, pool
schemas onto more clusters before changing the model.

Cross-workspace reads (org dashboard, analytics) do **not** query workspace
stores live. Each store's `events` audit log is already append-only. The pro
layer tails it into a warehouse or rollup tables. Org views read the rollups.

### 2. Auth: workspace-scoped tokens, then SSO

- **Token format:** `uwws_<token_id>_<secret>`. `token_id` is a public lookup
  key. `secret` is 32 random bytes, base64url. The control DB stores only
  `sha256(secret)` and compares hashes with `timingSafeEqual`, the same
  pattern as `UNDERWRIGHT_TOKEN` and node tokens. The plaintext is shown
  once, at issue time.
- **Binding:** a token belongs to exactly one workspace. There are no
  multi-workspace tokens, so one leaked token exposes at most one board.
  Agents in several workspaces hold several tokens, one MCP server entry
  each, which is how harness configs already work.
- **Scopes:**
  - `read`: board, get_task, search and audit. No mutations, and no
    `digest`, because `digest` can send mail.
  - `agent`: the MCP tool surface.
  - `admin`: `agent` plus node enrollment, node revocation and policy. This
    mirrors the existing administrator-only node tools.

  No scope can call store lifecycle methods or write raw audit rows
  (`close`, `log`).
- **Lifecycle:** optional `expires_at`, which must be ISO-8601 UTC. An
  unparseable expiry is refused at issue time, not treated as "never".
  Revocation sets `revoked_at` and takes effect on the next request. The
  router does not cache positive results across requests (stateless;
  ADR-0001).
- **Attribution:** a resolved token sets the request principal to
  `token:<token_id>` (or the SSO user for humans), so the per-workspace audit
  log stays attributable without schema changes.
- **Humans (Enterprise):** OIDC/SAML sessions map a user to org roles and
  per-workspace permissions, and then to the same scopes. They resolve to
  the same `{workspace, scope, principal}` triple as tokens. This is the
  same shape as `databricksAuth()` today.

### 3. Billing boundary

- The billing entity is the **tenant**. Workspaces roll up to it.
- The leading metric (gtm.md) is **active agents per month**: distinct
  (workspace, `agent_id`) pairs that claimed at least one task during the
  period. `agent_id` is free-form and scoped to its workspace, so the same
  string in two workspaces counts as two agents. **Claimed tasks per
  month** is recorded alongside it, so the design partners can validate
  either metric.
- Metering is derived, not instrumented. It counts `task`/`claimed` events
  from each workspace's audit log in the pro layer. Dispatcher auto-claims
  count too, because the agent still did the work. The OSS core emits
  nothing new, and no billing code runs in the request path. The router
  increments a coarse `usage` row per (workspace, period) only as a cache.
- Limits (plan caps on workspaces or agents) are enforced at the router
  (token issue, workspace create) and never inside `IStore`.

### 4. Migration path from self-hosted

A self-hosted workspace is one SQLite file (or one Postgres DB). Migration
moves it into a hosted workspace store unchanged:

1. `underwright export` (new OSS command, generic and useful on its own):
   a consistent snapshot of every table, in schema order, as NDJSON.
2. The hosted import creates the workspace, applies `SCHEMA`, loads the
   snapshot into its store, and copies `underwright.policy.json` into the
   workspace's policy. Task, claim, and evidence ids are preserved, so
   `gh-*` ids, GitHub status links, and artifact references survive.
3. The hosted layer issues workspace tokens. Users swap `UNDERWRIGHT_TOKEN`
   and URL in their harness MCP config (`install-agents.sh` already writes
   these). Self-hosted node daemons re-enroll against the hosted URL because
   node tokens are not portable across control planes.
4. Reverse path: export from hosted gives the same NDJSON, which imports
   into a fresh self-hosted SQLite. There is no lock-in, which is a sales
   point.

Because workspace stores *are* OSS stores, migration is a copy, not a
transform. That is the main payoff of decision 1.

### 5. OSS vs `underwright-pro` split

| Piece | Repo | Why |
|---|---|---|
| `IStore`, `SqliteStore`, `PgStore`, `SCHEMA`, `createServer(store)` | OSS | Single-workspace core. Already there. |
| Request principal (`runAsPrincipal`), audit `principal` stamping | OSS | Already there. Needed by any auth front end. |
| Pluggable auth hook: `authenticate(req) → {principal, scope}` on `serveHttp` | OSS | Generic seam. Self-hosted users can plug their own proxy auth (as Databricks mode does). |
| Store-scoped policy source (constructor option; default `loadPolicy()`) | OSS | Also lets tests and embedders avoid the global policy. Required before a hosted process serves two workspaces. |
| Read-only scope enforcement in tool dispatch | OSS | Useful self-hosted (dashboards, CI viewers). It is not a scale feature. |
| `underwright export` / `import` (NDJSON) | OSS | Backup and portability for one workspace. Also the migration path. |
| Control DB, tenants and workspaces, `uwws_` token issue and verify | pro | Multi-workspace hosting. |
| Tenant router, store pool, per-workspace Postgres schemas | pro | Hosted control plane. |
| Usage metering, plan limits, billing integration | pro | Paid tier. |
| Org dashboard, cross-workspace rollups, analytics | pro | Paid tier (gtm.md matrix). |
| SSO/RBAC, compliance packs, retention | pro | Enterprise (gtm.md matrix). |

Rule: if a self-hosted, single-workspace user would want it, it goes in OSS
as a seam. The multi-tenant implementation behind that seam goes in pro.

**Open question for the maintainer: where the spike lives.**
`COMMERCIAL.md` says paid-tier work "does not go in this repo" and makes no
exception for spikes. The spike in `spikes/hosted-tenancy/` was put here
only because `underwright-pro` does not exist yet and #30 asks for a spike.
It is throwaway, Apache-licensed reference code. It is not built
(`tsconfig` includes only `src/`), not published (`package.json` `files` is
`dist/`), and `src/` must not import it. Nothing enforces that last rule
yet, because depcruise scans only `src/`. Before accepting this ADR, the
maintainer chooses one of these:
(a) keep the spike here until `underwright-pro` is created, then delete it;
(b) move it to `underwright-pro` now and keep only this ADR here.
Either way, the production token, router and metering code is written in
`underwright-pro`, not by growing this spike.

## Consequences

- The OSS core needs **no schema change** for hosting. Its only code change
  is the store-scoped policy seam. The hosted product is a router, a
  control DB, and a store pool.
- Per-workspace schemas cost more per tenant than shared tables (more
  connections and more migrations to fan out). Mitigations: a bounded store
  pool, lazy open, and schema migrations applied on first open (the store
  constructor already does `CREATE ... IF NOT EXISTS` plus migrations). The
  production pool must refcount in-flight calls before evicting, because
  `PgStore` is async. The spike skips this.
- Cross-workspace queries need a rollup pipeline. That is acceptable
  because only paid analytics needs them.
- Follow-up OSS tasks (each small and useful self-hosted): a store-scoped
  policy source, the auth hook on `serveHttp`, read-only scope, and
  `export`/`import`. Pro tasks wait for the hosted-beta step (gtm.md
  sequencing: "do not build paid components before the step that needs
  them").

## Spike result

`spikes/hosted-tenancy/` implements the control DB schema, token
issue/verify/revoke, and a router that maps a token to an unmodified
`SqliteStore` per workspace. Its test (`npm test` picks it up) shows:

- two workspaces under one tenant have isolated boards and audit logs;
- a token for workspace A can never reach workspace B's store;
- malformed, wrong-secret, unknown, expired, and revoked tokens are
  rejected, and the plaintext secret is never written to the DB or its WAL;
- the `read` scope rejects mutations (including mail-sending `digest`)
  while `agent` allows them, node administration needs `admin`, and
  `close`/`log` are never routable;
- an unparseable or non-UTC expiry is refused at issue time;
- active-agent and claimed-task metering is derived from each store's
  `claimed` audit events, and a never-opened workspace meters as zero;
- a self-hosted SQLite file is adopted as a hosted workspace unchanged
  (migration as copy).
