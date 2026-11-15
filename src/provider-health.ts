/** Per-provider health rollup for the board/dashboard: attested quota state
 *  aggregated across nodes plus execution-detected issues from recent job
 *  results. Token-level burn arrives with usage sampling (gh-149); until then
 *  job counts are the activity signal. */

export type IssueKind = "billing" | "rate_limit" | "auth" | "config" | "aborted" | "other";

export interface ProviderIssue {
  kind: IssueKind;
  count: number;
  last_at: string | null;
  last_msg: string;
}

export interface ProviderRow {
  id: string;
  nodes: number;           // nodes attesting it installed
  ready: number;           // installed + auth ready + quota allows
  exhausted: number;       // nodes declaring quota exhausted
  resets_at: string | null; // nearest future reset among exhausted entries
  jobs_6h: { done: number; failed: number; other: number };
  issues: ProviderIssue[];
}

/** Classify a finished job's result tail into the failure bucket that matters
 *  for "at a glance" provider health. Order matters — billing strings also
 *  contain words that would hit weaker buckets. */
export function classifyFailure(result: string | null | undefined): IssueKind {
  const r = result ?? "";
  if (/out of credits|usageLimitExceeded|insufficient_quota|payment|billing/i.test(r)) return "billing";
  if (/hit your .*limit|rate.?limit|usage.?limit|429|too many requests/i.test(r)) return "rate_limit";
  if (/\b401\b|unauthorized|invalid (api )?key|authentication failed/i.test(r)) return "auth";
  if (/unknown option|a value is required|REPL-only|requires the|missing .*package|command not found/i.test(r)) return "config";
  if (/aborted|timed out|outcome_unknown/i.test(r)) return "aborted";
  return "other";
}

/** Extract a reset time from provider error text. Understands explicit ISO
 *  timestamps, "resets 8:50am"-style clock times (next occurrence, capped at
 *  +12h — over-blocking a window beats burning retries), and "resets in N
 *  hours/minutes" relatives. Returns ISO or null when nothing parses. */
export function parseResetAt(result: string | null | undefined, now = Date.now()): string | null {
  const r = result ?? "";
  const iso = r.match(/\b(20\d{2}-\d{2}-\d{2}[T ][0-2]\d:[0-5]\d(?::[0-5]\d)?\s*(?:Z|[+-][0-2]\d:?[0-5]\d)?)\b/);
  if (iso) {
    const t = Date.parse(iso[1].replace(" ", "T"));
    if (Number.isFinite(t) && t > now) return new Date(t).toISOString();
  }
  const rel = r.match(/resets? (?:in|after) (\d+)\s*(hours?|hrs?|h|minutes?|mins?|m)\b/i);
  if (rel) {
    const ms = /^h/i.test(rel[2]) ? Number(rel[1]) * 3_600_000 : Number(rel[1]) * 60_000;
    if (ms > 0) return new Date(now + ms).toISOString();
  }
  const tod = r.match(/resets? (?:at )?(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i);
  if (tod) {
    let h = Number(tod[1]) % 12;
    if (tod[3].toLowerCase() === "pm") h += 12;
    const d = new Date(now);
    d.setHours(h, Number(tod[2] ?? 0), 0, 0);
    if (d.getTime() <= now) d.setDate(d.getDate() + 1);
    const capped = Math.min(d.getTime(), now + 12 * 3_600_000);
    return new Date(capped).toISOString();
  }
  return null;
}

/** One line to show next to an issue kind — the tail of the last failure. */
function excerpt(result: string): string {
  const line = (result ?? "").split("\n").map(l => l.trim()).filter(l => l && !l.startsWith("Omnigent session:") && !l.startsWith("omnigent:")).pop() ?? "";
  return line.slice(0, 90);
}

const harnessOf = (agentId: string) => agentId.split("@")[0];

export function aggregateProviders(
  nodes: Array<{ name?: string; harnesses?: Array<{ id: string; installed?: boolean; auth_status?: string; quota?: { state?: string; resets_at?: string } }> }>,
  failures: Array<{ agent_id: string; result?: string; finished_at?: string }>,
  jobCounts: Array<{ agent_id: string; status: string; n: number }>,
  now = Date.now(),
): ProviderRow[] {
  const map = new Map<string, ProviderRow>();
  const row = (id: string) => {
    let r = map.get(id);
    if (!r) { r = { id, nodes: 0, ready: 0, exhausted: 0, resets_at: null, jobs_6h: { done: 0, failed: 0, other: 0 }, issues: [] }; map.set(id, r); }
    return r;
  };

  for (const node of nodes) {
    for (const h of node.harnesses ?? []) {
      if (!h.installed) continue;
      const r = row(h.id);
      r.nodes++;
      const quotaState = h.quota?.state ?? "unknown";
      const resets = h.quota?.resets_at ? Date.parse(h.quota.resets_at) : NaN;
      const quotaOk = quotaState !== "exhausted" || (Number.isFinite(resets) && resets <= now);
      if (quotaState === "exhausted") {
        r.exhausted++;
        if (Number.isFinite(resets) && resets > now && (!r.resets_at || resets < Date.parse(r.resets_at))) r.resets_at = h.quota!.resets_at!;
      }
      if (h.auth_status === "ready" && quotaOk) r.ready++;
    }
  }

  for (const j of jobCounts) {
    const r = row(harnessOf(j.agent_id));
    if (j.status === "done") r.jobs_6h.done += j.n;
    else if (j.status === "failed") r.jobs_6h.failed += j.n;
    else r.jobs_6h.other += j.n;
  }

  const issueByProvider = new Map<string, Map<IssueKind, ProviderIssue>>();
  for (const f of failures) {
    const id = harnessOf(f.agent_id);
    const kind = classifyFailure(f.result);
    let kinds = issueByProvider.get(id);
    if (!kinds) { kinds = new Map(); issueByProvider.set(id, kinds); }
    const cur = kinds.get(kind) ?? { kind, count: 0, last_at: null, last_msg: "" };
    cur.count++;
    if (!cur.last_at || (f.finished_at ?? "") > cur.last_at) { cur.last_at = f.finished_at ?? null; cur.last_msg = excerpt(f.result ?? ""); }
    kinds.set(kind, cur);
  }
  const sev: IssueKind[] = ["billing", "rate_limit", "auth", "config", "aborted", "other"];
  for (const [id, kinds] of issueByProvider) {
    row(id).issues = [...kinds.values()].sort((a, b) => sev.indexOf(a.kind) - sev.indexOf(b.kind));
  }

  return [...map.values()].sort((a, b) => {
    const aIssue = a.issues.length ? sev.indexOf(a.issues[0].kind) : 99;
    const bIssue = b.issues.length ? sev.indexOf(b.issues[0].kind) : 99;
    return aIssue - bIssue || b.ready - a.ready || a.id.localeCompare(b.id);
  });
}
