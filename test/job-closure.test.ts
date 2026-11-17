import { afterEach, beforeEach, expect, it } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SqliteStore } from "../src/store.js";
import { serveHttp } from "../src/server.js";
import { closureVerdict, NO_ACTIVITY_BLOCK_AFTER, NO_ACTIVITY_REASON } from "../src/node-dispatch.js";

// task-37ab2493: a dispatch job's exit 0 must not count as task progress.
// The worker closes its own task through the scoped credential (AC2); a job
// that exits 0 without touching the board leaves the task open, then blocked,
// with an explanatory artifact (AC3).

process.env.UNDERWRIGHT_DISPATCH_THROTTLE_MS = "0";

const cleanup: (() => unknown)[] = [];
const savedPolicy = process.env.UNDERWRIGHT_POLICY;
beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), "uw-closure-policy-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, "policy.json"), JSON.stringify({
    dod: {}, enforcement: "observe",
    dispatch: { enabled: true, default_workspace: "underwright", workspaces: { "underwright/underwright": "underwright" }, harness_order: ["claude"] },
    dispatcher: { enabled: true, idle_minutes: 60 },
  }));
  process.env.UNDERWRIGHT_POLICY = join(dir, "policy.json");
});
afterEach(async () => {
  if (savedPolicy === undefined) delete process.env.UNDERWRIGHT_POLICY;
  else process.env.UNDERWRIGHT_POLICY = savedPolicy;
  for (const f of cleanup.splice(0).reverse()) await f();
});

const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const task = (over: Record<string, unknown> = {}) =>
  ({ title: "close me", type: "docs", estimate: "M", ac_ids: ["ac-1", "ac-2"], spec_ref: "https://github.com/underwright/underwright/issues/1", ...over });

async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "uw-closure-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "store.db");
  const store: any = new SqliteStore(path);
  cleanup.push(() => store.close());
  const secret = randomBytes(32).toString("hex");
  const e = await store.createNodeEnrollment({ version: 1, name: "box", device_secret_hash: hash(secret), platform: "linux", arch: "x64" });
  await store.approveNodeEnrollment(e.id, e.code, { allowed_task_types: ["launch-agent"], workspace_ids: ["underwright"], repository_ids: [] }, "admin");
  const issued = await store.exchangeNodeEnrollment(e.id, secret);
  const session = await store.startNodeSession(issued.token);
  const caps = { protocol_version: 1, max_concurrency: 4, supported_operation_kinds: ["launch-agent"], features: ["launch-model-flag", "worktree-mcp"],
    harnesses: [{ id: "claude", installed: true, auth_status: "ready", quota: { state: "available" } }] };
  expect((await store.putNodeCapabilities(issued.token, session.session_id, 1, caps)).error).toBeUndefined();
  const node = { token: issued.token, sid: session.session_id };
  const poll = () => store.pollNodeJob(node.token, node.sid, 0);
  const finish = (job: any, status: "done" | "failed", out: string) => store.finishNodeJob(node.token, node.sid, job.id, job.lease_token, status, out);
  // Simulate the cooldown passing for every finished job.
  const age = () => store.db.prepare("UPDATE jobs SET finished_at=? WHERE finished_at IS NOT NULL").run(new Date(Date.now() - 10 * 60_000).toISOString());
  return { store, path, node, poll, finish, age };
}

const status = (store: any, id: string) => (store.db.prepare("SELECT status FROM tasks WHERE id=?").get(id) as any).status;

it("closureVerdict: closed > review > retry > blocked", () => {
  const none = { ledger: 0, evidence: 0, artifacts: 0, proven_ac_ids: [] };
  expect(closureVerdict("done", none, 5)).toBe("closed");
  expect(closureVerdict("open", { ...none, evidence: 1 }, 5)).toBe("review");
  expect(closureVerdict("open", none, 0)).toBe("retry");
  expect(closureVerdict("open", none, NO_ACTIVITY_BLOCK_AFTER - 1)).toBe("blocked");
});

it("AC2: a worker that finishes its task closes it end-to-end via the scoped worker credential", async () => {
  const f = await fixture();
  const t = await f.store.createTask(task());
  const job = await f.poll();
  expect(job.task_id).toBe(t.id);
  expect(job.agent_id).toBe("claude@box");

  // Real HTTP control plane: node mints the worker credential, the harness
  // speaks MCP to /worker/mcp exactly as the injected .mcp.json would.
  const http = await serveHttp(f.path, "127.0.0.1", 0, "admin");
  cleanup.push(() => new Promise<void>(r => { http.close(() => r()); http.closeAllConnections(); }));
  const url = `http://127.0.0.1:${(http.address() as any).port}`;
  const issued = await (await fetch(`${url}/nodes/v1/jobs/${job.id}/worker`, {
    method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + f.node.token },
    body: JSON.stringify({ session_id: f.node.sid, lease_token: job.lease_token }),
  })).json() as any;
  expect(issued.token).toMatch(/^uw_worker_/);
  const c = new Client({ name: "worker", version: "1" });
  await c.connect(new StreamableHTTPClientTransport(new URL(url + "/worker/mcp"), { requestInit: { headers: { authorization: "Bearer " + issued.token } } }));
  cleanup.push(() => c.close());

  await c.callTool({ name: "claim_task", arguments: {} });
  await c.callTool({ name: "record_progress", arguments: { status: "started", summary: "working" } });
  await c.callTool({ name: "report_evidence", arguments: { kind: "test_run", ac_ids: ["ac-1", "ac-2"], command: "npm test", exit_code: 0, output: "all green" } });
  const done = await c.callTool({ name: "complete_task", arguments: {} });
  expect(JSON.stringify(done)).toContain("completed");

  const r = await f.finish(job, "done", "task complete");
  expect(r.closure).toBe("closed");
  expect(status(f.store, t.id)).toBe("done");
  const events = f.store.db.prepare("SELECT action, actor FROM events WHERE entity_type='task' AND entity_id=?").all(t.id) as any[];
  expect(events).toContainEqual({ action: "completed", actor: "claude@box" });
  expect(events.map(e => e.action)).toContain("job_closed");
  // No human or dispatcher artifacts were needed.
  expect(f.store.listArtifacts(t.id).filter((a: any) => a.agent_id === "dispatcher")).toEqual([]);
});

it("AC3: exit 0 with no board activity does not close the task — open, then blocked, with explanatory artifacts", async () => {
  const f = await fixture();
  const t = await f.store.createTask(task());

  const j1 = await f.poll();
  expect(j1.task_id).toBe(t.id);
  const r1 = await f.finish(j1, "done", "could not reach the board");
  expect(r1.closure).toBe("retry");
  expect(status(f.store, t.id)).toBe("open");
  expect((f.store.getJob(j1.id) as any).outcome_reason).toBe(NO_ACTIVITY_REASON);
  let arts = f.store.listArtifacts(t.id) as any[];
  expect(arts).toHaveLength(1);
  expect(arts[0].kind).toBe("note");
  expect(arts[0].content).toContain("no ledger entry, evidence, or artifact");
  expect(arts[0].content).toContain("could not reach the board");

  // Cooldown parks it; afterwards it re-dispatches once more.
  expect((await f.poll()).empty).toBe(true);
  f.age();
  const j2 = await f.poll();
  expect(j2.task_id).toBe(t.id);
  const r2 = await f.finish(j2, "done", "could not reach the board");
  expect(r2.closure).toBe("blocked");
  expect(status(f.store, t.id)).toBe("blocked");
  arts = f.store.listArtifacts(t.id) as any[];
  const blocked = arts.find(a => a.kind === "blocked");
  expect(blocked.content).toContain("exited 0 without touching the board");
  expect(f.store.board().tasks.find((x: any) => x.id === t.id).blocked_artifacts).toBe(1);

  // Blocked is out of the dispatch pool for good — no more quota burn.
  f.age();
  expect((await f.poll()).empty).toBe(true);
  // No 'completed' event was ever written.
  expect(f.store.db.prepare("SELECT COUNT(*) n FROM events WHERE entity_id=? AND action='completed'").get(t.id).n).toBe(0);

  // A human re-open resets the consecutive count: the next no-op exit retries.
  f.store.setTaskStatus(t.id, "open", "human");
  const j3 = await f.poll();
  expect((await f.finish(j3, "done", "")).closure).toBe("retry");
});

it("worker activity without completion moves the task to in_review with a footprint note", async () => {
  const f = await fixture();
  const t = await f.store.createTask(task());
  const job = await f.poll();
  const w = await f.store.issueNodeWorker(f.node.token, f.node.sid, job.id, job.lease_token);
  f.store.workerTool(w.token, "claim_task", {});
  f.store.workerTool(w.token, "report_evidence", { kind: "test_run", ac_ids: ["ac-1"], output: "half" });

  const r = await f.finish(job, "done", "partial");
  expect(r.closure).toBe("review");
  expect(status(f.store, t.id)).toBe("in_review");
  expect(f.store.getTask(t.id).claim).toBeNull();
  expect((f.store.getJob(job.id) as any).outcome_reason).toBeNull();
  const note = (f.store.listArtifacts(t.id) as any[]).find(a => a.agent_id === "dispatcher");
  expect(note.content).toContain("ACs proven: [ac-1] missing: [ac-2]");
  f.age();
  expect((await f.poll()).empty).toBe(true);
});

it("a useful job in between resets the no-activity streak", async () => {
  const f = await fixture();
  const t = await f.store.createTask(task());
  const j1 = await f.poll();
  expect((await f.finish(j1, "done", "")).closure).toBe("retry");
  f.age();
  const j2 = await f.poll();
  const w = await f.store.issueNodeWorker(f.node.token, f.node.sid, j2.id, j2.lease_token);
  f.store.workerTool(w.token, "record_progress", { status: "progress", summary: "did a thing" });
  expect((await f.finish(j2, "done", "")).closure).toBe("review");
  // Human sends it back to open; the earlier no-op must not count.
  f.store.setTaskStatus(t.id, "open", "human");
  f.age();
  const j3 = await f.poll();
  expect((await f.finish(j3, "done", "")).closure).toBe("retry");
});

it("failed jobs are not judged by closure — the task stays open for retry", async () => {
  const f = await fixture();
  const t = await f.store.createTask(task());
  const j = await f.poll();
  const r = await f.finish(j, "failed", "boom");
  expect(r.closure).toBeUndefined();
  expect(status(f.store, t.id)).toBe("open");
  expect(f.store.listArtifacts(t.id)).toEqual([]);
});
