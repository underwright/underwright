/**
 * Token/cost usage normalization + rollup for agent job results (gh-226).
 *
 * Workers report usage in whatever shape the harness emits — omnigent's
 * `session_usage` ({input_tokens, output_tokens, total_cost_usd}), harness
 * result JSON with a `usage` block, or flat token keys. `extractUsage`
 * folds all of them into one canonical record stored under
 * `result_metadata.usage`; `sumUsage` rolls jobs up per task in JS so the
 * rollup is engine-agnostic (no JSON SQL — same code on SQLite and PG).
 */

export interface JobUsage {
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  cost_usd?: number;
  backend?: string;
  model?: string;
}

const num = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) ? v : undefined;

/** Read one usage-shaped dict into a JobUsage, or undefined if it holds no usage fields. */
function readDict(d: Record<string, unknown>): JobUsage | undefined {
  if (d == null || typeof d !== "object" || Array.isArray(d)) return undefined;
  const input = num(d.input_tokens) ?? num(d.prompt_tokens);
  const output = num(d.output_tokens) ?? num(d.completion_tokens);
  let total = num(d.total_tokens);
  if (total === undefined && (input !== undefined || output !== undefined)) {
    total = (input ?? 0) + (output ?? 0);
  }
  const cost = num(d.total_cost_usd) ?? num(d.cost_usd);
  const backend = typeof d.backend === "string" ? d.backend : undefined;
  const model = typeof d.model === "string" ? d.model : undefined;
  if (input === undefined && output === undefined && total === undefined && cost === undefined) return undefined;
  const u: JobUsage = {};
  if (input !== undefined) u.input_tokens = input;
  if (output !== undefined) u.output_tokens = output;
  if (total !== undefined) u.total_tokens = total;
  if (cost !== undefined) u.cost_usd = cost;
  if (backend) u.backend = backend;
  if (model) u.model = model;
  return u;
}

/**
 * Normalize usage out of an arbitrary payload (parsed result_metadata,
 * parsed JSON result, or an already-canonical `{usage}` record).
 * Returns a canonical JobUsage or undefined — never fabricates zeros.
 */
export function extractUsage(payload: unknown): JobUsage | undefined {
  if (payload == null || typeof payload !== "object" || Array.isArray(payload)) return undefined;
  const d = payload as Record<string, unknown>;
  // Canonical first — an explicit `usage` block wins over nested variants.
  for (const key of ["usage", "session_usage", "token_usage"]) {
    const u = readDict(d[key] as Record<string, unknown>);
    if (u) return u;
  }
  // Flat shape: the payload itself carries token keys.
  return readDict(d);
}

/** JSON-parse a stored result string, tolerating non-JSON free text. */
export function parseResultJson(result: unknown): Record<string, unknown> | undefined {
  if (typeof result !== "string") return undefined;
  const t = result.trim();
  if (!t.startsWith("{")) return undefined;
  try {
    const v = JSON.parse(t);
    return v && typeof v === "object" && !Array.isArray(v) ? v : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Merge normalized usage into a result_metadata object (parsed dict).
 * Returns a new object with `usage` set when found; otherwise the input
 * unchanged (or undefined when nothing was there to begin with).
 */
export function withUsage(metadata: Record<string, unknown> | undefined, ...payloads: unknown[]): Record<string, unknown> | undefined {
  if (metadata?.usage && typeof metadata.usage === "object") {
    const existing = readDict(metadata.usage as Record<string, unknown>);
    if (existing) return metadata;
  }
  for (const p of payloads) {
    const u = extractUsage(p);
    if (u) return { ...(metadata ?? {}), usage: u };
  }
  return metadata;
}

export interface TaskUsage {
  jobs_with_usage: number;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  cost_usd: number | null;
  models: string[];
}

/** Sum usage across a task's jobs. cost_usd is null unless at least one job was priced. */
export function sumUsage(usages: (JobUsage | undefined)[]): TaskUsage {
  const out: TaskUsage = { jobs_with_usage: 0, input_tokens: 0, output_tokens: 0, total_tokens: 0, cost_usd: null, models: [] };
  const models = new Set<string>();
  for (const u of usages) {
    if (!u) continue;
    out.jobs_with_usage++;
    out.input_tokens += u.input_tokens ?? 0;
    out.output_tokens += u.output_tokens ?? 0;
    out.total_tokens += u.total_tokens ?? (u.input_tokens ?? 0) + (u.output_tokens ?? 0);
    if (u.cost_usd !== undefined) out.cost_usd = (out.cost_usd ?? 0) + u.cost_usd;
    if (u.model) models.add(u.model);
  }
  out.models = [...models].sort();
  return out;
}
