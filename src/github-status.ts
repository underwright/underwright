// Board→GitHub status mirror (task-cfc5f333, issue #62).
//
// Humans follow the work on GitHub issues without opening the board. Two outputs:
//   1. Status comments: when a linked task's status changes, post one comment
//      on its issue ("claimed → done by X"). Completions include the evidence pack.
//   2. Digests: a periodic per-issue summary (claim, lease, evidence, artifacts)
//      for tasks that are not done.
//
// Design: state diff, not store hooks. Status changes come from many store
// paths (claim, release, sweeper, complete, webhook, sync). Hooking each would
// spread GitHub concerns through the store and both backends. Instead the
// github_status table records the status last reported per task. Each pass
// compares it with the live status and comments on the difference. The pass
// is idempotent, stateless across HTTP requests, and catches every mutation path.
//
// Depends on the IStore port, evidence-pack and digest only. The poster is
// injected (GitHub App in server.ts, gh CLI in cli.ts).

import type { IStore, GithubStatusRow } from "./istore.js";
import { evidencePack } from "./evidence-pack.js";
import { normalizeTimestamp } from "./digest.js";

export const STATUS_ACTOR = "github-status";

/** Actors whose status changes originate on GitHub; reporting them back would echo. */
export const ECHO_ACTORS = new Set(["github-webhook", "github-sync", "github-pr-sync", "github-adapter", STATUS_ACTOR]);

/** Audit actions that move a task between statuses. */
const STATUS_ACTIONS = /^(status:\w+|completed|claimed|released|lease_expired|created)$/;

export type IssuePoster = (repo: string, number: number, body: string) => Promise<unknown>;
export type IssueRef = { repo: string; number: number };

export interface StatusPassOptions {
  post: IssuePoster;
  /** Repo for `gh-N` ids / `[#N]` titles when spec_ref carries no issue URL. */
  defaultRepo?: string;
  now?: () => number;
  /** Cap on comments per pass so a backlog cannot flood GitHub. Default 20. */
  maxPosts?: number;
}

export interface StatusPassResult {
  seeded: string[];
  posted: { task_id: string; from: string; to: string; issue: string }[];
  suppressed: string[];
  failed: { task_id: string; error: string }[];
  deferred: string[];
}

/** Resolve the GitHub issue a task mirrors. spec_ref issue URL wins; then `gh-N` / `[#N]` with the default repo. */
export function issueRefFor(task: { id: string; title?: string; spec_ref?: string | null }, defaultRepo?: string): IssueRef | null {
  const m = String(task.spec_ref ?? "").match(/github\.com\/([\w.-]+\/[\w.-]+)\/issues\/(\d+)/);
  if (m) return { repo: m[1], number: Number(m[2]) };
  if (!defaultRepo) return null;
  const id = task.id.match(/^gh-(\d+)$/);
  if (id) return { repo: defaultRepo, number: Number(id[1]) };
  const title = String(task.title ?? "").match(/^\[#(\d+)\]/);
  if (title) return { repo: defaultRepo, number: Number(title[1]) };
  return null;
}

const refKey = (r: IssueRef) => `${r.repo}#${r.number}`;

/** Retry backoff: 1, 2, 4 … minutes, capped at one hour. */
export function backoffMs(attempts: number): number {
  return Math.min(60, 2 ** Math.max(0, attempts - 1)) * 60_000;
}

function lastStatusEvent(events: any[]): any | null {
  for (let i = events.length - 1; i >= 0; i--) if (STATUS_ACTIONS.test(String(events[i].action))) return events[i];
  return null;
}

export function renderStatusComment(args: { task: any; from: string; to: string; actor: string; pack?: string | null }): string {
  const { task, from, to, actor, pack } = args;
  const lines = [
    `<!-- underwright:status task=${task.id} status=${to} -->`,
    `**Board update:** \`${task.id}\` moved **${from} → ${to}** (by \`${actor}\`).`,
  ];
  if (to === "claimed" && task.claim?.agent_id) {
    lines.push(`Claimed by \`${task.claim.agent_id}\`, lease until ${task.claim.lease_expires}.`);
  }
  if (to === "done" && pack) lines.push("", pack);
  return lines.join("\n");
}

/** One reconciliation pass: comment on every linked task whose status differs from what was last reported. */
export async function publishStatusChanges(store: IStore, opts: StatusPassOptions): Promise<StatusPassResult> {
  const now = opts.now ?? Date.now;
  const maxPosts = opts.maxPosts ?? 20;
  const out: StatusPassResult = { seeded: [], posted: [], suppressed: [], failed: [], deferred: [] };
  const state = new Map<string, GithubStatusRow>((await store.listGithubStatus()).map((r) => [r.task_id, r]));

  for (const summary of await store.listTasks()) {
    const ref = issueRefFor(summary, opts.defaultRepo);
    if (!ref) continue;
    const issue_ref = refKey(ref);
    const prev = state.get(summary.id);

    // First sighting: record the baseline silently; never flood old issues.
    if (!prev) {
      await store.putGithubStatus(summary.id, { issue_ref, last_status: summary.status }, STATUS_ACTOR);
      out.seeded.push(summary.id);
      continue;
    }
    if (prev.last_status === summary.status) continue;

    const events = await store.taskEvents(summary.id);
    const last = lastStatusEvent(events);
    const actor = String(last?.actor ?? "unknown");
    if (ECHO_ACTORS.has(actor)) {
      await store.putGithubStatus(summary.id, { issue_ref, last_status: summary.status, attempts: 0, last_error: null }, STATUS_ACTOR);
      out.suppressed.push(summary.id);
      continue;
    }

    if (prev.attempts > 0 && prev.last_attempt_at && Date.parse(prev.last_attempt_at) + backoffMs(prev.attempts) > now()) {
      out.deferred.push(summary.id);
      continue;
    }
    if (out.posted.length + out.failed.length >= maxPosts) {
      out.deferred.push(summary.id);
      continue;
    }

    const task = await store.getTask(summary.id);
    const pack = summary.status === "done" ? await evidencePack(store, summary.id) : null;
    const body = renderStatusComment({ task, from: prev.last_status, to: summary.status, actor, pack });
    const at = new Date(now()).toISOString();
    try {
      await opts.post(ref.repo, ref.number, body);
      await store.putGithubStatus(summary.id, {
        issue_ref, last_status: summary.status, last_comment_at: at, attempts: 0, last_attempt_at: at, last_error: null,
      }, STATUS_ACTOR);
      out.posted.push({ task_id: summary.id, from: prev.last_status, to: summary.status, issue: issue_ref });
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      // Keep last_status unchanged so the next pass retries after backoff.
      await store.putGithubStatus(summary.id, {
        issue_ref, last_status: prev.last_status, attempts: prev.attempts + 1, last_attempt_at: at, last_error: error.slice(0, 500),
      }, STATUS_ACTOR);
      out.failed.push({ task_id: summary.id, error });
    }
  }
  return out;
}

function since(rows: any[], sinceIso: string | null): any[] {
  if (!sinceIso) return rows;
  return rows.filter((r) => (normalizeTimestamp(r.created_at) ?? "") > sinceIso);
}

/** Render the per-issue digest body. Returns null when nothing happened since the last digest (unless forced). */
export async function renderTaskDigest(store: IStore, taskId: string, sinceIso: string | null, force = false): Promise<string | null> {
  const task = await store.getTask(taskId);
  if (!task) return null;
  const events = sinceIso ? await store.taskEvents(taskId, sinceIso) : await store.taskEvents(taskId);
  const evidence = await store.getEvidence(taskId);
  const newEvidence = since(evidence, sinceIso);
  const newArtifacts = since(task.artifacts ?? [], sinceIso);
  const activity = events.filter((e: any) => e.entity_type === "task" && e.actor !== STATUS_ACTOR);
  if (!force && sinceIso && activity.length === 0 && newEvidence.length === 0 && newArtifacts.length === 0) return null;

  const proven = new Set<string>();
  for (const e of evidence) {
    try { for (const id of JSON.parse(e.ac_ids ?? "[]")) proven.add(id); } catch { /* malformed ac_ids */ }
  }
  const acs: string[] = task.ac_ids ?? [];
  const counts = new Map<string, number>();
  for (const e of activity) counts.set(e.action, (counts.get(e.action) ?? 0) + 1);

  const lines = [
    `<!-- underwright:digest task=${task.id} -->`,
    `**Board digest:** \`${task.id}\` is **${task.status}**${sinceIso ? ` (changes since ${sinceIso})` : ""}`,
    "",
    task.claim
      ? `- Claim: \`${task.claim.agent_id}\`, lease until ${task.claim.lease_expires}`
      : "- Claim: unclaimed",
    acs.length
      ? `- Acceptance criteria with evidence: ${acs.filter((a) => proven.has(a)).length}/${acs.length}` +
        (acs.some((a) => !proven.has(a)) ? ` (missing: ${acs.filter((a) => !proven.has(a)).join(", ")})` : "")
      : "- Acceptance criteria: none declared",
    `- Activity: ${counts.size ? [...counts].map(([a, n]) => `${a} ×${n}`).join(", ") : "none"}`,
  ];
  if (task.unfinished_blockers?.length) lines.push(`- Blocked by: ${task.unfinished_blockers.join(", ")}`);
  if (newEvidence.length) {
    lines.push("", "**New evidence**");
    for (const e of newEvidence) {
      lines.push(`- ${e.kind} by \`${e.agent_id}\`${e.command ? ` — \`${e.command}\`` : ""} → exit ${e.exit_code ?? "?"}` +
        (e.ac_ids && e.ac_ids !== "[]" ? ` (proves: ${e.ac_ids})` : ""));
    }
  }
  if (newArtifacts.length) {
    lines.push("", "**New artifacts**");
    for (const a of newArtifacts) lines.push(`- ${a.kind}${a.title ? `: ${a.title}` : ""} (by \`${a.agent_id}\`)`);
  }
  return lines.join("\n");
}

export interface DigestPassOptions {
  post: IssuePoster;
  defaultRepo?: string;
  now?: () => number;
  /** Minimum hours between digests on one issue. 0 = every pass (manual runs). */
  everyHours: number;
  /** Post even if nothing changed since the last digest. */
  force?: boolean;
  /** Only digest these task ids. */
  only?: string[];
}

export interface DigestPassResult {
  posted: { task_id: string; issue: string }[];
  skipped: string[];
  failed: { task_id: string; error: string }[];
}

/** Post one digest comment per open linked task that is due. */
export async function postIssueDigests(store: IStore, opts: DigestPassOptions): Promise<DigestPassResult> {
  const now = opts.now ?? Date.now;
  const out: DigestPassResult = { posted: [], skipped: [], failed: [] };
  const state = new Map<string, GithubStatusRow>((await store.listGithubStatus()).map((r) => [r.task_id, r]));
  for (const summary of await store.listTasks()) {
    if (summary.status === "done") continue;
    if (opts.only && !opts.only.includes(summary.id)) continue;
    const ref = issueRefFor(summary, opts.defaultRepo);
    if (!ref) continue;
    const prev = state.get(summary.id);
    const lastDigest = prev?.last_digest_at ?? null;
    if (lastDigest && opts.everyHours > 0 && Date.parse(lastDigest) + opts.everyHours * 3_600_000 > now()) {
      out.skipped.push(summary.id);
      continue;
    }
    const body = await renderTaskDigest(store, summary.id, lastDigest, opts.force);
    if (!body) {
      out.skipped.push(summary.id);
      continue;
    }
    const issue_ref = refKey(ref);
    try {
      await opts.post(ref.repo, ref.number, body);
      await store.putGithubStatus(summary.id, {
        issue_ref,
        // A digest is not a status report. Keep the baseline, or seed it now.
        last_status: prev?.last_status ?? summary.status,
        last_digest_at: new Date(now()).toISOString(),
      }, STATUS_ACTOR);
      out.posted.push({ task_id: summary.id, issue: issue_ref });
    } catch (err) {
      out.failed.push({ task_id: summary.id, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return out;
}

/** Background loop for serve --http: status pass every interval, digest pass when due. */
export function startGithubStatusLoop(
  store: IStore,
  opts: { post: IssuePoster; defaultRepo?: string; statusComments: boolean; digestHours: number; intervalMs?: number },
  onError: (error: unknown) => void = (error) => console.error("[underwright] github status pass failed:", error),
) {
  let running = false;
  let stopped = false;
  let pending: Promise<void> = Promise.resolve();
  const tick = () => {
    if (running || stopped) return;
    running = true;
    pending = (async () => {
      try {
        if (opts.statusComments) await publishStatusChanges(store, opts);
        if (opts.digestHours > 0) await postIssueDigests(store, { ...opts, everyHours: opts.digestHours });
      } catch (error) {
        onError(error);
      } finally {
        running = false;
      }
    })();
  };
  const timer = setInterval(tick, opts.intervalMs ?? 60_000);
  timer.unref();
  tick();
  return async () => {
    stopped = true;
    clearInterval(timer);
    await pending;
  };
}
