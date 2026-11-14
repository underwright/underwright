// Programmatic SDLC (gh-56): task.status as an enforced state machine.
//
// The stored statuses stay the five the schema knows. The SDLC phases map
// onto them:
//   backlog/triage(DoR)/design/ready -> open     (DoR gates the exit)
//   claimed/implementing             -> claimed
//   reviewing                        -> in_review
//   verifying                        -> the evidence gate on the way to done
//   done                             -> done
//
// A policy `lifecycle` block turns enforcement on. Without it the store keeps
// its legacy, permissive behaviour, so hermetic tests and old deployments are
// unaffected. Pure module: no store, no I/O.

import type { Policy } from "./policy.js";
import type { TaskStatus } from "./istore.js";

/** Phases a task type must pass through. Missing keys fall back to defaults. */
export interface PipelineRule {
  /** A design (or spec) artifact must exist before reviewing/done. */
  design?: boolean;
  /** Completion must come from in_review: the task went through reviewing. */
  review?: boolean;
  /** Completion needs passing verification evidence (test_run, ci_check, smoke_test, contract_test or deploy; exit 0 or unset). */
  verify?: boolean;
  /** A failing test_run (the reproduction) must be on record before done. */
  reproduction?: boolean;
}

export interface LifecycleRule {
  enabled?: boolean;
  /** Estimates that force the design phase regardless of type. Default ["L"]. */
  design_estimates?: string[];
  pipelines?: Record<string, PipelineRule>;
}

export interface LifecyclePolicy {
  enabled: boolean;
  design_estimates: string[];
  pipelines: Record<string, PipelineRule>;
}

/** Built-in per-type pipelines: docs skips verifying, architecture requires
 *  design, bug requires reproduction evidence. Policy entries override. */
export const DEFAULT_PIPELINES: Record<string, Required<PipelineRule>> = {
  default: { design: false, review: false, verify: true, reproduction: false },
  feature: { design: false, review: false, verify: true, reproduction: false },
  bug: { design: false, review: false, verify: true, reproduction: true },
  architecture: { design: true, review: false, verify: false, reproduction: false },
  docs: { design: false, review: false, verify: false, reproduction: false },
  review: { design: false, review: false, verify: false, reproduction: false },
  triage: { design: false, review: false, verify: false, reproduction: false },
  retro: { design: false, review: false, verify: false, reproduction: false },
};

/** Evidence kinds that count as verification. */
const VERIFY_KINDS = new Set(["test_run", "ci_check", "smoke_test", "contract_test", "deploy"]);

/** Legal edges. Anything else is rejected while the lifecycle is enabled.
 *  `open` is reachable from everywhere (release, unblock, reopen, sync). */
export const TRANSITIONS: Record<TaskStatus, readonly TaskStatus[]> = {
  open: ["claimed", "blocked", "done"],
  claimed: ["claimed", "in_review", "open", "blocked", "done"],
  in_review: ["claimed", "open", "blocked", "done"],
  blocked: ["open", "done"],
  done: ["open"],
};

export function getLifecyclePolicy(policy: Policy): LifecyclePolicy {
  const raw = (policy as { lifecycle?: LifecycleRule }).lifecycle;
  if (!raw || typeof raw !== "object") return { enabled: false, design_estimates: ["L"], pipelines: {} };
  return {
    enabled: raw.enabled !== false,
    design_estimates: Array.isArray(raw.design_estimates) ? raw.design_estimates.map(String) : ["L"],
    pipelines: raw.pipelines && typeof raw.pipelines === "object" ? raw.pipelines : {},
  };
}

export function pipelineFor(type: string | null | undefined, lc: LifecyclePolicy): Required<PipelineRule> {
  const t = type || "default";
  const base = DEFAULT_PIPELINES[t] ?? DEFAULT_PIPELINES.default;
  const over = lc.pipelines[t] ?? (DEFAULT_PIPELINES[t] ? {} : lc.pipelines.default) ?? {};
  return { ...base, ...over };
}

interface Ctx {
  task: { id: string; type?: string | null; estimate?: string | null; status: TaskStatus };
  evidence?: { kind: string; exit_code?: number | null }[];
  artifacts?: { kind: string }[];
}

function needsDesign(ctx: Ctx, lc: LifecyclePolicy, p: Required<PipelineRule>) {
  return p.design || (!!ctx.task.estimate && lc.design_estimates.includes(ctx.task.estimate));
}

function designMissing(ctx: Ctx, lc: LifecyclePolicy, p: Required<PipelineRule>): string | null {
  if (!needsDesign(ctx, lc, p)) return null;
  const has = (ctx.artifacts ?? []).some((a) => a.kind === "design" || a.kind === "spec");
  return has ? null : "design phase incomplete: post a design or spec artifact first";
}

/** Gate for any status change. `via` names the store operation so the
 *  message points the agent at the right tool. Returns an error or null. */
export function checkTransition(
  ctx: Ctx,
  to: TaskStatus,
  via: "claim" | "complete" | "status",
  lc: LifecyclePolicy,
): string | null {
  if (!lc.enabled) return null;
  const from = ctx.task.status;
  const id = ctx.task.id;
  if (!TRANSITIONS[from]?.includes(to)) {
    return `illegal transition for ${id}: ${from} → ${to}`;
  }
  const p = pipelineFor(ctx.task.type, lc);

  if (to === "claimed" && via !== "claim") {
    return `illegal transition for ${id}: use claim_task to enter claimed (DoR gate)`;
  }
  if (to === "open" && from === "claimed" && via === "status") {
    return `illegal transition for ${id}: use release_task to give up a claim`;
  }
  if (to === "in_review") {
    return designMissing(ctx, lc, p);
  }
  if (to === "done" && via === "complete") {
    if (from === "open" || from === "blocked") {
      return `illegal transition for ${id}: cannot complete from '${from}' — claim_task first`;
    }
    const design = designMissing(ctx, lc, p);
    if (design) return design;
    if (p.review && from !== "in_review") {
      return `reviewing phase required for ${ctx.task.type ?? "default"}: set_task_status in_review before completing`;
    }
    const ev = ctx.evidence ?? [];
    if (p.reproduction && !ev.some((e) => e.kind === "test_run" && e.exit_code != null && e.exit_code !== 0)) {
      return "reproduction evidence required: report a failing test_run that reproduces the bug";
    }
    if (p.verify && !ev.some(isPassingVerification)) {
      return "verifying phase incomplete: report passing test_run, ci_check, smoke_test, contract_test or deploy evidence";
    }
  }
  return null;
}

function isPassingVerification(e: { kind: string; exit_code?: number | null }) {
  if (!VERIFY_KINDS.has(e.kind)) return false;
  return e.exit_code == null || e.exit_code === 0;
}
