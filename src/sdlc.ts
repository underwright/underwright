// Programmatic SDLC ceremonies (gh-56): retro, backlog grooming, sprint scope.
//
// Pure module: callers (Store / PgStore) fetch rows, these functions decide.
// Nothing here touches a database, the clock (callers pass `now`), or I/O.

import type { Policy } from "./policy.js";

// ---------------------------------------------------------------- policy

export interface RetroRule { enabled?: boolean; every_days?: number }
export interface GroomingRule {
  enabled?: boolean;
  every_minutes?: number;
  /** Open tasks untouched this long are stale. */
  stale_open_days?: number;
  /** An active claim with no holder activity on the task this long is stale. */
  stale_claim_minutes?: number;
  /** Clear the estimate of stale open tasks so the DoR gate forces re-estimation. */
  reset_estimates?: boolean;
}
export interface SdlcRule { retro?: RetroRule; grooming?: GroomingRule }

export interface SdlcPolicy {
  retro: { enabled: boolean; every_days: number };
  grooming: {
    enabled: boolean; every_minutes: number; stale_open_days: number;
    stale_claim_minutes: number; reset_estimates: boolean;
  };
}

function num(v: unknown, fallback: number, min = 0) {
  const n = Number(v);
  return Number.isFinite(n) && n > min ? n : fallback;
}

/** Ceremonies are opt-in: a missing `sdlc` block leaves both off. */
export function getSdlcPolicy(policy: Policy): SdlcPolicy {
  const raw = ((policy as { sdlc?: SdlcRule }).sdlc ?? {}) as SdlcRule;
  const r = raw.retro ?? {};
  const g = raw.grooming ?? {};
  return {
    // Retro task ids are per day, so the interval is at least one day.
    retro: { enabled: !!raw.retro && r.enabled !== false, every_days: Math.max(1, num(r.every_days, 7)) },
    grooming: {
      enabled: !!raw.grooming && g.enabled !== false,
      every_minutes: num(g.every_minutes, 60),
      stale_open_days: num(g.stale_open_days, 14),
      stale_claim_minutes: num(g.stale_claim_minutes, 120),
      reset_estimates: g.reset_estimates === true,
    },
  };
}

// ---------------------------------------------------------------- time

/** Parse SQLite `datetime('now')` (UTC, no zone), ISO strings, or Dates. */
export function toMs(v: unknown): number {
  if (v instanceof Date) return v.getTime();
  if (typeof v !== "string" || !v) return NaN;
  const s = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d+)?$/.test(v) ? `${v.replace(" ", "T")}Z` : v;
  return Date.parse(s);
}

const DAY = 86_400_000;
const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** True when the last run is older than the interval (or never happened). */
export function isDue(lastRun: unknown, intervalMs: number, now: number): boolean {
  const last = toMs(lastRun);
  return !Number.isFinite(last) || now - last >= intervalMs;
}

// ---------------------------------------------------------------- retro

export interface EventRow { entity_type: string; entity_id: string; action: string; actor: string; data?: unknown; created_at: unknown }
export interface EvidenceRow { task_id: string; kind: string; exit_code?: number | null; agent_id?: string; created_at?: unknown }

export interface RetroStats {
  since: string;
  until: string;
  tasks_completed: number;
  review: { reviews: number; failed: number; failed_tasks: string[] };
  /** reclaimed = every task claimed twice+ (raw); tasks/rate = true rework only. */
  rework: { tasks: string[]; reopened: string[]; reclaimed: string[]; rate: number };
  /** Re-claims not preceded by completion: lease expiry, release, dispatcher hand-off. */
  churn: { tasks: string[]; rate: number };
  blockers: { escalations: number; tasks_blocked: string[]; leases_expired: number };
  recommendations: string[];
}

const inWindow = (v: unknown, since: number, until: number) => {
  const t = toMs(v);
  // Inclusive end: `until` defaults to Date.now() and events carry ms
  // timestamps, so an event logged in the same millisecond must count.
  return t >= since && t <= until;
};

/** Aggregate one window of the audit log into retro numbers plus policy
 *  tuning suggestions. Review failure = review evidence with non-zero exit.
 *  Rework = reopened after done, failed review, or claimed again after done.
 *  Churn = claimed again without a completion in between (lease expiry,
 *  release, dispatcher hand-off) — a dispatch/lease problem, not readiness. */
export function buildRetro(args: {
  since: number; until: number; events: EventRow[]; evidence: EvidenceRow[];
}): RetroStats {
  const { since, until } = args;
  const events = args.events.filter((e) => e.entity_type === "task" && inWindow(e.created_at, since, until));
  const evidence = args.evidence.filter((e) => inWindow(e.created_at, since, until));

  const completed = new Set(events.filter((e) => e.action === "completed" || e.action === "status:done").map((e) => e.entity_id));
  const reviews = evidence.filter((e) => e.kind === "review");
  const failedReviews = reviews.filter((e) => e.exit_code != null && e.exit_code !== 0);
  const failedTasks = [...new Set(failedReviews.map((e) => e.task_id))].sort();

  // Only done → open is a reopen. Unblocking (blocked → open) and pulling back
  // from review (in_review → open) are routine moves, not rework. Status events
  // record `from`; one without it (logged before `from` existed) is not counted.
  const reopened = [...new Set(events.filter((e) => e.action === "reopened"
    || (e.action === "status:open" && eventData(e).from === "done")).map((e) => e.entity_id))].sort();
  const claims = new Map<string, number>();
  const doneSinceClaim = new Map<string, boolean>();
  const holder = new Map<string, string | null>();
  const redoneAfterDone = new Set<string>();
  const churned = new Set<string>();
  const ordered = [...events].sort((a, b) => toMs(a.created_at) - toMs(b.created_at));
  for (const e of ordered) {
    const id = e.entity_id;
    if (e.action === "completed" || e.action === "status:done") { doneSinceClaim.set(id, true); holder.set(id, null); }
    if (e.action === "released" || e.action === "lease_expired" || e.action === "status:open") holder.set(id, null);
    if (e.action !== "claimed") continue;
    // The live holder calling claim_task again is a renewal, not a new claim.
    if (holder.get(id) === e.actor) continue;
    holder.set(id, e.actor);
    const n = (claims.get(id) ?? 0) + 1;
    claims.set(id, n);
    if (n > 1) (doneSinceClaim.get(id) ? redoneAfterDone : churned).add(id);
    doneSinceClaim.set(id, false);
  }
  const reclaimed = [...claims].filter(([, n]) => n > 1).map(([id]) => id).sort();
  const reworkSet = new Set([...reopened, ...redoneAfterDone, ...failedTasks]);
  const churnTasks = [...churned].filter((id) => !reworkSet.has(id)).sort();
  const touched = new Set([...completed, ...reworkSet, ...churnTasks]);
  const rate = touched.size ? round(reworkSet.size / touched.size) : 0;
  const churnRate = touched.size ? round(churnTasks.length / touched.size) : 0;

  const escalations = events.filter((e) => e.action === "blocked");
  const tasksBlocked = [...new Set([...escalations.map((e) => e.entity_id),
    ...events.filter((e) => e.action === "status:blocked").map((e) => e.entity_id)])].sort();
  const leasesExpired = events.filter((e) => e.action === "lease_expired").length;

  const recommendations: string[] = [];
  if (reviews.length && failedReviews.length / reviews.length > 0.25) {
    recommendations.push(`review failure rate ${pct(failedReviews.length / reviews.length)}: tighten DoD (require test_run + coverage before review) or set lifecycle pipelines.<type>.review=true`);
  }
  if (rate > 0.2) {
    recommendations.push(`rework rate ${pct(rate)}: tighten DoR (dor.require_description, require_ac_ids) so tasks are ready before claim`);
  }
  if (churnRate > 0.2) {
    recommendations.push(`claim churn ${pct(churnRate)}: tasks bounced between claimants — check dispatcher.live_minutes / exclude_agents so work only goes to live agents, and renew leases on long work`);
  }
  if (tasksBlocked.length >= 3 || (touched.size && tasksBlocked.length / touched.size > 0.2)) {
    recommendations.push(`${tasksBlocked.length} tasks blocked: declare blocked_by edges at intake and split tasks with external dependencies`);
  }
  if (leasesExpired >= 3) {
    recommendations.push(`${leasesExpired} leases expired: estimates too large — split L tasks or renew leases on long work`);
  }
  if (!recommendations.length) recommendations.push("no policy change suggested — keep current DoR/DoD");

  return {
    since: new Date(since).toISOString(),
    until: new Date(until).toISOString(),
    tasks_completed: completed.size,
    review: { reviews: reviews.length, failed: failedReviews.length, failed_tasks: failedTasks },
    rework: { tasks: [...reworkSet].sort(), reopened, reclaimed, rate },
    churn: { tasks: churnTasks, rate: churnRate },
    blockers: { escalations: escalations.length, tasks_blocked: tasksBlocked, leases_expired: leasesExpired },
    recommendations,
  };
}

/** Event data arrives as a JSON string (SQLite) or an object (Postgres jsonb). */
function eventData(e: EventRow): Record<string, unknown> {
  const d = e.data;
  if (d && typeof d === "object") return d as Record<string, unknown>;
  if (typeof d !== "string") return {};
  try { const v = JSON.parse(d); return v && typeof v === "object" ? v : {}; } catch { return {}; }
}

function round(n: number) { return Math.round(n * 1000) / 1000; }
function pct(n: number) { return `${Math.round(n * 100)}%`; }

export function retroTaskId(until: number) { return `retro-${isoDay(until)}`; }

export function retroMarkdown(s: RetroStats): string {
  const list = (xs: string[]) => (xs.length ? xs.join(", ") : "none");
  return [
    `# Retro ${s.since.slice(0, 10)} → ${s.until.slice(0, 10)}`,
    "",
    `- Tasks completed: ${s.tasks_completed}`,
    `- Reviews: ${s.review.reviews}, failed: ${s.review.failed} (${list(s.review.failed_tasks)})`,
    `- Rework rate: ${pct(s.rework.rate)} — reopened: ${list(s.rework.reopened)}; rework tasks: ${list(s.rework.tasks)}`,
    `- Claim churn: ${pct(s.churn.rate)} — ${list(s.churn.tasks)}`,
    `- Blockers: ${s.blockers.escalations} escalations; blocked tasks: ${list(s.blockers.tasks_blocked)}; leases expired: ${s.blockers.leases_expired}`,
    "",
    "## Policy tuning (DoR / DoD)",
    ...s.recommendations.map((r) => `- ${r}`),
  ].join("\n");
}

// ---------------------------------------------------------------- grooming

export interface GroomTaskRow { id: string; status: string; estimate?: string | null; updated_at: unknown; last_activity?: unknown }
export interface GroomClaimRow { task_id: string; agent_id: string; lease_expires: unknown; claimed_at?: unknown; last_holder_activity?: unknown }
export interface GroomEdgeRow { task_id: string; task_status: string; blocker_id: string; blocker_status: string }

export interface GroomFindings {
  stale_open: { task_id: string; idle_days: number; estimate: string }[];
  stale_claims: { task_id: string; agent_id: string; idle_minutes: number }[];
  dependency_issues: { task_id: string; blocker_id?: string; issue: string }[];
}

/** One grooming pass. `last_activity` is the newest task event; for claims,
 *  `last_holder_activity` is the holder's newest event on that task. */
export function groomFindings(args: {
  now: number; tasks: GroomTaskRow[]; claims: GroomClaimRow[]; edges: GroomEdgeRow[];
  policy: SdlcPolicy["grooming"];
}): GroomFindings {
  const { now, policy } = args;
  const stale_open = args.tasks
    .filter((t) => t.status === "open")
    .map((t) => {
      const last = Math.max(toMs(t.updated_at) || 0, toMs(t.last_activity) || 0);
      return { task_id: t.id, idle_days: Math.floor((now - last) / DAY), estimate: t.estimate ?? "" };
    })
    .filter((t) => t.idle_days >= policy.stale_open_days)
    .sort((a, b) => b.idle_days - a.idle_days || a.task_id.localeCompare(b.task_id));

  const stale_claims = args.claims
    .filter((c) => toMs(c.lease_expires) > now)
    .map((c) => {
      const last = Math.max(toMs(c.last_holder_activity) || 0, toMs(c.claimed_at) || 0);
      return { task_id: c.task_id, agent_id: c.agent_id, idle_minutes: Math.floor((now - last) / 60_000) };
    })
    .filter((c) => c.idle_minutes >= policy.stale_claim_minutes)
    .sort((a, b) => b.idle_minutes - a.idle_minutes || a.task_id.localeCompare(b.task_id));

  const dependency_issues: GroomFindings["dependency_issues"] = [];
  const byTask = new Map<string, GroomEdgeRow[]>();
  for (const e of args.edges) byTask.set(e.task_id, [...(byTask.get(e.task_id) ?? []), e]);
  for (const [taskId, edges] of [...byTask].sort(([a], [b]) => a.localeCompare(b))) {
    for (const e of edges) {
      if (e.task_status === "done" && e.blocker_status !== "done") {
        dependency_issues.push({ task_id: taskId, blocker_id: e.blocker_id, issue: "done before its blocker — edge is stale or the task was closed early" });
      }
      if ((e.task_status === "claimed" || e.task_status === "in_review") && e.blocker_status !== "done") {
        dependency_issues.push({ task_id: taskId, blocker_id: e.blocker_id, issue: `${e.task_status} while blocker is ${e.blocker_status}` });
      }
    }
    const task = edges[0];
    if (task.task_status === "blocked" && edges.every((e) => e.blocker_status === "done")) {
      dependency_issues.push({ task_id: taskId, issue: "status blocked but every blocker is done — unblock it" });
    }
  }
  return { stale_open, stale_claims, dependency_issues };
}

/** Stable identity of each finding, so a pass only acts on what changed. */
export function findingKeys(f: GroomFindings): string[] {
  return [
    ...f.stale_open.map((t) => `stale:${t.task_id}`),
    ...f.stale_claims.map((c) => `claim:${c.task_id}:${c.agent_id}`),
    ...f.dependency_issues.map((d) => `dep:${d.task_id}:${d.blocker_id ?? ""}:${d.issue.split(" ")[0]}`),
  ];
}

/** Findings not already reported by the previous pass (keys from its
 *  `groomed` audit event). A finding that clears and recurs is reported again. */
export function newFindings(f: GroomFindings, previous: readonly string[]): GroomFindings {
  const seen = new Set(previous);
  return {
    stale_open: f.stale_open.filter((t) => !seen.has(`stale:${t.task_id}`)),
    stale_claims: f.stale_claims.filter((c) => !seen.has(`claim:${c.task_id}:${c.agent_id}`)),
    dependency_issues: f.dependency_issues.filter((d) => !seen.has(`dep:${d.task_id}:${d.blocker_id ?? ""}:${d.issue.split(" ")[0]}`)),
  };
}

export function groomMarkdown(f: GroomFindings, at: number): string {
  const lines = [`# Backlog grooming ${new Date(at).toISOString()}`, ""];
  lines.push(`## Stale open tasks (${f.stale_open.length})`);
  for (const t of f.stale_open) lines.push(`- ${t.task_id}: idle ${t.idle_days}d, estimate ${t.estimate || "unset"} — re-estimate or close`);
  lines.push("", `## Stale claims (${f.stale_claims.length})`);
  for (const c of f.stale_claims) lines.push(`- ${c.task_id}: ${c.agent_id} silent ${c.idle_minutes}m — renew or release`);
  lines.push("", `## Dependency edges (${f.dependency_issues.length})`);
  for (const d of f.dependency_issues) lines.push(`- ${d.task_id}${d.blocker_id ? ` ← ${d.blocker_id}` : ""}: ${d.issue}`);
  return lines.join("\n");
}

// ---------------------------------------------------------------- sprints

export interface SprintRow { id: string; name: string; starts_at: string; ends_at: string; goal?: string | null }
export interface SprintTaskRow { id: string; status: string; completed_at?: unknown }

export interface SprintReport {
  sprint: SprintRow;
  state: "planned" | "active" | "closed";
  committed: number;
  done: number;
  remaining: number;
  burndown: { date: string; remaining: number; ideal: number }[];
  /** Unfinished tasks of a closed sprint. */
  carry_over: string[];
  /** Tasks moved here from another sprint. */
  carried_in: string[];
}

export function validateSprint(s: { name?: string; starts_at?: string; ends_at?: string }): string | null {
  if (!s.name?.trim()) return "sprint name required";
  const a = toMs(s.starts_at);
  const b = toMs(s.ends_at);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return "starts_at and ends_at must be dates (YYYY-MM-DD or ISO)";
  // A date-only end runs through that day, so a one-day sprint (start == end) is valid.
  const end = /^\d{4}-\d{2}-\d{2}$/.test(s.ends_at ?? "") ? b + DAY : b;
  if (end <= a) return "ends_at must be after starts_at";
  return null;
}

export function sprintState(s: SprintRow, now: number): SprintReport["state"] {
  if (now < toMs(s.starts_at)) return "planned";
  return now >= sprintEnd(s) ? "closed" : "active";
}

/** A date-only end means "through that day". */
function sprintEnd(s: SprintRow) {
  const end = toMs(s.ends_at);
  return /^\d{4}-\d{2}-\d{2}$/.test(s.ends_at) ? end + DAY : end;
}

/** Daily burndown of committed tasks: a start point (remaining = ideal =
 *  committed) then one point per elapsed day, dated at that day's cutoff
 *  (empty while planned). A task counts as burned on the day of its
 *  completion; tasks completed after the sprint end stay in remaining and
 *  are carried over. */
export function sprintReport(sprint: SprintRow, tasks: SprintTaskRow[], now: number, carriedIn: string[] = []): SprintReport {
  const start = toMs(sprint.starts_at);
  const end = sprintEnd(sprint);
  const state = sprintState(sprint, now);
  const committed = tasks.length;
  const doneAt = (t: SprintTaskRow) => {
    if (t.status !== "done") return Infinity;
    const at = toMs(t.completed_at);
    return Number.isFinite(at) ? at : start;
  };
  const done = tasks.filter((t) => doneAt(t) < end).length;
  const days = Math.max(1, Math.ceil((end - start) / DAY));
  // Start point, then one point per elapsed day (today included) at that day's end.
  const elapsed = Math.min(days, Math.max(0, Math.ceil((Math.min(now, end) - start) / DAY)));
  const burndown: SprintReport["burndown"] = [];
  for (let d = 0; state !== "planned" && d <= elapsed; d++) {
    const cutoff = Math.min(start + d * DAY, end);
    burndown.push({
      date: isoDay(start + d * DAY),
      remaining: committed - tasks.filter((t) => doneAt(t) < cutoff).length,
      ideal: round(committed - (committed * d) / days),
    });
  }
  const carry_over = state === "closed" ? tasks.filter((t) => doneAt(t) >= end).map((t) => t.id).sort() : [];
  const inSprint = new Set(tasks.map((t) => t.id));
  return {
    sprint, state, committed, done, remaining: committed - done, burndown, carry_over,
    carried_in: [...new Set(carriedIn)].filter((id) => inSprint.has(id)).sort(),
  };
}
