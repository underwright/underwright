import { afterEach, beforeEach, expect, it } from "vitest";
import { SqliteStore } from "../src/store.js";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// gh-126: pull-through dispatch — poll forms launch-agent jobs from eligible
// board tasks when no queued job exists for the node.

process.env.UNDERWRIGHT_DISPATCH_THROTTLE_MS = "0"; // tests poll back-to-back

const cleanup: (() => void)[] = [];
const savedPolicy = process.env.UNDERWRIGHT_POLICY;
beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), "uw-dispatch-policy-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, "policy.json"), JSON.stringify({
    dod: {}, enforcement: "observe",
    dispatch: {
      enabled: true,
      default_workspace: "underwright",
      workspaces: { "underwright/underwright": "underwright", "alandennis1024/omnigent": "omnigent" },
      harness_order: ["claude", "codex"],
    },
    dispatcher: { enabled: true, idle_minutes: 60 },
    model_routing: {
      enabled: true, default_tier: "standard",
      rules: [{ estimate: ["L"], tier: "heavy" }, { estimate: ["S"], tier: "light" }],
      models: { claude: { light: "haiku", standard: "sonnet", heavy: "opus" }, codex: { standard: "gpt-5.4", heavy: "gpt-5.4" } },
      flags: { claude: "--model" },
    },
  }));
  process.env.UNDERWRIGHT_POLICY = join(dir, "policy.json");
});
afterEach(() => {
  if (savedPolicy === undefined) delete process.env.UNDERWRIGHT_POLICY;
  else process.env.UNDERWRIGHT_POLICY = savedPolicy;
  cleanup.splice(0).reverse().forEach(f => f());
});

const hash = (s: string) => createHash("sha256").update(s).digest("hex");

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "uw-node-dispatch-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const store: any = new SqliteStore(join(dir, "store.db"));
  cleanup.push(() => store.close());
  return { store };
}

const LAUNCH_POLICY = {
  allowed_task_types: ["launch-agent"] as const,
  workspace_ids: ["underwright", "omnigent"],
  repository_ids: [] as string[],
};

async function enrolled(store: any, name = "node", policy = LAUNCH_POLICY) {
  const secret = randomBytes(32).toString("hex");
  const e = await store.createNodeEnrollment({ version: 1, name, device_secret_hash: hash(secret), platform: "linux", arch: "x64" });
  await store.approveNodeEnrollment(e.id, e.code, policy, "admin");
  const issued = await store.exchangeNodeEnrollment(e.id, secret);
  const session = await store.startNodeSession(issued.token);
  return { ...issued, session };
}

const READY_CAPS = (harnesses: { id: string; quota?: object }[], extra: object = {}) => ({
  protocol_version: 1 as const,
  max_concurrency: 4,
  supported_operation_kinds: ["launch-agent"],
  features: ["launch-model-flag"],
  harnesses: harnesses.map(h => ({ id: h.id, installed: true, auth_status: "ready" as const, quota: h.quota ?? { state: "available" } })),
  ...extra,
});

async function attest(store: any, node: any, inventory = READY_CAPS([{ id: "claude" }, { id: "codex" }])) {
  const r = await store.putNodeCapabilities(node.token, node.session.session_id, 1, inventory);
  expect(r.error).toBeUndefined();
}

const task = (over: Record<string, unknown> = {}) =>
  ({ title: "dispatch me", estimate: "M", ac_ids: ["ac-1"], spec_ref: "https://github.com/underwright/underwright/issues/1", ...over });

it("poll forms a launch-agent job from an eligible task on an empty queue", async () => {
  const { store } = fixture();
  const node = await enrolled(store);
  await attest(store, node);
  const t = await store.createTask(task());

  const leased = await store.pollNodeJob(node.token, node.session.session_id, 0);
  expect(leased.empty).toBeUndefined();
  expect(leased.task_id).toBe(t.id);
  const spec = leased.node_spec;
  expect(spec.kind).toBe("launch-agent");
  expect(spec.workspace_id).toBe("underwright");
  expect(spec.payload.harness).toBe("claude");           // harness_order first
  expect(spec.payload.model).toBe("sonnet");              // M → default standard
  expect(spec.payload.model_flag).toBe("--model");
  expect(spec.payload.prompt).toContain(t.id);
  expect(spec.payload.prompt).toContain("claude@node");   // agent_id = harness@node
  expect(leased.agent_id).toBe("claude@node");

  // second poll: held job is redelivered (idempotent); excluding it proves no
  // duplicate is formed — the live job keeps the task out of dispatch.
  const held = await store.pollNodeJob(node.token, node.session.session_id, 0);
  expect(held.id).toBe(leased.id);
  const again = await store.pollNodeJob(node.token, node.session.session_id, 0, undefined, [leased.id]);
  expect(again.empty).toBe(true);
  expect(again.match.skipped.live_job).toBe(1);
});

it("resolves heavy tier model for L tasks and falls back per harness", async () => {
  const { store } = fixture();
  const node = await enrolled(store);
  await attest(store, node);
  await store.createTask(task({ estimate: "L" }));

  const leased = await store.pollNodeJob(node.token, node.session.session_id, 0);
  const spec = leased.node_spec;
  expect(spec.payload.harness).toBe("claude");
  expect(spec.payload.model).toBe("opus");
});

it("skips ineligible tasks and explains starvation in match metadata", async () => {
  const { store } = fixture();
  const node = await enrolled(store);
  await attest(store, node);
  await store.createTask(task({ estimate: "" }));                       // no DoR — not even in eligible set
  const claimed = await store.createTask(task({ title: "claimed" }));
  await store.claimTask(claimed.id, "someone@else");                    // flips status → leaves eligible set
  const blocked = await store.createTask(task({ title: "blocked" }));
  const blocker = await store.createTask(task({ title: "blocker" }));
  store.updateTask(blocked.id, { blocked_by: [blocker.id] }, "test");
  await store.claimTask(blocker.id, "someone@else");                    // blocker unfinished → dep-blocked

  const res = await store.pollNodeJob(node.token, node.session.session_id, 0);
  expect(res.empty).toBe(true);
  expect(res.match.eligible).toBe(1);                                   // only the dep-blocked task stays open
  expect(res.match.skipped.blocked_deps).toBe(1);
});

it("skips tasks whose workspace the node policy does not allow", async () => {
  const { store } = fixture();
  const node = await enrolled(store, "node", { ...LAUNCH_POLICY, workspace_ids: ["underwright"] });
  await attest(store, node);
  await store.createTask(task({ spec_ref: "https://github.com/alandennis1024/omnigent/issues/2" }));

  const res = await store.pollNodeJob(node.token, node.session.session_id, 0);
  expect(res.empty).toBe(true);
  expect(res.match.skipped.no_workspace).toBe(1);
});

it("prefers pre-queued jobs over pull-through dispatch", async () => {
  const { store } = fixture();
  const node = await enrolled(store);
  await attest(store, node);
  const t = await store.createTask(task());
  const pre = await store.submitNodeTask({
    target_node_id: node.node_id, task_id: t.id, agent_id: "claude@node",
    node_spec: { version: 1, kind: "launch-agent", workspace_id: "underwright",
      payload: { workspace_id: "underwright", harness: "claude", prompt: "pre-queued" } },
  });
  const leased = await store.pollNodeJob(node.token, node.session.session_id, 0);
  expect(leased.id).toBe(pre.id);
  expect(leased.node_spec.payload.prompt).toBe("pre-queued");
});

it("respects quota: exhausted harnesses are skipped for the next ready one", async () => {
  const { store } = fixture();
  const node = await enrolled(store);
  await attest(store, node, READY_CAPS([
    { id: "claude", quota: { state: "exhausted", resets_at: new Date(Date.now() + 3600e3).toISOString() } },
    { id: "codex" },
  ]));
  await store.createTask(task({ estimate: "L" }));

  const leased = await store.pollNodeJob(node.token, node.session.session_id, 0);
  const spec = leased.node_spec;
  expect(spec.payload.harness).toBe("codex");
  expect(spec.payload.model).toBe("gpt-5.4");              // codex heavy row
  expect(spec.payload.model_flag).toBeUndefined();          // no flag configured for codex
});

it("starves cleanly when every harness is exhausted", async () => {
  const { store } = fixture();
  const node = await enrolled(store);
  await attest(store, node, READY_CAPS([
    { id: "claude", quota: { state: "exhausted", resets_at: new Date(Date.now() + 3600e3).toISOString() } },
    { id: "codex", quota: { state: "exhausted", resets_at: new Date(Date.now() + 3600e3).toISOString() } },
  ]));
  await store.createTask(task());

  const res = await store.pollNodeJob(node.token, node.session.session_id, 0);
  expect(res.empty).toBe(true);
  expect(res.match.skipped.no_harness).toBe(1);
});

it("cools down re-dispatch after a formed job fails", async () => {
  const { store } = fixture();
  const node = await enrolled(store);
  await attest(store, node);
  const t = await store.createTask(task());

  const leased = await store.pollNodeJob(node.token, node.session.session_id, 0);
  await store.finishNodeJob(node.token, node.session.session_id, leased.id, leased.lease_token, "failed", "boom");

  // task is parked for the cooldown window — no infinite fail/re-dispatch loop
  const res = await store.pollNodeJob(node.token, node.session.session_id, 0);
  expect(res.empty).toBe(true);
  expect(res.match.skipped.recent_failure).toBe(1);
});

it("backs off a failing harness and rotates to the next ready one", async () => {
  const { store } = fixture();
  const node = await enrolled(store);
  await attest(store, node);
  const t1 = await store.createTask(task({ title: "first", priority: 0 }));
  const t2 = await store.createTask(task({ title: "second", priority: 1 }));

  const j1 = await store.pollNodeJob(node.token, node.session.session_id, 0);
  expect(j1.node_spec.payload.harness).toBe("claude");
  await store.finishNodeJob(node.token, node.session.session_id, j1.id, j1.lease_token, "failed", "out of credits");

  // t1 is parked on task-cooldown; t2 dispatches on codex — claude is backed off
  const j2 = await store.pollNodeJob(node.token, node.session.session_id, 0);
  expect(j2.task_id).toBe(t2.id);
  expect(j2.node_spec.payload.harness).toBe("codex");

  // codex also fails → every ready harness backed off → clean no_harness
  await store.finishNodeJob(node.token, node.session.session_id, j2.id, j2.lease_token, "failed", "boom");
  const t3 = await store.createTask(task({ title: "third", priority: 2 }));
  const res = await store.pollNodeJob(node.token, node.session.session_id, 0);
  expect(res.empty).toBe(true);
  expect(res.match.skipped.no_harness).toBeGreaterThanOrEqual(1);
});

it("omits model args for daemons that do not attest launch-model-flag", async () => {
  const { store } = fixture();
  const node = await enrolled(store);
  const legacy = READY_CAPS([{ id: "claude" }]);
  delete (legacy as any).features;                       // pre-gh-126 daemon
  await attest(store, node, legacy);
  await store.createTask(task({ estimate: "L" }));

  const leased = await store.pollNodeJob(node.token, node.session.session_id, 0);
  const spec = leased.node_spec;
  expect(spec.payload.harness).toBe("claude");
  expect(spec.payload.model).toBeUndefined();            // strict-schema-safe
  expect(spec.payload.model_flag).toBeUndefined();
});

it("dispatch forms jobs across free concurrency slots, not just one", async () => {
  const { store } = fixture();
  const node = await enrolled(store);
  await attest(store, node);
  const t1 = await store.createTask(task({ title: "one", priority: 0 }));
  const t2 = await store.createTask(task({ title: "two", priority: 1 }));

  const j1 = await store.pollNodeJob(node.token, node.session.session_id, 0);
  expect(j1.task_id).toBe(t1.id);                          // priority order
  const j2 = await store.pollNodeJob(node.token, node.session.session_id, 0);
  expect(j2.task_id).toBe(t2.id);                          // slot 2 dispatches next task
  const j3 = await store.pollNodeJob(node.token, node.session.session_id, 0, undefined, [j1.id, j2.id]);
  expect(j3.empty).toBe(true);                             // both live → nothing left
});

it("cooldown expires — ISO-format finished_at older than the window does not park the task", async () => {
  const { store } = fixture();
  const node = await enrolled(store);
  await attest(store, node);
  const t = await store.createTask(task());

  const j1 = await store.pollNodeJob(node.token, node.session.session_id, 0);
  expect(j1.task_id).toBe(t.id);
  await store.finishNodeJob(node.token, node.session.session_id, j1.id, j1.lease_token, "failed", "boom");

  // fresh failure parks the task
  const parked = await store.pollNodeJob(node.token, node.session.session_id, 0);
  expect(parked.empty).toBe(true);
  expect(parked.match.skipped.recent_failure).toBe(1);

  // backdate finished_at to an ISO T-format stamp outside the window — a raw
  // text comparison vs datetime('now') space-format keeps 'T' > ' ' forever,
  // permanently parking the task; the datetime() read must normalize it.
  const old = new Date(Date.now() - 10 * 60_000).toISOString();
  store.db.prepare("UPDATE jobs SET finished_at=? WHERE id=?").run(old, j1.id);
  const j2 = await store.pollNodeJob(node.token, node.session.session_id, 0);
  expect(j2.task_id).toBe(t.id);
});

it("done job on an unclosed task parks it in_review instead of re-dispatching", async () => {
  const { store } = fixture();
  const node = await enrolled(store);
  await attest(store, node);
  const t = await store.createTask(task());

  const j1 = await store.pollNodeJob(node.token, node.session.session_id, 0);
  expect(j1.task_id).toBe(t.id);
  // Worker jobs hold no board credential, so 'done' means "exited clean", not
  // "task closed". The task must leave the dispatch pool — in_review — rather
  // than burn quota re-running a dead-end session every cooldown.
  await store.finishNodeJob(node.token, node.session.session_id, j1.id, j1.lease_token, "done", "could not reach the board");

  const row = store.db.prepare("SELECT status FROM tasks WHERE id=?").get(t.id) as { status: string };
  expect(row.status).toBe("in_review");

  // and it must not come back through dispatch, even after the cooldown window
  const again = await store.pollNodeJob(node.token, node.session.session_id, 0);
  expect(again.empty).toBe(true);
});

it("failed job keeps the task open and re-dispatchable after cooldown", async () => {
  const { store } = fixture();
  const node = await enrolled(store);
  await attest(store, node);
  const t = await store.createTask(task());

  const j1 = await store.pollNodeJob(node.token, node.session.session_id, 0);
  await store.finishNodeJob(node.token, node.session.session_id, j1.id, j1.lease_token, "failed", "boom");

  // failure leaves the task open — it parks for the cooldown then retries
  const row = store.db.prepare("SELECT status FROM tasks WHERE id=?").get(t.id) as { status: string };
  expect(row.status).toBe("open");
  const old = new Date(Date.now() - 10 * 60_000).toISOString();
  store.db.prepare("UPDATE jobs SET finished_at=? WHERE id=?").run(old, j1.id);
  const j2 = await store.pollNodeJob(node.token, node.session.session_id, 0);
  expect(j2.task_id).toBe(t.id);
});

it("pull-through runs tasks claimed to this node's own agent ids", async () => {
  const { store } = fixture();
  const node = await enrolled(store, "box");
  await attest(store, node);
  const t = await store.createTask(task());
  const c = await store.claimTask(t.id, "claude@box");
  expect(c.error).toBeUndefined();
  // mailbox assignment to a fleet agent must actually deliver: the node picks
  // up its own claim and runs it AS that agent
  const j = await store.pollNodeJob(node.token, node.session.session_id, 0);
  expect(j.task_id).toBe(t.id);
  expect(j.agent_id).toBe("claude@box");
});

it("tasks claimed to other agents are still skipped", async () => {
  const { store } = fixture();
  const node = await enrolled(store, "box");
  await attest(store, node);
  const t = await store.createTask(task());
  const c = await store.claimTask(t.id, "ghost@elsewhere");
  expect(c.error).toBeUndefined();
  const res = await store.pollNodeJob(node.token, node.session.session_id, 0);
  expect(res.empty).toBe(true);
  expect(res.match.eligible).toBe(0);   // foreign claims never enter the candidate list
});

it("idle sweep reassigns to live agents, never to dead interactive ids", async () => {
  const { store } = fixture();
  const node = await enrolled(store, "box");
  await attest(store, node);
  const t = await store.createTask(task());
  // ghost id with workload-0 history but no recent activity — the old pool
  // would pick it every time
  store.db.prepare(
    "INSERT INTO events (entity_type,entity_id,action,actor,data,created_at) VALUES ('task',?,'claimed','ghost@dead','{}',datetime('now','-2 days'))",
  ).run(t.id);
  await store.sendMessage("ghost@dead", "dispatcher", `your next task: ${t.id}`, t.id);
  store.db.prepare("UPDATE messages SET created_at=datetime('now','-2 hours') WHERE task_id=?").run(t.id);
  const r = await store.sweepIdleDispatches();
  expect(r.reassigned).toEqual([t.id]);
  const claim = store.db.prepare("SELECT agent_id FROM claims WHERE task_id=?").get(t.id) as { agent_id: string };
  expect(claim.agent_id).toBe("claude@box");   // live node agent, not the ghost
  // and the claim actually delivers through the node's next poll
  const j = await store.pollNodeJob(node.token, node.session.session_id, 0);
  expect(j.task_id).toBe(t.id);
  expect(j.agent_id).toBe("claude@box");
});

it("a rate-limit failure marks the provider exhausted on every node", async () => {
  const { store } = fixture();
  const node = await enrolled(store, "box");
  const node2 = await enrolled(store, "box2");
  await attest(store, node);
  await attest(store, node2);
  const t = await store.createTask(task());
  const j1 = await store.pollNodeJob(node.token, node.session.session_id, 0);
  expect(j1.agent_id).toBe("claude@box");
  await store.finishNodeJob(node.token, node.session.session_id, j1.id, j1.lease_token, "failed", "You've hit your 5-hour limit");
  // provider-level mark: the OTHER node must also refuse claude, not just
  // back it off locally — the subscription is shared
  const t2 = await store.createTask(task());
  const j2 = await store.pollNodeJob(node2.token, node2.session.session_id, 0);
  expect(j2.task_id).toBe(t2.id);
  expect(j2.agent_id).toBe("codex@box2");
});

it("a successful job clears observed provider exhaustion", async () => {
  const { store } = fixture();
  const node = await enrolled(store, "box");
  const node2 = await enrolled(store, "box2");
  await attest(store, node);
  await attest(store, node2);
  const t1 = await store.createTask(task());
  const t2 = await store.createTask(task());
  const j1 = await store.pollNodeJob(node.token, node.session.session_id, 0);
  const j2 = await store.pollNodeJob(node.token, node.session.session_id, 0);
  expect(j2.agent_id).toBe("claude@box");
  await store.finishNodeJob(node.token, node.session.session_id, j1.id, j1.lease_token, "failed", "402 Payment Required: usage balance exhausted");
  await store.finishNodeJob(node.token, node.session.session_id, j2.id, j2.lease_token, "done", "all good");
  const t3 = await store.createTask(task());
  const j3 = await store.pollNodeJob(node2.token, node2.session.session_id, 0);
  expect(j3.task_id).toBe(t3.id);
  expect(j3.agent_id).toBe("claude@box2");   // success proved it alive
});

it("promotes free_fallback harnesses while any ready harness is quota-blocked", async () => {
  const { store } = fixture();
  const node = await enrolled(store, "box");
  await attest(store, node, READY_CAPS([
    { id: "claude", quota: { state: "exhausted", resets_at: new Date(Date.now() + 3600_000).toISOString() } },
    { id: "codex" },
    { id: "devin" },
  ]));
  const t = await store.createTask(task());
  const j = await store.pollNodeJob(node.token, node.session.session_id, 0);
  expect(j.task_id).toBe(t.id);
  expect(j.agent_id).toBe("devin@box");   // zero-cost promoted ahead of codex
});

it("self-claim pickup delivers for non-top harnesses, not just claude", async () => {
  const { store } = fixture();
  const node = await enrolled(store, "box");
  await attest(store, node, READY_CAPS([{ id: "claude" }, { id: "kimi" }]));
  const t = await store.createTask(task());
  const c = await store.claimTask(t.id, "kimi@box");
  expect(c.error).toBeUndefined();
  // unconstrained, the match would pick claude@box first and the claim check
  // would reject it — the claim must steer matching to kimi itself
  const j = await store.pollNodeJob(node.token, node.session.session_id, 0);
  expect(j.task_id).toBe(t.id);
  expect(j.agent_id).toBe("kimi@box");
});

it("heartbeat refreshes capabilities_observed_at for a quiet node", async () => {
  const { store } = fixture();
  const node = await enrolled(store, "box");
  await attest(store, node);
  store.db.prepare("UPDATE nodes SET capabilities_observed_at=?, capabilities_version=1").run(new Date(Date.now() - 3600_000).toISOString());
  const hb = await store.nodeHeartbeat(node.token, node.session.session_id, { capabilities_version: 1 });
  expect(hb.error).toBeUndefined();
  const row = store.db.prepare("SELECT capabilities_observed_at FROM nodes WHERE id=?").get(node.node_id ?? hb.node_id) as { capabilities_observed_at: string };
  expect(Date.parse(row.capabilities_observed_at)).toBeGreaterThan(Date.now() - 60_000);
});
