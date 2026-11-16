# Security review gh-86: threat model, findings, pro-tier gap list

Scope: static review of `src/{server,webhook,dashboard,node-http,node-executors,node-protocol,node-run,runner,store}.ts`
and `docs/tls-reverse-proxy.md`. No dynamic testing. Several files named in the issue
(`principal.ts`, `platform-auth.ts`, `secret-scan.ts`, `agent-identity.ts`) do not exist on this branch, so
those areas are **not reviewed**. Findings are rated on this branch's code (HEAD b004dd2).

## 1. Threat model (trust boundaries)

| Principal | Credential | Reaches | Trust |
|---|---|---|---|
| Admin | `UNDERWRIGHT_TOKEN` (static bearer, or `?token=`/cookie for the dashboard) | `/mcp` (all tools, incl. `submit_job`, `submit_node_task`), dashboard mutations | Fully trusted. Single shared secret, no per-user identity. |
| Node daemon | `uw_node_*` (hashed, scoped, expiring, revocable) via enrollment code + device secret | `/nodes/v1/*` only. Explicitly refused on admin surfaces (`server.ts:344`) | Semi-trusted host. It receives only ids; executables/paths come from local config (`ExecutorConfig`). |
| Worker (launched agent) | `uw_worker_*`, bound to one job/attempt/session/task/agent | `/worker/mcp`: 11 tools, task_id/agent_id forced from the credential (`store.ts:263-295`) | Untrusted. It runs LLM-driven code that ingests untrusted issue text. |
| GitHub | HMAC-SHA256 secret on `/github/webhook` | Creates/syncs tasks, writes evidence from check events | Authenticated, but the **content** (issue bodies, PR text) is attacker-influenced. |
| Runner (legacy `runner.ts`) | Admin MCP | Executes `job.command` with `shell:true` | Equivalent to admin RCE on the runner host. |

Main flows: GitHub issue body -> task description -> agent prompt (prompt-injection path) -> worker token -> evidence -> `complete_task`.

## 2. Findings

No CRITICAL findings were found in the reviewed code. Positives worth keeping:
node/worker tokens are 256-bit random and stored as SHA-256 hashes; worker scope is re-derived from the DB on every call
(job running, lease live, session epoch, token unrevoked); webhook HMAC uses `timingSafeEqual` and rejects when no secret is set;
executors are `shell:false`, env is allowlisted and strips `UNDERWRIGHT_*`; `containedPath` rejects symlinks; node tokens/dirs are 0600/0700;
FTS and SQL use bound parameters.

### HIGH

**H1. No authentication when `UNDERWRIGHT_TOKEN` is unset (`server.ts:358`, `:456`, `dashboard.ts:485`).**
`serveHttp` serves `/mcp` and the whole dashboard with no auth, and only logs a warning. Any host that can reach the port can use
`submit_job` (shell on runners) and `submit_node_task`. Repro: `underwright serve --http 0.0.0.0:8741` with no token, then
`curl -d '{...tools/call submit_job...}' /mcp`. Fix: refuse to bind a non-loopback host without a token; make the
no-auth mode require an explicit `--insecure`.

**H2. Prompt injection from GitHub issue content into agents holding write-capable credentials.**
Issue bodies are synced into task descriptions (`github.ts`, `webhook.ts onIssue`) and into `launch-agent` prompts. A worker can
`post_artifact`, `report_evidence` and `complete_task` for its own task (`store.ts:285-292`). Evidence is self-attested, and
the evidence gate (ADR 0003) counts it. A malicious issue can steer an agent to fabricate passing evidence and complete a task. The
worker also runs with the node's full local environment (git credentials, `envAllow` vars, network). Fixes: mark synced text
as untrusted in the prompt envelope; require an independent evidence source (CI check from webhook) for done on `gh-*`
tasks; only allow issue-sync from allowlisted authors or labels; keep `envAllow` minimal.

**H3. Admin token handling: stored in cookie, accepted in URL, non-constant-time on `/mcp`.**
(a) `/mcp` compares `auth !== \`Bearer ${token}\`` (`server.ts:360`). This is a timing side channel, unlike the dashboard's hashed
`sameSecret`. (b) The session cookie value **is the raw admin token** (`dashboard.ts:494`), so XSS or a leaked cookie jar
discloses the full admin credential, not a revocable session. (c) `?token=` puts the secret into access logs, proxy logs and
browser history, and `/login` is reachable by GET. Fix: constant-time compare everywhere; issue random, expiring server-side
session ids; drop the query-param path or make it one-time.

**H4. Admin surface is all-or-nothing and can run arbitrary shell (`runner.ts:101`, `submit_job`).**
`submit_job` with type!=agent runs `job.command` through `shell:true` on any polling runner. This is by design for the open-core
single-operator model, but there is no scoping, so one leaked token equals RCE on every runner and, via node tasks, on every
approved node workspace. This is a blocker for multi-user use (see pro gaps).

### MEDIUM

**M1. Dashboard mutations lack CSRF defence beyond `SameSite=Strict`.** With `?token=` or bearer auth, or
behind a platform proxy (`principal` path), there is no Origin/Referer or CSRF-token check on POSTs. Add an Origin check.

**M2. Webhook replay.** `X-GitHub-Delivery` is read (`webhook.ts:148`) but is not stored for de-duplication. A captured signed
payload can be replayed indefinitely. Effects such as evidence insertion should be idempotent per delivery id.

**M3. Redaction is pattern-based and partial.** `redact()` (`node-executors.ts:182`) covers `uw_*`, Bearer and
`token=` forms only. GitHub PATs (`ghp_`, `github_pat_`), cloud keys and the `UNDERWRIGHT_TOKEN` itself are not matched, and
the worker `.mcp.json` file carrying `uw_worker_*` is written into the worktree (`node-executors.ts:100`). It is git-excluded
in the repo's `info/exclude` (shared across worktrees), but an agent can still read or print it. It is job-scoped and short-lived, which limits the damage.
Extend redaction patterns and run a secret scan on artifacts and evidence.

**M4. Rate limiting is only on node enrollment and the node API (`nodeRequests >= 32` is a global counter).**
`/mcp`, `/github/webhook` (2 MB body, HMAC computed before auth-failure throttling) and the dashboard have no per-IP limits. A single
slow-body client class is bounded only by `maxConnections=128` and `requestTimeout=40s`. Add per-IP throttling at the proxy and
auth-failure backoff.

**M5. SQLite store is a single file with no at-rest protection and no permission enforcement.** `new Database(path)`
inherits the process umask. The DB holds token hashes, audit log and task content. Create it 0600 and refuse world-readable files.

**M6. FTS5 `MATCH ?` takes raw user query (`store.ts:1414`).** It is parameterised (no SQL injection), but malformed FTS syntax
throws, which gives a cheap error oracle, and expensive prefix/NEAR queries are a CPU DoS vector. Wrap in a try/catch and quote the terms.

**M7. Plaintext HTTP is the default transport.** `docs/tls-reverse-proxy.md` documents the mitigation. The `Secure` cookie flag
is only set when `x-forwarded-proto` says https, and **that header is client-controlled when no trusted proxy is in front.**
`enroll --allow-insecure` exists. Add a trusted-proxy setting.

### LOW

- L1. `agent_id` is caller-supplied on the admin surface (any string); audit attribution is only as strong as the token holder.
- L2. Node-task `prompt` up to 32 KB is passed as argv: no shell, but visible in `ps` to local users.
- L3. Dashboard `/health` is open and unauthenticated (fine, but returns a fixed body only; keep it that way).
- L4. Snapshot/export contents were not found on this branch; confirm any export omits `secret_hash` columns before shipping.

## 3. Pro/hosted must-fix list (`pro-gap-list`)

1. Per-tenant isolation: tenant id on every table and query, enforced in the store layer (not the handler), with cross-tenant tests;
   separate Lakebase schemas or row-level security. Today there is one namespace and a single admin token.
2. Real identity: SSO/OIDC, per-user sessions with server-side expiry and revocation (replaces H3), RBAC roles (admin, maintainer, read-only) in
   place of one shared bearer. The unreviewed `platform-auth` path (Databricks Apps) must be audited before sale.
3. Remove or tenant-scope raw shell execution (`submit_job` / `runner.ts`) — H4.
4. Mandatory auth and TLS at the app edge; no no-auth mode in hosted builds (H1, M7).
5. Independent evidence provenance (H2): done is not self-attestable for hosted tenants.
6. Untrusted-content handling for issue text, with a GitHub App using least-privilege per-installation tokens and tenant-bound webhook secrets (one secret per tenant, so the global env secret goes away).
7. Per-tenant quotas and rate limits across `/mcp`, the dashboard and the webhook (M4); replay protection (M2).
8. Audit log: append-only, tamper-evident, retained per policy, exportable per tenant; the log must not contain secrets (M3).
9. Secrets: KMS-backed storage for the webhook secret, app credentials and node-token pepper; rotation runbook.
10. Incident response: token revocation-all, tenant kill switch, breach-notification runbook, dependency and vulnerability scanning in CI, an external penetration test.

## 4. Follow-ups

HIGH findings H1-H4 each need an issue + board task. **`gh` is not installed in this sandbox, so the issues could not be filed from the job.**
Titles to file: "serve --http must refuse unauthenticated non-loopback", "Untrusted issue content to agent + self-attested
evidence", "Admin token: constant-time compare, server-side sessions, remove ?token=", "Admin RBAC and scoped job execution".

## 5. Review

Second-harness review of this audit has **not** been done. A reviewer should confirm H2/H3 against the code and check the unreviewed files above.
