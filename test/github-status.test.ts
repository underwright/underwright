import { generateKeyPairSync } from "node:crypto";
import { rmSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteStore } from "../src/store.js";
import { appIssuePoster, repoInstallationId } from "../src/github-app.js";
import { ghIssuePoster } from "../src/github.js";
import { getGithubStatusPolicy } from "../src/policy.js";
import {
  STATUS_ACTOR,
  backoffMs,
  issueRefFor,
  postIssueDigests,
  publishStatusChanges,
  renderTaskDigest,
} from "../src/github-status.js";

const DB = "/tmp/uw-test-github-status.db";
let store: SqliteStore;
type Post = { repo: string; number: number; body: string };

function recorder(fail = false) {
  const posts: Post[] = [];
  const post = async (repo: string, number: number, body: string) => {
    if (fail) throw new Error("GitHub 502");
    posts.push({ repo, number, body });
  };
  return { posts, post };
}

beforeEach(() => {
  for (const s of ["", "-wal", "-shm"]) rmSync(DB + s, { force: true });
  store = new SqliteStore(DB);
  // The repo policy enforces definition-of-ready on claims; default the triage fields.
  const create = store.createTask.bind(store);
  store.createTask = (a) => create({ description: "test task", estimate: "S", type: "tdd", ac_ids: ["a1"], ...a });
});
afterEach(() => store.close());

describe("issueRefFor", () => {
  it("prefers a spec_ref issue URL, then gh-N, then [#N] with the default repo", () => {
    expect(issueRefFor({ id: "t1", spec_ref: "https://github.com/acme/app/issues/7" }, "x/y")).toEqual({ repo: "acme/app", number: 7 });
    expect(issueRefFor({ id: "gh-12" }, "acme/app")).toEqual({ repo: "acme/app", number: 12 });
    expect(issueRefFor({ id: "task-1", title: "[#62] Board status" }, "acme/app")).toEqual({ repo: "acme/app", number: 62 });
    expect(issueRefFor({ id: "gh-12" })).toBeNull();
    expect(issueRefFor({ id: "t2", spec_ref: "https://github.com/acme/app/pull/3" }, undefined)).toBeNull();
  });
});

describe("status-comments", () => {
  it("seeds silently, then comments once per status change", async () => {
    store.createTask({ id: "gh-5", title: "[#5] thing", ac_ids: ["a1"] });
    const { posts, post } = recorder();

    const first = await publishStatusChanges(store, { post, defaultRepo: "acme/app" });
    expect(first.seeded).toEqual(["gh-5"]);
    expect(posts).toHaveLength(0);

    store.claimTask("gh-5", "claude@box");
    const second = await publishStatusChanges(store, { post, defaultRepo: "acme/app" });
    expect(second.posted).toEqual([{ task_id: "gh-5", from: "open", to: "claimed", issue: "acme/app#5" }]);
    expect(posts[0]).toMatchObject({ repo: "acme/app", number: 5 });
    expect(posts[0].body).toContain("open → claimed");
    expect(posts[0].body).toContain("`claude@box`");

    // Idempotent: no change, no comment.
    await publishStatusChanges(store, { post, defaultRepo: "acme/app" });
    expect(posts).toHaveLength(1);
  });

  it("attaches the evidence pack on completion", async () => {
    store.createTask({ id: "gh-6", title: "[#6] done soon", ac_ids: ["a1"], type: "tdd" });
    const { posts, post } = recorder();
    await publishStatusChanges(store, { post, defaultRepo: "acme/app" });
    store.claimTask("gh-6", "codex@box");
    store.reportEvidence({ task_id: "gh-6", agent_id: "codex@box", kind: "test_run", command: "npm test", exit_code: 0, output: "ok", ac_ids: ["a1"] });
    const done = store.completeTask("gh-6", "codex@box");
    expect(done.error).toBeUndefined();

    const res = await publishStatusChanges(store, { post, defaultRepo: "acme/app" });
    expect(res.posted[0]).toMatchObject({ from: "open", to: "done" });
    expect(posts[0].body).toContain("open → done");
    expect(posts[0].body).toContain("### Evidence pack — gh-6");
    expect(posts[0].body).toContain("npm test");
  });

  it("suppresses echoes of changes that came from GitHub", async () => {
    store.createTask({ id: "gh-7", title: "[#7] closed on GitHub" });
    const { posts, post } = recorder();
    await publishStatusChanges(store, { post, defaultRepo: "acme/app" });
    store.setTaskStatus("gh-7", "done", "github-webhook");
    const res = await publishStatusChanges(store, { post, defaultRepo: "acme/app" });
    expect(res.suppressed).toEqual(["gh-7"]);
    expect(posts).toHaveLength(0);
    expect(store.listGithubStatus()[0].last_status).toBe("done");
  });

  it("records failures, backs off, then retries", async () => {
    store.createTask({ id: "gh-8", title: "[#8] flaky" });
    await publishStatusChanges(store, { post: recorder().post, defaultRepo: "acme/app" });
    store.claimTask("gh-8", "a@b");

    let t = Date.parse("2026-11-08T12:00:00Z");
    const now = () => t;
    const bad = await publishStatusChanges(store, { post: recorder(true).post, defaultRepo: "acme/app", now });
    expect(bad.failed[0]).toMatchObject({ task_id: "gh-8", error: "GitHub 502" });
    const row = store.listGithubStatus()[0];
    expect(row).toMatchObject({ last_status: "open", attempts: 1, last_error: "GitHub 502" });

    const good = recorder();
    const early = await publishStatusChanges(store, { post: good.post, defaultRepo: "acme/app", now });
    expect(early.deferred).toEqual(["gh-8"]);
    t += backoffMs(1);
    const retried = await publishStatusChanges(store, { post: good.post, defaultRepo: "acme/app", now });
    expect(retried.posted).toHaveLength(1);
    expect(store.listGithubStatus()[0]).toMatchObject({ last_status: "claimed", attempts: 0, last_error: null });
  });

  it("caps comments per pass", async () => {
    for (const n of [1, 2, 3]) store.createTask({ id: `gh-${n}`, title: `[#${n}]` });
    const { posts, post } = recorder();
    await publishStatusChanges(store, { post, defaultRepo: "acme/app" });
    for (const n of [1, 2, 3]) store.claimTask(`gh-${n}`, "a@b");
    const res = await publishStatusChanges(store, { post, defaultRepo: "acme/app", maxPosts: 2 });
    expect(res.posted).toHaveLength(2);
    expect(res.deferred).toHaveLength(1);
    await publishStatusChanges(store, { post, defaultRepo: "acme/app", maxPosts: 2 });
    expect(posts).toHaveLength(3);
  });

  it("audit-logs mirror updates under the github-status actor", async () => {
    store.createTask({ id: "gh-9", title: "[#9]" });
    await publishStatusChanges(store, { post: recorder().post, defaultRepo: "acme/app" });
    const ev = store.taskEvents("gh-9").find((e: any) => e.entity_type === "github_status");
    expect(ev).toMatchObject({ action: "updated", actor: STATUS_ACTOR });
  });
});

describe("digest", () => {
  it("summarises claim, AC coverage, evidence and artifacts", async () => {
    store.createTask({ id: "gh-20", title: "[#20] digest me", ac_ids: ["a1", "a2"] });
    store.claimTask("gh-20", "kimi@box");
    store.reportEvidence({ task_id: "gh-20", agent_id: "kimi@box", kind: "test_run", command: "npm test", exit_code: 0, ac_ids: ["a1"] });
    store.postArtifact({ task_id: "gh-20", agent_id: "kimi@box", kind: "design", title: "plan", content: "x" });

    const body = (await renderTaskDigest(store, "gh-20", null))!;
    expect(body).toContain("`gh-20` is **claimed**");
    expect(body).toContain("Claim: `kimi@box`");
    expect(body).toContain("1/2 (missing: a2)");
    expect(body).toContain("test_run by `kimi@box`");
    expect(body).toContain("design: plan");
    expect(body).toMatch(/claimed ×1/);
  });

  it("posts for open linked tasks only, skips quiet ones until forced, respects cadence", async () => {
    store.createTask({ id: "gh-21", title: "[#21] open" });
    store.createTask({ id: "gh-22", title: "[#22] done" });
    store.setTaskStatus("gh-22", "done", "human");
    store.createTask({ id: "task-x", title: "unlinked" });

    let t = Date.now();
    const now = () => t;
    const { posts, post } = recorder();
    const first = await postIssueDigests(store, { post, defaultRepo: "acme/app", everyHours: 24, now });
    expect(first.posted.map((p) => p.task_id)).toEqual(["gh-21"]);
    expect(posts[0]).toMatchObject({ repo: "acme/app", number: 21 });

    // Cadence: not due yet.
    const again = await postIssueDigests(store, { post, defaultRepo: "acme/app", everyHours: 24, now });
    expect(again.skipped).toContain("gh-21");

    // Due, but nothing happened → skipped; forced → posted.
    t += 25 * 3_600_000;
    const quiet = await postIssueDigests(store, { post, defaultRepo: "acme/app", everyHours: 24, now });
    expect(quiet.posted).toHaveLength(0);
    const forced = await postIssueDigests(store, { post, defaultRepo: "acme/app", everyHours: 24, now, force: true });
    expect(forced.posted).toHaveLength(1);

    // A digest does not move the status baseline.
    expect(store.listGithubStatus().find((r) => r.task_id === "gh-21")?.last_status).toBe("open");
  });
});

describe("posters and policy", () => {
  it("app poster resolves the repo installation and caches the token", async () => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const creds = { appId: "1", privateKey: privateKey.export({ type: "pkcs8", format: "pem" }).toString() };
    const calls: string[] = [];
    const fetchImpl = async (url: string, init?: any) => {
      calls.push(`${init?.method} ${url.replace("https://api.github.com", "")}`);
      const body = url.endsWith("/installation") ? { id: 42 }
        : url.endsWith("/access_tokens") ? { token: "ghs_x" }
        : { id: 9, html_url: "https://github.com/acme/app/issues/5#c9" };
      return { ok: true, status: 200, json: async () => body, text: async () => "" };
    };
    expect(await repoInstallationId(creds, "acme/app", fetchImpl)).toBe(42);
    calls.length = 0;
    const post = appIssuePoster(creds, fetchImpl);
    await post("acme/app", 5, "hi");
    await post("acme/app", 6, "again");
    expect(calls).toEqual([
      "GET /repos/acme/app/installation",
      "POST /app/installations/42/access_tokens",
      "POST /repos/acme/app/issues/5/comments",
      "POST /repos/acme/app/issues/6/comments",
    ]);
  });

  it("gh poster shells to gh issue comment with the body on stdin", async () => {
    const seen: [string, string?][] = [];
    await ghIssuePoster((cmd, input) => { seen.push([cmd, input]); return ""; })("acme/app", 5, "body");
    expect(seen).toEqual([["issue comment 5 --repo acme/app --body-file -", "body"]]);
    await expect(ghIssuePoster(() => "")("acme/app; rm -rf /", 5, "x")).rejects.toThrow(/invalid issue/);
  });

  it("policy defaults off and validates repo/digest_hours", () => {
    expect(getGithubStatusPolicy({ dod: {}, enforcement: "observe" })).toEqual({ status_comments: false, repo: undefined, digest_hours: 0 });
    expect(getGithubStatusPolicy({ dod: {}, enforcement: "observe", github: { status_comments: true, repo: "acme/app", digest_hours: 12 } }))
      .toEqual({ status_comments: true, repo: "acme/app", digest_hours: 12 });
    expect(getGithubStatusPolicy({ dod: {}, enforcement: "observe", github: { repo: "bad repo", digest_hours: -1 } }))
      .toMatchObject({ repo: undefined, digest_hours: 0 });
  });
});
