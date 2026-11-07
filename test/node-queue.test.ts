import { afterEach, expect, it, vi } from "vitest";
import { SqliteStore } from "../src/store.js";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NODE_RESULT_LIMIT, nodeReceiptDigest } from "../src/node-protocol.js";

const cleanup: (() => void)[] = [];
afterEach(() => { vi.useRealTimers(); cleanup.splice(0).reverse().forEach(f => f()); });
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "uw-node-queue-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "store.db");
  const store: any = new SqliteStore(path);
  cleanup.push(() => store.close());
  return { store, path };
}
async function enrolled(store: any, name = "node", policy = { allowed_task_types: ["run-script"] as const, workspace_ids: ["ws-1"] }) {
  const secret = randomBytes(32).toString("hex");
  const e = await store.createNodeEnrollment({ version: 1, name, device_secret_hash: hash(secret), platform: "linux", arch: "x64" });
  const approved = await store.approveNodeEnrollment(e.id, e.code, policy, "admin");
  const issued = await store.exchangeNodeEnrollment(e.id, secret);
  const session = await store.startNodeSession(issued.token);
  return { ...issued, session, policy };
}
const spec = (over: Record<string, unknown> = {}) => ({ version: 1 as const, kind: "run-script" as const, workspace_id: "ws-1", payload: { argv: ["true"] }, ...over });

it("isolates two nodes, keeps legacy nextJob off node work, and fences a single slot", async () => {
  const { store, path } = fixture();
  const second = new SqliteStore(path); cleanup.push(() => second.close());
  const a = await enrolled(store, "a");
  const b = await enrolled(store, "b");
  const nodeJob = await store.submitNodeTask({ target_node_id: a.node_id, node_spec: spec(), agent_id: "admin" });
  const legacy = store.submitJob({ agent_id: "submitter", type: "test", command: "echo legacy" });
  expect(store.submitJob({ agent_id: "x", type: "node", command: "nope" }).error).toMatch(/submit_node_task/);
  expect(store.nextJob("legacy-runner", "host-A").id).toBe(legacy.id);
  expect(second.nextJob("legacy-runner", "host-A")).toBeNull();
  const stolen = await store.pollNodeJob(b.token, b.session.session_id, 0);
  expect(stolen.empty || stolen.status_code).toBeTruthy();
  const leased = await store.pollNodeJob(a.token, a.session.session_id, 0);
  expect(leased.id).toBe(nodeJob.id);
  expect(leased.attempt_id).toBeTruthy();
  expect(leased.lease_token).toBeTruthy();
  const extra = await store.submitNodeTask({ target_node_id: a.node_id, node_spec: spec({ payload: { argv: ["echo"] } }) });
  expect((await second.pollNodeJob(a.token, a.session.session_id, 0)).id).toBe(leased.id);
  expect((await store.pollNodeJob(a.token, a.session.session_id, 0)).id).toBe(leased.id);
  expect(store.getJob(extra.id).status).toBe("queued");
  expect(store.nextJob("legacy-runner", "host-A")).toBeNull();
});

it("rejects stale session/attempt owners and acknowledges matching finish only", async () => {
  const { store, path } = fixture();
  const second = new SqliteStore(path); cleanup.push(() => second.close());
  const node = await enrolled(store);
  await store.submitNodeTask({ target_node_id: node.node_id, node_spec: spec() });
  const leased = await store.pollNodeJob(node.token, node.session.session_id, 0);
  expect((await store.finishNodeJob(node.token, node.session.session_id, leased.id, "wrong", "done", "ok")).error).toBeTruthy();
  const done = await second.finishNodeJob(node.token, node.session.session_id, leased.id, leased.lease_token, "done", "ok");
  expect(done.status).toBe("done");
  expect(done.receipt_digest).toBe(nodeReceiptDigest(leased.attempt_id, "done", "ok"));
  const replay = await store.finishNodeJob(node.token, node.session.session_id, leased.id, leased.lease_token, "done", "ok");
  expect(replay.idempotent).toBe(true);
  expect(replay.receipt_digest).toBe(done.receipt_digest);
  expect((await store.finishNodeJob(node.token, node.session.session_id, leased.id, leased.lease_token, "failed", "ok")).error).toMatch(/conflict/);

  const next = await store.submitNodeTask({ target_node_id: node.node_id, node_spec: spec({ payload: { argv: ["echo"] } }) });
  const held = await store.pollNodeJob(node.token, node.session.session_id, 0);
  expect(held.id).toBe(next.id);
  const newer = await second.startNodeSession(node.token);
  expect((await store.renewNodeJob(node.token, node.session.session_id, held.id, held.lease_token)).error).toBeTruthy();
  expect((await store.finishNodeJob(node.token, node.session.session_id, held.id, held.lease_token, "done", "late")).error).toBeTruthy();
  expect((await store.finishNodeJob(node.token, newer.session_id, held.id, held.lease_token, "done", "ok")).error).toBeTruthy();
  const audit = JSON.stringify(store.auditLog(200));
  expect(audit).not.toContain(node.token);
  expect(audit).not.toContain(leased.lease_token);
});

it("fails expired node leases as outcome_unknown without reclaim, while legacy jobs remain reclaimable", async () => {
  const { store } = fixture();
  vi.useFakeTimers();
  const node = await enrolled(store);
  const nodeJob = await store.submitNodeTask({ target_node_id: node.node_id, node_spec: spec() });
  const leased = await store.pollNodeJob(node.token, node.session.session_id, 0);
  const legacy = store.submitJob({ agent_id: "a", type: "test", command: "echo hi" });
  const oldLegacy = store.nextJob("runner", "A", 5);
  vi.setSystemTime(Date.now() + 61_000);
  expect((await store.finishNodeJob(node.token, node.session.session_id, leased.id, leased.lease_token, "done", "late")).error).toBeTruthy();
  expect(store.sweepExpiredNodeJobs().expired).toContain(nodeJob.id);
  expect(store.getJob(nodeJob.id).status).toBe("failed");
  expect(store.getJob(nodeJob.id).outcome_reason).toBe("lease_lost/outcome_unknown");
  expect((await store.pollNodeJob(node.token, node.session.session_id, 0)).empty).toBe(true);
  const retry = await store.submitNodeTask({ target_node_id: node.node_id, node_spec: spec(), retry_of: nodeJob.id });
  expect(retry.id).not.toBe(nodeJob.id);
  expect(store.getJob(retry.id).retry_of).toBe(nodeJob.id);
  expect(store.finishJob(legacy.id, "done", "late", "runner", oldLegacy.lease_token).error).toMatch(/lease/);
  const fresh = store.nextJob("runner", "A");
  expect(fresh.id).toBe(legacy.id);
  expect(fresh.lease_token).not.toBe(oldLegacy.lease_token);
});

it("dedupes active node tasks, bounds results, and waits/cancels long-poll without leaking jobs", async () => {
  const { store } = fixture();
  const node = await enrolled(store);
  const first = await store.submitNodeTask({ target_node_id: node.node_id, node_spec: spec({ idempotency_key: "once" }) });
  const again = await store.submitNodeTask({ target_node_id: node.node_id, node_spec: spec({ idempotency_key: "once" }) });
  expect(again.deduped).toBe(true);
  expect(again.id).toBe(first.id);
  const denied = await store.submitNodeTask({
    target_node_id: node.node_id,
    node_spec: { version: 1, kind: "launch-agent", payload: {} },
  });
  expect(denied.status_code).toBe(403);
  const empty = await store.pollNodeJob(node.token, node.session.session_id, 1);
  const leased = empty.id ? empty : await store.pollNodeJob(node.token, node.session.session_id, 0);
  expect(leased.id).toBe(first.id);
  const huge = "x".repeat(NODE_RESULT_LIMIT + 50);
  const renewed = await store.renewNodeJob(node.token, node.session.session_id, leased.id, leased.lease_token, huge);
  expect(renewed.error).toBeUndefined();
  expect(store.getJob(leased.id).result.length).toBe(NODE_RESULT_LIMIT);
  await store.finishNodeJob(node.token, node.session.session_id, leased.id, leased.lease_token, "done", huge);
  expect(store.getJob(leased.id).result.length).toBe(NODE_RESULT_LIMIT);

  const controller = new AbortController();
  const pending = store.pollNodeJob(node.token, node.session.session_id, 25, controller.signal);
  controller.abort();
  const canceled = await pending;
  expect(canceled.status_code).toBe(499);
  expect(canceled.lease_token).toBeUndefined();

  const timed = await store.pollNodeJob(node.token, node.session.session_id, 1);
  expect(timed.empty).toBe(true);
});
