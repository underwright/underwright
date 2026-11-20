// gh-191: quota is per-account (seat) but was marked per-provider, so one
// dead seat blocked the whole provider and seat failover could never engage.
import { afterEach, expect, it } from "vitest";
import { SqliteStore } from "../src/store.js";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launchableHarnesses, mergeObservedQuota } from "../src/node-dispatch.js";

const cleanup: (() => void)[] = [];
afterEach(() => {
  cleanup.splice(0).reverse().forEach(f => f());
  delete process.env.UNDERWRIGHT_POLICY;
});
const hash = (s: string) => createHash("sha256").update(s).digest("hex");

const SEATS = ["/home/alan/.codex-seat-gmail", "/home/alan/.codex-seat-covasant"];
const BILLING = "payment required: insufficient_quota, please update your billing";

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "uw-quota-seats-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, "policy.json"), JSON.stringify({ watch: { codex_seats: SEATS } }));
  process.env.UNDERWRIGHT_POLICY = join(dir, "policy.json");
  const store: any = new SqliteStore(join(dir, "store.db"));
  cleanup.push(() => store.close());
  return { store, dir };
}

const quotaRows = (store: any) =>
  (store.db.prepare("SELECT provider, state, reason FROM provider_quota ORDER BY provider").all() as any[])
    .map(r => ({ ...r, reason: r.reason }));

function failLegacyJob(store: any, agentSpec: Record<string, unknown>) {
  const j = store.submitJob({ agent_id: "uw-watch", type: "agent", agent: agentSpec } as any);
  const started = store.nextJob("uw-runner");
  expect(started.id).toBe(j.id);
  store.finishJob(j.id, "failed", BILLING, "uw-runner", started.lease_token);
  return j;
}

async function enrolledLaunchNode(store: any) {
  const secret = randomBytes(32).toString("hex");
  const e = await store.createNodeEnrollment({ version: 1, name: "minipc", device_secret_hash: hash(secret), platform: "linux", arch: "x64" });
  await store.approveNodeEnrollment(e.id, e.code, { allowed_task_types: ["launch-agent"], workspace_ids: ["ws-1"] }, "admin");
  const issued = await store.exchangeNodeEnrollment(e.id, secret);
  const session = await store.startNodeSession(issued.token);
  await store.putNodeCapabilities(issued.token, session.session_id, 1, {
    supported_operation_kinds: ["launch-agent"],
    harnesses: [{ id: "codex", installed: true, auth_status: "ready", quota: { state: "available" } }],
  });
  return { ...issued, session };
}

const launchSpec = (over: Record<string, unknown> = {}) => ({
  version: 1, kind: "launch-agent", workspace_id: "ws-1",
  payload: { workspace_id: "ws-1", harness: "codex", prompt: "work the task" }, ...over,
});

it("seat-keyed-or-failover-first: a billing failure marks the seat and failovers instead of marking the provider", () => {
  const { store } = fixture();
  const j = failLegacyJob(store, { harness: "codex", executable: "codex", args: [], prompt: "x", env: { CODEX_HOME: SEATS[0] } });
  expect(quotaRows(store)).toEqual([{ provider: "codex:gmail", state: "exhausted", reason: "billing" }]);

  const failover = store.db.prepare("SELECT * FROM jobs WHERE dedupe_key=?").get(`failover:${j.id}`) as any;
  expect(failover).toBeTruthy();
  expect(failover.type).toBe("agent");
  expect(failover.retry_of).toBe(j.id);
  const spec = JSON.parse(failover.agent_spec);
  expect(spec.env.CODEX_HOME).toBe(SEATS[1]);
  expect(spec.env.UW_SEATS_TRIED.split(",")).toContain("gmail");
  expect(spec.env.UW_SEATS_TRIED.split(",")).toContain("covasant");
});

it("failover-engages-with-live-seat: the failovered job runs under the legacy runner with the next seat's env", () => {
  const { store } = fixture();
  failLegacyJob(store, { harness: "codex", executable: "codex", args: [], prompt: "x", env: { CODEX_HOME: SEATS[0] } });
  const next = store.nextJob("uw-runner");
  expect(next).toBeTruthy();
  expect(JSON.parse(next.agent_spec).env.CODEX_HOME).toBe(SEATS[1]);
});

it("dead-seat-not-provider: seat marks leave dispatch launchable; only a spent roster blocks the provider", () => {
  const { store } = fixture();
  failLegacyJob(store, { harness: "codex", executable: "codex", args: [], prompt: "x", env: { CODEX_HOME: SEATS[0] } });

  // one seat dead: provider must still form codex jobs
  const observed = store.observedExhaustedProviders();
  expect(observed.has("codex")).toBe(false);
  const caps = JSON.stringify({ harnesses: [{ id: "codex", installed: true, auth_status: "ready", quota: { state: "available" } }] });
  const merged = JSON.parse(mergeObservedQuota(caps, observed));
  expect(launchableHarnesses(JSON.stringify(merged), ["codex"])).toEqual(["codex"]);

  // burn the second seat: the failover job fails on seat covasant -> provider-level mark
  const second = store.nextJob("uw-runner");
  store.finishJob(second.id, "failed", BILLING, "uw-runner", second.lease_token);
  expect(quotaRows(store).map(r => r.provider)).toContain("codex");
  expect(store.observedExhaustedProviders().has("codex")).toBe(true);
  // no third failover — roster spent after one failover + the provider mark
  expect(store.nextJob("uw-runner")).toBeNull();
  expect(store.db.prepare("SELECT COUNT(*) n FROM jobs WHERE dedupe_key LIKE 'failover:%'").get().n).toBe(1);
});

it("a fully-marked roster reads as provider-exhausted even without a provider-level row", () => {
  const { store } = fixture();
  failLegacyJob(store, { harness: "codex", executable: "codex", args: [], prompt: "x", env: { CODEX_HOME: SEATS[0] } });
  const second = store.nextJob("uw-runner");
  store.finishJob(second.id, "failed", BILLING, "uw-runner", second.lease_token);
  // simulate an older writer that only wrote seat marks
  store.db.prepare("DELETE FROM provider_quota WHERE provider='codex'").run();
  expect(store.observedExhaustedProviders().has("codex")).toBe(true);
});

it("a successful job clears provider and seat marks — the provider proved itself alive", () => {
  const { store } = fixture();
  failLegacyJob(store, { harness: "codex", executable: "codex", args: [], prompt: "x", env: { CODEX_HOME: SEATS[0] } });
  expect(quotaRows(store).length).toBe(1);
  // The failover job may sit ahead in the queue — either one reporting done
  // proves the provider alive and must clear every mark, seat-keyed included.
  const started = store.nextJob("uw-runner");
  store.finishJob(started.id, "done", "ok", "uw-runner", started.lease_token);
  expect(quotaRows(store)).toEqual([]);
});

it("no roster in policy keeps the legacy provider-wide behavior", () => {
  const dir = mkdtempSync(join(tmpdir(), "uw-quota-nopolicy-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  process.env.UNDERWRIGHT_POLICY = join(dir, "policy.json");
  writeFileSync(process.env.UNDERWRIGHT_POLICY, JSON.stringify({}));
  const store: any = new SqliteStore(join(dir, "store.db"));
  cleanup.push(() => store.close());
  failLegacyJob(store, { harness: "codex", executable: "codex", args: [], prompt: "x", env: { CODEX_HOME: SEATS[0] } });
  expect(quotaRows(store)).toEqual([{ provider: "codex", state: "exhausted", reason: "billing" }]);
  expect(store.db.prepare("SELECT COUNT(*) n FROM jobs WHERE dedupe_key LIKE 'failover:%'").get().n).toBe(0);
});

it("node launch-agent failure failovers on the same node, bypassing the quota-blocked formation path", async () => {
  const { store } = fixture();
  const node = await enrolledLaunchNode(store);
  const task = store.createTask({ title: "x", ac_ids: ["a"] });
  await store.claimTask(task.id, "codex@minipc");
  const submitted = await store.submitNodeTask({
    target_node_id: node.node_id, task_id: task.id, agent_id: "codex@minipc", node_spec: launchSpec(),
  });
  const leased = await store.pollNodeJob(node.token, node.session.session_id, 0);
  expect(leased.id).toBe(submitted.id);
  const failed = await store.finishNodeJob(node.token, node.session.session_id, leased.id, leased.lease_token, "failed", BILLING);
  expect(failed.error).toBeUndefined();

  // provider NOT marked; a failover job is queued for the same node with the next seat
  expect(store.db.prepare("SELECT COUNT(*) n FROM provider_quota WHERE provider='codex'").get().n).toBe(0);
  const failover = store.db.prepare("SELECT * FROM jobs WHERE dedupe_key=?").get(`failover:${leased.id}`) as any;
  expect(failover).toBeTruthy();
  expect(failover.target_node_id).toBe(node.node_id);
  expect(failover.retry_of).toBe(leased.id);
  const spec = JSON.parse(failover.node_spec);
  expect(spec.kind).toBe("launch-agent");
  expect(spec.env.CODEX_HOME).toBe(SEATS[0]);

  // pre-queued delivery bypasses the formation-time quota gate: the node gets it
  const second = await store.pollNodeJob(node.token, node.session.session_id, 0);
  expect(second.id).toBe(failover.id);
  // worker issuance surfaces the seat env to the executor's child process
  const worker = await store.issueNodeWorker(node.token, node.session.session_id, second.id, second.lease_token);
  expect(worker.error).toBeUndefined();
  expect(worker.env.CODEX_HOME).toBe(SEATS[0]);
  expect(worker.env.UW_SEATS_TRIED).toBeTruthy();

  // when the failover job also fails, the seat is marked and the chain advances
  await store.finishNodeJob(node.token, node.session.session_id, second.id, second.lease_token, "failed", BILLING);
  expect(quotaRows(store).map(r => r.provider)).toContain("codex:gmail");
  const third = store.db.prepare("SELECT * FROM jobs WHERE retry_of=?").get(second.id) as any;
  expect(JSON.parse(third.node_spec).env.CODEX_HOME).toBe(SEATS[1]);
  const thirdLease = await store.pollNodeJob(node.token, node.session.session_id, 0);
  await store.finishNodeJob(node.token, node.session.session_id, thirdLease.id, thirdLease.lease_token, "failed", BILLING);
  expect(quotaRows(store).map(r => r.provider)).toContain("codex");
});
