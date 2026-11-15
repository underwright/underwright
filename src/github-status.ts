import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import type { IStore } from "./istore.js";
import { loadPolicy, type Policy } from "./policy.js";

const exec = promisify(execFile);
export type IssuePoster = (repo: string, number: number, body: string, marker: string) => Promise<void>;

/** Reconcile a remote marker before posting: retries after a local checkpoint
 * failure do not duplicate an already accepted GitHub comment. No shell input. */
export const ghIssuePoster: IssuePoster = async (repo, number, body, marker) => {
  const endpoint = `repos/${repo}/issues/${number}/comments`;
  const { stdout } = await exec("gh", ["api", "--paginate", "--slurp", `${endpoint}?per_page=100`], { timeout: 20_000, maxBuffer: 16 * 1024 * 1024 });
  const pages = JSON.parse(stdout) as { body?: string }[][];
  if (pages.flat().some(comment => comment.body?.includes(marker))) return;
  const work = exec("gh", ["api", "--method", "POST", endpoint, "--input", "-"], { timeout: 20_000, maxBuffer: 1024 * 1024 });
  work.child.stdin?.end(JSON.stringify({ body }));
  await work;
};

const repoPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
export function issueRefFor(task: any, repo: string): number | null {
  const ref = String(task.spec_ref ?? "");
  if (ref) {
    const match = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/issues\/(\d+)(?:[?#].*)?$/.exec(ref);
    return match && match[1].toLowerCase() === repo.toLowerCase() ? Number(match[2]) : null;
  }
  const number = /^gh-(\d+)$/.exec(task.id)?.[1] ?? /^\[#(\d+)\]/.exec(task.title)?.[1];
  return number ? Number(number) : null;
}

type Snapshot = { status: string; agent: string | null; evidence: string[] };
type Cursor = {
  issue: number; snapshot: Snapshot; sequence: number; digest_at: number;
  failures?: number; retry_at?: number;
};
const asArray = (v: any): string[] => typeof v === "string" ? JSON.parse(v) : v ?? [];
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 24);
const echoActors = new Set(["github-webhook", "github-sync", "github-pr-sync", "github-adapter"]);

export function renderTaskDigest(task: any, evidence: any[]): string {
  const proven = new Set(evidence.flatMap(row => asArray(row.ac_ids)));
  const missing = asArray(task.ac_ids).filter(id => !proven.has(id));
  return [
    `**Board:** \`${task.id}\` is **${task.status}**`,
    `- Claim: ${task.claim ? `\`${task.claim.agent_id}\`, lease until ${task.claim.lease_expires}` : "unclaimed"}`,
    `- Acceptance criteria: ${missing.length ? `missing evidence for ${missing.join(", ")}` : "all evidenced"}`,
    "", "**Evidence summary**",
    ...(evidence.length ? evidence.slice(-10).map(row => `- ${row.kind} by \`${row.agent_id}\`: exit ${row.exit_code ?? "n/a"}; proves ${asArray(row.ac_ids).join(", ") || "no criteria"}`) : ["- No evidence reported."]),
  ].join("\n");
}

export interface GithubStatusOptions {
  repo: string;
  mode?: "status" | "digest" | "both";
  digestHours?: number;
  force?: boolean;
  dryRun?: boolean;
  nowMs?: number;
  poster?: IssuePoster;
  maxComments?: number;
}

/** One publisher per board. State lives in the store; GitHub failures retain
 * the prior snapshot and back off without blocking task mutations. */
export async function publishGithubStatus(store: IStore, options: GithubStatusOptions) {
  if (!repoPattern.test(options.repo)) throw new Error("Expected GitHub repo owner/name");
  const repo = options.repo.toLowerCase();
  const now = options.nowMs ?? Date.now();
  const mode = options.mode ?? "both";
  const hours = options.digestHours ?? 168;
  if (!Number.isFinite(hours) || hours < 0) throw new Error("digestHours must be nonnegative and finite");
  const max = options.maxComments ?? 20;
  if (!Number.isInteger(max) || max < 1 || max > 100) throw new Error("maxComments must be an integer from 1 to 100");
  const poster = options.poster ?? ghIssuePoster;
  const result = { posted: 0, baselined: 0, skipped: 0, errors: [] as { task_id: string; error: string }[], previews: [] as string[] };
  const tasks = await store.listTasks();
  // Reuse normalized timestamps and event data from the existing digest helper.
  const events = (await store.digest({ since: "1970-01-01T00:00:00Z" })).events;
  let attempts = 0;
  for (const row of tasks) {
    const number = issueRefFor(row, repo);
    if (!number) continue;
    const task = await store.getTask(row.id);
    if (!task) continue;
    const evidence = await store.getEvidence(task.id);
    const snapshot: Snapshot = { status: task.status, agent: task.claim?.agent_id ?? null, evidence: evidence.map(e => e.id).sort() };
    const raw = await store.getGithubStatus(repo, task.id);
    let previous: Cursor | null = raw ? JSON.parse(raw) : null;
    if (previous?.issue !== number) previous = null;
    if (previous?.retry_at && previous.retry_at > now && !options.force) { result.skipped++; continue; }
    const latest = events.filter(e => (e.entity_type === "task" && e.entity_id === task.id &&
      ["claimed", "released", "lease_expired", "completed", "status:open", "status:done", "status:blocked", "status:in_review", "status:claimed"].includes(e.action)) ||
      (e.entity_type === "evidence" && e.data?.task_id === task.id)).at(-1);
    const changed = previous && JSON.stringify(previous.snapshot) !== JSON.stringify(snapshot);
    const echo = latest && echoActors.has(latest.actor);
    const statusDue = mode !== "digest" && changed && !echo;
    const digestDue = mode !== "status" && task.status !== "done" && hours > 0 &&
      (options.force || now - (previous?.digest_at ?? now) >= hours * 3_600_000);
    const next: Cursor = { issue: number, snapshot, sequence: (previous?.sequence ?? 0) + 1,
      digest_at: digestDue ? now : previous?.digest_at ?? now };
    if ((!previous && !digestDue) || (!statusDue && !digestDue)) {
      // Digest-only calls must not consume an unreported status change.
      if (mode === "digest" && changed) next.snapshot = previous!.snapshot;
      if (!options.dryRun && (!previous || (changed && mode !== "digest"))) {
        await store.putGithubStatus(repo, task.id, JSON.stringify(next));
        result.baselined++;
      } else result.skipped++;
      continue;
    }
    if (attempts >= max) break;
    attempts++;
    const marker = `<!-- underwright:report ${hash([repo, task.id, next.sequence, snapshot, digestDue ? "digest" : "status"])} -->`;
    const heading = statusDue ? `**Board update:** ${previous!.snapshot.status} → ${task.status}` : "**Board digest**";
    const body = `${marker}\n${heading}\n\n${renderTaskDigest(task, evidence)}`;
    if (options.dryRun) { result.previews.push(body); continue; }
    try {
      await poster(repo, number, body, marker);
      // Keep status pending when only an explicit digest was requested.
      if (mode === "digest" && changed) next.snapshot = previous!.snapshot;
      await store.putGithubStatus(repo, task.id, JSON.stringify(next));
      result.posted++;
    } catch (error) {
      const failures = (previous?.failures ?? 0) + 1;
      const retry = previous ?? { issue: number, snapshot, sequence: 0, digest_at: now - hours * 3_600_000 };
      await store.putGithubStatus(repo, task.id, JSON.stringify({ ...retry, failures,
        retry_at: now + Math.min(60, 2 ** Math.min(failures - 1, 6)) * 60_000 }));
      result.errors.push({ task_id: task.id, error: String(error) });
    }
  }
  return result;
}

/** Automatic publishing is opt-in and only runs on the HTTP control plane. */
export function startGithubStatusLoop(store: IStore, policy: Policy = loadPolicy(), intervalMs = 60_000) {
  const cfg = policy.github;
  if (!cfg?.repo || (!cfg.status_comments && !(Number(cfg.digest_hours) > 0))) return async () => {};
  let stopped = false;
  let pending: Promise<unknown> | null = null;
  const tick = () => {
    if (stopped || pending) return;
    pending = publishGithubStatus(store, { repo: cfg.repo!, mode: cfg.status_comments ? "both" : "digest", digestHours: cfg.digest_hours ?? 0 })
      .then(result => { for (const error of result.errors) console.error("[github-status]", error); })
      .catch(error => console.error("[github-status]", error)).finally(() => { pending = null; });
  };
  const timer = setInterval(tick, intervalMs);
  timer.unref();
  tick();
  return async () => { stopped = true; clearInterval(timer); await pending; };
}
