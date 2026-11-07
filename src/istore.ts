// The control-plane store contract. Call sites always `await` results;
// implementations may be sync (SQLite) or async (Postgres/Lakebase).

import type { NodeEnrollmentInput, NodePolicy, NodePrincipal, NodeError, NodeEnrollment, NodeSpec } from "./node-protocol.js";

type Awaitable<T> = T | Promise<T>;

export type TaskStatus = "open" | "claimed" | "in_review" | "done" | "blocked";

export type TaskType = "feature" | "bug" | "deploy" | "architecture" | "docs" | "tdd" | string;

export interface CreateTaskArgs {
  title: string; description?: string; spec_ref?: string; ac_ids?: string[];
  priority?: number; ownership?: object; created_by?: string; id?: string;
  blocked_by?: string[];
  type?: TaskType;
  severity?: "low" | "normal" | "high" | "critical";
  estimate?: "S" | "M" | "L" | "";
  template?: string;   // task template id — expands AC scaffold, type, DoR checklist
}

export interface AgentJobSpec {
  executable: string;
  args: string[];
  prompt: string; // {{task_id}}, {{agent_id}}, {{host}}, {{job_id}}
}
export interface SubmitJobArgs {
  task_id?: string; agent_id: string; type: string; command?: string;
  host?: string; target_agent_id?: string; agent?: AgentJobSpec;
}

export interface SubmitNodeTaskArgs {
  target_node_id: string;
  node_spec: NodeSpec;
  task_id?: string;
  agent_id?: string;
  dedupe_key?: string;
  retry_of?: string;
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

export interface IStore {
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

  createTask(a: CreateTaskArgs): Awaitable<any>;
  listTemplates(): Awaitable<any[]>;
  getTask(id: string): Awaitable<any>;
  setTaskStatus(id: string, status: TaskStatus, actor: string): Awaitable<any>;
  linkTask(id: string, spec_ref: string): Awaitable<any>;
  listTasks(status?: TaskStatus): Awaitable<any[]>;
  claimTask(taskId: string, agentId: string, ttlSeconds?: number, scope?: object): Awaitable<any>;
  updateTask(id: string, patch: Partial<CreateTaskArgs>, actor: string): Awaitable<any>;
  releaseTask(taskId: string, agentId: string): Awaitable<any>;
  renewLease(taskId: string, agentId: string, ttlSeconds?: number): Awaitable<any>;
  sweepExpiredClaims(): Awaitable<{ reclaimed: string[] }>;
  /** Reassign dispatcher "your next task" mail whose task is still unclaimed. */
  sweepIdleDispatches(): Awaitable<{ reassigned: string[]; logged: string[] }>;
  claimResources(resources: string[], agentId: string, taskId?: string, ttlSeconds?: number): Awaitable<any>;
  releaseResources(resources: string[], agentId: string): Awaitable<any>;
  checkLocks(resources: string[]): Awaitable<any[]>;
  sendMessage(to: string, from: string, body: string, taskId?: string): Awaitable<any>;
  inbox(agentId: string, unreadOnly?: boolean): Awaitable<any[]>;
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
  completeTask(taskId: string, agentId: string): Awaitable<any>;
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
  auditLog(limit?: number): Awaitable<any[]>;
  close(): Awaitable<void>;
}
