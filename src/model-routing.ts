// Model-complexity routing (gh-54): match model tier to task difficulty.
// Pure decisions plus one watch pass. The tier map and per-harness model names
// are policy data (`model_routing`), never code: estimate:S / docs go light,
// architecture / design review / L go heavy, the rest standard.
import { harnessOf } from "./dispatcher.js";
import type { AgentJobSpec, SubmitJobArgs } from "./istore.js";
import type { ModelRoutingRule, Policy } from "./policy.js";

export type { ModelRoutingRule };

/** The store surface the escalation pass needs (SqliteStore satisfies it). */
export interface ModelEscalationStore {
  modelEscalationCandidates(): { id: string; task_id: string; content: string }[];
  latestAgentSpec(taskId: string): string | null;
  submitJob(args: SubmitJobArgs, policy?: Policy): unknown;
  sendMessage(to: string, from: string, body: string, taskId?: string): unknown;
  log(entityType: string, entityId: string, action: string, actor: string, data?: unknown): unknown;
}

export const MODEL_TIERS = ["light", "standard", "heavy"] as const;
export type ModelTier = (typeof MODEL_TIERS)[number];

/** One policy rule. Every present field must match; first matching rule wins. */
export interface ModelRule {
  tier: ModelTier;
  estimate?: string[];
  type?: string[];
  review_kind?: string[];
  /** Matches when the task declares at least this many acceptance criteria. */
  min_ac?: number;
  /** Repo area: globs matched against the task's ownership.paths (any hit). */
  paths?: string[];
}

export interface ModelRouting {
  enabled: boolean;
  default_tier: ModelTier;
  rules: ModelRule[];
  models: Record<string, Partial<Record<ModelTier, string>>>;
  flags: Record<string, string>;
}

/** Used when the policy enables routing but lists no rules. */
export const DEFAULT_MODEL_RULES: readonly ModelRule[] = [
  { type: ["architecture", "design"], tier: "heavy" },
  { review_kind: ["design"], tier: "heavy" },
  { estimate: ["L"], tier: "heavy" },
  { min_ac: 6, tier: "heavy" },
  { estimate: ["S"], tier: "light" },
  { type: ["docs"], tier: "light" },
];

/** CLI flag that selects the model, per harness. Unknown harnesses get no flag. */
export const MODEL_FLAGS: Readonly<Record<string, string>> = {
  claude: "--model",
  "claude-sdk": "--model",
  codex: "-m",
  opencode: "-m",
  kimi: "--model",
};

const isTier = (v: unknown): v is ModelTier => (MODEL_TIERS as readonly unknown[]).includes(v);
const strList = (v: unknown) => Array.isArray(v) ? v.map(String).map((s) => s.trim()).filter(Boolean) : undefined;

function parseRule(raw: unknown): ModelRule | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (!isTier(r.tier)) return null;
  const rule: ModelRule = { tier: r.tier };
  const estimate = strList(r.estimate); if (estimate) rule.estimate = estimate.map((e) => e.toUpperCase());
  const type = strList(r.type); if (type) rule.type = type.map((t) => t.toLowerCase());
  const kind = strList(r.review_kind); if (kind) rule.review_kind = kind.map((k) => k.toLowerCase());
  const paths = strList(r.paths); if (paths) rule.paths = paths;
  const min = Number(r.min_ac); if (r.min_ac !== undefined && Number.isFinite(min) && min > 0) rule.min_ac = Math.floor(min);
  return rule;
}

/** Read and validate `model_routing`. Missing or enabled:false turns routing off. */
export function getModelRouting(policy: Pick<Policy, "model_routing">): ModelRouting {
  const raw = policy.model_routing;
  if (!raw || typeof raw !== "object" || raw.enabled === false) {
    return { enabled: false, default_tier: "standard", rules: [...DEFAULT_MODEL_RULES], models: {}, flags: {} };
  }
  const rules = Array.isArray(raw.rules)
    ? raw.rules.map(parseRule).filter((r): r is ModelRule => r !== null)
    : [...DEFAULT_MODEL_RULES];
  const models: ModelRouting["models"] = {};
  for (const [h, table] of Object.entries(raw.models ?? {})) {
    if (!table || typeof table !== "object") continue;
    const clean: Partial<Record<ModelTier, string>> = {};
    for (const t of MODEL_TIERS) if (typeof table[t] === "string" && table[t]!.trim()) clean[t] = table[t]!.trim();
    models[h.trim().toLowerCase()] = clean;
  }
  const flags: Record<string, string> = {};
  for (const [h, f] of Object.entries(raw.flags ?? {})) if (typeof f === "string" && f.trim()) flags[h.trim().toLowerCase()] = f.trim();
  return { enabled: true, default_tier: isTier(raw.default_tier) ? raw.default_tier : "standard", rules, models, flags };
}

/** Minimal glob: `**` any path, `*` within a segment. Plain paths match exactly or as a prefix dir. */
function globMatch(glob: string, path: string): boolean {
  if (!/[*?]/.test(glob)) return path === glob || path.startsWith(glob.endsWith("/") ? glob : `${glob}/`);
  const re = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*\/?/g, "\u0000").replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]").replace(/\u0000/g, ".*");
  return new RegExp(`^${re}$`).test(path);
}

export interface TaskSignals {
  estimate?: string | null;
  type?: string | null;
  review_kind?: string | null;
  ac_ids?: string[] | string | null;
  ownership?: { paths?: string[] } | string | null;
}

function acCount(ac: TaskSignals["ac_ids"]): number {
  if (Array.isArray(ac)) return ac.length;
  if (typeof ac === "string") { try { const v = JSON.parse(ac); return Array.isArray(v) ? v.length : 0; } catch { return 0; } }
  return 0;
}

function ownedPaths(o: TaskSignals["ownership"]): string[] {
  const v = typeof o === "string" ? (() => { try { return JSON.parse(o); } catch { return null; } })() : o;
  return Array.isArray(v?.paths) ? v.paths.map(String) : [];
}

/** Tier for a task from its signals: first matching rule, else the default tier. */
export function classifyTask(task: TaskSignals, routing: ModelRouting): { tier: ModelTier; reason: string } {
  const estimate = String(task.estimate ?? "").toUpperCase();
  const type = String(task.type ?? "").toLowerCase();
  const kind = String(task.review_kind ?? "").toLowerCase();
  const acs = acCount(task.ac_ids);
  const paths = ownedPaths(task.ownership);
  for (const r of routing.rules) {
    const why: string[] = [];
    if (r.estimate) { if (!r.estimate.includes(estimate)) continue; why.push(`estimate ${estimate}`); }
    if (r.type) { if (!r.type.includes(type)) continue; why.push(`type ${type}`); }
    if (r.review_kind) { if (!r.review_kind.includes(kind)) continue; why.push(`review_kind ${kind}`); }
    if (r.min_ac !== undefined) { if (acs < r.min_ac) continue; why.push(`${acs} ACs >= ${r.min_ac}`); }
    if (r.paths) {
      const hit = paths.find((p) => r.paths!.some((g) => globMatch(g, p)));
      if (!hit) continue;
      why.push(`paths ${hit}`);
    }
    if (!why.length) continue; // an empty rule would match everything; treat as malformed
    return { tier: r.tier, reason: why.join(", ") };
  }
  return { tier: routing.default_tier, reason: "default" };
}

export function nextTier(tier: ModelTier): ModelTier | null {
  const i = MODEL_TIERS.indexOf(tier);
  return i >= 0 && i < MODEL_TIERS.length - 1 ? MODEL_TIERS[i + 1] : null;
}

/** Model name for a harness at a tier: exact harness, then family (`claude-sdk` → `claude`). */
export function resolveModel(harness: string, tier: ModelTier | undefined | null, routing: ModelRouting): string | undefined {
  if (!tier) return undefined;
  const h = harness.trim().toLowerCase();
  return routing.models[h]?.[tier] ?? routing.models[harnessOf(h)]?.[tier];
}

/** CLI flag selecting the model for a raw harness launch; null when the CLI has none we know. */
export function modelFlag(harness: string, routing?: ModelRouting): string | null {
  const h = harness.trim().toLowerCase();
  return routing?.flags[h] ?? routing?.flags[harnessOf(h)] ?? MODEL_FLAGS[h] ?? MODEL_FLAGS[harnessOf(h)] ?? null;
}

/** Insert `flag model` after leading subcommand words (`exec`), unless a model flag is already present. */
export function withModelArgs(args: string[], flag: string, model: string): string[] {
  const set = args.some((a) => a === flag || a === "--model" || a === "-m" || a.startsWith("--model="));
  if (set) return args;
  let at = args.findIndex((a) => a.startsWith("-") || a === "{{prompt}}");
  if (at < 0) at = args.length;
  return [...args.slice(0, at), flag, model, ...args.slice(at)];
}

/** Stamp the routed tier on an agent spec. Explicit model / model_tier win; off → unchanged. */
export function routeAgentSpec(spec: AgentJobSpec, task: TaskSignals | null | undefined, policy: Pick<Policy, "model_routing">): AgentJobSpec {
  if (spec.model || spec.model_tier || !task) return spec;
  const routing = getModelRouting(policy);
  if (!routing.enabled) return spec;
  return { ...spec, model_tier: classifyTask(task, routing).tier };
}

// ------------------------------------------------------------ escalation path

const ESCALATION_MARKER = /\bneeds[-_ ]stronger[-_ ]model\b/i;

/** True when a blocked artifact asks for a heavier model (`needs-stronger-model`). */
export function isModelEscalation(text: string | null | undefined): boolean {
  return Boolean(text) && ESCALATION_MARKER.test(text!);
}

/** The spec one tier up (pinned model cleared so the runner re-resolves), or null at the top. */
export function escalatedSpec(spec: AgentJobSpec, routing: ModelRouting): { from: ModelTier; to: ModelTier; spec: AgentJobSpec } | null {
  const from = isTier(spec.model_tier) ? spec.model_tier : routing.default_tier;
  const to = nextTier(from);
  if (!to) return null;
  const { model: _pinned, ...rest } = spec;
  return { from, to, spec: { ...rest, model_tier: to } };
}

export interface ModelEscalationAction {
  task_id: string;
  artifact_id: string;
  action: "redispatched" | "escalated" | "no_job";
  from?: ModelTier;
  to?: ModelTier;
  job_id?: string;
}

export const MODEL_ESCALATION_AGENT = "model-router";

/**
 * Watch pass: each unhandled `blocked` artifact carrying `needs-stronger-model`
 * re-dispatches the task's latest agent job one tier heavier. At the heavy tier
 * (or with no agent job to copy) it messages the human instead of thrashing.
 * Idempotent per artifact via a `model_escalated` event.
 */
export function runModelEscalation(store: ModelEscalationStore, opts: { policy: Pick<Policy, "model_routing">; human?: string; agentId?: string }): ModelEscalationAction[] {
  const routing = getModelRouting(opts.policy);
  if (!routing.enabled) return [];
  const agentId = opts.agentId ?? MODEL_ESCALATION_AGENT;
  const human = opts.human ?? "human";
  const out: ModelEscalationAction[] = [];
  for (const art of store.modelEscalationCandidates()) {
    if (!isModelEscalation(art.content)) {
      store.log("artifact", art.id, "model_escalated", agentId, { task_id: art.task_id, action: "ignored" });
      continue;
    }
    const base = { task_id: art.task_id, artifact_id: art.id };
    const raw = store.latestAgentSpec(art.task_id);
    let spec: AgentJobSpec | null = null;
    try { spec = raw ? JSON.parse(raw) : null; } catch { spec = null; }
    if (!spec) {
      store.sendMessage(human, agentId, `${art.task_id}: agent asked for a stronger model (artifact ${art.id}) but no agent job exists to re-dispatch.`, art.task_id);
      store.log("artifact", art.id, "model_escalated", agentId, { ...base, action: "no_job" });
      out.push({ ...base, action: "no_job" });
      continue;
    }
    const up = escalatedSpec(spec, routing);
    if (!up) {
      store.sendMessage(human, agentId,
        `${art.task_id}: agent asked for a stronger model but the job already ran at the heaviest tier (heavy). Split the task or take it yourself. Artifact ${art.id}.`,
        art.task_id);
      store.log("artifact", art.id, "model_escalated", agentId, { ...base, action: "escalated" });
      out.push({ ...base, action: "escalated", from: "heavy" });
      continue;
    }
    const job = store.submitJob({ agent_id: agentId, task_id: art.task_id, type: "agent", agent: up.spec }, opts.policy as Policy) as { id?: string };
    store.log("artifact", art.id, "model_escalated", agentId, { ...base, action: "redispatched", from: up.from, to: up.to, job_id: job.id });
    store.log("task", art.task_id, "model_escalated", agentId, { from: up.from, to: up.to, job_id: job.id });
    out.push({ ...base, action: "redispatched", from: up.from, to: up.to, job_id: job.id });
  }
  return out;
}

// ------------------------------------------------------------------- metrics

export interface ModelJobRow { job_id?: string; task_id: string; estimate?: string | null; agent_spec?: string | null }
export interface TokenRow { task_id: string; output: string }

export interface TierLine { tasks: number; tokens_in: number; tokens_out: number; tokens_per_task: number; cost_usd: number }

function num(v: unknown): number { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : 0; }

/** Token counts from a cost/usage blob: JSON (tokens_in / input_tokens …) or `key=value` text. */
export function parseTokens(output: string): { tokens_in: number; tokens_out: number; cost_usd: number } | null {
  try {
    const v = JSON.parse(output);
    if (v && typeof v === "object") {
      const tin = num(v.tokens_in ?? v.input_tokens), tout = num(v.tokens_out ?? v.output_tokens);
      if (tin || tout || "tokens_in" in v || "input_tokens" in v) return { tokens_in: tin, tokens_out: tout, cost_usd: num(v.cost_usd) };
      return null;
    }
  } catch { /* fall through to key=value */ }
  const grab = (k: string) => num(output.match(new RegExp(`\\b${k}\\s*[=:]\\s*([0-9.]+)`))?.[1]);
  if (!/\b(tokens_in|input_tokens)\s*[=:]/.test(output)) return null;
  return { tokens_in: grab("tokens_in") || grab("input_tokens"), tokens_out: grab("tokens_out") || grab("output_tokens"), cost_usd: grab("cost_usd") };
}

/**
 * Tokens per task by model tier, and by tier × estimate (gh-54 metrics; closes the
 * loop with gh-44 cost evidence). A task's tier is its latest agent job's
 * model_tier (escalations land on the heavier tier); jobs without one are "unrouted".
 */
export function modelTierReport(jobs: ModelJobRow[], tokens: TokenRow[]): {
  by_tier: Record<string, TierLine>; by_tier_estimate: Record<string, TierLine>;
} {
  const taskTier = new Map<string, { tier: string; estimate: string }>();
  for (const j of jobs) {
    let spec: any = null;
    try { spec = j.agent_spec ? JSON.parse(j.agent_spec) : null; } catch { spec = null; }
    taskTier.set(j.task_id, { tier: isTier(spec?.model_tier) ? spec.model_tier : "unrouted", estimate: j.estimate || "?" });
  }
  const usage = new Map<string, { tokens_in: number; tokens_out: number; cost_usd: number }>();
  for (const r of tokens) {
    const t = parseTokens(r.output);
    if (!t || !taskTier.has(r.task_id)) continue;
    const u = usage.get(r.task_id) ?? { tokens_in: 0, tokens_out: 0, cost_usd: 0 };
    u.tokens_in += t.tokens_in; u.tokens_out += t.tokens_out; u.cost_usd += t.cost_usd;
    usage.set(r.task_id, u);
  }
  const by_tier: Record<string, TierLine> = {};
  const by_tier_estimate: Record<string, TierLine> = {};
  const add = (bag: Record<string, TierLine>, key: string, u: { tokens_in: number; tokens_out: number; cost_usd: number }) => {
    const l = bag[key] ?? (bag[key] = { tasks: 0, tokens_in: 0, tokens_out: 0, tokens_per_task: 0, cost_usd: 0 });
    l.tasks++; l.tokens_in += u.tokens_in; l.tokens_out += u.tokens_out; l.cost_usd += u.cost_usd;
  };
  for (const [taskId, { tier, estimate }] of taskTier) {
    const u = usage.get(taskId) ?? { tokens_in: 0, tokens_out: 0, cost_usd: 0 };
    add(by_tier, tier, u);
    add(by_tier_estimate, `${tier}:${estimate}`, u);
  }
  for (const l of [...Object.values(by_tier), ...Object.values(by_tier_estimate)]) {
    l.tokens_per_task = l.tasks ? Math.round((l.tokens_in + l.tokens_out) / l.tasks) : 0;
    l.cost_usd = Math.round(l.cost_usd * 1e6) / 1e6;
  }
  return { by_tier, by_tier_estimate };
}
