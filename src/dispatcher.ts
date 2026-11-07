// Agent dispatcher: pure decisions shared by both stores.
// Stores claim, message, and audit. This module picks who and when.

export const DISPATCHER_AGENT = "dispatcher";
export const NEXT_TASK_PREFIX = "your next task: ";

/** Fleet launch prompt. Placeholders: task_id, agent_id, host, job_id. */
export const LAUNCH_PROMPT =
  "You are {{agent_id}} on {{host}}. Read AGENTS.md strictly and work the board until idle. Before escalating, search_context for helpers, check artifacts and handoffs on the task, and try the alternate harness CLI. If still blocked, post_artifact kind=blocked with what was tried, send_message to the human, then release_task and read inbox for your next task — do not idle. Claim {{task_id}}, implement it, report evidence, then read inbox and continue. Job: {{job_id}}.";

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

/**
 * Harness cost tiers from docs/multi-harness.md.
 * Review routing prefers a higher tier than the implementer.
 * 0 free, 1 low, 2 high. Unknown harnesses sit in the middle.
 */
export const HARNESS_TIERS: Readonly<Record<string, number>> = {
  devin: 0,
  cmdc: 0,
  opencode: 0,
  codex: 1,
  grok: 1,
  claude: 2,
  agy: 2,
  kimi: 2,
};

const HIGH_TIER = 2;

const NOT_IMPLEMENTERS = new Set(["human", "github-sync", "sync", "underwright"]);

export type ReviewKind = "code" | "design";

/** `grok@alandesktop` → `grok`. Ids without `@` are their own harness. */
export function harnessOf(agentId: string): string {
  const at = agentId.indexOf("@");
  const name = at === -1 ? agentId : agentId.slice(0, at);
  return name.trim().toLowerCase();
}

export function tierOf(agentId: string): number {
  const tier = HARNESS_TIERS[harnessOf(agentId)];
  return tier === undefined ? 1 : tier;
}

/** Prefer the agent who finished the subject, then whoever holds or last held it. */
export function implementerFromRecords(args: {
  completedBy?: string | null;
  claimAgent?: string | null;
  lastClaimedBy?: string | null;
  artifactAuthor?: string | null;
  createdBy?: string | null;
}): string | null {
  const pick = (id?: string | null) => {
    if (!id) return null;
    const trimmed = id.trim();
    if (!trimmed || isSystemActor(trimmed) || NOT_IMPLEMENTERS.has(trimmed)) return null;
    return trimmed;
  };
  return (
    pick(args.completedBy) ??
    pick(args.claimAgent) ??
    pick(args.lastClaimedBy) ??
    pick(args.artifactAuthor) ??
    pick(args.createdBy)
  );
}

/** Claim gate: the reviewer must be a different agent than the implementer. */
export function reviewIndependenceError(
  reviewer: string,
  implementer: string | null,
  subjectId: string,
): string | null {
  if (implementer && reviewer === implementer) {
    return `reviewer ${reviewer} cannot claim this review: they implemented ${subjectId}`;
  }
  return null;
}

/** `review_of` forces type review, records the kind, and blocks code review on the subject. */
export function linkedReviewArgs<T extends {
  type?: string;
  review_of?: string;
  review_kind?: ReviewKind;
  blocked_by?: string[];
}>(args: T, subject: { type?: string | null } | null): { args: T; reviewOf: string | null; error?: string } {
  const reviewOf = args.review_of?.trim() || null;
  if (!reviewOf) {
    if (args.review_kind) return { args, reviewOf: null, error: "review_kind requires review_of" };
    return { args, reviewOf: null };
  }
  if (!subject) return { args, reviewOf, error: `review_of task ${reviewOf} not found` };
  if (args.type && args.type !== "review") {
    return { args, reviewOf, error: "review_of requires task type review" };
  }
  const reviewKind: ReviewKind = args.review_kind ?? (subject.type === "architecture" ? "design" : "code");
  const blocked = [...(args.blocked_by ?? [])];
  if (reviewKind === "code" && !blocked.includes(reviewOf)) blocked.push(reviewOf);
  return {
    reviewOf,
    args: { ...args, type: "review", review_of: reviewOf, review_kind: reviewKind, blocked_by: blocked },
  };
}

/**
 * Pick a reviewer other than the implementer.
 * Prefer a different harness, then a stronger tier (or a high tier for design review).
 * Returns null when nobody qualifies — the review stays open.
 */
export function chooseReviewer(args: {
  implementer: string | null;
  agents: { id: string; workload: number }[];
  max: number;
  requireDifferentHarness: boolean;
  preferStronger: boolean;
  designReview: boolean;
}): string | null {
  const impl = args.implementer;
  const implHarness = impl ? harnessOf(impl) : null;
  const implTier = impl ? tierOf(impl) : 0;
  const eligible = args.agents.filter((a) =>
    a.id && !isSystemActor(a.id) && a.id !== impl && !overCap(a.workload, args.max));
  const differentHarness = eligible.filter((a) => !implHarness || harnessOf(a.id) !== implHarness);
  if (args.requireDifferentHarness && implHarness && differentHarness.length === 0) return null;
  let pool = args.requireDifferentHarness && differentHarness.length ? differentHarness : eligible;
  if (args.designReview) {
    const heavy = pool.filter((a) => tierOf(a.id) >= HIGH_TIER);
    if (heavy.length) pool = heavy;
  } else if (args.preferStronger && impl) {
    const stronger = pool.filter((a) => tierOf(a.id) > implTier);
    if (stronger.length) pool = stronger;
  }
  pool.sort((a, b) => {
    if (args.preferStronger || args.designReview) {
      const byTier = tierOf(b.id) - tierOf(a.id);
      if (byTier) return byTier;
    }
    return a.workload - b.workload || a.id.localeCompare(b.id);
  });
  return pool[0]?.id ?? null;
}
