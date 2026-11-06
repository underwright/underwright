import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

// Definition-of-Done policy: per task-type requirements evaluated at completion.
// Enforcement is progressive: "observe" and "warn" annotate results; "block" refuses.

export interface DodRule {
  evidence?: string[];   // required evidence kinds
  artifacts?: string[];  // required artifact kinds
  tdd?: boolean;         // require failing test_run before passing one
}

export interface AutoMergeRule {
  enabled?: boolean;
  method?: "merge" | "squash" | "rebase";
  delete_branch?: boolean;
}

export interface Policy {
  dod: Record<string, DodRule>;
  enforcement: "observe" | "warn" | "block";
  templates?: TaskTemplate[];
  automerge?: boolean | string[] | Record<string, boolean | AutoMergeRule>;
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
