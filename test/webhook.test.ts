import { createHmac } from "node:crypto";
import { once } from "node:events";
import { rmSync, readFileSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteStore } from "../src/store.js";
import { serveHttp } from "../src/server.js";
import {
  dispatchGithubEvent,
  verifyGithubSignature,
  webhookSecretFromEnv,
  WEBHOOK_SECRET_ENV,
  WEBHOOK_SECRET_FALLBACK_ENV,
} from "../src/webhook.js";

const DB = "/tmp/uw-test-webhook.db";
const root = fileURLToPath(new URL("..", import.meta.url));
let store: SqliteStore;

function sign(body: string | Buffer, secret: string) {
  return "sha256=" + createHmac("sha256", secret).update(body).digest("hex");
}

beforeEach(() => {
  rmSync(DB, { force: true });
  rmSync(`${DB}-wal`, { force: true });
  rmSync(`${DB}-shm`, { force: true });
  store = new SqliteStore(DB);
});

afterEach(() => store.close());

describe("verifyGithubSignature", () => {
  const body = Buffer.from('{"zen":"practice"}');
  const secret = "topsecret";

  it("accepts an HMAC-SHA256 of the raw body", () => {
    expect(verifyGithubSignature(body, sign(body, secret), secret)).toBe(true);
  });

  it("rejects a tampered body, a wrong secret, a missing header, sha1, and an empty secret", () => {
    expect(verifyGithubSignature(Buffer.from(body + " "), sign(body, secret), secret)).toBe(false);
    expect(verifyGithubSignature(body, sign(body, "other"), secret)).toBe(false);
    expect(verifyGithubSignature(body, undefined, secret)).toBe(false);
    expect(verifyGithubSignature(body, "sha1=abcdef", secret)).toBe(false);
    expect(verifyGithubSignature(body, sign(body, secret), "")).toBe(false);
    expect(verifyGithubSignature(body, "sha256=abc", secret)).toBe(false);
  });

  it("accepts uppercase hex", () => {
    const upper = sign(body, secret).replace(/sha256=(.*)/, (_, hex) => `sha256=${hex.toUpperCase()}`);
    expect(verifyGithubSignature(body, upper, secret)).toBe(true);
  });
});

describe("webhookSecretFromEnv", () => {
  it("prefers UNDERWRIGHT_GITHUB_WEBHOOK_SECRET and falls back to GITHUB_WEBHOOK_SECRET", () => {
    expect(webhookSecretFromEnv({
      [WEBHOOK_SECRET_ENV]: "primary",
      [WEBHOOK_SECRET_FALLBACK_ENV]: "fallback",
    })).toBe("primary");
    expect(webhookSecretFromEnv({ [WEBHOOK_SECRET_FALLBACK_ENV]: "fallback" })).toBe("fallback");
    expect(webhookSecretFromEnv({})).toBe("");
  });
});

describe("event map", () => {
  it("records ci_check evidence for a completed check_run on the PR task", async () => {
    store.createTask({
      id: "pr-7",
      title: "PR task",
      spec_ref: "https://github.com/org/repo/pull/7",
      ac_ids: ["checks-gate"],
    });

    const result = await dispatchGithubEvent(store, "check_run", {
      action: "completed",
      check_run: {
        name: "test",
        status: "completed",
        conclusion: "success",
        html_url: "https://github.com/org/repo/runs/1",
        head_sha: "abc123",
        pull_requests: [{ number: 7 }],
      },
      repository: { full_name: "org/repo" },
    }, { delivery: "deliv-check" });

    expect(result.effects).toEqual([
      { action: "evidence", task_id: "pr-7", evidence_id: expect.any(String), kind: "ci_check" },
    ]);
    const [ev] = store.getEvidence("pr-7") as any[];
    expect(ev.kind).toBe("ci_check");
    expect(ev.exit_code).toBe(0);
    expect(ev.command).toContain("deliv-check");
    expect(ev.output).toContain("test");
    expect(JSON.parse(ev.ac_ids)).toEqual(["checks-gate"]);
  });

  it("links a check_suite by spec_ref when the task id is not pr-<n>", async () => {
    store.createTask({
      id: "task-custom",
      title: "Linked by URL",
      spec_ref: "https://github.com/org/repo/pull/7",
    });

    const result = await dispatchGithubEvent(store, "check_suite", {
      action: "completed",
      check_suite: {
        status: "completed",
        conclusion: "failure",
        head_branch: "feat/else",
        head_sha: "def456",
        app: { name: "GitHub Actions" },
        pull_requests: [{ number: 7, html_url: "https://github.com/org/repo/pull/7" }],
      },
      repository: { full_name: "org/repo" },
    });

    expect(result.effects).toMatchObject([
      { action: "evidence", task_id: "task-custom", kind: "ci_check" },
    ]);
    const [ev] = store.getEvidence("task-custom") as any[];
    expect(ev.exit_code).toBe(1);
    expect(JSON.parse(ev.ac_ids)).toEqual([]);
    expect(ev.output).toContain("failure");
  });

  it("links a check with no pull request via the head branch task id", async () => {
    store.createTask({ id: "task-abc123", title: "branch task" });
    const result = await dispatchGithubEvent(store, "check_run", {
      action: "completed",
      check_run: {
        name: "build",
        status: "completed",
        conclusion: "neutral",
        check_suite: { head_branch: "feat/task-abc123", head_sha: "fff" },
        pull_requests: [],
      },
    });
    expect(result.effects).toMatchObject([
      { action: "evidence", task_id: "task-abc123", kind: "ci_check" },
    ]);
    const [ev] = store.getEvidence("task-abc123") as any[];
    expect(ev.exit_code).toBe(0);
  });

  it("does not invent a task when a check is not linked", async () => {
    const result = await dispatchGithubEvent(store, "check_run", {
      action: "completed",
      check_run: {
        name: "test",
        conclusion: "success",
        pull_requests: [{ number: 99 }],
      },
    });
    expect(result.effects).toEqual([{ action: "ignored", reason: "no linked task" }]);
    expect(store.listTasks()).toEqual([]);
  });

  it("syncs an edited issue onto the existing gh-<n> task", async () => {
    store.createTask({
      id: "gh-29",
      title: "old",
      description: "old body",
      ac_ids: ["keep-me"],
      priority: 2,
    });

    const result = await dispatchGithubEvent(store, "issues", {
      action: "edited",
      issue: {
        number: 29,
        title: "New title",
        body: "updated body",
        state: "open",
        html_url: "https://github.com/org/repo/issues/29",
        labels: [{ name: "p0" }],
      },
      repository: { full_name: "org/repo" },
    });

    expect(result.effects).toEqual([{ action: "synced", task_id: "gh-29" }]);
    const task = store.getTask("gh-29");
    expect(task.title).toBe("[#29] New title");
    expect(task.description).toBe("updated body");
    expect(task.spec_ref).toBe("https://github.com/org/repo/issues/29");
    expect(task.ac_ids).toEqual(["keep-me"]);
    expect(task.status).toBe("open");
  });

  it("updates the uw: marker task instead of creating gh-<n>", async () => {
    store.createTask({ id: "task-existing", title: "keep this id", description: "x" });
    const result = await dispatchGithubEvent(store, "issues", {
      action: "edited",
      issue: {
        number: 29,
        title: "From marker",
        body: "see uw:task-existing for the board id",
        state: "open",
        html_url: "https://github.com/org/repo/issues/29",
      },
    });
    expect(result.effects).toEqual([{ action: "synced", task_id: "task-existing" }]);
    expect(store.getTask("gh-29")).toBeNull();
    expect(store.getTask("task-existing").title).toBe("[#29] From marker");
  });

  it("creates a task when an issue is opened and closes it when the issue closes", async () => {
    const opened = await dispatchGithubEvent(store, "issues", {
      action: "opened",
      issue: {
        number: 15,
        title: "Ship webhook",
        body: "please",
        state: "open",
        html_url: "https://github.com/org/repo/issues/15",
        labels: [{ name: "p1" }],
      },
    });
    expect(opened.effects).toEqual([{ action: "created", task_id: "gh-15" }]);
    expect(store.getTask("gh-15")).toMatchObject({
      title: "[#15] Ship webhook",
      description: "please",
      spec_ref: "https://github.com/org/repo/issues/15",
      priority: 1,
      status: "open",
    });

    const closed = await dispatchGithubEvent(store, "issues", {
      action: "closed",
      issue: {
        number: 15,
        title: "Ship webhook",
        body: "please",
        state: "closed",
        html_url: "https://github.com/org/repo/issues/15",
      },
    });
    expect(closed.effects).toEqual([{ action: "synced", task_id: "gh-15" }]);
    expect(store.getTask("gh-15").status).toBe("done");
  });

  it("skips a closed issue that was never imported and reopens a done task", async () => {
    const skipped = await dispatchGithubEvent(store, "issues", {
      action: "closed",
      issue: { number: 4, title: "ancient", state: "closed", html_url: "https://github.com/org/repo/issues/4" },
    });
    expect(skipped.effects).toEqual([{ action: "skipped", reason: "closed issue has no task" }]);

    store.createTask({ id: "gh-4", title: "done already" });
    store.setTaskStatus("gh-4", "done", "tester");
    const reopened = await dispatchGithubEvent(store, "issues", {
      action: "reopened",
      issue: { number: 4, title: "done already", state: "open", html_url: "https://github.com/org/repo/issues/4" },
    });
    expect(reopened.effects).toEqual([{ action: "synced", task_id: "gh-4" }]);
    expect(store.getTask("gh-4").status).toBe("open");
  });

  it("records review evidence for a submitted pull_request_review", async () => {
    store.createTask({
      id: "task-feat",
      title: "Feature",
      ac_ids: ["review"],
      spec_ref: "https://github.com/org/repo/pull/7",
    });

    const approved = await dispatchGithubEvent(store, "pull_request_review", {
      action: "submitted",
      review: {
        user: { login: "ada" },
        body: "LGTM",
        state: "approved",
        html_url: "https://github.com/org/repo/pull/7#pullrequestreview-1",
        commit_id: "abc",
      },
      pull_request: {
        number: 7,
        title: "Add webhook",
        body: "uw:task-feat",
        html_url: "https://github.com/org/repo/pull/7",
        head: { ref: "feat/webhook", sha: "abc" },
      },
    }, { delivery: "deliv-review" });

    expect(approved.effects).toEqual([
      { action: "evidence", task_id: "task-feat", evidence_id: expect.any(String), kind: "review" },
    ]);
    const [ev] = store.getEvidence("task-feat") as any[];
    expect(ev.kind).toBe("review");
    expect(ev.agent_id).toBe("github:ada");
    expect(ev.exit_code).toBe(0);
    expect(ev.output).toContain("LGTM");
    expect(ev.command).toContain("deliv-review");
    expect(JSON.parse(ev.ac_ids)).toEqual(["review"]);

    const changes = await dispatchGithubEvent(store, "pull_request_review", {
      action: "submitted",
      review: { user: { login: "ada" }, body: "fix tests", state: "changes_requested", html_url: "https://github.com/org/repo/pull/7#pullrequestreview-2" },
      pull_request: { number: 7, body: "uw:task-feat", html_url: "https://github.com/org/repo/pull/7" },
    });
    expect(changes.effects).toMatchObject([{ action: "evidence", task_id: "task-feat", kind: "review" }]);
    const rows = store.getEvidence("task-feat") as any[];
    const requested = rows.find((e) => String(e.output).includes("fix tests"));
    expect(requested.exit_code).toBe(1);
    expect(JSON.parse(requested.ac_ids)).toEqual([]);
  });

  it("ignores events that are not part of the map", async () => {
    const result = await dispatchGithubEvent(store, "push", { ref: "refs/heads/main" });
    expect(result).toEqual({ event: "push", effects: [{ action: "ignored", reason: "unhandled event" }] });
  });
});

describe("docs", () => {
  it("documents the env secret and repository webhook setup", () => {
    const doc = readFileSync(join(root, "docs/webhook.md"), "utf8");
    expect(doc).toContain("UNDERWRIGHT_GITHUB_WEBHOOK_SECRET");
    expect(doc).toContain("GITHUB_WEBHOOK_SECRET");
    expect(doc).toContain("/github/webhook");
    expect(doc).toContain("check_run");
    expect(doc).toContain("check_suite");
    expect(doc).toContain("pull_request_review");
    expect(doc).toContain("Issues");
    const readme = readFileSync(join(root, "README.md"), "utf8");
    expect(readme).toContain("docs/webhook.md");
    expect(readme).toContain("UNDERWRIGHT_GITHUB_WEBHOOK_SECRET");
  });
});

describe("POST /github/webhook", () => {
  const secret = "webhook-secret";
  let http: Server | undefined;
  let port = 0;
  const httpDb = "/tmp/uw-test-webhook-http.db";
  const savedSecret = process.env[WEBHOOK_SECRET_ENV];
  const savedFallback = process.env[WEBHOOK_SECRET_FALLBACK_ENV];
  const savedDatabaseUrl = process.env.DATABASE_URL;

  function restoreEnv(name: string, value: string | undefined) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }

  async function start(token?: string) {
    process.env.DATABASE_URL = "";
    rmSync(httpDb, { force: true });
    rmSync(`${httpDb}-wal`, { force: true });
    rmSync(`${httpDb}-shm`, { force: true });
    http = await serveHttp(httpDb, "127.0.0.1", 0, token);
    port = (http.address() as AddressInfo).port;
  }

  async function stop() {
    if (!http) return;
    const closed = once(http, "close");
    http.close();
    await closed;
    http = undefined;
  }

  afterEach(async () => {
    await stop();
    restoreEnv(WEBHOOK_SECRET_ENV, savedSecret);
    restoreEnv(WEBHOOK_SECRET_FALLBACK_ENV, savedFallback);
    restoreEnv("DATABASE_URL", savedDatabaseUrl);
  });

  async function post(body: string, headers: Record<string, string>, path = "/github/webhook") {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, { method: "POST", headers, body });
    const text = await res.text();
    return { status: res.status, text };
  }

  it("accepts a signed check_run and rejects a bad signature", async () => {
    process.env[WEBHOOK_SECRET_ENV] = secret;
    await start();
    const seed = new SqliteStore(httpDb);
    seed.createTask({ id: "pr-7", title: "PR", spec_ref: "https://github.com/org/repo/pull/7" });
    seed.close();

    const payload = JSON.stringify({
      action: "completed",
      check_run: {
        name: "test",
        status: "completed",
        conclusion: "success",
        html_url: "https://github.com/org/repo/runs/9",
        pull_requests: [{ number: 7 }],
      },
      repository: { full_name: "org/repo" },
    });
    const ok = await post(payload, {
      "content-type": "application/json",
      "x-github-event": "check_run",
      "x-github-delivery": "http-deliv",
      "x-hub-signature-256": sign(payload, secret),
    });
    expect(ok.status).toBe(200);
    const parsed = JSON.parse(ok.text);
    expect(parsed.ok).toBe(true);
    expect(parsed.effects[0]).toMatchObject({ action: "evidence", task_id: "pr-7", kind: "ci_check" });

    const bad = await post(payload, {
      "content-type": "application/json",
      "x-github-event": "check_run",
      "x-hub-signature-256": sign(payload, "nope"),
    });
    expect(bad.status).toBe(401);
    expect(JSON.parse(bad.text).error).toMatch(/signature/i);

    const check = new SqliteStore(httpDb);
    try {
      const rows = check.getEvidence("pr-7") as any[];
      expect(rows).toHaveLength(1);
      expect(rows[0].command).toContain("http-deliv");
    } finally {
      check.close();
    }
  });

  it("accepts the fallback secret env and a trailing-slash URL", async () => {
    delete process.env[WEBHOOK_SECRET_ENV];
    process.env[WEBHOOK_SECRET_FALLBACK_ENV] = secret;
    await start();
    const body = JSON.stringify({ zen: "keep it logically awesome" });
    const res = await post(body, {
      "content-type": "application/json",
      "x-github-event": "ping",
      "x-hub-signature-256": sign(body, secret),
    }, "/github/webhook/?from=github");
    expect(res.status).toBe(200);
    expect(JSON.parse(res.text)).toMatchObject({ ok: true, event: "ping" });
  });

  it("fails closed when the secret is unset, and does not require the bearer token", async () => {
    delete process.env[WEBHOOK_SECRET_ENV];
    delete process.env[WEBHOOK_SECRET_FALLBACK_ENV];
    await start("bearer-token");

    const body = JSON.stringify({ zen: "hi" });
    const missing = await post(body, {
      "content-type": "application/json",
      "x-github-event": "ping",
      "x-hub-signature-256": sign(body, secret),
    });
    expect(missing.status).toBe(503);

    process.env[WEBHOOK_SECRET_ENV] = secret;
    const authed = await post(body, {
      "content-type": "application/json",
      "x-github-event": "ping",
      "x-hub-signature-256": sign(body, secret),
    });
    expect(authed.status).toBe(200);

    const mcp = await fetch(`http://127.0.0.1:${port}/mcp`, { method: "POST" });
    expect(mcp.status).toBe(401);
    const health = await fetch(`http://127.0.0.1:${port}/health`);
    expect(health.status).toBe(200);
  });

  it("rejects the wrong method, bad json, and an oversized body", async () => {
    process.env[WEBHOOK_SECRET_ENV] = secret;
    await start();
    const get = await fetch(`http://127.0.0.1:${port}/github/webhook`);
    expect(get.status).toBe(405);

    const badJson = "{";
    const parsed = await post(badJson, {
      "content-type": "application/json",
      "x-github-event": "ping",
      "x-hub-signature-256": sign(badJson, secret),
    });
    expect(parsed.status).toBe(400);

    const big = "x".repeat(2_000_001);
    const huge = await post(big, {
      "content-type": "application/json",
      "x-github-event": "ping",
      "x-hub-signature-256": sign(big, secret),
    });
    expect(huge.status).toBe(413);
  });
});
