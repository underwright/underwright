import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { parseCoverage, checkCoverage, type CoverageRequirement, type CoverageSummary } from "./coverage.js";

// Definition-of-Done policy: per task-type requirements evaluated at completion.
// Enforcement is progressive: "observe" and "warn" annotate results; "block" refuses.

export interface DodRule {
  evidence?: string[];   // required evidence kinds
  artifacts?: string[];  // required artifact kinds
  tdd?: boolean;         // require failing test_run before passing one
  min_coverage?: CoverageRequirement;  // number = line %, or per-metric thresholds
}

export interface AutoMergeRule {
  enabled?: boolean;
  method?: "merge" | "squash" | "rebase";
  delete_branch?: boolean;
}

/** Micro-manager. Absent or enabled:false leaves complete/release unchanged. */
export interface DispatcherRule {
  enabled?: boolean;
  /** Completions by the agent plus their active claims. 0 or omitted means no cap. */
  max_tasks_per_agent?: number;
  /** How long a "your next task" message may sit while that task is unclaimed. */
  idle_minutes?: number;
}

export interface DispatcherPolicy {
  enabled: boolean;
  max_tasks_per_agent: number;
  idle_minutes: number;
}

export type HumanNotifyEventKind = "task_completed" | "claim_reclaimed";

/** Preferred launch configuration for agent jobs, from the policy harness_matrix. */
export interface HarnessBackend {
  harness?: string;                 // e.g. "codex", "claude-sdk"
  backend?: "raw" | "omnigent";
  server?: string;                  // remote omnigent server URL
}

/** Full harness matrix: per-agent launch preferences plus the omnigent coverage table. */
export interface HarnessMatrix {
  /** agent_id (or "*") -> preferred harness+backend. */
  agents: Record<string, HarnessBackend>;
  /** harness -> runnable through omnigent today; missing or false means raw-only. */
  coverage: Record<string, boolean>;
}

/** Policy harness_matrix block: agent_id (or "*") entries plus a "coverage" table. */
export type HarnessMatrixRule = {
  coverage?: Record<string, boolean | { omni?: boolean }>;
} & {
  [agentId: string]: HarnessBackend | Record<string, boolean | { omni?: boolean }> | undefined;
};

export interface HumanNotifyRule {
  enabled?: boolean;
  webhook_url?: string;
  url?: string;
  events?: string[];
}

export interface HumanNotifyPolicy {
  enabled: boolean;
  webhook_url: string | null;
  events: HumanNotifyEventKind[];
}

/** Per-agent launch preferences plus the omnigent coverage table. Agent entries
 *  map agent_id (or "*") to a preferred harness+backend; the "coverage" table
 *  records which harnesses omnigent can drive today. */
export interface Policy {
  dod: Record<string, DodRule>;
  enforcement: "observe" | "warn" | "block";
  templates?: TaskTemplate[];
  automerge?: boolean | string[] | Record<string, boolean | AutoMergeRule>;
  dispatcher?: DispatcherRule;
  human_notify?: string | HumanNotifyRule;
  "human-notify"?: string | HumanNotifyRule;
  notifications?: string | HumanNotifyRule;
  notify?: string | HumanNotifyRule;
  webhook_url?: string;
  /** Per-agent preferred harness+backend for agent jobs, plus the omnigent
   *  coverage table. Exact agent_id wins over "*". */
  harness_matrix?: HarnessMatrixRule;
}

const DEFAULT_POLICY: Policy = { dod: {}, enforcement: "observe" };

export function getAutoMergePolicy(
  repo: string,
  policy: Policy = loadPolicy()
): { enabled: boolean; method: "merge" | "squash" | "rebase"; delete_branch: boolean } {
  const def = { enabled: false, method: "merge" as const, delete_branch: false };
  const am = policy.automerge;
  if (!am) return def;
  if (am === true) return { ...def, enabled: true };
  if (Array.isArray(am)) {
    return { ...def, enabled: am.includes(repo) || am.includes("*") };
  }
  if (typeof am === "object") {
    const entry = am[repo] ?? am["*"];
    if (entry === true) return { ...def, enabled: true };
    if (entry && typeof entry === "object") {
      return {
        enabled: entry.enabled ?? true,
        method: entry.method ?? "merge",
        delete_branch: entry.delete_branch ?? false,
      };
    }
  }
  return def;
}

/** Missing block stays off so callers that ship no policy do not auto-assign. */
export function getDispatcherPolicy(policy: Policy = loadPolicy()): DispatcherPolicy {
  const raw = policy.dispatcher;
  if (!raw || typeof raw !== "object") {
    return { enabled: false, max_tasks_per_agent: 0, idle_minutes: 15 };
  }
  const max = Number(raw.max_tasks_per_agent);
  const idle = Number(raw.idle_minutes);
  return {
    enabled: raw.enabled === true,
    max_tasks_per_agent: Number.isFinite(max) && max > 0 ? Math.floor(max) : 0,
    idle_minutes: Number.isFinite(idle) && idle >= 0 ? Math.floor(idle) : 15,
  };
}

/** Parse the policy harness_matrix into agents + coverage. Agent preferences
 *  may be namespaced under "agents" or listed flat by agent_id (or "*");
 *  the reserved "coverage" key holds the per-harness omnigent support table
 *  (true/false or { "omni": bool }). Malformed blocks yield empty maps. */
export function getHarnessMatrix(policy: Policy = loadPolicy()): HarnessMatrix {
  const agents: Record<string, HarnessBackend> = {};
  const coverage: Record<string, boolean> = {};
  const raw = policy.harness_matrix;
  if (raw && typeof raw === "object") {
    for (const source of [raw.agents, raw]) {
      if (!source || typeof source !== "object") continue;
      for (const [key, value] of Object.entries(source)) {
        if (key === "agents" || key === "coverage") continue;
        if (value && typeof value === "object" && !("omni" in value) && !(key in agents)) {
          agents[key] = value as HarnessBackend;
        }
      }
    }
    const table = raw.coverage;
    if (table && typeof table === "object") {
      for (const [harness, value] of Object.entries(table)) {
        coverage[harness] = typeof value === "boolean" ? value : value?.omni === true;
      }
    }
  }
  return { agents, coverage };
}

/** Preferred harness+backend for an agent job. Exact agent_id wins over "*";
 *  absent or malformed matrix yields {} (the runner then uses raw defaults). */
export function getHarnessBackend(agentId: string, policy: Policy = loadPolicy()): HarnessBackend {
  const { agents } = getHarnessMatrix(policy);
  return agents[agentId] ?? agents["*"] ?? {};
}

const DEFAULT_NOTIFY_EVENTS: HumanNotifyEventKind[] = ["task_completed", "claim_reclaimed"];

function normalizeNotifyEvent(raw: string): HumanNotifyEventKind | null {
  const v = raw.trim().toLowerCase();
  if (v === "task_completed" || v === "completed" || v === "task.completed" || v === "task-completed") {
    return "task_completed";
  }
  if (
    v === "claim_reclaimed" ||
    v === "claim-reclaimed" ||
    v === "reclaimed" ||
    v === "lease_expired" ||
    v === "claim.reclaimed"
  ) {
    return "claim_reclaimed";
  }
  return null;
}

/** Optional human webhook notifications on task completed / claim-reclaimed events. */
export function getHumanNotifyPolicy(policy: Policy = loadPolicy()): HumanNotifyPolicy {
  const raw =
    policy.human_notify ??
    policy["human-notify"] ??
    policy.notifications ??
    policy.notify ??
    policy.webhook_url;
  if (!raw) {
    return { enabled: false, webhook_url: null, events: [...DEFAULT_NOTIFY_EVENTS] };
  }
  if (typeof raw === "string") {
    const url = raw.trim();
    return {
      enabled: url.length > 0,
      webhook_url: url || null,
      events: [...DEFAULT_NOTIFY_EVENTS],
    };
  }
  if (typeof raw === "object") {
    const url = (
      typeof raw.webhook_url === "string"
        ? raw.webhook_url
        : typeof raw.url === "string"
          ? raw.url
          : ""
    ).trim();
    const events = Array.isArray(raw.events)
      ? [...new Set(raw.events.map((e) => normalizeNotifyEvent(String(e))).filter((e): e is HumanNotifyEventKind => !!e))]
      : [...DEFAULT_NOTIFY_EVENTS];
    return {
      enabled: (raw.enabled ?? true) && url.length > 0 && events.length > 0,
      webhook_url: url || null,
      events,
    };
  }
  return { enabled: false, webhook_url: null, events: [...DEFAULT_NOTIFY_EVENTS] };
}

export const getNotifyPolicy = getHumanNotifyPolicy;

export function loadPolicy(path?: string): Policy {
  const p = path ?? process.env.UNDERWRIGHT_POLICY ?? resolve(process.cwd(), "underwright.policy.json");
  if (!p || !existsSync(p)) return DEFAULT_POLICY;
  const parsed = JSON.parse(readFileSync(p, "utf8"));
  return {
    ...parsed,
    dod: parsed.dod ?? {},
    enforcement: parsed.enforcement ?? "warn",
  };
}

/** Definition of Ready — mirror of DoD at intake. Policy "dor" block lists
 *  required fields; empty/missing values fail the gate. */
export interface DorRule {
  require_ac_ids?: boolean;
  require_estimate?: boolean;
  require_type?: boolean;
  require_description?: boolean;
}

export function evaluateDoR(task: any, policy: Policy) {
  const rule = (policy as any).dor as DorRule | undefined;
  if (!rule) return { ready: true, missing: [] as string[] };
  const missing: string[] = [];
  if (rule.require_type && !task.type) missing.push("type unset");
  if (rule.require_description && !task.description) missing.push("no description");
  if (rule.require_ac_ids && !(task.ac_ids as string[]).length) missing.push("no acceptance criteria (ac_ids)");
  if (rule.require_estimate && !task.estimate) missing.push("no effort estimate (S|M|L)");
  return { ready: missing.length === 0, missing };
}

export function evaluateDoD(args: {
  task: any;
  evidence: any[];
  artifacts: any[];
  claimAgent?: string | null;
  policy: Policy;
}) {
  const { task, evidence, artifacts, claimAgent, policy } = args;
  const rule = policy.dod[task.type] ?? policy.dod["default"] ?? {};
  const missing: string[] = [];
  const warnings: string[] = [];

  const kinds = new Set(evidence.map((e) => e.kind));
  for (const k of rule.evidence ?? []) {
    if (!kinds.has(k)) missing.push(`missing evidence kind: ${k}`);
  }

  // Numeric coverage floor: the latest coverage report must meet the threshold.
  if (rule.min_coverage !== undefined) {
    const summaries = evidence
      .filter((e) => e.kind === "coverage")
      .map((e) => (e.coverage as CoverageSummary | undefined) ?? parseCoverage(String(e.output ?? "")))
      .filter((s): s is CoverageSummary => !!s);
    if (!summaries.length) {
      missing.push("missing parseable coverage evidence for min_coverage");
    } else {
      missing.push(...checkCoverage(summaries[summaries.length - 1], rule.min_coverage));
    }
  }

  const artKinds = new Set(artifacts.map((a) => a.kind));
  for (const k of rule.artifacts ?? []) {
    if (!artKinds.has(k)) missing.push(`missing artifact kind: ${k}`);
  }

  // Independent review: review evidence must not come from the claim holder.
  if ((rule.evidence ?? []).includes("review") && claimAgent) {
    const independent = evidence.some((e) => e.kind === "review" && e.agent_id !== claimAgent);
    if (kinds.has("review") && !independent) {
      missing.push("review must come from an agent other than the claim holder");
    }
  }

  // TDD ordering: a failing test_run must precede the passing one.
  if (rule.tdd) {
    const runs = evidence.filter((e) => e.kind === "test_run").map((e) => e.created_at);
    const fails = evidence.filter((e) => e.kind === "test_run" && e.exit_code !== 0);
    const passes = evidence.filter((e) => e.kind === "test_run" && e.exit_code === 0);
    if (!fails.length || !passes.length) {
      missing.push("tdd requires a failing and a passing test_run");
    } else if (Math.min(...passes.map((e: any) => Date.parse(e.created_at))) <
               Math.max(...fails.map((e: any) => Date.parse(e.created_at)))) {
      missing.push("tdd ordering violated: passing test precedes a failing one");
    }
  }

  const ok = missing.length === 0;
  if (!ok && policy.enforcement === "observe") warnings.push(...missing);
  return { ok: ok || policy.enforcement !== "block", blocked: !ok && policy.enforcement === "block", missing, warnings };
}

// Task templates: PRD/spec/scaffold prompts that seed a task's structure —
// AC scaffold, type, and the DoR checklist the triager must fill. Builtins
// cover the common shapes; a policy `templates` array adds or overrides by id.

export interface TaskTemplate {
  id: string;
  type?: string;
  description?: string;       // PRD/spec scaffold (markdown)
  ac_ids?: string[];          // acceptance-criteria scaffold ids
  dor_checklist?: string[];   // DoR items the triager completes before claiming
  prompt?: string;            // scaffold prompt for the agent picking the task up
}

export const BUILTIN_TEMPLATES: TaskTemplate[] = [
  {
    id: "feature",
    type: "feature",
    description: "## Problem\n\n\n## Proposed change\n\n\n## Out of scope\n",
    ac_ids: ["scope", "tests", "review"],
    dor_checklist: ["Problem statement is specific and bounded", "Acceptance criteria are testable", "Out-of-scope is explicit"],
  },
  {
    id: "bug",
    type: "bug",
    description: "## Steps to reproduce\n\n\n## Expected\n\n\n## Actual\n",
    ac_ids: ["repro", "fix", "regression"],
    dor_checklist: ["Reproduction is minimal and deterministic", "Expected vs actual stated", "Regression test identified"],
  },
  {
    id: "architecture",
    type: "architecture",
    description: "## Context\n\n\n## Decision\n\n\n## Consequences\n",
    ac_ids: ["context", "decision", "review"],
    dor_checklist: ["Forces and constraints listed", "Options considered with trade-offs", "Decision and consequences recorded"],
  },
  {
    id: "tdd",
    type: "tdd",
    description: "## Behaviour to implement\n",
    ac_ids: ["red", "green", "refactor"],
    dor_checklist: ["A failing test can be written first", "Success is observable", "Refactor target identified"],
  },
];

/** Builtin templates overlaid by policy-defined ones (policy wins on id). */
export function listTemplates(policy: Policy): TaskTemplate[] {
  const byId = new Map<string, TaskTemplate>();
  for (const t of BUILTIN_TEMPLATES) byId.set(t.id, t);
  for (const t of policy.templates ?? []) if (t?.id) byId.set(t.id, t);
  return [...byId.values()];
}

export function getTemplate(id: string, policy: Policy): TaskTemplate | undefined {
  return listTemplates(policy).find((t) => t.id === id);
}

export interface TemplateSeedArgs {
  template?: string;
  description?: string;
  ac_ids?: string[];
  type?: string;
}

/** Expand a named template into the task fields it seeds. Caller-supplied
 *  values win: an explicit ac_ids list or type is never overwritten. */
export function expandTemplate<T extends TemplateSeedArgs>(args: T, policy: Policy): { args: T; error?: string } {
  if (!args.template) return { args };
  const t = getTemplate(args.template, policy);
  if (!t) return { args, error: `unknown template: ${args.template}` };

  const parts: string[] = [];
  if (args.description) parts.push(args.description);
  if (t.description) parts.push(t.description.trimEnd());
  if (t.dor_checklist?.length) {
    parts.push(["## Definition of Ready", ...t.dor_checklist.map((c) => `- [ ] ${c}`)].join("\n"));
  }
  if (t.prompt) parts.push(`> ${t.prompt}`);

  return {
    args: {
      ...args,
      type: args.type ?? t.type,
      ac_ids: args.ac_ids?.length ? args.ac_ids : [...(t.ac_ids ?? [])],
      description: parts.join("\n\n"),
    },
    error: undefined,
  };
}
