// The control-plane store contract. Call sites always `await` results;
// implementations may be sync (SQLite) or async (Postgres/Lakebase).

type Awaitable<T> = T | Promise<T>;

export type TaskStatus = "open" | "claimed" | "in_review" | "done" | "blocked";

export type TaskType = "feature" | "bug" | "deploy" | "architecture" | "docs" | string;

export interface CreateTaskArgs {
  title: string; description?: string; spec_ref?: string; ac_ids?: string[];
  priority?: number; ownership?: object; created_by?: string; id?: string;
  type?: TaskType;
  severity?: "low" | "normal" | "high" | "critical";
  estimate?: "S" | "M" | "L" | "";
}

export interface IStore {
  createTask(a: CreateTaskArgs): Awaitable<any>;
  getTask(id: string): Awaitable<any>;
  setTaskStatus(id: string, status: TaskStatus, actor: string): Awaitable<any>;
  linkTask(id: string, spec_ref: string): Awaitable<any>;
  listTasks(status?: TaskStatus): Awaitable<any[]>;
  claimTask(taskId: string, agentId: string, ttlSeconds?: number, scope?: object): Awaitable<any>;
  updateTask(id: string, patch: Partial<CreateTaskArgs>, actor: string): Awaitable<any>;
  releaseTask(taskId: string, agentId: string): Awaitable<any>;
  renewLease(taskId: string, agentId: string, ttlSeconds?: number): Awaitable<any>;
  claimResources(resources: string[], agentId: string, taskId?: string, ttlSeconds?: number): Awaitable<any>;
  releaseResources(resources: string[], agentId: string): Awaitable<any>;
  checkLocks(resources: string[]): Awaitable<any[]>;
  postArtifact(a: { task_id?: string; agent_id: string; kind: string; title?: string; content: string }): Awaitable<any>;
  listArtifacts(taskId: string): Awaitable<any[]>;
  reportEvidence(a: {
    task_id: string; agent_id: string; kind: string; command?: string;
    exit_code?: number; output?: string; ac_ids?: string[];
  }): Awaitable<any>;
  getEvidence(taskId: string): Awaitable<any[]>;
  completeTask(taskId: string, agentId: string): Awaitable<any>;
  registerHelper(a: { agent_id: string; path: string; symbol?: string; kind: string; summary: string }): Awaitable<any>;
  searchContext(query: string, kinds?: string[]): Awaitable<any[]>;
  submitJob(a: { task_id?: string; agent_id: string; type: string; command: string }): Awaitable<any>;
  nextJob(agentId?: string): Awaitable<any>;
  finishJob(jobId: string, status: "done" | "failed", result: string): Awaitable<any>;
  getJob(id: string): Awaitable<any>;
  board(): Awaitable<any>;
  auditLog(limit?: number): Awaitable<any[]>;
  close(): Awaitable<void>;
}
