// The control-plane store contract. Call sites always `await` results;
// implementations may be sync (SQLite) or async (Postgres/Lakebase).

import type { Attestation, AuditAttestation, RegisterKeyInput } from "./agent-identity.js";
import type { NodeEnrollmentInput, NodePolicy, NodePrincipal, NodeError, NodeEnrollment, NodeSpec } from "./node-protocol.js";

type Awaitable<T> = T | Promise<T>;

export type TaskStatus = "open" | "claimed" | "in_review" | "done" | "blocked";

export type TaskType = "feature" | "bug" | "deploy" | "architecture" | "docs" | "tdd" | "triage" | "review" | string;

export interface CreateTaskArgs {
  title: string; description?: string; spec_ref?: string; ac_ids?: string[];
  priority?: number; ownership?: object; created_by?: string; id?: string;
  blocked_by?: string[];
  type?: TaskType;
  severity?: "low" | "normal" | "high" | "critical";
  estimate?: "S" | "M" | "L" | "";
  template?: string;   // task template id — expands AC scaffold, type, DoR checklist
  review_of?: string;  // subject task; creates a review task linked to it
  review_kind?: "code" | "design";
}

export interface CreateSprintArgs {
  id?: string; name: string; starts_at: string; ends_at: string; goal?: string; actor: string;
}

export interface RetroArgs {
  /** Window bounds (ISO or YYYY-MM-DD). Default: the last sdlc.retro.every_days. */
  since?: string; until?: string; actor: string;
}

export type AgentBackend = "raw" | "omnigent";

export interface AgentJobSpec {
  executable: string;
  args: string[];
  prompt: string; // {{task_id}}, {{agent_id}}, {{host}}, {{job_id}}
  /** Harness name for the omnigent backend; defaults to the executable basename. */
  harness?: string;
  /** "omnigent" launches through `omni run`; unset (or "raw") runs the CLI directly. */
  backend?: AgentBackend;
  /** Remote omnigent server URL, passed as `omni run --server`. */
  server?: string;
  /** Extra environment for the spawned process (e.g. CODEX_HOME per seat). */
  env?: Record<string, string>;
  /** Working directory for the spawned process — the task's repo. Agent sessions
   *  launch here so they load that repo's .mcp.json and see its files. */
  cwd?: string;
  /** Model tier routed from task difficulty (gh-54); the runner maps it per harness. */
  model_tier?: "light" | "standard" | "heavy";
  /** Explicit model name; wins over model_tier. Passed via the harness's model flag. */
  model?: string;
}
export interface SubmitJobArgs {
  task_id?: string; agent_id: string; type: string; command?: string;
  host?: string; target_agent_id?: string; agent?: AgentJobSpec;
}

export interface SubmitNodeTaskArgs {
  /** Omit to route to the best eligible approved node (policy + capabilities). */
  target_node_id?: string;
  node_spec: NodeSpec;
  task_id?: string;
  agent_id?: string;
  dedupe_key?: string;
  retry_of?: string;
}

/** Keyset paging over the audit log (events.id is monotonic per workspace). */
export interface AuditPage {
  /** Only events with id > after_id, oldest first. */
  after_id?: number;
  /** Only events with id < before_id. */
  before_id?: number;
}

export interface DigestArgs {
  since?: string;
  to_agent?: string;
  to?: string;
  from_agent?: string;
}

export interface DigestResult {
  since: string;
  generated_at: string;
  counts: {
    tasks_created: number;
    tasks_completed: number;
    tasks_claimed: number;
    tasks_released: number;
    claims_reclaimed: number;
    tasks_unblocked: number;
    jobs_submitted: number;
    jobs_finished: number;
    artifacts_posted: number;
    evidence_reported: number;
    messages_sent: number;
    total_events: number;
  };
  tasks_created: { id: string; title: string; actor: string; created_at: string }[];
  tasks_completed: { id: string; title: string; actor: string; created_at: string }[];
  tasks_claimed: { id: string; title: string; actor: string; created_at: string }[];
  tasks_released: { id: string; title: string; actor: string; created_at: string }[];
  claims_reclaimed: { id: string; title: string; agent_id: string; reopened: boolean; created_at: string }[];
  tasks_unblocked: { id: string; title: string; actor: string; blocker_id?: string; created_at: string }[];
  active_claims: { task_id: string; title: string; agent_id: string; lease_expires: string }[];
  board_totals: { open: number; claimed: number; in_review: number; blocked: number; done: number; total: number };
  events: any[];
  summary: string;
  sent_to: string | null;
}

/** Row of the github_status mirror table (see GITHUB_STATUS_SCHEMA). */
export interface GithubStatusRow {
  task_id: string;
  issue_ref: string;
  last_status: string;
  last_comment_at: string | null;
  last_digest_at: string | null;
  attempts: number;
  last_attempt_at: string | null;
  last_error: string | null;
  updated_at: string;
}

export type GithubStatusPatch = Partial<Omit<GithubStatusRow, "task_id" | "updated_at">> & { issue_ref: string; last_status: string };

export interface VerifyAgentActionArgs {
  action: string;
  agent_id: string;
  task_id: string;
  /** Tool arguments the signature covers (agent_id/task_id/attestation excluded from the digest). */
  args: Record<string, unknown>;
  attestation?: Attestation;
}

export type VerifyAgentActionResult = { ok: true; attestation?: AuditAttestation } | { error: string };

export interface IStore {
  // Agent identity & attestation (gh-20).
  /** TOFU registration or signed rotation of an agent's Ed25519 key. */
  registerAgentKey(a: RegisterKeyInput): Awaitable<any>;
  listAgentKeys(agentId?: string): Awaitable<any[]>;
  /** Admin reset: retire every key for an agent so it can re-register. */
  revokeAgentKeys(agentId: string, actor: string): Awaitable<any>;
  /** Check (and consume, for replay) an action's attestation. */
  verifyAgentAction(a: VerifyAgentActionArgs): Awaitable<VerifyAgentActionResult>;
  createNodeEnrollment(a: NodeEnrollmentInput): Awaitable<NodeEnrollment | NodeError>;
  listNodeEnrollments(): Awaitable<any[]>;
  approveNodeEnrollment(id: string, code: string, policy: NodePolicy, actor: string): Awaitable<any>;
  rejectNodeEnrollment(id: string, actor: string): Awaitable<any>;
  exchangeNodeEnrollment(id: string, secret: string): Awaitable<any>;
  listNodes(): Awaitable<any[]>;
  revokeNode(id: string, actor: string): Awaitable<any>;
  authenticateNode(token: string, sessionId?: string): Awaitable<NodePrincipal | NodeError>;
  startNodeSession(token: string): Awaitable<any>;
  submitNodeTask(a: SubmitNodeTaskArgs): Awaitable<any>;
  pollNodeJob(token: string, sessionId: string, waitSeconds?: number, signal?: AbortSignal): Awaitable<any>;
  renewNodeJob(token: string, sessionId: string, jobId: string, leaseToken: string, result?: string): Awaitable<any>;
  finishNodeJob(token: string, sessionId: string, jobId: string, leaseToken: string, status: "done" | "failed", result: string, resultMetadata?: unknown): Awaitable<any>;
  sweepExpiredNodeJobs(): Awaitable<{ expired: string[] }>;
  nodeHeartbeat(token: string, sessionId: string, body?: { capabilities_version?: number; active_job_id?: string; phase?: string }): Awaitable<any>;
  putNodeCapabilities(token: string, sessionId: string, version: number, inventory: unknown): Awaitable<any>;

  issueNodeWorker(token: string, sessionId: string, jobId: string, leaseToken: string): Awaitable<any>;
  workerTool(token: string, name: string, args: Record<string, unknown>): Awaitable<any>;
  createTask(a: CreateTaskArgs): Awaitable<any>;
  listTemplates(): Awaitable<any[]>;
  getTask(id: string): Awaitable<any>;
  setTaskStatus(id: string, status: TaskStatus, actor: string): Awaitable<any>;
  linkTask(id: string, spec_ref: string): Awaitable<any>;
  listTasks(status?: TaskStatus): Awaitable<any[]>;
  claimTask(taskId: string, agentId: string, ttlSeconds?: number, scope?: object): Awaitable<any>;
  updateTask(id: string, patch: Partial<CreateTaskArgs>, actor: string): Awaitable<any>;
  releaseTask(taskId: string, agentId: string, scoped?: boolean): Awaitable<any>;
  renewLease(taskId: string, agentId: string, ttlSeconds?: number): Awaitable<any>;
  sweepExpiredClaims(): Awaitable<{ reclaimed: string[] }>;
  /** Single-instance lease for in-process loops (sweeper). True when caller holds it. */
  sweeperLeadership?(instanceId: string, ttlSeconds?: number): Awaitable<boolean>;
  /** Reassign dispatcher "your next task" mail whose task is still unclaimed. */
  sweepIdleDispatches(): Awaitable<{ reassigned: string[]; logged: string[] }>;
  // SDLC ceremonies (gh-56): sprint scope, retro, backlog grooming.
  createSprint(a: CreateSprintArgs): Awaitable<any>;
  listSprints(): Awaitable<any[]>;
  /** Move tasks into a sprint (null removes them). Carry-over is logged. */
  assignSprint(taskIds: string[], sprintId: string | null, actor: string): Awaitable<any>;
  /** Burndown for a sprint; the active one when no id is given. */
  sprintReport(sprintId?: string): Awaitable<any>;
  /** Tokens per task by model tier and tier × estimate (gh-54). */
  modelReport(): Awaitable<any>;
  /** Create (idempotently, one per window end day) a retro task with stats. */
  runRetro(a: RetroArgs): Awaitable<any>;
  /** Flag stale open tasks, surface stale claims, re-validate dependency edges. */
  groomBacklog(actor: string): Awaitable<any>;
  /** Run retro / grooming when the policy `sdlc` block says they are due. */
  sweepSdlc(): Awaitable<{ retro?: string; groomed?: boolean }>;
  claimResources(resources: string[], agentId: string, taskId?: string, ttlSeconds?: number): Awaitable<any>;
  releaseResources(resources: string[], agentId: string): Awaitable<any>;
  checkLocks(resources: string[]): Awaitable<any[]>;
  sendMessage(to: string, from: string, body: string, taskId?: string): Awaitable<any>;
  inbox(agentId: string, unreadOnly?: boolean): Awaitable<any[]>;
  /** Messages exchanged between two agents, oldest first (last `limit`). Read-only: never marks mail read. */
  conversation(a: string, b: string, limit?: number): Awaitable<any[]>;
  watchTask(agentId: string, taskId: string): Awaitable<any>;
  notifyWatchers(taskId: string, body: string): Awaitable<void>;
  log(entityType: string, entityId: string, action: string, actor: string, data?: unknown): Awaitable<void>;
  postArtifact(a: { task_id?: string; agent_id: string; kind: string; title?: string; content: string }): Awaitable<any>;
  importSpecKit(a: {
    path?: string;
    task_id?: string;
    agent_id: string;
    create_tasks?: boolean;
    documents?: { doc_type?: "constitution" | "spec" | "plan" | "tasks"; title?: string; content: string }[];
  }): Awaitable<any>;
  listArtifacts(taskId: string): Awaitable<any[]>;
  reportEvidence(a: {
    task_id: string; agent_id: string; kind: string; command?: string;
    exit_code?: number; output?: string; ac_ids?: string[];
  }): Awaitable<any>;
  getEvidence(taskId: string): Awaitable<any[]>;
  completeTask(taskId: string, agentId: string, scoped?: boolean): Awaitable<any>;
  registerHelper(a: { agent_id: string; path: string; symbol?: string; kind: string; summary: string }): Awaitable<any>;
  searchContext(query: string, kinds?: string[]): Awaitable<any[]>;
  submitJob(a: SubmitJobArgs): Awaitable<any>;
  nextJob(agentId: string, host?: string, ttlSeconds?: number): Awaitable<any>;
  finishJob(jobId: string, status: "done" | "failed", result: string, agentId: string, token: string): Awaitable<any>;
  renewJob(jobId: string, agentId: string, token: string, ttlSeconds?: number, result?: string): Awaitable<any>;
  getJob(id: string): Awaitable<any>;
  board(): Awaitable<any>;
  digest(args?: string | DigestArgs): Awaitable<DigestResult>;
  dashboard(eventsLimit?: number): Awaitable<any>;
  /** Audit events. Default newest first; `before_id` pages older. With `after_id`
   *  the order is oldest first (an incremental ingest cursor: pass the last id seen). */
  auditLog(limit?: number, page?: AuditPage): Awaitable<any[]>;
  /** Audit events for one task, oldest first, optionally after an ISO timestamp. */
  taskEvents(taskId: string, sinceIso?: string): Awaitable<any[]>;
  /** Most recent audit events an agent acted in, oldest first: events it is
   *  the actor of, messages sent to it, and events stamped with it as the
   *  platform principal (gh-23 agent timeline). */
  agentEvents(agentId: string, limit?: number): Awaitable<any[]>;
  listGithubStatus(): Awaitable<GithubStatusRow[]>;
  /** Upsert the mirror row for a task; audit-logged as github_status/<task>. */
  putGithubStatus(taskId: string, patch: GithubStatusPatch, actor: string): Awaitable<GithubStatusRow>;
  close(): Awaitable<void>;
}
