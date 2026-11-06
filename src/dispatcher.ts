// Agent dispatcher: pure decisions shared by both stores.
// Stores claim, message, and audit. This module picks who and when.

export const DISPATCHER_AGENT = "dispatcher";
export const NEXT_TASK_PREFIX = "your next task: ";

const SYSTEM_ACTORS = new Set([
  DISPATCHER_AGENT,
  "lease-sweeper",
  "underwright",
  "sync",
  "github-sync",
]);

export function isSystemActor(agentId: string): boolean {
  return SYSTEM_ACTORS.has(agentId);
}

/** Mailbox body the sweeper and the agent loop both recognize. */
export function nextTaskMessage(taskId: string): string {
  return `${NEXT_TASK_PREFIX}${taskId}`;
}

export function taskIdFromNextTaskMessage(body: string): string | null {
  if (!body.startsWith(NEXT_TASK_PREFIX)) return null;
  const id = body.slice(NEXT_TASK_PREFIX.length).trim().split(/\s+/)[0];
  return id || null;
}

export function leaseActive(leaseExpires: unknown, now = Date.now()): boolean {
  if (leaseExpires == null || leaseExpires === "") return false;
  const t = new Date(leaseExpires as string | number | Date).getTime();
  return Number.isFinite(t) && t > now;
}

/** max <= 0 means no cap. An agent at the cap is not given more work. */
export function overCap(workload: number, max: number): boolean {
  return max > 0 && workload >= max;
}

/** Lowest workload, then agent id. Skips the agent who missed the task and anyone at the cap. */
export function chooseReassignAgent(args: {
  assignee: string;
  agents: { id: string; workload: number }[];
  max: number;
}): string | null {
  const eligible = args.agents
    .filter((a) => a.id && a.id !== args.assignee && !isSystemActor(a.id) && !overCap(a.workload, args.max))
    .sort((a, b) => a.workload - b.workload || a.id.localeCompare(b.id));
  return eligible[0]?.id ?? null;
}
