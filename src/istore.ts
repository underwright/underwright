// The control-plane store contract. Call sites always `await` results;
// implementations may be sync (SQLite) or async (Postgres/Lakebase).

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

export interface IStore {
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
  claimResources(resources: string[], agentId: string, taskId?: string, ttlSeconds?: number): Awaitable<any>;
  releaseResources(resources: string[], agentId: string): Awaitable<any>;
  checkLocks(resources: string[]): Awaitable<any[]>;
  sendMessage(to: string, from: string, body: string, taskId?: string): Awaitable<any>;
  inbox(agentId: string, unreadOnly?: boolean): Awaitable<any[]>;
  watchTask(agentId: string, taskId: string): Awaitable<any>;
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
  dashboard(eventsLimit?: number): Awaitable<any>;
  auditLog(limit?: number): Awaitable<any[]>;
  close(): Awaitable<void>;
}
