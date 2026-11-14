import { createWorkerServer } from './node-worker.js';
import { handleNodeHttp } from "./node-http.js";
import { nodePolicySchema, nodeSpecSchema } from "./node-protocol.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer as createHttpServer } from "node:http";
import { z } from "zod";
import { openStore } from "./store.js";
import type { IStore } from "./istore.js";
import { indexWorkspace } from "./codeindex.js";
import { startLeaseSweeper } from "./sweeper.js";
import { startScheduler } from "./schedule.js";
import { handleDashboardRequest, dashboardAuth, sessionCookie, SESSION_COOKIE } from "./dashboard.js";
import { handleGithubWebhookHttp, isGithubWebhookRequest, webhookSecretFromEnv } from "./webhook.js";
import { appCredsFromEnv, appIssuePoster, appPublisher, handleGithubAppHttp, isGithubAppRequest } from "./github-app.js";
import { startGithubStatusLoop } from "./github-status.js";
import { getAuthPolicy, getGithubStatusPolicy, type AuthRule } from "./policy.js";
import { databricksAuth } from "./platform-auth.js";
import { currentCredential, runAsPrincipal, runWithAttestation, runWithCredential } from "./principal.js";
import { credentialBinding, type Attestation, type SignedAction } from "./agent-identity.js";

const isDashboardPath = (path: string | undefined): boolean => {
  const p = (path ?? "").split("?")[0];
  return p === "/" || /^\/(board|task|inbox|tasks|messages|chat|login|logout)(\/|$)/.test(p);
};

// cli.ts reaches the store through this module so the edge stays cli → server → store.
export { openStore };

const text = (data: unknown) => ({
  content: [{ type: "text" as const, text: typeof data === "string" ? data : JSON.stringify(data, null, 2) }],
});

export function createServer(store: IStore, adminConfigured = Boolean(process.env.UNDERWRIGHT_TOKEN)) {
  const server = new McpServer(
    { name: "underwright", version: "0.1.0" },
    { instructions: `Underwright is the shared control plane for agentic development on this workspace.
Rules of engagement:
1. Before writing shared code, call search_context — reuse helpers that exist.
2. Claim a task before working on it; renew the lease on long work.
3. Coordinate through artifacts posted to tasks, never through side channels.
4. Done requires evidence: report_evidence citing the task's acceptance criteria before complete_task.
5. Prefer submit_job for long-running work (tests, builds) over running it in-context.
6. Work the board until idle. After complete_task or release_task, read inbox. A message "your next task: <id>" is your assignment — claim it if you do not hold it, then repeat until no next task arrives.
7. Anti-escalation: before asking a human, search_context for helpers, check artifacts and handoffs on the task, and try the alternate harness CLI. If still blocked, post_artifact with kind "blocked" recording what was tried, send_message to the human, release_task, then read inbox and take the next dispatcher assignment. Do not go idle and do not stop silently.` }
  );

  const admin = async (work: () => unknown) => adminConfigured
    ? text(await work()) : text({ error: "Configure UNDERWRIGHT_TOKEN before administering nodes" });
  server.tool("list_nodes", "List enrolled nodes (administrator only).", {},
    async () => admin(() => store.listNodes()));
  server.tool("list_node_enrollments", "List bounded pending/recent enrollment metadata; codes are shown only on the device.", {},
    async () => admin(() => store.listNodeEnrollments()));
  server.tool("approve_node_enrollment", "Approve the code compared on the enrolling device; configure explicit node policy.", {
    enrollment_id: z.string().max(64), code: z.string().max(64), policy: nodePolicySchema,
  }, async a => admin(() => store.approveNodeEnrollment(a.enrollment_id, a.code, a.policy, "admin")));
  server.tool("reject_node_enrollment", "Reject a pending enrollment.", { enrollment_id: z.string().max(64) },
    async a => admin(() => store.rejectNodeEnrollment(a.enrollment_id, "admin")));
  server.tool("revoke_node", "Revoke every credential and session for one node.", { node_id: z.string().max(64) },
    async a => admin(() => store.revokeNode(a.node_id, "admin")));
  server.tool("submit_node_task", "Queue a node-targeted job. Omit target_node_id to route to the best eligible approved node. Legacy next_job consumers never receive these leases.", {
    target_node_id: z.string().min(1).max(64).optional(),
    node_spec: nodeSpecSchema,
    task_id: z.string().max(64).optional(),
    dedupe_key: z.string().min(1).max(128).optional(),
    retry_of: z.string().max(64).optional(),
  }, async a => admin(() => store.submitNodeTask({ ...a, agent_id: "admin" })));

  server.tool("board", "Show the task board: all tasks, who holds each claim, job counts.", {},
    async () => text(await store.board()));

  server.tool("digest", "Summarize board delta since a timestamp (standup digest) and optionally send the summary to an agent's mailbox.", {
    since: z.string().optional().describe("ISO8601 timestamp or relative window like 24h, 30m (default: 24h ago)"),
    to_agent: z.string().optional().describe("if set, send the formatted digest summary to this agent's mailbox"),
    from_agent: z.string().optional().describe("sender agent id when to_agent is set (default: underwright)"),
  }, async (a) => text(await store.digest(a)));

  server.tool("create_task", "Create a task on the board. Reference the spec and list its acceptance criterion ids.", {
    title: z.string(),
    description: z.string().optional(),
    spec_ref: z.string().optional().describe("path or URI of the governing spec"),
    blocked_by: z.array(z.string()).optional().describe("task ids that must be done before claiming; update replaces the list, [] clears it"),
    ac_ids: z.array(z.string()).optional().describe("acceptance criterion ids this task must prove"),
    priority: z.number().int().min(0).max(4).optional(),
    ownership: z.object({ paths: z.array(z.string()).optional(), symbols: z.array(z.string()).optional() }).optional()
      .describe("file globs / symbols this task owns"),
    type: z.enum(["feature", "bug", "deploy", "architecture", "docs", "tdd", "triage", "review"]).optional()
      .describe("task type — drives Definition-of-Done requirements at completion"),
    review_of: z.string().optional()
      .describe("subject task id. Sets type review and links the review. Code reviews wait until the subject is done. Architecture subjects are design reviews and are not blocked on the subject."),
    review_kind: z.enum(["code", "design"]).optional()
      .describe("code waits on the subject; design does not. Defaults from the subject type."),
    severity: z.enum(["low", "normal", "high", "critical"]).optional(),
    estimate: z.enum(["S", "M", "L"]).optional().describe("effort in agent-sessions"),
    template: z.string().optional()
      .describe("task template id — expands AC scaffold, type, and a DoR checklist (builtin: feature/bug/architecture/tdd, or policy-defined)"),
    created_by: z.string().optional(),
  }, async (a) => text(await store.createTask(a)));

  server.tool("list_templates", "List task templates (builtin + policy-defined) that seed a task's AC scaffold, type, and DoR checklist.", {},
    async () => text(await store.listTemplates()));

  server.tool("update_task", "Update task fields — the triage action. Set type, severity, estimate, ac_ids before a task is claimable.", {
    task_id: z.string(),
    actor: z.string().describe("who is making the change"),
    title: z.string().optional(),
    description: z.string().optional(),
    spec_ref: z.string().optional(),
    blocked_by: z.array(z.string()).optional().describe("task ids that must be done before claiming; update replaces the list, [] clears it"),
    ac_ids: z.array(z.string()).optional(),
    type: z.enum(["feature", "bug", "deploy", "architecture", "docs", "tdd", "triage", "review"]).optional(),
    severity: z.enum(["low", "normal", "high", "critical"]).optional(),
    estimate: z.enum(["S", "M", "L"]).optional(),
  }, async (a) => {
    const { task_id, actor, ...patch } = a;
    return text(await store.updateTask(task_id, patch, actor ?? "unknown"));
  });

  server.tool("list_tasks", "List tasks, optionally filtered by status.", {
    status: z.enum(["open", "claimed", "in_review", "done", "blocked"]).optional(),
  }, async ({ status }) => text(await store.listTasks(status)));

  server.tool("get_task", "Get a task with its claim state and full detail.", {
    task_id: z.string(),
  }, async ({ task_id }) => text(await store.getTask(task_id) ?? { error: "not found" }));

  // Agent identity (gh-20). Signed actions verify before they mutate. Every
  // audit event the action writes carries the attestation (key_id, sig_hash).
  const attestationArg = z.object({
    key_id: z.string().max(80),
    ts: z.number().int().describe("signing time, epoch ms"),
    sig: z.string().max(200).describe("base64 Ed25519 signature"),
  }).optional().describe("required once agent_id has a registered key: `underwright agent-key sign`");
  const signed = async (action: SignedAction, a: { agent_id: string; task_id: string; attestation?: Attestation } & Record<string, unknown>,
    work: () => unknown) => {
    const { attestation, ...args } = a;
    const v = await store.verifyAgentAction({ action, agent_id: a.agent_id, task_id: a.task_id, args, attestation });
    if ("error" in v) return text(v);
    return text(await runWithAttestation(v.attestation, async () => work()));
  };

  server.tool("register_agent_key", "Register this agent's Ed25519 public key. First registration wins (trust on first use) and is bound to the presenting credential. Rotation: same credential plus `rotation` signed by the current key over rotate_key {new_key_id}.", {
    agent_id: z.string(),
    public_key: z.string().max(1000).describe("PEM SPKI Ed25519 public key (`underwright agent-key gen`)"),
    rotation: z.object({ key_id: z.string().max(80), ts: z.number().int(), sig: z.string().max(200) }).optional(),
  }, async (a) => text(await store.registerAgentKey({ ...a, binding: currentCredential() ?? credentialBinding() })));

  server.tool("list_agent_keys", "List registered agent public keys (active and retired) for verifying audit attestations.", {
    agent_id: z.string().optional(),
  }, async ({ agent_id }) => text(await store.listAgentKeys(agent_id)));

  server.tool("revoke_agent_key", "Retire every key for an agent so it can re-register (administrator only). Use after key loss.", {
    agent_id: z.string(),
  }, async ({ agent_id }) => admin(() => store.revokeAgentKeys(agent_id, "admin")));

  server.tool("claim_task", "Atomically claim a task with a lease. Fails if another agent holds an unexpired claim.", {
    task_id: z.string(),
    agent_id: z.string().describe("stable identity for this agent/session"),
    ttl_seconds: z.number().int().optional().describe("lease duration, default 1800"),
    scope: z.object({ paths: z.array(z.string()).optional(), symbols: z.array(z.string()).optional() }).optional()
      .describe("subset of the task's ownership you're claiming"),
    attestation: attestationArg,
  }, async (a) => signed("claim_task", a, () => store.claimTask(a.task_id, a.agent_id, a.ttl_seconds, a.scope)));

  server.tool("release_task", "Release your claim, returning the task to open.", {
    task_id: z.string(), agent_id: z.string(), attestation: attestationArg,
  }, async (a) => signed("release_task", a, () => store.releaseTask(a.task_id, a.agent_id)));

  server.tool("renew_lease", "Extend your claim's lease.", {
    task_id: z.string(), agent_id: z.string(), ttl_seconds: z.number().int().optional(), attestation: attestationArg,
  }, async (a) => signed("renew_lease", a, () => store.renewLease(a.task_id, a.agent_id, a.ttl_seconds)));

  server.tool("claim_resources", "Lock files/folders/entities so no other agent duplicates your intermediate work. Call check_locks first for batch conflict check.", {
    resources: z.array(z.string()).describe("file globs, folders, or entity refs e.g. 'src/db/**'"),
    agent_id: z.string(),
    task_id: z.string().optional(),
    ttl_seconds: z.number().int().optional(),
  }, async (a) => text(await store.claimResources(a.resources, a.agent_id, a.task_id, a.ttl_seconds)));

  server.tool("release_resources", "Release your resource locks.", {
    resources: z.array(z.string()),
    agent_id: z.string(),
  }, async (a) => text(await store.releaseResources(a.resources, a.agent_id)));

  server.tool("check_locks", "Check whether resources are locked by other agents. Returns only active conflicts — call before touching shared files.", {
    resources: z.array(z.string()),
  }, async (a) => text(await store.checkLocks(a.resources)));

  server.tool("send_message", "Send a direct message to another agent (e.g. blocked-on, handoff request). Keep it structured and short.", {
    to: z.string(), from: z.string(), body: z.string(), task_id: z.string().optional(),
  }, async (a) => text(await store.sendMessage(a.to, a.from, a.body, a.task_id)));

  server.tool("inbox", "Read your messages. Returns unread by default and marks them read.", {
    agent_id: z.string(), unread_only: z.boolean().optional(),
  }, async (a) => text(await store.inbox(a.agent_id, a.unread_only ?? true)));

  server.tool("watch_task", "Subscribe to a task — the control plane messages you when its status or jobs change. This is how agents de-register instead of polling.", {
    agent_id: z.string(), task_id: z.string(),
  }, async (a) => text(await store.watchTask(a.agent_id, a.task_id)));

  server.tool("post_artifact", "Post a durable artifact (spec, design, handoff, note, review, blocked) — the only inter-agent communication channel. kind blocked records an escalation after self-recovery fails.", {
    task_id: z.string().optional(),
    agent_id: z.string(),
    kind: z.enum(["spec", "design", "handoff", "note", "review", "blocked"]),
    title: z.string().optional(),
    content: z.string(),
  }, async (a) => text(await store.postArtifact(a)));

  server.tool("import_speckit", "Import Spec Kit markdown (constitution/spec/plan/tasks) as spec artifacts and link extracted ac_ids to task.ac_ids.", {
    path: z.string().optional().describe("path to a Spec Kit directory (.specify/specs) or markdown file"),
    task_id: z.string().optional().describe("existing task id to attach artifacts and link extracted ac_ids to"),
    agent_id: z.string(),
    create_tasks: z.boolean().optional().describe("when true, create board tasks from tasks.md items with linked ac_ids"),
    documents: z.array(z.object({
      doc_type: z.enum(["constitution", "spec", "plan", "tasks"]).optional(),
      title: z.string().optional(),
      content: z.string(),
    })).optional().describe("inline Spec Kit markdown documents"),
  }, async (a) => text(await store.importSpecKit(a)));

  server.tool("search_context", "Search shared knowledge: helpers, specs, handoffs, prior decisions. Call before writing new shared code.", {
    query: z.string(),
    kinds: z.array(z.enum(["helper", "artifact", "evidence", "symbol"])).optional(),
  }, async ({ query, kinds }) => text(await store.searchContext(query, kinds)));

  const codeStore = () => {
    const c = store as any;
    if (typeof c.searchSymbols !== "function") throw new Error("code index is only available on the SQLite store");
    return c;
  };

  server.tool("index_code", "Build or refresh the tree-sitter code index for a directory. Incremental: only files whose content changed are reparsed.", {
    root: z.string().optional().describe("directory to index (default: server working directory)"),
    agent_id: z.string().optional(),
  }, async ({ root, agent_id }) => text(await indexWorkspace(codeStore(), root ?? process.cwd(), agent_id ?? "indexer")));

  server.tool("search_symbols", "Find symbol definitions (functions, classes, methods, types…) by name in the code index.", {
    query: z.string(),
    kind: z.enum(["function", "class", "method", "interface", "type", "enum", "variable"]).optional(),
    limit: z.number().int().min(1).max(100).optional(),
  }, async ({ query, kind, limit }) => text(codeStore().searchSymbols(query, kind, limit)));

  server.tool("find_references", "List where a symbol name is referenced (calls, new, type uses, imports) in the code index.", {
    name: z.string(),
  }, async ({ name }) => text(codeStore().findReferences(name)));

  server.tool("blast_radius", "Transitive callers/users of a symbol: what could break if it changes. Name-based over-approximation.", {
    name: z.string(),
    depth: z.number().int().min(1).max(10).optional(),
  }, async ({ name, depth }) => text(codeStore().blastRadius(name, depth)));

  server.tool("register_helper", "Publish a reusable helper (utility, pattern, config, fixture) so other agents reuse it instead of duplicating.", {
    agent_id: z.string(),
    path: z.string(),
    symbol: z.string().optional(),
    kind: z.enum(["util", "pattern", "config", "fixture"]),
    summary: z.string(),
  }, async (a) => text(await store.registerHelper(a)));

  server.tool("report_evidence", "Attach proof of work to a task: a test run, CI check, review, or coverage result, citing which acceptance criteria it proves. Coverage output is parsed into structured lines/statements/branches/functions percentages.", {
    task_id: z.string(),
    agent_id: z.string(),
    kind: z.enum(["test_run", "ci_check", "review", "coverage", "deploy", "contract_test", "security_scan", "smoke_test", "mutation"]),
    command: z.string().optional(),
    exit_code: z.number().int().optional(),
    output: z.string().optional().describe("raw output; for kind=coverage pass the vitest text table or coverage-summary.json"),
    ac_ids: z.array(z.string()).optional(),
    attestation: attestationArg,
  }, async (a) => signed("report_evidence", a, () => {
    const { attestation: _att, ...evidence } = a;
    return store.reportEvidence(evidence);
  }));

  server.tool("complete_task", "Mark a task done. Refuses unless every declared acceptance criterion has cited evidence.", {
    task_id: z.string(), agent_id: z.string(), attestation: attestationArg,
  }, async (a) => signed("complete_task", a, () => store.completeTask(a.task_id, a.agent_id)));

  server.tool("set_task_status", "Move a task through the SDLC state machine: in_review (reviewing phase), blocked, or open (unblock). Illegal transitions are rejected; use claim_task / complete_task for claimed / done.", {
    task_id: z.string(), agent_id: z.string(),
    status: z.enum(["in_review", "blocked", "open"]),
  }, async ({ task_id, agent_id, status }) => text(await store.setTaskStatus(task_id, status, agent_id)));

  server.tool("create_sprint", "Open a sprint window (commitment). Dates are YYYY-MM-DD or ISO; a date-only end includes that day.", {
    agent_id: z.string(), name: z.string().min(1).max(200),
    starts_at: z.string().max(40), ends_at: z.string().max(40),
    goal: z.string().max(2000).optional(), id: z.string().max(64).optional(),
  }, async ({ agent_id, ...a }) => text(await store.createSprint({ ...a, actor: agent_id })));

  server.tool("list_sprints", "List sprints with their state (planned, active, closed).", {},
    async () => text(await store.listSprints()));

  server.tool("assign_sprint", "Commit tasks to a sprint (sprint_id null removes them). Moving unfinished work out of another sprint is logged as carry-over.", {
    agent_id: z.string(), task_ids: z.array(z.string()).min(1).max(200), sprint_id: z.string().nullable(),
  }, async ({ agent_id, task_ids, sprint_id }) => text(await store.assignSprint(task_ids, sprint_id, agent_id)));

  server.tool("sprint_report", "Sprint burndown: committed/done/remaining, daily series against the ideal line, carry-over. Defaults to the active sprint.", {
    sprint_id: z.string().optional(),
  }, async ({ sprint_id }) => text(await store.sprintReport(sprint_id)));

  server.tool("model_report", "Model-tier economics (gh-54): tokens per task by model tier (light/standard/heavy) and by tier × estimate, from agent jobs and token-bearing cost evidence.", {},
    async () => text(await store.modelReport()));

  server.tool("run_retro", "Create the retro task for a window: review failures, rework rate, blocker stats, and DoR/DoD tuning suggestions. Idempotent per end day.", {
    agent_id: z.string(), since: z.string().max(40).optional(), until: z.string().max(40).optional(),
  }, async ({ agent_id, since, until }) => text(await store.runRetro({ actor: agent_id, since, until })));

  server.tool("groom_backlog", "Run a grooming pass: flag stale open tasks for re-estimation, message holders of stale claims, re-validate dependency edges.", {
    agent_id: z.string(),
  }, async ({ agent_id }) => text(await store.groomBacklog(agent_id)));

  server.tool("submit_job", "Submit long-running work (test/build/deploy/review) to the job queue and continue other work. Don't poll in-context — check job_status later or let the runner callback.", {
    agent_id: z.string(),
    task_id: z.string().optional(),
    type: z.enum(["test", "build", "deploy", "review", "agent"]),
    command: z.string().min(1).optional(),
    host: z.string().min(1).optional(),
    target_agent_id: z.string().min(1).optional(),
    agent: z.object({
      executable: z.string().min(1),
      args: z.array(z.string()),
      prompt: z.string().min(1),
      harness: z.string().min(1).optional().describe("harness name for the omnigent backend; defaults to the executable basename"),
      backend: z.enum(["raw", "omnigent"]).optional().describe("omnigent launches via `omni run`; raw (default) runs the CLI directly"),
      server: z.string().min(1).optional().describe("remote omnigent server URL (`omni run --server`)"),
    }).optional(),
  }, async (a) => text(await store.submitJob(a)));

  server.tool("next_job", "Atomically lease the next eligible job. Supply the runner identity and host; retain lease_token for heartbeats and completion.", {
    agent_id: z.string().min(1), host: z.string().min(1),
    ttl_seconds: z.number().int().min(5).max(3600).optional(),
  }, async (a) => text(await store.nextJob(a.agent_id, a.host, a.ttl_seconds)));

  server.tool("renew_job", "Renew an owned job lease and upload a bounded live output snapshot.", {
    job_id: z.string(), agent_id: z.string(), lease_token: z.string(),
    ttl_seconds: z.number().int().min(5).max(3600).optional(), result: z.string().optional(),
  }, async (a) => text(await store.renewJob(a.job_id, a.agent_id, a.lease_token, a.ttl_seconds, a.result)));

  server.tool("finish_job", "Finish a job only while holding its current lease. Stale or foreign runners are rejected.", {
    job_id: z.string(), agent_id: z.string(), lease_token: z.string(),
    status: z.enum(["done", "failed"]), result: z.string(),
  }, async (a) => text(await store.finishJob(a.job_id, a.status, a.result, a.agent_id, a.lease_token)));

  server.tool("job_status", "Check a submitted job's status and result.", {
    job_id: z.string(),
  }, async ({ job_id }) => text(await store.getJob(job_id) ?? { error: "not found" }));

  server.tool("audit_log", "Control-plane events (who did what, when). Newest first; before_id pages older. With after_id, oldest first, for incremental ingest (pass the last id seen).", {
    limit: z.number().int().optional(),
    after_id: z.number().int().nonnegative().optional().describe("only events with id > after_id, oldest first"),
    before_id: z.number().int().positive().optional().describe("only events with id < before_id"),
  }, async ({ limit, after_id, before_id }) => text(await store.auditLog(limit, { after_id, before_id })));

  return { server, store };
}

export async function serve(dbPath: string) {
  const { server, store } = createServer(await openStore(dbPath));
  const stopSweeper = startLeaseSweeper(store);
  const onEnd = () => { void server.close(); };
  server.server.onclose = () => {
    process.stdin.off("end", onEnd);
    void stopSweeper().then(() => store.close()).catch(error => console.error("[underwright] shutdown failed:", error));
  };
  process.stdin.once("end", onEnd);
  try {
    await server.connect(new StdioServerTransport());
  } catch (error) {
    process.stdin.off("end", onEnd);
    await stopSweeper();
    await store.close();
    throw error;
  }
  return server;
}

/** Board→GitHub status mirror (task-cfc5f333). Runs only when GitHub App creds
 *  are exported and policy `github.status_comments` or `github.digest_hours` is set. */
function startGithubStatusFromEnv(store: IStore): () => Promise<void> {
  const policy = getGithubStatusPolicy();
  if (!policy.status_comments && policy.digest_hours === 0) return async () => {};
  const creds = appCredsFromEnv();
  if (!creds) {
    console.error("[underwright] github status mirror enabled in policy but no GitHub App credentials; skipping");
    return async () => {};
  }
  return startGithubStatusLoop(store, {
    post: appIssuePoster(creds),
    defaultRepo: policy.repo,
    statusComments: policy.status_comments,
    digestHours: policy.digest_hours,
  });
}

/** Shared control plane over HTTP — agents on any machine connect to /mcp.
 *  Bearer auth required when UNDERWRIGHT_TOKEN is set. /health stays open.
 *  POST /github/webhook stays open and authenticates with the HMAC secret. */
export async function serveHttp(dbPath: string, host: string, port: number, token?: string, authRule: Required<AuthRule> = getAuthPolicy()) {
  const databricks = authRule.mode === "databricks";
  const store = await openStore(dbPath);
  const stopLeaseSweeper = startLeaseSweeper(store);
  const stopGithubStatus = startGithubStatusFromEnv(store);
  // Declarative policy cadences (schedule[]). HTTP only: stdio servers are per-session.
  const stopScheduler = startScheduler(store);
  const stopSweeper = async () => { await Promise.all([stopLeaseSweeper(), stopGithubStatus(), stopScheduler()]); };
  let nodeRequests = 0;
  const http = createHttpServer(async (req, res) => {
    if (req.url?.startsWith("/nodes/")) {
      if (nodeRequests >= 32) { res.writeHead(429, { "retry-after": "3" }).end(); return; }
      nodeRequests++;
      try { await handleNodeHttp(store, req, res, Boolean(token)); }
      finally { nodeRequests--; }
      return;
    }
    if (req.url === '/worker/mcp') {
      const workerToken = req.headers.authorization?.match(/^Bearer (uw_worker_[a-f0-9]{64})$/)?.[1];
      const auth = workerToken ? await store.workerTool(workerToken, 'board', {}) : { error: 'unauthorized' };
      if (auth.error) { res.writeHead(401).end(); return; }
      const server = createWorkerServer(store, workerToken!);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on('close', () => { void transport.close(); void server.close(); });
      await server.connect(transport);
      await transport.handleRequest(req, res);
      return;
    }
    // Explicitly refuse scoped credentials even in legacy no-auth mode and query fallback.
    let supplied: string | null;
    try { supplied = new URL(req.url ?? "/", "http://underwright.local").searchParams.get("token"); }
    catch { res.writeHead(400).end(); return; }
    if (/^Bearer uw_(node|worker)_/.test(req.headers.authorization ?? "") || /^uw_(node|worker)_/.test(supplied ?? "")) {
      res.writeHead(401).end('{"error":"scoped credential cannot access admin surface"}'); return;
    }
    if (isGithubAppRequest(req.url)) {
      try {
        await handleGithubAppHttp(req, res);
      } catch (error) {
        console.error("[underwright] github app route failed:", error);
        if (!res.headersSent) res.writeHead(500).end();
      }
      return;
    }
    if (isGithubWebhookRequest(req.url)) {
      try {
        const creds = appCredsFromEnv();
        await handleGithubWebhookHttp(store, req, res, webhookSecretFromEnv(), {
          publish: creds ? appPublisher(creds) : undefined,
        });
      } catch (error) {
        console.error("[underwright] webhook failed:", error);
        if (!res.headersSent) {
          res.writeHead(500, { "content-type": "application/json" }).end('{"error":"webhook handler failed"}');
        }
      }
      return;
    }
    // Databricks Apps mode: the platform proxy's forwarded user gates /mcp (here) and the dashboard (below).
    const platform = databricks && req.url === "/mcp" ? databricksAuth(authRule, token, req.headers) : undefined;
    if (platform && !platform.ok) {
      res.writeHead(platform.status, { "content-type": "application/json" }).end(JSON.stringify({ error: platform.error }));
      return;
    }
    const principal = platform?.ok && platform.via === "databricks" ? platform.principal : undefined;
    if (!databricks && token && req.url === "/mcp") {
      const auth = req.headers.authorization;
      if (auth !== `Bearer ${token}`) {
        res.writeHead(401, { "www-authenticate": "Bearer" }).end('{"error":"unauthorized"}');
        return;
      }
    }
    if (req.url === "/mcp") {
      // Stateless mode: fresh transport + server per request — all shared
      // state lives in the store, so any agent can call any tool anytime.
      // Node administration stays behind UNDERWRIGHT_TOKEN: a forwarded workspace user is not an admin.
      const { server } = createServer(store, Boolean(token) && !principal);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on("close", () => { transport.close(); server.close(); });
      // gh-20: the presenting credential binds TOFU key registration.
      const binding = credentialBinding({ principal, token });
      await runAsPrincipal(principal, () => runWithCredential(binding, async () => {
        await server.connect(transport);
        await transport.handleRequest(req, res);
      }));
      return;
    }
    if (req.url === "/health") {
      res.writeHead(200, { "content-type": "application/json" }).end('{"ok":true}');
      return;
    }
    // Interactive dashboard: reads and form-posted mutations share the
    // dashboard token rule (bearer header or ?token= when a token exists).
    let url: URL;
    let dashPrincipal: string | undefined;
    try {
      url = new URL(req.url ?? "/", "http://underwright.local");
    } catch {
      res.writeHead(400).end();
      return;
    }
    if (isDashboardPath(url.pathname)) {
      // Gate on the normalized pathname so `/x/../board` cannot sidestep platform auth.
      if (databricks) {
        const gate = databricksAuth(authRule, token, req.headers);
        if (!gate.ok) {
          res.writeHead(gate.status, { "content-type": "application/json" }).end(JSON.stringify({ error: gate.error }));
          return;
        }
        if (gate.via === "databricks") dashPrincipal = gate.principal;
      }
      const auth = databricks ? { ok: true } : dashboardAuth(token, req.headers, url);
      if (url.pathname === "/logout") {
        res.writeHead(303, { location: "/board", "set-cookie": `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0` }).end();
        return;
      }
      if (!auth.ok) {
        res.writeHead(401, { "www-authenticate": "Bearer" }).end('{"error":"unauthorized"}');
        return;
      }
      if (url.pathname === "/login") {
        // Trade ?token= for a session cookie so phone bookmarks/QR links stay token-free afterwards.
        const secure = req.headers["x-forwarded-proto"] === "https" || Boolean((req.socket as { encrypted?: boolean }).encrypted);
        const headers: Record<string, string> = { location: "/board", "cache-control": "no-store" };
        if (token && !databricks) headers["set-cookie"] = sessionCookie(token, secure);
        res.writeHead(303, headers).end();
        return;
      }
      let body = new URLSearchParams();
      if (req.method === "POST") {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk as Buffer);
        const raw = Buffer.concat(chunks).toString("utf8");
        if (raw.length > 512 * 1024) { res.writeHead(413).end(); return; }
        body = new URLSearchParams(raw);
      }
      let result;
      try {
        const dashToken = token && !databricks ? url.searchParams.get("token") ?? undefined : undefined;
        result = await runAsPrincipal(dashPrincipal, () => handleDashboardRequest(store, req.method ?? "GET", url, body, dashToken, dashPrincipal));
      } catch (error) {
        console.error("[underwright] dashboard request failed:", error);
        res.writeHead(500, { "content-type": "application/json" }).end(JSON.stringify({ error: "dashboard error" }));
        return;
      }
      if (result.redirect) {
        res.writeHead(303, { location: result.redirect }).end();
        return;
      }
      if (result.error) {
        res.writeHead(result.status ?? 400, { "content-type": "application/json" }).end(JSON.stringify({ error: result.error }));
        return;
      }
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }).end(result.html);
      return;
    }
    res.writeHead(404).end();
  });
  http.requestTimeout = 40000;
  http.headersTimeout = 10000;
  http.maxConnections = 128;
  http.once("close", () => {
    void stopSweeper().then(() => store.close()).catch(error => console.error("[underwright] shutdown failed:", error));
  });
  try {
    await new Promise<void>((resolve, reject) => {
      http.once("error", reject);
      http.listen(port, host, () => {
        http.off("error", reject);
        resolve();
      });
    });
  } catch (error) {
    await stopSweeper();
    await store.close();
    throw error;
  }
  const bound = http.address();
  const boundPort = typeof bound === "object" && bound ? bound.port : port;
  console.error(`[underwright] MCP over HTTP at http://${host}:${boundPort}/mcp (stateless${databricks ? ", databricks platform auth" : token ? ", bearer-auth" : ", NO AUTH — set UNDERWRIGHT_TOKEN for shared use"}); GitHub webhook POST /github/webhook`);
  return http;
}
