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

/** Node's launchable harnesses: attested, installed, auth ready, quota open,
 *  ordered by dispatch.harness_order then attestation order. */
export function launchableHarnesses(capabilitiesJson: string, harnessOrder: string[], now = Date.now()): string[] {
  let caps: { harnesses?: Array<{ id?: string; installed?: boolean; auth_status?: string; quota?: { state?: string; resets_at?: string } }> };
  try {
    caps = JSON.parse(capabilitiesJson || "{}");
  } catch {
    return [];
  }
  const ready = (caps.harnesses ?? [])
    .filter(h => h?.id && h.installed && h.auth_status === "ready" && quotaAllows(h.quota, now))
    .map(h => h.id as string);
  const ranked = harnessOrder.filter(h => ready.includes(h));
  return [...ranked, ...ready.filter(h => !ranked.includes(h))];
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
}

/** Build the launch-agent node spec the executor consumes. */
export function buildLaunchSpec(input: LaunchSpecInput) {
  const prompt = LAUNCH_PROMPT
    .replaceAll("{{agent_id}}", input.agentId)
    .replaceAll("{{host}}", input.host)
    .replaceAll("{{task_id}}", input.taskId)
    .replaceAll("{{job_id}}", input.jobId);
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
  const ready = launchableHarnesses(node.capabilitiesJson, dispatch.harness_order, now)
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
