import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

// Definition-of-Done policy: per task-type requirements evaluated at completion.
// Enforcement is progressive: "observe" and "warn" annotate results; "block" refuses.

export interface DodRule {
  evidence?: string[];   // required evidence kinds
  artifacts?: string[];  // required artifact kinds
  tdd?: boolean;         // require failing test_run before passing one
}

export interface Policy {
  dod: Record<string, DodRule>;
  enforcement: "observe" | "warn" | "block";
}

const DEFAULT_POLICY: Policy = { dod: {}, enforcement: "observe" };

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
