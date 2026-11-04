import { execSync } from "node:child_process";
import type { IStore, TaskStatus } from "./istore.js";

// GitHub adapter v1: issue⇄task sync via the `gh` CLI.
// Requires `gh` to be installed and authenticated — no token plumbing here.

type Issue = {
  number: number;
  title: string;
  body: string;
  url: string;
  state: string;
  labels: { name: string }[];
};

const gh = (args: string) =>
  JSON.parse(execSync(`gh ${args}`, { encoding: "utf8" }));

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
export async function syncIssues(store: IStore, repo: string, actor = "github-sync") {
  const issues = gh(`issue list --repo ${repo} --state all --limit 200 --json number,title,body,url,state,labels`) as Issue[];
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
          execSync(`gh issue close ${issue.number} --repo ${repo} --comment "Completed via underwright evidence gate."`, { encoding: "utf8" });
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
      execSync(`gh issue close ${issue.number} --repo ${repo} --comment "Completed via underwright evidence gate."`, { encoding: "utf8" });
      out.closed_issues.push(issue.number);
    }
  }
  return out;
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
export async function postEvidenceComment(store: IStore, repo: string, taskId: string) {
  const task = await store.getTask(taskId);
  if (!task?.spec_ref) return { error: `task ${taskId} has no spec_ref` };
  const m = String(task.spec_ref).match(/\/(?:issues|pull)\/(\d+)/);
  if (!m) return { error: `spec_ref ${task.spec_ref} is not an issue/PR URL` };
  const number = m[1];
  const body = (await evidencePack(store, taskId)) ?? "";
  const target = task.spec_ref.includes("/pull/") ? "pr" : "issue";
  execSync(`gh ${target} comment ${number} --repo ${repo} --body-file -`, {
    encoding: "utf8",
    input: body,
  });
  return { posted: `${target}#${number}` };
}
