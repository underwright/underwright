// gh-168: omnigent session id + cost telemetry captured into jobs and projected into evidence.
import { afterEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteStore } from "../src/store.js";
import { executeLeasedJob, type JobCall } from "../src/runner.js";
import { evidencePack, syncIssues } from "../src/github.js";
import { parseSessionSnapshot, sessionIdFromLocator, summarizeTaskUsage, telemetryColumns, usageCitation } from "../src/usage.js";

const cleanups: (() => void)[] = [];
afterEach(() => { cleanups.splice(0).reverse().forEach(f => f()); });
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "uw-usage-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "jobs.db");
  const store = new SqliteStore(path);
  cleanups.push(() => store.close());
  return { store, path, dir };
}
function caller(store: SqliteStore, log: { name: string; args: any }[] = []): JobCall {
  return async (name, a: any) => {
    log.push({ name, args: a });
    return name === "next_job" ? store.nextJob(a.agent_id, a.host, a.ttl_seconds) :
      name === "renew_job" ? store.renewJob(a.job_id, a.agent_id, a.lease_token, a.ttl_seconds, a.result, a.telemetry) :
      store.finishJob(a.job_id, a.status, a.result, a.agent_id, a.lease_token, a.telemetry);
  };
}
/** Put a fake `omni` on PATH; `--version` (the availability probe) exits at once. */
function fakeOmni(dir: string, script: string) {
  const binDir = mkdtempSync(join(dir, "omni-"));
  writeFileSync(join(binDir, "omni"), `#!/bin/sh\n[ "$1" = "--version" ] && exit 0\n${script}\n`, { mode: 0o755 });
  const oldPath = process.env.PATH;
  process.env.PATH = `${binDir}:${oldPath}`;
  cleanups.push(() => { process.env.PATH = oldPath; });
}
const omniSpec = { executable: "codex", args: [], prompt: "hi", backend: "omnigent" as const, harness: "codex", server: "https://omni.example" };

describe("gh-168 runner telemetry", () => {
  it("persists the session id at launch, polls usage mid-job, and captures usage at exit", async () => {
    const { store, dir } = fixture();
    fakeOmni(dir, 'echo "omnigent session: https://omni.example/s/sess-42"\nsleep 1.2\necho done');
    const t = store.createTask({ title: "omni task", ac_ids: ["x"] });
    const j = store.submitJob({ task_id: t.id, agent_id: "a", type: "agent", agent: omniSpec });
    let reads = 0;
    const seen: string[] = [];
    const log: { name: string; args: any }[] = [];
    await executeLeasedJob(store.nextJob("r", "A"), caller(store, log), {
      agentId: "r", host: "A", usagePollMs: 200,
      sessionSnapshot: async (server, id) => { reads++; seen.push(`${server}|${id}`); return { cost_usd: 0.01 * reads, usage_by_model: { "gpt-5": { input_tokens: 100 * reads } } }; },
    });
    // session-id-persisted: a renewal before finish carried the session id.
    const renewals = log.filter(c => c.name === "renew_job" && c.args.telemetry);
    expect(renewals.length).toBeGreaterThan(0);
    expect(renewals[0].args.telemetry.omni_session_id).toBe("sess-42");
    // heartbeat-usage-poll: snapshot read more than once (mid-job + exit), against the job's server.
    expect(reads).toBeGreaterThanOrEqual(3);
    expect(seen[0]).toBe("https://omni.example|sess-42");
    expect(renewals.some(c => typeof c.args.telemetry.cost_usd === "number")).toBe(true);
    // exit-usage-capture: final snapshot stored in columns and as a JSON trailer in jobs.result.
    const done = store.getJob(j.id) as any;
    expect(done.status).toBe("done");
    expect(done.omni_session_id).toBe("sess-42");
    expect(done.cost_usd).toBeCloseTo(0.01 * reads);
    expect(JSON.parse(done.usage_json)["gpt-5"].input_tokens).toBe(100 * reads);
    const trailer = done.result.match(/omnigent usage: (.*)$/m)[1];
    expect(JSON.parse(trailer)).toMatchObject({ omni_session_id: "sess-42", cost_usd: done.cost_usd });
  });

  it("killed jobs retain the last heartbeat usage", async () => {
    const { store, dir } = fixture();
    fakeOmni(dir, 'echo "omnigent session: sess-k"\nsleep 5');
    const j = store.submitJob({ agent_id: "a", type: "agent", agent: omniSpec });
    const inner = caller(store);
    let costRenewals = 0;
    const call: JobCall = async (name, a: any) => {
      if (name === "renew_job" && costRenewals >= 1) return { error: "job lease not owned or expired" };
      const r = await inner(name, a);
      if (name === "renew_job" && a.telemetry?.cost_usd !== undefined) costRenewals++;
      return r;
    };
    await expect(executeLeasedJob(store.nextJob("r", "A"), call, {
      agentId: "r", host: "A", usagePollMs: 150, sessionSnapshot: async () => ({ usage: { cost_usd: 0.5 } }),
    })).rejects.toThrow(/lost lease/);
    const row = store.getJob(j.id) as any;
    expect(row.omni_session_id).toBe("sess-k");
    expect(row.cost_usd).toBe(0.5);
  }, 10000);

  it("raw jobs never read session snapshots or report telemetry (negative)", async () => {
    const { store } = fixture();
    const j = store.submitJob({ agent_id: "a", type: "test", command: "echo 'omnigent session: fake'" });
    let reads = 0;
    const log: { name: string; args: any }[] = [];
    await executeLeasedJob(store.nextJob("r", "A"), caller(store, log), {
      agentId: "r", host: "A", usagePollMs: 50, sessionSnapshot: async () => { reads++; return { cost_usd: 9 }; },
    });
    expect(reads).toBe(0);
    expect(log.some(c => c.args.telemetry)).toBe(false);
    const row = store.getJob(j.id) as any;
    expect(row.omni_session_id).toBeNull();
    expect(row.cost_usd).toBeNull();
  });

  it("a failing snapshot endpoint keeps the session id and does not fail the job", async () => {
    const { store, dir } = fixture();
    fakeOmni(dir, 'echo "omnigent session: sess-e"');
    const j = store.submitJob({ agent_id: "a", type: "agent", agent: omniSpec });
    await executeLeasedJob(store.nextJob("r", "A"), caller(store), {
      agentId: "r", host: "A", sessionSnapshot: async () => { throw new Error("503"); },
    });
    const row = store.getJob(j.id) as any;
    expect(row.status).toBe("done");
    expect(row.omni_session_id).toBe("sess-e");
    expect(row.cost_usd).toBeNull();
  });
});

describe("gh-168 store + schema", () => {
  it("migrates a v11 database by adding the telemetry columns", () => {
    const { path } = fixture();
    // Simulate a pre-v12 database by dropping the new columns and rewinding user_version.
    const raw = new Database(path);
    const cols = (raw.prepare("SELECT name FROM pragma_table_info('jobs')").all() as any[]).map(r => r.name);
    expect(cols).toEqual(expect.arrayContaining(["omni_session_id", "cost_usd", "usage_json"]));
    expect(raw.pragma("user_version", { simple: true })).toBeGreaterThanOrEqual(12);
    raw.exec("ALTER TABLE jobs DROP COLUMN omni_session_id; ALTER TABLE jobs DROP COLUMN cost_usd; ALTER TABLE jobs DROP COLUMN usage_json; PRAGMA user_version = 11;");
    raw.close();
    const reopened = new SqliteStore(path);
    cleanups.push(() => reopened.close());
    const db = new Database(path, { readonly: true });
    cleanups.push(() => db.close());
    const after = (db.prepare("SELECT name FROM pragma_table_info('jobs')").all() as any[]).map(r => r.name);
    expect(after).toEqual(expect.arrayContaining(["omni_session_id", "cost_usd", "usage_json"]));
    expect(db.pragma("user_version", { simple: true })).toBe(12);
  });

  it("rejects telemetry from a non-owner and never clears recorded values with absent fields", () => {
    const { store } = fixture();
    const j = store.submitJob({ agent_id: "a", type: "test", command: "true" });
    const lease = store.nextJob("r", "A") as any;
    expect(store.renewJob(j.id, "r", "wrong-token", 60, undefined, { omni_session_id: "evil", cost_usd: 99 })).toEqual({ error: "job lease not owned or expired" });
    expect((store.getJob(j.id) as any).omni_session_id).toBeNull();
    store.renewJob(j.id, "r", lease.lease_token, 60, undefined, { omni_session_id: "s1", cost_usd: 0.2 });
    store.renewJob(j.id, "r", lease.lease_token, 60, undefined, {});
    store.finishJob(j.id, "failed", "out", "r", lease.lease_token);
    const row = store.getJob(j.id) as any;
    expect(row).toMatchObject({ omni_session_id: "s1", cost_usd: 0.2, status: "failed" });
  });

  it("aggregates cost by task and surfaces it on the board", () => {
    const { store } = fixture();
    const t = store.createTask({ title: "costed", ac_ids: ["x"] });
    const other = store.createTask({ title: "other", ac_ids: ["x"] });
    for (const [cost, session] of [[0.25, "s-a"], [0.5, "s-b"]] as const) {
      store.submitJob({ task_id: t.id, agent_id: "a", type: "test", command: "true" });
      const l = store.nextJob("r", "A") as any;
      store.finishJob(l.id, "done", "", "r", l.lease_token, { omni_session_id: session, cost_usd: cost, usage_by_model: { m: { usd: cost } } });
    }
    store.submitJob({ task_id: other.id, agent_id: "a", type: "test", command: "true" });
    const usage = store.taskUsage(t.id);
    expect(usage.total_cost_usd).toBe(0.75);
    expect(usage.jobs.map(j => j.omni_session_id).sort()).toEqual(["s-a", "s-b"]);
    expect(usage.jobs.find(j => j.omni_session_id === "s-b")?.usage_by_model).toEqual({ m: { usd: 0.5 } });
    expect(store.taskUsage(other.id)).toEqual({ task_id: other.id, total_cost_usd: 0, jobs: [] });
    const board = store.board() as any;
    expect(board.tasks.find((x: any) => x.id === t.id).cost_usd).toBe(0.75);
    expect(board.tasks.find((x: any) => x.id === other.id).cost_usd).toBeNull();
  });
});

describe("gh-168 evidence projection", () => {
  it("evidence packs and issue-close comments cite omni session + cost", async () => {
    const { store } = fixture();
    const t = store.createTask({ id: "gh-901", title: "issue", ac_ids: ["x"], spec_ref: "https://github.com/o/r/issues/901" });
    store.submitJob({ task_id: t.id, agent_id: "a", type: "test", command: "true" });
    const l = store.nextJob("r", "A") as any;
    store.finishJob(l.id, "done", "", "r", l.lease_token, { omni_session_id: "sess-ev", cost_usd: 1.2345 });
    const pack = await evidencePack(store, t.id);
    expect(pack).toContain("omni session `sess-ev`");
    expect(pack).toContain("$1.2345");

    store.setTaskStatus(t.id, "done", "test");
    const calls: { cmd: string; input?: string }[] = [];
    await syncIssues(store, "o/r", "github-sync", { runner: (cmd: string, input?: string) => {
      calls.push({ cmd, input });
      return cmd.startsWith("issue list") ? [{ number: 901, title: "issue", body: "", url: "https://github.com/o/r/issues/901", state: "OPEN", labels: [] }] : "";
    } });
    const comment = calls.find(c => c.cmd.startsWith("issue comment 901"));
    expect(comment?.input).toContain("omni session `sess-ev`");
    expect(comment?.input).toContain("$1.2345");
    expect(calls.some(c => c.cmd.startsWith("issue close 901"))).toBe(true);
  });

  it("tasks without omni jobs get no usage section or extra comment (negative)", async () => {
    const { store } = fixture();
    const t = store.createTask({ id: "gh-902", title: "plain", ac_ids: ["x"], spec_ref: "https://github.com/o/r/issues/902" });
    expect(await evidencePack(store, t.id)).not.toContain("Omnigent usage");
    store.setTaskStatus(t.id, "done", "test");
    const calls: string[] = [];
    await syncIssues(store, "o/r", "github-sync", { runner: (cmd: string) => {
      calls.push(cmd);
      return cmd.startsWith("issue list") ? [{ number: 902, title: "plain", body: "", url: "https://github.com/o/r/issues/902", state: "OPEN", labels: [] }] : "";
    } });
    expect(calls.some(c => c.startsWith("issue comment"))).toBe(false);
    expect(calls.some(c => c.startsWith("issue close 902"))).toBe(true);
  });
});

describe("gh-168 usage helpers", () => {
  it("parses snapshot cost/usage from top-level, nested usage, or `n`", () => {
    expect(parseSessionSnapshot({ cost_usd: 1, usage_by_model: { a: 1 } })).toEqual({ cost_usd: 1, usage_by_model: { a: 1 } });
    expect(parseSessionSnapshot({ session: { usage: { total_cost_usd: "2.5", by_model: { b: 2 } } } })).toEqual({ cost_usd: 2.5, usage_by_model: { b: 2 } });
    expect(parseSessionSnapshot({ n: 0.3 })).toEqual({ cost_usd: 0.3 });
    expect(parseSessionSnapshot(null)).toEqual({});
    expect(parseSessionSnapshot({ cost_usd: "nope" })).toEqual({});
  });
  it("normalizes locators, rejects bad telemetry values, and formats citations", () => {
    expect(sessionIdFromLocator("https://omni.example/s/abc")).toBe("abc");
    expect(sessionIdFromLocator("abc")).toBe("abc");
    expect(telemetryColumns({ cost_usd: -1, omni_session_id: "  " })).toEqual({ omni_session_id: null, cost_usd: null, usage_json: null });
    expect(telemetryColumns(undefined)).toEqual({ omni_session_id: null, cost_usd: null, usage_json: null });
    expect(usageCitation(summarizeTaskUsage("t", []))).toEqual([]);
  });
});
