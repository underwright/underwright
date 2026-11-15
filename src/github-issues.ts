import { execSync } from "node:child_process";
import { z } from "zod";
import type { IStore, GithubRaiseArgs } from "./istore.js";

export type GhRunner = (cmd: string, input?: string) => any;

export const defaultGhRunner: GhRunner = (args: string, input?: string) => {
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

export const priorityFromLabels = (labels: { name: string }[]) => {
  for (const l of labels) {
    const m = l.name.match(/^p([0-4])$/i);
    if (m) return Number(m[1]);
  }
  return 2;
};

/** Import open issues as tasks; close tasks whose issues were closed;
 *  close issues whose tasks are done. */
export async function syncIssues(
  store: IStore,
  repo: string,
  actor = "github-sync",
  options: { runner?: GhRunner; issues?: Issue[]; task_extras?: GithubTaskExtras; ignoreMarkers?: boolean } = {}
) {
  const runner = options.runner ?? defaultGhRunner;
  const issues = options.issues ?? (await runner(
    `issue list --repo ${repo} --state all --limit 200 --json number,title,body,url,state,labels`
  )) as Issue[];
  const out = { imported: 0, closed_tasks: [] as string[], closed_issues: [] as number[], skipped: 0 };

  for (const issue of issues) {
    // Marker link: "uw:<task-id>" in the body binds the issue to an existing
    // task instead of importing a duplicate.
    const canonical = await store.getTask(`gh-${issue.number}`);
    const alreadyImported = canonical?.spec_ref === issue.url;
    const marker = !alreadyImported && !options.ignoreMarkers && issue.body?.match(/uw:([\w-]+)/)?.[1];
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
      const created = await store.createTask({
        id,
        title: `[#${issue.number}] ${issue.title}`,
        description: issue.body ?? "",
        spec_ref: issue.url,
        priority: priorityFromLabels(issue.labels),
        created_by: actor,
        ...options.task_extras,
      });
      if (created?.error) throw new Error(created.error);
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


export const githubTaskExtrasSchema = z.object({
  type: z.enum(['feature', 'bug', 'deploy', 'architecture', 'docs', 'tdd', 'triage']).optional(),
  severity: z.enum(['low', 'normal', 'high', 'critical']).optional(),
  estimate: z.enum(['S', 'M', 'L']).optional(),
  ac_ids: z.array(z.string().min(1)).min(1).optional(),
  priority: z.number().int().min(0).max(4).optional(),
  ownership: z.object({ paths: z.array(z.string()).optional(), symbols: z.array(z.string()).optional() }).strict().optional(),
  blocked_by: z.array(z.string()).optional(),
}).strict();
export type GithubTaskExtras = z.infer<typeof githubTaskExtrasSchema>;
export const githubRaiseSchema = z.object({
  repo: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
  title: z.string().refine(value => value.trim().length > 0, 'title must not be blank'),
  body: z.string().optional(),
  agent_id: z.string().min(1).optional(),
  task_extras: githubTaskExtrasSchema.optional(),
}).strict();
export type { GithubRaiseArgs } from "./istore.js";

/** Create the issue first, then import that exact response through the sync path.
 * Re-sync is idempotent; repeating raise creates another issue, so return recovery
 * details when only the import failed. All board writes use audited Store methods. */
export async function raiseIssue(store: IStore, args: GithubRaiseArgs, options: { runner?: GhRunner } = {}) {
  const a = githubRaiseSchema.parse(args);
  const runner = options.runner ?? defaultGhRunner;
  const raw = await runner(`api repos/${a.repo}/issues --method POST --input -`, JSON.stringify({ title: a.title, body: a.body ?? '' }));
  const posted = typeof raw === 'string' ? JSON.parse(raw) : raw;
  if (!Number.isSafeInteger(posted?.number) || posted.number <= 0 || typeof posted.html_url !== 'string') {
    throw new Error('GitHub returned an invalid issue response; check the repository before retrying raise');
  }
  const issue: Issue = { ...posted, url: posted.html_url, state: String(posted.state).toUpperCase(), labels: posted.labels ?? [] };
  const task_id = `gh-${issue.number}`;
  try {
    const existing = await store.getTask(task_id);
    if (existing && existing.spec_ref !== issue.url) throw new Error(`task id collision: ${task_id} belongs to ${existing.spec_ref ?? 'an unlinked task'}`);
    await syncIssues(store, a.repo, a.agent_id ?? 'github-raise', {
      runner, issues: [issue], ignoreMarkers: true,
      task_extras: { type: 'feature', estimate: 'S', ac_ids: ['impl', 'tests', 'review'], ...a.task_extras },
    });
    const task = await store.getTask(task_id);
    if (!task || task.spec_ref !== issue.url) throw new Error(`issue was not imported as ${task_id}`);
    return { issue, task_id };
  } catch (err) {
    return { issue, task_id: null, error: err instanceof Error ? err.message : String(err), recovery: `Issue already created. Resolve the board error, then run underwright github sync --repo ${a.repo}; do not repeat raise.` };
  }
}
