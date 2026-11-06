import { execSync } from "node:child_process";
import type { IStore, TaskStatus } from "./istore.js";
import { getAutoMergePolicy, loadPolicy, type Policy } from "./policy.js";

// GitHub adapter v1: issue & PR sync + review gates via the `gh` CLI.
// Requires `gh` to be installed and authenticated — no token plumbing here.

export type GhRunner = (cmd: string, input?: string) => any;

const defaultGhRunner: GhRunner = (args: string, input?: string) => {
  if (input !== undefined) {
    return execSync(`gh ${args}`, { encoding: "utf8", input });
  }
  const out = execSync(`gh ${args}`, { encoding: "utf8" });
  return args.includes("--json") ? JSON.parse(out) : out;
};

export type Issue = {
  number: number;
  title: string;
  body: string;
  url: string;
  state: string;
  labels: { name: string }[];
};

export type PullRequest = {
  number: number;
  title: string;
  body: string;
  url: string;
  state: string;
  labels: { name: string }[];
  headRefName?: string;
  baseRefName?: string;
  mergedAt?: string | null;
};

export interface CheckStatus {
  name: string;
  status: string;
  conclusion: string | null;
  url?: string;
}

export interface CheckGateResult {
  ok: boolean;
  total: number;
  passed: number;
  failed: number;
  pending: number;
  checks: CheckStatus[];
  evidenceId?: string;
  error?: string;
}

const priorityFromLabels = (labels: { name: string }[]) => {
  for (const l of labels) {
    const m = l.name.match(/^p([0-4])$/i);
    if (m) return Number(m[1]);
  }
  return 2;
};

const taskStatusToIssueState = (s: TaskStatus) =>
  s === "done" ? "closed" : "open";

/** Import open issues as tasks; close tasks whose issues were closed;
 *  close issues whose tasks are done. */
export async function syncIssues(
  store: IStore,
  repo: string,
  actor = "github-sync",
  options: { runner?: GhRunner } = {}
) {
  const runner = options.runner ?? defaultGhRunner;
  const issues = (await runner(
    `issue list --repo ${repo} --state all --limit 200 --json number,title,body,url,state,labels`
  )) as Issue[];
  const out = { imported: 0, closed_tasks: [] as string[], closed_issues: [] as number[], skipped: 0 };

  for (const issue of issues) {
    // Marker link: "uw:<task-id>" in the body binds the issue to an existing
    // task instead of importing a duplicate.
    const marker = issue.body?.match(/uw:([\w-]+)/)?.[1];
    if (marker) {
      const task = await store.getTask(marker);
      if (task) {
        if (task.spec_ref !== issue.url) await store.linkTask(marker, issue.url);
        if (issue.state === "CLOSED" && task.status !== "done") {
          await store.setTaskStatus(marker, "done", actor);
          out.closed_tasks.push(marker);
        } else if (task.status === "done" && issue.state === "OPEN") {
          await runner(`issue close ${issue.number} --repo ${repo} --comment "Completed via underwright evidence gate."`);
          out.closed_issues.push(issue.number);
        }
        out.skipped++;
        continue;
      }
    }

    const id = `gh-${issue.number}`;
    const task = await store.getTask(id);

    if (!task) {
      if (issue.state === "CLOSED") { out.skipped++; continue; }
      await store.createTask({
        id,
        title: `[#${issue.number}] ${issue.title}`,
        description: issue.body ?? "",
        spec_ref: issue.url,
        priority: priorityFromLabels(issue.labels),
        created_by: actor,
      });
      out.imported++;
      continue;
    }

    // Reconcile: issue closed → task done; task done → close issue.
    if (issue.state === "CLOSED" && task.status !== "done") {
      await store.setTaskStatus(id, "done", actor);
      out.closed_tasks.push(id);
    } else if (task.status === "done" && issue.state === "OPEN") {
      await runner(`issue close ${issue.number} --repo ${repo} --comment "Completed via underwright evidence gate."`);
      out.closed_issues.push(issue.number);
    }
  }
  return out;
}

/** Import and map PRs to tasks; link PRs with marker or branch references;
 *  report pr-link evidence when acceptance criteria require it;
 *  evaluate auto-merge when repo is opted in via policy. */
export async function syncPRs(
  store: IStore,
  repo: string,
  actor = "github-pr-sync",
  options: { runner?: GhRunner; policy?: Policy } = {}
) {
  const runner = options.runner ?? defaultGhRunner;
  const policy = options.policy ?? loadPolicy();
  const amPolicy = getAutoMergePolicy(repo, policy);
  const prs = (await runner(
    `pr list --repo ${repo} --state all --limit 200 --json number,title,body,url,state,labels,headRefName,baseRefName,mergedAt`
  )) as PullRequest[];

  const out = {
    imported: 0,
    linked: [] as { taskId: string; pr: number }[],
    closed_tasks: [] as string[],
    merged: [] as { taskId: string; pr: number }[],
    conflicts: [] as { taskId: string; pr: number }[],
    skipped: 0,
  };

  for (const pr of prs) {
    const bodyMarker = pr.body?.match(/uw:([\w-]+)/)?.[1];
    const branchMarker = pr.headRefName?.match(/(?:feat\/|fix\/)?((?:task-[a-f0-9]+|gh-\d+))/)?.[1];
    const marker = bodyMarker ?? branchMarker;

    if (marker) {
      const task = await store.getTask(marker);
      if (task) {
        if (task.spec_ref !== pr.url) {
          await store.linkTask(marker, pr.url);
        }
        if (task.ac_ids && (task.ac_ids as string[]).includes("pr-link")) {
          const existing = await store.getEvidence(marker);
          const proven = new Set(
            existing.flatMap((e: any) =>
              typeof e.ac_ids === "string" ? JSON.parse(e.ac_ids) : e.ac_ids
            )
          );
          if (!proven.has("pr-link")) {
            await store.reportEvidence({
              task_id: marker,
              agent_id: actor,
              kind: "ci_check",
              command: `gh pr view ${pr.number}`,
              exit_code: 0,
              output: `Linked to PR ${pr.url}`,
              ac_ids: ["pr-link"],
            });
          }
        }
        out.linked.push({ taskId: marker, pr: pr.number });

        if ((pr.state === "MERGED" || pr.state === "CLOSED") && task.status !== "done") {
          await store.setTaskStatus(marker, "done", actor);
          out.closed_tasks.push(marker);
        } else if (pr.state === "OPEN" && amPolicy.enabled) {
          const mRes = await autoMergePR(store, repo, marker, {
            actor,
            runner,
            policy,
            prNumber: pr.number,
            mergeable: (pr as any).mergeable,
            mergeStateStatus: (pr as any).mergeStateStatus,
          });
          if (mRes.merged) {
            out.merged.push({ taskId: marker, pr: pr.number });
            out.closed_tasks.push(marker);
          } else if (mRes.conflict) {
            out.conflicts.push({ taskId: marker, pr: pr.number });
          }
        }
        continue;
      }
    }

    const id = `pr-${pr.number}`;
    const task = await store.getTask(id);

    if (!task) {
      if (pr.state === "CLOSED") {
        out.skipped++;
        continue;
      }
      await store.createTask({
        id,
        title: `[PR #${pr.number}] ${pr.title}`,
        description: pr.body ?? "",
        spec_ref: pr.url,
        priority: priorityFromLabels(pr.labels),
        type: "feature",
        created_by: actor,
      });
      out.imported++;
      continue;
    }

    if (task.spec_ref !== pr.url) {
      await store.linkTask(id, pr.url);
    }
    if ((pr.state === "MERGED" || pr.state === "CLOSED") && task.status !== "done") {
      await store.setTaskStatus(id, "done", actor);
      out.closed_tasks.push(id);
    } else if (pr.state === "OPEN" && amPolicy.enabled) {
      const mRes = await autoMergePR(store, repo, id, {
        actor,
        runner,
        policy,
        prNumber: pr.number,
        mergeable: (pr as any).mergeable,
        mergeStateStatus: (pr as any).mergeStateStatus,
      });
      if (mRes.merged) {
        out.merged.push({ taskId: id, pr: pr.number });
        out.closed_tasks.push(id);
      } else if (mRes.conflict) {
        out.conflicts.push({ taskId: id, pr: pr.number });
      } else {
        out.skipped++;
      }
    } else {
      out.skipped++;
    }
  }

  return out;
}

/** Directly link a task to a PR URL or number, reporting pr-link evidence if required. */
export async function linkPR(
  store: IStore,
  taskId: string,
  prNumberOrUrl: number | string,
  repo?: string,
  options: { actor?: string; runner?: GhRunner } = {}
) {
  const actor = options.actor ?? "github-adapter";
  const prUrl =
    typeof prNumberOrUrl === "number" || /^\d+$/.test(String(prNumberOrUrl))
      ? `https://github.com/${repo}/pull/${prNumberOrUrl}`
      : String(prNumberOrUrl);

  const task = await store.getTask(taskId);
  if (!task) return { error: `task ${taskId} not found` };

  await store.linkTask(taskId, prUrl);

  if (task.ac_ids && (task.ac_ids as string[]).includes("pr-link")) {
    await store.reportEvidence({
      task_id: taskId,
      agent_id: actor,
      kind: "ci_check",
      command: `linkPR ${taskId} -> ${prUrl}`,
      exit_code: 0,
      output: `Linked task ${taskId} to ${prUrl}`,
      ac_ids: ["pr-link"],
    });
  }

  return { linked: taskId, url: prUrl };
}

/** Check PR check-runs / CI status, gating task completion on required checks.
 *  Reports passing ci_check evidence proving checks-gate when all checks pass,
 *  or exit_code 1 failure without proving checks-gate when checks fail/pending. */
export async function checkPRGate(
  store: IStore,
  repo: string,
  taskId: string,
  options: { actor?: string; requiredOnly?: boolean; runner?: GhRunner } = {}
): Promise<CheckGateResult> {
  const actor = options.actor ?? "github-adapter";
  const runner = options.runner ?? defaultGhRunner;

  const task = await store.getTask(taskId);
  if (!task) {
    return { ok: false, total: 0, passed: 0, failed: 0, pending: 0, checks: [], error: `task ${taskId} not found` };
  }

  if (!task.spec_ref) {
    return { ok: false, total: 0, passed: 0, failed: 0, pending: 0, checks: [], error: `task ${taskId} has no spec_ref` };
  }

  const m = String(task.spec_ref).match(/\/pull\/(\d+)/);
  if (!m) {
    return { ok: false, total: 0, passed: 0, failed: 0, pending: 0, checks: [], error: `spec_ref ${task.spec_ref} is not a pull request URL` };
  }
  const prNumber = m[1];

  let rawChecks: any = null;
  try {
    rawChecks = await runner(`pr view ${prNumber} --repo ${repo} --json statusCheckRollup`);
  } catch (err: any) {
    return {
      ok: false,
      total: 0,
      passed: 0,
      failed: 0,
      pending: 0,
      checks: [],
      error: `Failed to fetch PR checks: ${err.message}`,
    };
  }

  const rollup = Array.isArray(rawChecks?.statusCheckRollup)
    ? rawChecks.statusCheckRollup
    : Array.isArray(rawChecks)
      ? rawChecks
      : [];

  const checks: CheckStatus[] = rollup.map((c: any) => {
    if (c.__typename === "StatusContext") {
      const state = (c.state ?? "").toUpperCase();
      const passed = state === "SUCCESS";
      const pending = state === "PENDING" || state === "EXPECTED";
      return {
        name: c.context ?? "unknown",
        status: state,
        conclusion: passed ? "SUCCESS" : pending ? null : "FAILURE",
        url: c.targetUrl,
      };
    }
    const status = (c.status ?? "").toUpperCase();
    const conclusion = (c.conclusion ?? "").toUpperCase() || null;
    return {
      name: c.name ?? "unknown",
      status,
      conclusion,
      url: c.detailsUrl,
    };
  });

  let passed = 0;
  let failed = 0;
  let pending = 0;

  for (const c of checks) {
    if (c.conclusion === "SUCCESS" || c.conclusion === "NEUTRAL" || c.conclusion === "SKIPPED") {
      passed++;
    } else if (
      c.status === "IN_PROGRESS" ||
      c.status === "QUEUED" ||
      c.status === "WAITING" ||
      c.status === "PENDING" ||
      !c.conclusion
    ) {
      pending++;
    } else {
      failed++;
    }
  }

  const total = checks.length;
  const ok = total > 0 && failed === 0 && pending === 0;

  let evidenceId: string | undefined;
  if (ok) {
    const ev = await store.reportEvidence({
      task_id: taskId,
      agent_id: actor,
      kind: "ci_check",
      command: `gh pr checks ${prNumber} --repo ${repo}`,
      exit_code: 0,
      output: `PR #${prNumber} checks passed: ${passed}/${total} checks succeeded.`,
      ac_ids: (task.ac_ids as string[])?.includes("checks-gate") ? ["checks-gate"] : [],
    });
    evidenceId = ev?.id;
  } else {
    const summary = failed > 0 ? `${failed} checks failed` : `${pending} checks pending`;
    const details = checks
      .filter((c) => c.conclusion !== "SUCCESS" && c.conclusion !== "SKIPPED" && c.conclusion !== "NEUTRAL")
      .map((c) => `- ${c.name}: status=${c.status}, conclusion=${c.conclusion ?? "none"}`)
      .join("\n");

    const ev = await store.reportEvidence({
      task_id: taskId,
      agent_id: actor,
      kind: "ci_check",
      command: `gh pr checks ${prNumber} --repo ${repo}`,
      exit_code: 1,
      output: `PR #${prNumber} checks gate failed: ${summary} (total: ${total}).\n${details}`,
      ac_ids: [],
    });
    evidenceId = ev?.id;
  }

  return {
    ok,
    total,
    passed,
    failed,
    pending,
    checks,
    evidenceId,
    ...(ok ? {} : { error: `PR #${prNumber} checks gate: ${failed} failed, ${pending} pending.` }),
  };
}

/** Render a task's evidence pack as markdown (for PR/issue comments or review gates). */
export async function evidencePack(store: IStore, taskId: string) {
  const task = await store.getTask(taskId);
  if (!task) return null;
  const rows = await store.getEvidence(taskId);
  const lines = [
    `### Evidence pack — ${task.id}`,
    `**${task.title}**`,
    "",
    ...rows.map(
      (e) =>
        `- **${e.kind}** by ${e.agent_id} — \`${e.command}\` → exit ${e.exit_code}` +
        (e.ac_ids !== "[]" ? ` (proves: ${e.ac_ids})` : "") +
        (e.output ? `\n  \`\`\`\n  ${String(e.output).slice(0, 500)}\n  \`\`\`` : "")
    ),
  ];
  return lines.join("\n");
}

/** Post a task's evidence pack as a comment on its linked issue/PR. */
export async function postEvidenceComment(
  store: IStore,
  repo: string,
  taskId: string,
  options: { actor?: string; runner?: GhRunner } = {}
) {
  const actor = options.actor ?? "github-adapter";
  const runner = options.runner ?? defaultGhRunner;

  const task = await store.getTask(taskId);
  if (!task?.spec_ref) return { error: `task ${taskId} has no spec_ref` };
  const m = String(task.spec_ref).match(/\/(?:issues|pull)\/(\d+)/);
  if (!m) return { error: `spec_ref ${task.spec_ref} is not an issue/PR URL` };
  const number = m[1];
  const body = (await evidencePack(store, taskId)) ?? "";
  const target = task.spec_ref.includes("/pull/") ? "pr" : "issue";

  await runner(`${target} comment ${number} --repo ${repo} --body-file -`, body);

  if (task.ac_ids && (task.ac_ids as string[]).includes("evidence-comment")) {
    await store.reportEvidence({
      task_id: taskId,
      agent_id: actor,
      kind: "ci_check",
      command: `gh ${target} comment ${number} --repo ${repo}`,
      exit_code: 0,
      output: `Posted evidence pack to ${target}#${number}`,
      ac_ids: ["evidence-comment"],
    });
  }

  return { posted: `${target}#${number}` };
}

export interface AutoMergeResult {
  merged: boolean;
  skipped?: boolean;
  conflict?: boolean;
  reason?: string;
  pr?: number;
  taskId?: string;
  gate?: CheckGateResult;
  error?: string;
}

/** Evaluate PR gate and independent review evidence for a task's linked PR;
 *  when opted-in per repo via policy and both pass, merge via `gh pr merge`.
 *  On merge conflict, comment on the PR, notify task watchers, and leave to agent. */
export async function autoMergePR(
  store: IStore,
  repo: string,
  taskId: string,
  options: {
    actor?: string;
    runner?: GhRunner;
    policy?: Policy;
    prNumber?: number | string;
    mergeable?: string;
    mergeStateStatus?: string;
  } = {}
): Promise<AutoMergeResult> {
  const actor = options.actor ?? "automerge-bot";
  const runner = options.runner ?? defaultGhRunner;
  const policy = options.policy ?? loadPolicy();
  const amPolicy = getAutoMergePolicy(repo, policy);

  if (!amPolicy.enabled) {
    return { merged: false, skipped: true, reason: "policy_disabled", taskId };
  }

  const task = await store.getTask(taskId);
  if (!task) {
    return { merged: false, reason: "task_not_found", taskId, error: `task ${taskId} not found` };
  }

  const m = options.prNumber
    ? [String(options.prNumber), String(options.prNumber)]
    : String(task.spec_ref ?? "").match(/\/pull\/(\d+)/);
  if (!m) {
    return {
      merged: false,
      reason: "no_pr_linked",
      taskId,
      error: `task ${taskId} has no linked pull request`,
    };
  }
  const prNumber = Number(m[1]);

  const gate = await checkPRGate(store, repo, taskId, { actor, runner });
  if (!gate.ok) {
    return { merged: false, reason: "checks_not_green", pr: prNumber, taskId, gate };
  }

  const evidence = await store.getEvidence(taskId);
  const systemActors = new Set(["github-adapter", "github-pr-sync", "github-sync", actor]);
  const nonReviewAuthor = evidence.find(
    (e: any) => e.kind !== "review" && e.kind !== "ci_check" && e.agent_id && !systemActors.has(e.agent_id)
  )?.agent_id;
  const createdByAuthor =
    task.created_by && !["human", "github-sync", "github-pr-sync", "cli"].includes(task.created_by)
      ? task.created_by
      : null;
  const authorAgent: string | null = task.claim?.agent_id ?? nonReviewAuthor ?? createdByAuthor ?? null;

  const reviews = evidence.filter(
    (e: any) =>
      e.kind === "review" &&
      (e.exit_code === null || e.exit_code === undefined || e.exit_code === 0)
  );
  if (reviews.length === 0) {
    return { merged: false, reason: "missing_review", pr: prNumber, taskId, gate };
  }

  const independentReview = reviews.find((e: any) => !authorAgent || e.agent_id !== authorAgent);
  if (!independentReview) {
    return { merged: false, reason: "self_review", pr: prNumber, taskId, gate };
  }

  const handleConflict = async (errMsg: string): Promise<AutoMergeResult> => {
    const comment = `Auto-merge aborted for PR #${prNumber} (task \`${taskId}\`): merge conflict detected (${errMsg}). Leaving to assigned agent to resolve.`;
    await runner(`pr comment ${prNumber} --repo ${repo} --body-file -`, comment);
    await store.notifyWatchers(
      taskId,
      `task ${taskId}: PR #${prNumber} (${repo}) auto-merge failed due to merge conflict — left to agent`
    );
    await store.log("task", taskId, "automerge_conflict", actor, {
      repo,
      pr: prNumber,
      task_id: taskId,
      author: authorAgent,
      reviewer: independentReview.agent_id,
      error: errMsg,
    });
    return {
      merged: false,
      conflict: true,
      reason: "merge_conflict",
      pr: prNumber,
      taskId,
      gate,
      error: errMsg,
    };
  };

  if (options.mergeable === "CONFLICTING" || options.mergeStateStatus === "DIRTY") {
    return handleConflict("PR is CONFLICTING / DIRTY");
  }

  const mergeCmd = `pr merge ${prNumber} --repo ${repo} --${amPolicy.method}${
    amPolicy.delete_branch ? " --delete-branch" : ""
  }`;
  try {
    await runner(mergeCmd);
  } catch (err: any) {
    return handleConflict(err?.message ?? String(err));
  }

  await store.log("task", taskId, "automerge", actor, {
    repo,
    pr: prNumber,
    task_id: taskId,
    method: amPolicy.method,
    merged_by: actor,
    reviewer: independentReview.agent_id,
    author: authorAgent,
  });

  if (task.ac_ids && (task.ac_ids as string[]).includes("automerge")) {
    await store.reportEvidence({
      task_id: taskId,
      agent_id: actor,
      kind: "ci_check",
      command: `gh ${mergeCmd}`,
      exit_code: 0,
      output: `Auto-merged PR #${prNumber} (${repo}) after green checks and independent review by ${independentReview.agent_id}`,
      ac_ids: ["automerge"],
    });
  }

  if (task.status !== "done") {
    await store.setTaskStatus(taskId, "done", actor);
  }

  return { merged: true, pr: prNumber, taskId, gate };
}
