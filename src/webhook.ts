// GitHub webhook receiver for `underwright serve --http`.
// POST /github/webhook checks X-Hub-Signature-256 (HMAC-SHA256 of the raw body).
// The secret is read per request from UNDERWRIGHT_GITHUB_WEBHOOK_SECRET,
// falling back to GITHUB_WEBHOOK_SECRET. UNDERWRIGHT_TOKEN stays on /mcp;
// GitHub authenticates with the HMAC secret only.
// Depends on the IStore port so server.ts can mount the route without
// importing the gh CLI adapter.

import { createHmac, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { IStore } from "./istore.js";

export const WEBHOOK_PATH = "/github/webhook";
export const WEBHOOK_SECRET_ENV = "UNDERWRIGHT_GITHUB_WEBHOOK_SECRET";
export const WEBHOOK_SECRET_FALLBACK_ENV = "GITHUB_WEBHOOK_SECRET";
export const WEBHOOK_BODY_LIMIT = 2_000_000;

const ACTOR = "github-webhook";
const PASSING = new Set(["success", "neutral", "skipped"]);
const FAILING = new Set([
  "failure", "cancelled", "canceled", "timed_out", "action_required", "startup_failure", "stale",
]);

export type WebhookEffect = {
  action: "created" | "synced" | "evidence" | "ignored" | "skipped";
  task_id?: string;
  evidence_id?: string;
  kind?: string;
  reason?: string;
};

export type WebhookDispatch = { event: string; effects: WebhookEffect[] };

type LinkHint = {
  number?: number;
  kind: "issue" | "pull";
  url?: string;
  body?: string;
  headRef?: string;
};

export function webhookSecretFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  const primary = env[WEBHOOK_SECRET_ENV]?.trim() ?? "";
  if (primary) return primary;
  return env[WEBHOOK_SECRET_FALLBACK_ENV]?.trim() ?? "";
}

/** True when `X-Hub-Signature-256` is the HMAC-SHA256 of `rawBody` under `secret`. */
export function verifyGithubSignature(
  rawBody: Buffer | string,
  signatureHeader: string | undefined,
  secret: string,
): boolean {
  if (!secret || !signatureHeader) return false;
  const match = /^sha256=([0-9a-fA-F]+)$/.exec(signatureHeader.trim());
  if (!match) return false;
  const actualHex = match[1].toLowerCase();
  const expectedHex = createHmac("sha256", secret).update(rawBody).digest("hex");
  if (actualHex.length !== expectedHex.length) return false;
  return timingSafeEqual(Buffer.from(actualHex), Buffer.from(expectedHex));
}

export function isGithubWebhookRequest(url: string | undefined): boolean {
  if (!url) return false;
  const path = url.split("?")[0];
  const normal = path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;
  return normal === WEBHOOK_PATH;
}

export async function dispatchGithubEvent(
  store: IStore,
  event: string,
  payload: any,
  meta: { delivery?: string; actor?: string } = {},
): Promise<WebhookDispatch> {
  const name = event.trim();
  const actor = meta.actor ?? ACTOR;
  switch (name) {
    case "check_run":
      return { event: name, effects: await onCheck(store, name, payload?.check_run, actor, meta.delivery) };
    case "check_suite":
      return { event: name, effects: await onCheck(store, name, payload?.check_suite, actor, meta.delivery) };
    case "issues":
      return { event: name, effects: await onIssue(store, payload, actor) };
    case "pull_request_review":
      return { event: name, effects: await onReview(store, payload, actor, meta.delivery) };
    default:
      return { event: name, effects: [{ action: "ignored", reason: "unhandled event" }] };
  }
}

export async function handleGithubWebhookHttp(
  store: IStore,
  req: IncomingMessage,
  res: ServerResponse,
  secret: string,
): Promise<void> {
  if (req.method !== "POST") {
    send(res, 405, { error: "method not allowed" }, { allow: "POST" });
    return;
  }
  if (!secret) {
    send(res, 503, { error: "webhook secret not configured" });
    return;
  }

  let raw: Buffer;
  try {
    raw = await readBody(req, WEBHOOK_BODY_LIMIT);
  } catch (err: any) {
    const status = err?.statusCode === 413 ? 413 : 400;
    send(res, status, { error: status === 413 ? "payload too large" : "failed to read body" });
    return;
  }

  const signature = header(req, "x-hub-signature-256");
  if (!verifyGithubSignature(raw, signature, secret)) {
    send(res, 401, { error: signature ? "invalid signature" : "missing signature" });
    return;
  }

  let payload: any;
  try {
    payload = JSON.parse(raw.toString("utf8"));
  } catch {
    send(res, 400, { error: "invalid json" });
    return;
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    send(res, 400, { error: "invalid json" });
    return;
  }

  const event = header(req, "x-github-event");
  if (!event) {
    send(res, 400, { error: "missing event" });
    return;
  }
  if (event === "ping") {
    const body: Record<string, unknown> = { ok: true, event: "ping" };
    if (typeof payload.zen === "string") body.zen = payload.zen;
    send(res, 200, body);
    return;
  }

  try {
    const result = await dispatchGithubEvent(store, event, payload, {
      delivery: header(req, "x-github-delivery"),
    });
    send(res, 200, { ok: true, ...result });
  } catch (err) {
    console.error("[underwright] webhook dispatch failed:", err instanceof Error ? err.message : err);
    send(res, 500, { error: "webhook handler failed" });
  }
}

async function onCheck(
  store: IStore,
  event: string,
  check: any,
  actor: string,
  delivery?: string,
): Promise<WebhookEffect[]> {
  if (!check || typeof check !== "object") {
    return [{ action: "ignored", reason: `missing ${event}` }];
  }
  const tasks = await linkedTasks(store, checkHints(check));
  if (!tasks.length) return [{ action: "ignored", reason: "no linked task" }];

  const label = checkLabel(event, check);
  const conclusion = typeof check.conclusion === "string" ? check.conclusion : "";
  const status = typeof check.status === "string" ? check.status : "";
  const exitCode = exitForConclusion(conclusion);
  const sha = check.head_sha ?? check.check_suite?.head_sha;
  const output = [
    `${event} ${label}: ${conclusion || status || "pending"}`,
    typeof check.html_url === "string" ? check.html_url : "",
    typeof sha === "string" && sha ? `head ${sha}` : "",
  ].filter(Boolean).join("\n").slice(0, 4000);

  const effects: WebhookEffect[] = [];
  for (const task of tasks) {
    const ev = await store.reportEvidence({
      task_id: task.id,
      agent_id: actor,
      kind: "ci_check",
      command: command(event, delivery, label),
      exit_code: exitCode,
      output,
      ac_ids: exitCode === 0 ? acIds(task, "checks-gate") : [],
    });
    if (!ev?.id) {
      effects.push({ action: "skipped", task_id: task.id, reason: ev?.error ?? "evidence failed" });
      continue;
    }
    effects.push({ action: "evidence", task_id: task.id, evidence_id: ev.id, kind: "ci_check" });
  }
  return effects;
}

async function onIssue(store: IStore, payload: any, actor: string): Promise<WebhookEffect[]> {
  const issue = payload?.issue;
  if (!issue || typeof issue !== "object") return [{ action: "ignored", reason: "missing issue" }];
  const action = String(payload.action ?? "");
  if (action === "deleted" || action === "transferred") {
    return [{ action: "ignored", reason: `issue ${action}` }];
  }
  const number = asNumber(issue.number);
  if (number == null) return [{ action: "ignored", reason: "missing issue" }];

  const existing = await taskForIssue(store, issue, payload);
  const closed = action === "closed" || String(issue.state ?? "").toLowerCase() === "closed";
  if (!existing) {
    if (closed) return [{ action: "skipped", reason: "closed issue has no task" }];
    const created = await store.createTask({
      id: `gh-${number}`,
      title: issueTitle(number, issue.title),
      description: typeof issue.body === "string" ? issue.body : "",
      spec_ref: issueUrl(payload, issue) || undefined,
      priority: priorityFromLabels(issue.labels),
      created_by: actor,
    });
    if (!created?.id) return [{ action: "skipped", reason: created?.error ?? "create failed" }];
    return [{ action: "created", task_id: created.id }];
  }

  const spec = issueUrl(payload, issue);
  const patch: { title: string; description: string; spec_ref?: string } = {
    title: issueTitle(number, issue.title),
    description: typeof issue.body === "string" ? issue.body : "",
  };
  if (spec) patch.spec_ref = spec;
  const updated = await store.updateTask(existing.id, patch, actor);
  if (updated?.error) return [{ action: "skipped", task_id: existing.id, reason: String(updated.error) }];

  if (closed && existing.status !== "done") {
    await store.setTaskStatus(existing.id, "done", actor);
  } else if (action === "reopened" && existing.status === "done") {
    await store.setTaskStatus(existing.id, "open", actor);
  }
  return [{ action: "synced", task_id: existing.id }];
}

async function onReview(
  store: IStore,
  payload: any,
  actor: string,
  delivery?: string,
): Promise<WebhookEffect[]> {
  const review = payload?.review;
  const pr = payload?.pull_request;
  if (!review || typeof review !== "object" || !pr || typeof pr !== "object") {
    return [{ action: "ignored", reason: "missing review" }];
  }
  const tasks = await linkedTasks(store, [{
    kind: "pull",
    number: asNumber(pr.number),
    url: typeof pr.html_url === "string" ? pr.html_url : undefined,
    body: typeof pr.body === "string" ? pr.body : undefined,
    headRef: pr.head?.ref,
  }]);
  if (!tasks.length) return [{ action: "ignored", reason: "no linked task" }];

  const state = String(review.state ?? "").toLowerCase();
  const exitCode = reviewExit(state);
  const login = typeof review.user?.login === "string" ? review.user.login : "";
  const reviewer = /^[A-Za-z0-9-]+$/.test(login) ? `github:${login}` : actor;
  const body = typeof review.body === "string" ? review.body : "";
  const output = [
    `pull_request_review ${state || "submitted"} by ${login || "unknown"}`,
    typeof review.html_url === "string" ? review.html_url : "",
    typeof review.commit_id === "string" && review.commit_id ? `commit ${review.commit_id}` : "",
    body,
  ].filter(Boolean).join("\n").slice(0, 4000);

  const effects: WebhookEffect[] = [];
  for (const task of tasks) {
    const ev = await store.reportEvidence({
      task_id: task.id,
      agent_id: reviewer,
      kind: "review",
      command: command("pull_request_review", delivery, state || "submitted"),
      exit_code: exitCode,
      output,
      ac_ids: state === "approved" ? acIds(task, "review") : [],
    });
    if (!ev?.id) {
      effects.push({ action: "skipped", task_id: task.id, reason: ev?.error ?? "evidence failed" });
      continue;
    }
    effects.push({ action: "evidence", task_id: task.id, evidence_id: ev.id, kind: "review" });
  }
  return effects;
}

function checkHints(check: any): LinkHint[] {
  const branch = check.head_branch ?? check.check_suite?.head_branch;
  const prs = Array.isArray(check.pull_requests) ? check.pull_requests : [];
  if (!prs.length) return [{ kind: "pull", headRef: typeof branch === "string" ? branch : undefined }];
  return prs.map((pr: any) => ({
    kind: "pull" as const,
    number: asNumber(pr?.number),
    url: typeof pr?.html_url === "string" ? pr.html_url : undefined,
    body: typeof pr?.body === "string" ? pr.body : undefined,
    headRef: typeof pr?.head?.ref === "string" ? pr.head.ref : (typeof branch === "string" ? branch : undefined),
  }));
}

/** Marker, branch id, conventional pr-/gh- id, then a spec_ref scan. */
async function linkedTasks(store: IStore, hints: LinkHint[]): Promise<any[]> {
  const found = new Map<string, any>();
  const add = (task: any) => {
    if (task?.id && !found.has(task.id)) found.set(task.id, task);
  };

  for (const hint of hints) {
    const marker = markerId(hint.body);
    if (marker) add(await store.getTask(marker));
    const fromRef = taskIdFromGitRef(hint.headRef);
    if (fromRef) add(await store.getTask(fromRef));
    if (hint.number != null) {
      add(await store.getTask(hint.kind === "issue" ? `gh-${hint.number}` : `pr-${hint.number}`));
    }
  }

  const rows = await store.listTasks();
  for (const row of rows) {
    if (found.has(row.id)) continue;
    const task = await store.getTask(row.id);
    if (task && hints.some((hint) => specMatches(task.spec_ref, hint))) add(task);
  }
  return [...found.values()];
}

async function taskForIssue(store: IStore, issue: any, payload: any): Promise<any | null> {
  const marker = markerId(issue.body);
  if (marker) {
    const marked = await store.getTask(marker);
    if (marked) return marked;
  }
  const number = asNumber(issue.number);
  if (number == null) return null;
  const byId = await store.getTask(`gh-${number}`);
  if (byId) return byId;
  const hint: LinkHint = {
    kind: "issue",
    number,
    url: issueUrl(payload, issue) || undefined,
    body: typeof issue.body === "string" ? issue.body : undefined,
  };
  const rows = await store.listTasks();
  for (const row of rows) {
    const task = await store.getTask(row.id);
    if (task && specMatches(task.spec_ref, hint)) return task;
  }
  return null;
}

function specMatches(specRef: unknown, hint: LinkHint): boolean {
  if (typeof specRef !== "string" || !specRef) return false;
  if (hint.url && specRef === hint.url) return true;
  if (hint.number == null) return false;
  const alts = hint.kind === "pull" ? "pull|pulls" : "issues";
  const re = new RegExp(`/(?:${alts})/${hint.number}(?:$|[^0-9])`);
  return re.test(specRef);
}

function taskIdFromGitRef(ref: string | undefined): string | undefined {
  if (!ref) return undefined;
  const task = /(?:^|\/)(task-[a-f0-9]+)\/?$/i.exec(ref);
  if (task) return task[1].toLowerCase();
  const prefixed = /(?:^|\/)((?:gh|pr)-\d+)\/?$/i.exec(ref);
  return prefixed?.[1].toLowerCase();
}

function markerId(body: unknown): string | undefined {
  if (typeof body !== "string") return undefined;
  return /uw:([\w-]+)/.exec(body)?.[1];
}

function asNumber(value: unknown): number | undefined {
  const n = typeof value === "number" ? value : typeof value === "string" && /^\d+$/.test(value) ? Number(value) : NaN;
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

function priorityFromLabels(labels: unknown): number {
  if (!Array.isArray(labels)) return 2;
  for (const label of labels) {
    const name = typeof label === "string" ? label : label?.name;
    const match = typeof name === "string" ? /^p([0-4])$/i.exec(name) : null;
    if (match) return Number(match[1]);
  }
  return 2;
}

function issueTitle(number: number, title: unknown): string {
  return `[#${number}] ${typeof title === "string" ? title : ""}`;
}

function issueUrl(payload: any, issue: any): string {
  if (typeof issue.html_url === "string" && issue.html_url) return issue.html_url;
  const repo = payload?.repository?.full_name;
  if (typeof repo === "string" && repo) return `https://github.com/${repo}/issues/${issue.number}`;
  return "";
}

function acIds(task: any, id: string): string[] {
  const ac = Array.isArray(task?.ac_ids) ? task.ac_ids : [];
  return ac.includes(id) ? [id] : [];
}

function exitForConclusion(conclusion: string): number | undefined {
  const value = conclusion.toLowerCase();
  if (!value) return undefined;
  if (PASSING.has(value)) return 0;
  if (FAILING.has(value)) return 1;
  return undefined;
}

function reviewExit(state: string): number | undefined {
  if (state === "approved" || state === "commented") return 0;
  if (state === "changes_requested" || state === "dismissed") return 1;
  return undefined;
}

function checkLabel(event: string, check: any): string {
  if (event === "check_suite") {
    const app = check?.app?.name;
    return typeof app === "string" && app ? app : "check_suite";
  }
  return typeof check?.name === "string" && check.name ? check.name : "check_run";
}

function command(event: string, delivery: string | undefined, detail: string): string {
  return ["webhook", event, delivery, detail].filter((part) => part !== undefined && part !== "").join(" ");
}

function header(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  if (Array.isArray(value)) return value[0];
  return value;
}

function send(res: ServerResponse, status: number, body: unknown, extra?: Record<string, string>) {
  if (res.headersSent || res.writableEnded) return;
  const json = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(json),
    ...extra,
  });
  res.end(json);
}

function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  const declared = Number(req.headers["content-length"]);
  if (Number.isFinite(declared) && declared > limit) {
    const err = new Error("payload too large") as Error & { statusCode?: number };
    err.statusCode = 413;
    return Promise.reject(err);
  }
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const cleanup = () => {
      req.off("data", onData);
      req.off("end", onEnd);
      req.off("error", onError);
    };
    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    };
    const succeed = (body: Buffer) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(body);
    };
    const onData = (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        req.pause();
        const err = new Error("payload too large") as Error & { statusCode?: number };
        err.statusCode = 413;
        fail(err);
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = () => succeed(Buffer.concat(chunks));
    const onError = (err: Error) => fail(err);
    req.on("data", onData);
    req.on("end", onEnd);
    req.on("error", onError);
  });
}
