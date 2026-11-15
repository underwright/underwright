import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteStore } from "../src/store.js";
import { ghIssuePoster, issueRefFor, publishGithubStatus, renderTaskDigest, startGithubStatusLoop } from "../src/github-status.js";

let store: SqliteStore;
let dir: string;
const repo = "org/repo";
const epoch = Date.parse("2026-11-15T00:00:00Z");
let comments: { body: string; marker: string; issue: number }[];
const run = (options: Partial<Parameters<typeof publishGithubStatus>[1]> = {}) => publishGithubStatus(store, {
  repo, nowMs: epoch, poster: async (_repo, issue, body, marker) => { comments.push({ issue, body, marker }); }, ...options,
});
function task(id = "gh-62") {
  return store.createTask({ id, title: "Status mirror", ac_ids: ["scope", "tests"] });
}
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "uw-status-"));
  process.env.UNDERWRIGHT_POLICY = join(dir, "no-policy.json");
  store = new SqliteStore(join(dir, "test.db"));
  comments = [];
});
afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });

describe("durable GitHub reporting", () => {
  it("routes explicit issue links only to their own repository, excluding PRs", () => {
    expect(issueRefFor({ id: "gh-62" }, repo)).toBe(62);
    expect(issueRefFor({ id: "task-abc", title: "[#9] Work" }, repo)).toBe(9);
    expect(issueRefFor({ spec_ref: "https://github.com/ORG/REPO/issues/7" }, repo)).toBe(7);
    expect(issueRefFor({ id: "gh-62", spec_ref: "https://github.com/other/repo/issues/7" }, repo)).toBeNull();
    expect(issueRefFor({ id: "gh-62", spec_ref: "https://github.com/org/repo/pull/7" }, repo)).toBeNull();
  });
  it("baselines old tasks without flooding, then reports claims and releases once", async () => {
    task();
    expect((await run()).baselined).toBe(1);
    expect(comments).toHaveLength(0);
    store.claimTask("gh-62", "agent@host");
    expect((await run()).posted).toBe(1);
    expect(comments[0].body).toContain("open → claimed");
    expect(comments[0].body).toContain("agent@host");
    expect((await run()).posted).toBe(0);
    store.releaseTask("gh-62", "agent@host");
    await run();
    expect(comments[1].body).toContain("claimed → open");
  });
  it("reports new evidence and completion with acceptance criterion summary", async () => {
    task(); await run();
    store.reportEvidence({ task_id: "gh-62", agent_id: "agent", kind: "test_run", exit_code: 0, ac_ids: ["tests"], output: "private output" });
    await run();
    expect(comments[0].body).toContain("test_run by `agent`: exit 0; proves tests");
    expect(comments[0].body).toContain("missing evidence for scope");
    expect(comments[0].body).not.toContain("private output");
    store.setTaskStatus("gh-62", "done", "agent"); await run();
    expect(comments[1].body).toContain("open → done");
    expect(comments[1].body).toContain("Evidence summary");
  });
  it("silently advances webhook changes and then reports agent changes", async () => {
    task(); await run();
    store.setTaskStatus("gh-62", "done", "github-webhook");
    await run(); expect(comments).toHaveLength(0);
    store.setTaskStatus("gh-62", "open", "agent"); await run();
    expect(comments[0].body).toContain("done → open");
  });
  it("keeps state across reopen and does not duplicate a delivered transition", async () => {
    task(); await run(); store.setTaskStatus("gh-62", "blocked", "agent"); await run();
    store.close(); store = new SqliteStore(join(dir, "test.db"));
    await run(); expect(comments).toHaveLength(1);
  });
  it("retries failed delivery with the same marker and durable backoff", async () => {
    task(); await run(); store.setTaskStatus("gh-62", "blocked", "agent");
    let failedMarker = "";
    const failed = await run({ poster: async (_r, _n, _body, marker) => { failedMarker = marker; throw new Error("API unavailable"); } });
    expect(failed.errors).toHaveLength(1);
    expect((await run({ nowMs: epoch + 30_000 })).posted).toBe(0);
    await run({ nowMs: epoch + 60_000 });
    expect(comments[0].marker).toBe(failedMarker);
    expect((await run()).posted).toBe(0);
  });
  it("posts weekly digests only for unfinished tasks and persists cadence", async () => {
    task(); task("gh-63"); store.setTaskStatus("gh-63", "done", "agent");
    await run();
    expect((await run({ nowMs: epoch + 167 * 3_600_000 })).posted).toBe(0);
    expect((await run({ nowMs: epoch + 168 * 3_600_000 })).posted).toBe(1);
    expect(comments[0].issue).toBe(62); expect(comments[0].body).toContain("Board digest");
    expect((await run({ nowMs: epoch + 169 * 3_600_000 })).posted).toBe(0);
  });
  it("explicit digest calls do not consume pending status changes", async () => {
    task(); await run(); store.setTaskStatus("gh-62", "blocked", "agent");
    await run({ mode: "digest", force: true });
    await run({ mode: "status" });
    expect(comments).toHaveLength(2);
    expect(comments[1].body).toContain("open → blocked");
  });
  it("dry runs neither publish nor move cursors", async () => {
    task(); await run(); store.setTaskStatus("gh-62", "blocked", "agent");
    const before = store.getGithubStatus(repo, "gh-62");
    const result = await run({ dryRun: true });
    expect(result.previews).toHaveLength(1); expect(comments).toHaveLength(0);
    expect(store.getGithubStatus(repo, "gh-62")).toBe(before);
    await run(); expect(comments).toHaveLength(1);
  });
  it("limits failed attempts as well as successful comments", async () => {
    task(); task("gh-63"); await run();
    store.setTaskStatus("gh-62", "blocked", "agent"); store.setTaskStatus("gh-63", "blocked", "agent");
    let attempts = 0;
    const result = await run({ maxComments: 1, poster: async () => { attempts++; throw new Error("API unavailable"); } });
    expect(attempts).toBe(1); expect(result.errors).toHaveLength(1);
  });
  it("uses distinct markers for repeated status cycles", async () => {
    task(); await run();
    for (const status of ["blocked", "open", "blocked"] as const) { store.setTaskStatus("gh-62", status, "agent"); await run(); }
    expect(new Set(comments.map(c => c.marker)).size).toBe(3);
  });
  it("validates config and leaves the automatic loop off by default", async () => {
    await expect(run({ repo: "org/repo;bad" })).rejects.toThrow("owner/name");
    await expect(run({ digestHours: NaN })).rejects.toThrow("digestHours");
    await startGithubStatusLoop(store, { dod: {}, enforcement: "observe" })();
    expect(comments).toHaveLength(0);
  });
  it("checkpoints reporting writes in the audit log", async () => {
    task(); await run();
    expect(store.auditLog().some((e: any) => e.entity_type === "github_status" && e.action === "checkpoint")).toBe(true);
  });
});


describe("GitHub delivery and loop lifecycle", () => {
  it("sends JSON on stdin and reconciles remote markers before retrying", async () => {
    const remote = join(dir, "remote.json");
    writeFileSync(remote, "[]");
    writeFileSync(join(dir, "gh"), `#!${process.execPath}
const fs = require("node:fs");
const file = ${JSON.stringify(remote)};
const rows = JSON.parse(fs.readFileSync(file));
if (process.argv.includes("--paginate")) console.log(JSON.stringify([rows]));
else {
  let input = "";
  process.stdin.on("data", chunk => { input += chunk; });
  process.stdin.on("end", () => { rows.push(JSON.parse(input)); fs.writeFileSync(file, JSON.stringify(rows)); console.log("{}"); });
}
`, { mode: 0o755 });
    const oldPath = process.env.PATH;
    process.env.PATH = `${dir}:${oldPath}`;
    try {
      const body = '<!-- marker -->\nQuotes " and literal $(touch SHOULD_NOT_EXIST)';
      await ghIssuePoster(repo, 62, body, "<!-- marker -->");
      await ghIssuePoster(repo, 62, body, "<!-- marker -->");
      expect(JSON.parse(readFileSync(remote, "utf8"))).toEqual([{ body }]);
    } finally { process.env.PATH = oldPath; }
  });

  it("keeps a forced first digest pending and backs off after failure", async () => {
    task();
    let marker = "";
    await run({ mode: "digest", force: true, poster: async (_r, _n, _body, m) => { marker = m; throw new Error("failed"); } });
    expect((await run({ mode: "digest", nowMs: epoch + 1000 })).posted).toBe(0);
    await run({ mode: "digest", nowMs: epoch + 60_000 });
    expect(comments).toHaveLength(1);
    expect(comments[0].marker).toBe(marker);
  });

  it("stops safely after an enabled loop encounters an error", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const listing = vi.spyOn(store, "listTasks").mockImplementation(() => { throw new Error("store unavailable"); });
    try {
      const stop = startGithubStatusLoop(store, { dod: {}, enforcement: "observe", github: { repo, status_comments: true } });
      await stop();
      expect(listing).toHaveBeenCalledOnce();
      expect(error).toHaveBeenCalled();
      await stop();
    } finally { error.mockRestore(); listing.mockRestore(); }
  });
});
