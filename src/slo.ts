// Service-level objectives for the control plane, evaluated against the
// persistent metrics sink plus the live jobs/tasks/nodes tables. Stores build
// a SloContext per evaluation window (the SQL differs per backend); the
// definitions and the verdict logic below are pure and shared.
import { resolveSinceTimestamp } from "./digest.js";

/** Queue→start latency threshold for the dispatch-promptness SLO. */
export const DISPATCH_SLO_SECONDS = 300;
/** Node poll freshness threshold — mirrors the poll-silent liveness cutoff. */
export const NODE_POLL_FRESH_MS = 120_000;
/** Metric series each store must load into SloContext.series. */
export const SLO_SERIES_NAMES = ["search.duration_ms"] as const;

/** Snapshot of every quantity the SLO set needs for one window. */
export interface SloContext {
  counts: {
    jobs_done: number;
    jobs_failed: number;
    /** Jobs that started inside the window (dispatch latency population). */
    dispatch_total: number;
    /** Of those, jobs started within DISPATCH_SLO_SECONDS of queueing. */
    dispatch_within: number;
    tasks_done: number;
    tasks_done_with_evidence: number;
    nodes_approved: number;
    nodes_poll_fresh: number;
  };
  /** Metric name → observed values inside the window (bounded). */
  series: Record<string, number[]>;
  /** ts of the newest metrics row — freshness signal for the sink itself. */
  latest_metric_ts: string | null;
}

export type SloUnit = "ratio" | "seconds" | "ms";

export interface SloMeasurement {
  value: number | null;   // null = insufficient data this window
  samples: number;
  detail?: string;
}

export interface SloDefinition {
  id: string;
  title: string;
  description: string;
  /** Relative window ("1h","24h","7d","30d") understood by resolveSinceTimestamp. */
  window: string;
  /** For comparator "at_least" a fraction 0..1; for "at_most" a threshold in `unit`. */
  objective: number;
  comparator: "at_least" | "at_most";
  unit: SloUnit;
  measure: (ctx: SloContext, now: Date) => SloMeasurement;
}

export interface SloStatus extends SloMeasurement {
  id: string;
  title: string;
  description: string;
  window: string;
  objective: number;
  comparator: "at_least" | "at_most";
  unit: SloUnit;
  compliant: boolean;
  /** ok | breaching | no_data — dashboards sort breaching first. */
  status: "ok" | "breaching" | "no_data";
  /** Error budget consumed for ratio SLOs, 0..1 of the allowed-bad share. */
  error_budget_consumed?: number;
}

function ratio(good: number, total: number, detail?: string): SloMeasurement {
  return { value: total ? good / total : null, samples: total, detail };
}

function percentile(values: number[] | undefined, p: number): number | null {
  if (!values?.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)];
}

/** The control plane's SLO set — the equivalents of creation, checkout,
 *  search, and export health for a task-registry service. */
export const SLOS: SloDefinition[] = [
  {
    id: "job-success-rate",
    title: "Jobs finish successfully",
    description: "Share of jobs finished in the window that reach status done.",
    window: "24h", objective: 0.9, comparator: "at_least", unit: "ratio",
    measure: (c) => ratio(c.counts.jobs_done, c.counts.jobs_done + c.counts.jobs_failed,
      `${c.counts.jobs_done} done · ${c.counts.jobs_failed} failed`),
  },
  {
    id: "job-dispatch-latency",
    title: "Queued jobs dispatch promptly",
    description: `Share of jobs started in the window that began within ${DISPATCH_SLO_SECONDS}s of queueing.`,
    window: "24h", objective: 0.9, comparator: "at_least", unit: "ratio",
    measure: (c) => ratio(c.counts.dispatch_within, c.counts.dispatch_total,
      `≤${DISPATCH_SLO_SECONDS}s queue→start`),
  },
  {
    id: "search-context-p95",
    title: "Context search stays fast",
    description: "p95 search_context latency, from the persistent metrics series.",
    window: "24h", objective: 2000, comparator: "at_most", unit: "ms",
    measure: (c) => {
      const s = c.series["search.duration_ms"] ?? [];
      return { value: percentile(s, 0.95), samples: s.length, detail: "p95 latency" };
    },
  },
  {
    id: "done-task-evidence",
    title: "Done tasks carry evidence",
    description: "Share of tasks completed in the window that have at least one evidence row.",
    window: "7d", objective: 0.95, comparator: "at_least", unit: "ratio",
    measure: (c) => ratio(c.counts.tasks_done_with_evidence, c.counts.tasks_done),
  },
  {
    id: "node-poll-freshness",
    title: "Approved nodes keep polling",
    description: "Share of approved nodes whose last job poll is inside the freshness window.",
    window: "1h", objective: 0.9, comparator: "at_least", unit: "ratio",
    measure: (c) => ratio(c.counts.nodes_poll_fresh, c.counts.nodes_approved),
  },
  {
    id: "metrics-sink-freshness",
    title: "Metrics sink stays fresh",
    description: "Age of the newest persisted metric — the observability pipeline itself.",
    window: "1h", objective: 900, comparator: "at_most", unit: "seconds",
    measure: (c, now) => {
      if (!c.latest_metric_ts) return { value: null, samples: 0 };
      const age = (now.getTime() - Date.parse(c.latest_metric_ts)) / 1000;
      return { value: age, samples: 1, detail: `last point ${Math.round(age)}s ago` };
    },
  },
];

/**
 * Evaluate every SLO. `ctxFor(window, windowStart)` is supplied by the store —
 * each distinct window is requested once per call. Pure beyond that callback.
 */
export function evaluateSlos(
  ctxFor: (window: string, windowStart: string) => SloContext,
  defs: SloDefinition[] = SLOS,
  now = new Date(),
): SloStatus[] {
  const ctxs = new Map<string, SloContext>();
  return defs.map((def) => {
    let ctx = ctxs.get(def.window);
    if (!ctx) {
      ctx = ctxFor(def.window, resolveSinceTimestamp(def.window, now.getTime()));
      ctxs.set(def.window, ctx);
    }
    const m = def.measure(ctx, now);
    const compliant = m.value !== null &&
      (def.comparator === "at_least" ? m.value >= def.objective : m.value <= def.objective);
    const out: SloStatus = {
      ...def, ...m,
      compliant,
      status: m.value === null ? "no_data" : compliant ? "ok" : "breaching",
    };
    if (def.unit === "ratio" && def.comparator === "at_least" && m.samples) {
      const allowedBad = Math.floor(m.samples * (1 - def.objective));
      const bad = m.samples - Math.round((m.value ?? 0) * m.samples);
      out.error_budget_consumed = allowedBad <= 0 ? (bad ? 1 : 0) : Math.min(1, bad / allowedBad);
    }
    return out;
  });
}
