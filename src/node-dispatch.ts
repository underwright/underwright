// gh-126 pull-through dispatch: pure matching helpers shared by SqliteStore and
// PgStore. When a node polls and has no queued job, the control plane evaluates
// eligible board tasks against that node's live capabilities and forms a
// launch-agent job. Nodes stay dumb pullers; routing stays centralized here.
import { LAUNCH_PROMPT } from "./dispatcher.js";
import {
  getDispatchPolicy,
  getModelRouting,
  tierForTask,
  modelForHarness,
  loadPolicy,
} from "./policy.js";
import { nodeSpecAllowed, quotaAllows } from "./node-protocol.js";

export interface DispatchTask {
  id: string;
  title: string;
  type: string;
  estimate: string;
  ac_ids: string;
  spec_ref: string | null;
  review_kind?: string | null;
  priority: number;
  updated_at: string;
}

/** Why a task didn't match — kept coarse so callers can log/metric it. */
export type SkipReason = "no_workspace" | "claimed" | "blocked_deps" | "live_job" | "no_harness" | "recent_failure";

export interface DispatchMeta {
  eligible: number;
  considered: number;
  skipped: Partial<Record<SkipReason, number>>;
}

/** Flatten skip counters into telemetry attrs (skip_no_workspace: 2, …). */
export function matchAttrs(meta: DispatchMeta & { formed?: boolean }): Record<string, number | boolean> {
  const out: Record<string, number | boolean> = { eligible: meta.eligible, considered: meta.considered };
  for (const [k, v] of Object.entries(meta.skipped)) out[`skip_${k}`] = v as number;
  if (meta.formed !== undefined) out.formed = meta.formed;
  return out;
}

/** "owner/repo" from a GitHub spec_ref URL; null for non-URL refs. */
export function repoFromSpecRef(specRef: string | null | undefined): string | null {
  if (!specRef) return null;
  const m = specRef.match(/github\.com[:/]([\w.-]+\/[\w.-]+?)(?:\.git)?(?:\/|$)/);
  return m ? m[1] : null;
}

/** Resolve the workspace_id a task should run in for this policy. */
export function workspaceForTask(task: DispatchTask, workspaces: Record<string, string>, fallback: string): string {
  const repo = repoFromSpecRef(task.spec_ref);
  return (repo && workspaces[repo]) || fallback;
}

/** Overlay control-plane-observed provider exhaustion onto an attested
 *  capabilities doc. Quota is per-account — a provider observed exhausted by
 *  one node's job blocks it on every node until resets_at or a success. */
export function mergeObservedQuota(
  capabilitiesJson: string,
  observed: ReadonlyMap<string, { state?: string; resets_at?: string | null }>,
): string {
  if (!observed.size) return capabilitiesJson;
  try {
    const caps = JSON.parse(capabilitiesJson || "{}");
    if (!Array.isArray(caps.harnesses)) return capabilitiesJson;
    let changed = false;
    for (const h of caps.harnesses) {
      const o = h?.id ? observed.get(h.id) : undefined;
      if (o?.state === "exhausted") { h.quota = { state: "exhausted", ...(o.resets_at ? { resets_at: o.resets_at } : {}) }; changed = true; }
    }
    return changed ? JSON.stringify(caps) : capabilitiesJson;
  } catch { return capabilitiesJson; }
}

/** Node's launchable harnesses: attested, installed, auth ready, quota open,
 *  ordered by dispatch.harness_order then attestation order. When the node
 *  has an installed+ready harness blocked by quota and freeFallback names
 *  cheaper harnesses, those are promoted first — spend free capacity before
 *  draining another paid provider while quota is scarce. */
export function launchableHarnesses(capabilitiesJson: string, harnessOrder: string[], now = Date.now(), freeFallback: readonly string[] = []): string[] {
  let caps: { harnesses?: Array<{ id?: string; installed?: boolean; auth_status?: string; quota?: { state?: string; resets_at?: string } }> };
  try {
    caps = JSON.parse(capabilitiesJson || "{}");
  } catch {
    return [];
  }
  let quotaBlocked = false;
  const ready = (caps.harnesses ?? [])
    .filter(h => {
      if (!h?.id || !h.installed || h.auth_status !== "ready") return false;
      if (!quotaAllows(h.quota, now)) { quotaBlocked = true; return false; }
      return true;
    })
    .map(h => h.id as string);
  const ranked = harnessOrder.filter(h => ready.includes(h));
  const ordered = [...ranked, ...ready.filter(h => !ranked.includes(h))];
  if (quotaBlocked && freeFallback.length && ordered.some(h => freeFallback.includes(h)))
    return [...ordered.filter(h => freeFallback.includes(h)), ...ordered.filter(h => !freeFallback.includes(h))];
  return ordered;
}

export interface LaunchSpecInput {
  taskId: string;
  agentId: string;
  host: string;
  jobId: string;
  workspace: string;
  harness: string;
  model?: string;
  model_flag?: string;
  /** Repo-rubric text appended after the fleet prompt — the bar the
   *  implementer is held to on this repo (policy rubrics.<repo>.prompt). */
  promptExtra?: string;
}

/** Build the launch-agent node spec the executor consumes. */
export function buildLaunchSpec(input: LaunchSpecInput) {
  const prompt = LAUNCH_PROMPT
    .replaceAll("{{agent_id}}", input.agentId)
    .replaceAll("{{host}}", input.host)
    .replaceAll("{{task_id}}", input.taskId)
    .replaceAll("{{job_id}}", input.jobId)
    + (input.promptExtra ? ` ${input.promptExtra}` : "");
  return {
    version: 1 as const,
    kind: "launch-agent" as const,
    workspace_id: input.workspace,
    payload: {
      workspace_id: input.workspace,
      harness: input.harness,
      prompt,
      ...(input.model ? { model: input.model } : {}),
      ...(input.model_flag ? { model_flag: input.model_flag } : {}),
    },
  };
}

export interface DispatchMatch {
  task: DispatchTask;
  workspace: string;
  harness: string;
  agent_id: string;
  tier: string;
  model?: string;
  model_flag?: string;
}

/**
 * Evaluate one eligible task against a node. Returns the chosen placement —
 * caller generates the job id then calls buildLaunchSpec to fill the prompt —
 * or a skip reason. Pure: availability checks (claimed/blocked/live-job) are
 * the caller's queries.
 */
export function matchTaskToNode(
  task: DispatchTask,
  node: { name: string; policy: unknown; capabilitiesJson: string; capabilitiesObservedAt?: unknown },
  dispatch = getDispatchPolicy(),
  routing = getModelRouting(loadPolicy()),
  now = Date.now(),
  avoidHarnesses: ReadonlySet<string> = new Set(),
): { match: DispatchMatch } | { skip: SkipReason } {
  const workspace = workspaceForTask(task, dispatch.workspaces, dispatch.default_workspace);
  if (!workspace || !((node.policy as { workspace_ids?: string[] })?.workspace_ids ?? []).includes(workspace)) {
    return { skip: "no_workspace" };
  }
  const ready = launchableHarnesses(node.capabilitiesJson, dispatch.harness_order, now, dispatch.free_fallback)
    .filter(h => !avoidHarnesses.has(h));
  // Model args only ship to daemons that attest launch-model-flag — older
  // strict payload schemas reject unknown keys ("invalid task parameters").
  const modelFlagOk = (() => {
    try { return (JSON.parse(node.capabilitiesJson || "{}").features ?? []).includes("launch-model-flag"); }
    catch { return false; }
  })();
  const acCount = (() => {
    try { return (JSON.parse(task.ac_ids || "[]") as unknown[]).length; } catch { return 0; }
  })();
  const tier = tierForTask(
    { type: task.type, estimate: task.estimate, ac_count: acCount, review_kind: task.review_kind ?? undefined },
    routing,
  );
  for (const harness of ready) {
    const resolved = modelForHarness(routing, harness, tier);
    const { model, model_flag } = modelFlagOk ? resolved : { model: undefined, model_flag: undefined };
    const agent_id = `${harness}@${node.name}`;
    // probe spec: harness+workspace decide admissibility; prompt/model don't
    // affect nodeSpecAllowed
    const probe = {
      version: 1,
      kind: "launch-agent",
      workspace_id: workspace,
      payload: { workspace_id: workspace, harness, prompt: "x" },
    };
    if (nodeSpecAllowed(node.policy as never, probe as never, node.capabilitiesJson, node.capabilitiesObservedAt, now)) {
      return { match: { task, workspace, harness, agent_id, tier, model, model_flag } };
    }
  }
  return { skip: "no_harness" };
}

/** task-37ab2493: a dispatch job that exits 0 has only proven "the harness
 *  process exited clean", not "the task progressed". Workers hold a scoped
 *  credential (claim/report_evidence/complete_task on their own task), so a
 *  legitimate finish closes the task itself. When it did not, the closure
 *  verdict decides what the done job is worth, from the attempt's board
 *  footprint (ledger rows for the job, evidence and artifacts the worker
 *  identity wrote since the job started):
 *  - closed:  task already done — the worker closed it.
 *  - review:  worker left board activity but didn't close → in_review, so a
 *             reviewer/closer (rubric review, different harness) consumes it.
 *  - retry:   no activity → stays open; the 5-min cooldown gates re-dispatch.
 *  - blocked: repeated no-activity exits → status blocked + blocked artifact;
 *             re-running a session that never touches the board is pure burn. */
export const NO_ACTIVITY_BLOCK_AFTER = 2;
export const NO_ACTIVITY_REASON = "done/no_board_activity";

export interface AttemptFootprint {
  ledger: number;
  evidence: number;
  artifacts: number;
  proven_ac_ids: string[];
}

export type ClosureVerdict = "closed" | "review" | "retry" | "blocked";

export function closureVerdict(taskStatus: string, fp: AttemptFootprint, priorNoActivity: number): ClosureVerdict {
  if (taskStatus === "done") return "closed";
  if (fp.ledger + fp.evidence + fp.artifacts > 0) return "review";
  return priorNoActivity + 1 >= NO_ACTIVITY_BLOCK_AFTER ? "blocked" : "retry";
}

export function closureArtifact(v: ClosureVerdict, a: { jobId: string; agentId: string; acIds: string[]; fp: AttemptFootprint; noActivity: number; tail: string }) {
  const missing = a.acIds.filter(ac => !a.fp.proven_ac_ids.includes(ac));
  const footprint = `ledger=${a.fp.ledger} evidence=${a.fp.evidence} artifacts=${a.fp.artifacts}; ACs proven: [${a.fp.proven_ac_ids.join(", ")}] missing: [${missing.join(", ")}]`;
  const tail = a.tail.trim() ? `\n\nLast output:\n${a.tail.trim().slice(-600)}` : "";
  if (v === "review") return {
    kind: "note", title: `Job ${a.jobId} exited 0 without closing the task — queued for review`,
    content: `${a.agentId} job ${a.jobId} finished with exit 0 but did not complete_task. Board footprint this attempt: ${footprint}. Task moved to in_review for a reviewer/closer to verify against the ACs.${tail}`,
  };
  if (v === "retry") return {
    kind: "note", title: `Job ${a.jobId} exited 0 with no board activity — not counted as progress`,
    content: `${a.agentId} job ${a.jobId} finished with exit 0 but left no ledger entry, evidence, or artifact for this task (${footprint}). The job is recorded as ${NO_ACTIVITY_REASON}; the task stays open and re-dispatches after cooldown. ${NO_ACTIVITY_BLOCK_AFTER} such exits block it.${tail}`,
  };
  return {
    kind: "blocked", title: `Blocked: ${a.noActivity} dispatch jobs exited 0 with no board activity`,
    content: `${a.noActivity} consecutive dispatch jobs (latest ${a.jobId}, ${a.agentId}) exited 0 without touching the board for this task — likely the worker cannot reach the control plane (worker MCP config / credential) or cannot do the task. Task set to blocked to stop re-dispatch quota burn. Fix the cause, then set the task open. Footprint: ${footprint}.${tail}`,
  };
}
