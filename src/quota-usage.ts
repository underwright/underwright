/** gh-149 quota pacing. Prepaid subscription windows are use-it-or-lose-it:
 *  the right end-of-window state is ~100% consumed, not "avoided exhaustion".
 *  This module turns append-only usage samples into per-provider pace —
 *  burn rate, position against the linear-to-100% curve, projected % at
 *  reset — plus the derived quota state routing gates on. Pure functions;
 *  the stores do the I/O. */

import type { UsageSample } from "./node-protocol.js";

export const WINDOW_MS: Record<string, number> = {
  "5h": 5 * 3_600_000,
  daily: 24 * 3_600_000,
  weekly: 7 * 24 * 3_600_000,
  monthly: 30 * 24 * 3_600_000,
};

/** Longest window we pace — bounds the usage_samples scan. */
export const USAGE_LOOKBACK_MS = WINDOW_MS.monthly + 24 * 3_600_000;

/** window_used_pct at/above this reads as exhausted. */
export const EXHAUSTED_PCT = 99.5;

/** Pace deltas inside this band (percentage points) count as "on pace" so
 *  routing doesn't flap between harnesses on sampling noise. */
export const PACE_DEADBAND = 5;

/** One stored usage_samples row (node-scoped). */
export interface UsageRow {
  node_id: string;
  harness: string;
  sampled_at: string;
  tokens_in?: number | string | null;
  tokens_out?: number | string | null;
  cost?: number | string | null;
  window_used_pct?: number | string | null;
  window_kind?: string | null;
  resets_at?: string | null;
  vendor_state?: string | null;
}

export interface ProviderPace {
  harness: string;
  window_kind: string | null;
  window_used_pct: number | null;
  resets_at: string | null;
  sampled_at: string;
  nodes: number;
  /** Tokens (in+out) per hour summed across nodes over the lookback. */
  tokens_per_hr: number | null;
  cost_per_hr: number | null;
  /** Window percentage points consumed per hour. */
  pct_per_hr: number | null;
  /** Where a linear burn to 100% at reset would be right now. */
  expected_pct: number | null;
  /** window_used_pct - expected_pct: >0 ahead of pace (burning too fast),
   *  <0 behind (budget going to waste). */
  pace_delta: number | null;
  /** At the current burn rate, % consumed when the window resets. Can exceed
   *  100 — that means the window exhausts early. */
  projected_pct_at_reset: number | null;
  derived_state: "available" | "rate_limited" | "exhausted" | "unknown";
}

const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const round = (v: number | null, dp = 1) => v === null ? null : Math.round(v * 10 ** dp) / 10 ** dp;

/** Sum of positive counter increments for one node — a drop means the
 *  counter reset (new session/window), so the post-reset value counts. */
function counterBurn(values: Array<number | null>): number {
  let total = 0;
  let prev: number | null = null;
  for (const v of values) {
    if (v === null) continue;
    if (prev !== null) total += v >= prev ? v - prev : v;
    prev = v;
  }
  return total;
}

/** Fold one harness's samples (all nodes) into its pace. Quota is
 *  per-account, so window_used_pct/resets_at come from the newest sample on
 *  any node; token/cost burn is summed per node. */
export function paceForHarness(harness: string, rows: UsageRow[], now = Date.now()): ProviderPace | null {
  const sorted = rows
    .filter(r => r.harness === harness && Number.isFinite(Date.parse(r.sampled_at)))
    .sort((a, b) => Date.parse(a.sampled_at) - Date.parse(b.sampled_at));
  if (!sorted.length) return null;
  const latest = sorted[sorted.length - 1];
  const window_kind = latest.window_kind ?? [...sorted].reverse().find(r => r.window_kind)?.window_kind ?? null;
  const window_used_pct = num(latest.window_used_pct);
  const resets_at = latest.resets_at ?? null;
  const resetsMs = resets_at ? Date.parse(resets_at) : NaN;
  const windowMs = window_kind ? WINDOW_MS[window_kind] : undefined;
  const windowStart = windowMs && Number.isFinite(resetsMs) ? resetsMs - windowMs : null;

  // Token/cost burn: per node over the whole lookback span.
  const byNode = new Map<string, UsageRow[]>();
  for (const r of sorted) {
    const list = byNode.get(r.node_id) ?? [];
    list.push(r);
    byNode.set(r.node_id, list);
  }
  let tokens = 0, cost = 0, haveTokens = false, haveCost = false;
  for (const list of byNode.values()) {
    const ti = list.map(r => num(r.tokens_in)), to = list.map(r => num(r.tokens_out)), c = list.map(r => num(r.cost));
    if (ti.some(v => v !== null) || to.some(v => v !== null)) haveTokens = true;
    if (c.some(v => v !== null)) haveCost = true;
    tokens += counterBurn(ti) + counterBurn(to);
    cost += counterBurn(c);
  }
  const spanHrs = (Date.parse(latest.sampled_at) - Date.parse(sorted[0].sampled_at)) / 3_600_000;
  const tokens_per_hr = haveTokens && spanHrs > 0 ? tokens / spanHrs : null;
  const cost_per_hr = haveCost && spanHrs > 0 ? cost / spanHrs : null;

  // Window burn: percentage points per hour within the current window.
  let pct_per_hr: number | null = null;
  let expected_pct: number | null = null;
  let projected_pct_at_reset: number | null = null;
  if (window_used_pct !== null && windowStart !== null && windowMs) {
    const inWindow = sorted.filter(r => Date.parse(r.sampled_at) >= windowStart && num(r.window_used_pct) !== null);
    const first = inWindow[0];
    const hrs = first ? (Date.parse(latest.sampled_at) - Date.parse(first.sampled_at)) / 3_600_000 : 0;
    if (first && hrs >= 0.25) pct_per_hr = Math.max(0, (window_used_pct - num(first.window_used_pct)!) / hrs);
    else {
      // One reading: assume a linear burn since the window opened.
      const sinceOpen = (Date.parse(latest.sampled_at) - windowStart) / 3_600_000;
      if (sinceOpen > 0) pct_per_hr = window_used_pct / sinceOpen;
    }
    const elapsed = Math.min(Math.max(now - windowStart, 0), windowMs);
    expected_pct = (elapsed / windowMs) * 100;
    const remainingHrs = Math.max(resetsMs - now, 0) / 3_600_000;
    if (pct_per_hr !== null) projected_pct_at_reset = window_used_pct + pct_per_hr * remainingHrs;
  }
  const pace_delta = window_used_pct !== null && expected_pct !== null ? window_used_pct - expected_pct : null;
  return {
    harness, window_kind, window_used_pct: round(window_used_pct), resets_at, sampled_at: latest.sampled_at,
    nodes: byNode.size,
    tokens_per_hr: tokens_per_hr === null ? null : Math.round(tokens_per_hr),
    cost_per_hr: round(cost_per_hr, 4),
    pct_per_hr: round(pct_per_hr, 2), expected_pct: round(expected_pct), pace_delta: round(pace_delta),
    projected_pct_at_reset: round(projected_pct_at_reset),
    derived_state: deriveState(latest, now),
  };
}

/** Vendor says so, or the window is ~full → exhausted; vendor throttle →
 *  rate_limited. Both lapse once resets_at passes. */
export function deriveState(sample: Pick<UsageRow, "vendor_state" | "window_used_pct" | "resets_at">, now = Date.now()): ProviderPace["derived_state"] {
  const resets = sample.resets_at ? Date.parse(sample.resets_at) : NaN;
  const lapsed = Number.isFinite(resets) && resets <= now;
  if (sample.vendor_state === "rate_limited") return lapsed ? "available" : "rate_limited";
  const pct = num(sample.window_used_pct);
  if (sample.vendor_state === "exhausted" || (pct !== null && pct >= EXHAUSTED_PCT)) return lapsed ? "available" : "exhausted";
  if (sample.vendor_state === "available" || pct !== null) return "available";
  return "unknown";
}

export function paceByHarness(rows: UsageRow[], now = Date.now()): Map<string, ProviderPace> {
  const out = new Map<string, ProviderPace>();
  for (const h of new Set(rows.map(r => r.harness))) {
    const p = paceForHarness(h, rows, now);
    if (p) out.set(h, p);
  }
  return out;
}

type Quota = { state?: string; resets_at?: string; override?: boolean; observed_at?: string; source?: string };
const RESTRICTIVE: Record<string, number> = { exhausted: 3, rate_limited: 2, stale: 1, unknown: 0, available: 0 };

/** Combine attested quota with usage-derived state. A manual declaration
 *  with override=true wins outright; otherwise the more restrictive state
 *  applies (derived blocking states carry the vendor's resets_at). */
export function mergeQuota(attested: Quota | undefined, pace: ProviderPace | undefined): Quota {
  const base = attested ?? { state: "unknown" };
  if (base.override || !pace) return base;
  const derived = pace.derived_state;
  if (derived !== "exhausted" && derived !== "rate_limited") return base;
  if ((RESTRICTIVE[base.state ?? "unknown"] ?? 0) >= RESTRICTIVE[derived]) return base;
  return { state: derived, ...(pace.resets_at ? { resets_at: pace.resets_at } : {}), source: "usage" };
}

/** Fold derived quota into a node's capabilities document. */
export function mergeUsageQuota(capabilitiesJson: string, pace: ReadonlyMap<string, ProviderPace>): string {
  if (!pace.size) return capabilitiesJson;
  try {
    const caps = JSON.parse(capabilitiesJson || "{}");
    if (!Array.isArray(caps.harnesses)) return capabilitiesJson;
    let changed = false;
    for (const h of caps.harnesses) {
      const p = h?.id ? pace.get(h.id) : undefined;
      if (!p) continue;
      const merged = mergeQuota(h.quota, p);
      if (merged !== h.quota) { h.quota = merged; changed = true; }
    }
    return changed ? JSON.stringify(caps) : capabilitiesJson;
  } catch { return capabilitiesJson; }
}

/** Routing weight per harness: pace_delta bucketed by PACE_DEADBAND. Lower
 *  = further behind pace = more unused budget = preferred. */
export function paceWeights(pace: ReadonlyMap<string, ProviderPace>): Record<string, number> {
  const w: Record<string, number> = {};
  for (const [h, p] of pace) if (p.pace_delta !== null) w[h] = Math.round(p.pace_delta / PACE_DEADBAND);
  return w;
}

/** Normalize a heartbeat sample to a storage row. */
export function sampleRow(nodeId: string, s: UsageSample): UsageRow {
  return {
    node_id: nodeId, harness: s.harness, sampled_at: new Date(s.sampled_at).toISOString(),
    tokens_in: s.tokens_in ?? null, tokens_out: s.tokens_out ?? null, cost: s.cost ?? null,
    window_used_pct: s.window_used_pct ?? null, window_kind: s.window_kind ?? null,
    resets_at: s.resets_at ? new Date(s.resets_at).toISOString() : null, vendor_state: s.vendor_state ?? null,
  };
}
