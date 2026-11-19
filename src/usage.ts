// Omnigent session + cost telemetry (gh-168): the shape the runner reports,
// how it maps onto jobs columns, and how per-task usage is aggregated.

/** What a runner reports about an omnigent-backed job. All fields optional:
 *  absent values never overwrite previously recorded ones. */
export interface JobTelemetry {
  omni_session_id?: string;
  cost_usd?: number;
  usage_by_model?: Record<string, unknown>;
}

export interface TaskUsageJob {
  job_id: string;
  status: string;
  omni_session_id: string | null;
  cost_usd: number | null;
  usage_by_model: Record<string, unknown> | null;
}

export interface TaskUsage {
  task_id: string;
  total_cost_usd: number;
  jobs: TaskUsageJob[];
}

/** Normalize telemetry into nullable column values (null = keep existing). */
export function telemetryColumns(t?: JobTelemetry | null) {
  const cost = typeof t?.cost_usd === "number" && Number.isFinite(t.cost_usd) && t.cost_usd >= 0 ? t.cost_usd : null;
  const session = typeof t?.omni_session_id === "string" && t.omni_session_id.trim() ? t.omni_session_id.trim().slice(0, 512) : null;
  const usage = t?.usage_by_model && typeof t.usage_by_model === "object" ? JSON.stringify(t.usage_by_model).slice(0, 16000) : null;
  return { omni_session_id: session, cost_usd: cost, usage_json: usage };
}

/** Aggregate job rows (omni_session_id, cost_usd, usage_json) into a per-task total. */
export function summarizeTaskUsage(taskId: string, rows: any[]): TaskUsage {
  const jobs = rows.map(r => {
    let usage: Record<string, unknown> | null = null;
    try { usage = r.usage_json ? JSON.parse(r.usage_json) : null; } catch { usage = null; }
    const cost = r.cost_usd == null ? null : Number(r.cost_usd);
    return { job_id: r.job_id, status: r.status, omni_session_id: r.omni_session_id ?? null, cost_usd: cost, usage_by_model: usage };
  });
  const total = jobs.reduce((sum, j) => sum + (j.cost_usd ?? 0), 0);
  return { task_id: taskId, total_cost_usd: Math.round(total * 1e6) / 1e6, jobs };
}

export const formatUsd = (n: number | null | undefined) => n == null ? "n/a" : `$${n.toFixed(4)}`;

/** Markdown lines citing each omni session + cost for evidence/completion comments. */
export function usageCitation(usage: TaskUsage | null | undefined): string[] {
  if (!usage || usage.jobs.length === 0) return [];
  return [
    "",
    `**Omnigent usage** — total ${formatUsd(usage.total_cost_usd)}`,
    ...usage.jobs.map(j =>
      `- ${j.omni_session_id ? `omni session \`${j.omni_session_id}\`` : "omni session (unknown)"} — job \`${j.job_id}\` (${j.status}) — cost ${formatUsd(j.cost_usd)}`),
  ];
}

/** Extract cumulative cost + per-model usage from a `GET /v1/sessions/{id}`
 *  snapshot. Tolerant of field placement: top-level or under `usage`. */
export function parseSessionSnapshot(snapshot: any): { cost_usd?: number; usage_by_model?: Record<string, unknown> } {
  if (!snapshot || typeof snapshot !== "object") return {};
  const s = snapshot.session && typeof snapshot.session === "object" ? snapshot.session : snapshot;
  const u = s.usage && typeof s.usage === "object" ? s.usage : {};
  const num = (v: unknown) => typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : undefined;
  const cost = num(s.cost_usd) ?? num(s.total_cost_usd) ?? num(u.cost_usd) ?? num(u.total_cost_usd) ?? num(s.n);
  const byModel = s.usage_by_model ?? u.usage_by_model ?? u.by_model;
  const out: { cost_usd?: number; usage_by_model?: Record<string, unknown> } = {};
  if (cost !== undefined) out.cost_usd = cost;
  if (byModel && typeof byModel === "object") out.usage_by_model = byModel;
  return out;
}

/** Bare session id from an extracted locator: a URL yields its last path segment. */
export function sessionIdFromLocator(locator: string): string {
  if (!/^https?:\/\//i.test(locator)) return locator;
  try {
    const parts = new URL(locator).pathname.split("/").filter(Boolean);
    return parts[parts.length - 1] ?? locator;
  } catch { return locator; }
}
