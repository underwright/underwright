import { afterEach, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { SqliteStore } from "../src/store.js";

const cleanup: (() => unknown)[] = [];
afterEach(async () => { for (const f of cleanup.splice(0).reverse()) await f(); });
const hash = (s: string) => createHash("sha256").update(s).digest("hex");

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "uw-ledger-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const store: any = new SqliteStore(join(dir, "store.db"));
  cleanup.push(() => store.close());
  return { store };
}

it("records idempotent progress events, validates writer, and surfaces on get_task (gh-112)", async () => {
  const { store } = fixture();
  store.createTask({ id: "t1", title: "ledger task" });
  const first = store.recordProgress({ task_id: "t1", agent_id: "a1", status: "started", summary: "began work", operation_id: "op-1" });
  expect(first.operation_id).toBe("op-1");
  expect(first.status).toBe("started");
  // Idempotent retry: same operation_id + payload returns the prior row, no dup.
  const retry = store.recordProgress({ task_id: "t1", agent_id: "a1", status: "started", summary: "began work", operation_id: "op-1" });
  expect(retry.operation_id).toBe("op-1");
  expect(store.listLedger("t1").length).toBe(1);
  // Reused operation_id with different input is an error.
  const conflict = store.recordProgress({ task_id: "t1", agent_id: "a1", status: "blocked", summary: "different", operation_id: "op-1" });
  expect(conflict.error).toContain("different input");
  // Claimed-task validation: only the claim holder may write.
  store.createTask({ id: "t2", title: "claimed task", ac_ids: ["x"], estimate: "S" });
  store.claimTask("t2", "holder");
  expect(store.recordProgress({ task_id: "t2", agent_id: "other", status: "progress", summary: "intruder" }).error).toContain("claimed by holder");
  expect(store.recordProgress({ task_id: "t2", agent_id: "holder", status: "progress", summary: "halfway" }).status).toBe("progress");
  // Completed tasks close the ledger.
  store.createTask({ id: "t3", title: "done task" });
  store.nodeQuery("UPDATE tasks SET status='done' WHERE id='t3'");
  expect(store.recordProgress({ task_id: "t3", agent_id: "a1", status: "progress", summary: "late" }).error).toContain("completed");
  // get_task exposes the ledger.
  const task = store.getTask("t2");
  expect(task.ledger.length).toBe(1);
  expect(task.ledger[0].summary).toBe("halfway");
});

it("worker-scoped record_progress auto-fills task, agent, job and attempt (gh-112)", async () => {
  const { store } = fixture();
  const secret = randomBytes(32).toString("hex");
  const e = store.createNodeEnrollment({ version: 1, name: "n1", device_secret_hash: hash(secret), platform: "linux", arch: "x64" });
  store.approveNodeEnrollment(e.id, e.code, { allowed_task_types: ["launch-agent"], workspace_ids: ["w"] }, "admin");
  const issued = store.exchangeNodeEnrollment(e.id, secret);
  store.createTask({ id: "t1", title: "agent task" });
  const session = store.startNodeSession(issued.token);
  store.putNodeCapabilities(issued.token, session.session_id, 1, { protocol_version: 1, harnesses: [{ id: "codex", installed: true, auth_status: "ready", quota: { state: "available" } }] });
  store.submitNodeTask({ task_id: "t1", agent_id: "worker-1", target_node_id: issued.node_id, node_spec: { version: 1, kind: "launch-agent", workspace_id: "w", payload: { workspace_id: "w", harness: "codex", prompt: "go" } } });
  const job = await store.pollNodeJob(issued.token, session.session_id, 0);
  const worker = store.issueNodeWorker(issued.token, session.session_id, job.id, job.lease_token);
  const row = store.workerTool(worker.token, "record_progress", { status: "progress", summary: "mid-run", operation_id: "op-w1" });
  expect(row.error).toBeUndefined();
  expect(row.task_id).toBe("t1");
  expect(row.agent_id).toBe("worker-1");
  expect(row.job_id).toBe(job.id);
  expect(row.attempt_id).toBe(job.attempt_id);
  // The admin surface sees the same event.
  expect(store.listLedger("t1")[0].summary).toBe("mid-run");
});
