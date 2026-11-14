import { afterEach, beforeEach, expect, it } from "vitest";
import { SqliteStore } from "../src/store.js";
import { initTelemetry, telemetry, withSpan } from "../src/telemetry.js";
import { projectNode, NODE_STALE_MS, NODE_ONLINE_MS } from "../src/node-protocol.js";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// gh-136: telemetry port — span/event/metric behind an interface, JSONL file
// backend now, OTLP adapter later. Also pins last_poll_at poll-liveness.

const cleanup: (() => void)[] = [];
const savedPolicy = process.env.UNDERWRIGHT_POLICY;
const savedTel = process.env.UNDERWRIGHT_TELEMETRY;

beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), "uw-tel-policy-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, "policy.json"), JSON.stringify({
    dod: {}, enforcement: "observe",
    dispatch: { enabled: true, default_workspace: "underwright", workspaces: { "underwright/underwright": "underwright" }, harness_order: ["claude"] },
    model_routing: { enabled: true, default_tier: "standard", rules: [], models: { claude: { standard: "sonnet" } }, flags: {} },
  }));
  process.env.UNDERWRIGHT_POLICY = join(dir, "policy.json");
});
afterEach(() => {
  if (savedPolicy === undefined) delete process.env.UNDERWRIGHT_POLICY;
  else process.env.UNDERWRIGHT_POLICY = savedPolicy;
  if (savedTel === undefined) delete process.env.UNDERWRIGHT_TELEMETRY;
  else process.env.UNDERWRIGHT_TELEMETRY = savedTel;
  initTelemetry({ backend: "off" });   // reset global for other suites
  cleanup.splice(0).reverse().forEach(f => f());
});

const tmpdir_ = () => {
  const dir = mkdtempSync(join(tmpdir(), "uw-telemetry-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};
const lines = (file: string) => readFileSync(file, "utf8").trim().split("\n").map(l => JSON.parse(l));

it("JSONL backend writes span start/end with trace ids, duration, and events", () => {
  const file = join(tmpdir_(), "t.jsonl");
  const tel = initTelemetry({ backend: "file", file, resource: { service: "test" } });
  const span = tel.span("dispatch.match", { node_id: "n1" });
  span.event("candidate", { task_id: "t1" });
  span.end("ok", undefined, { eligible: 3 });

  const out = lines(file);
  expect(out).toHaveLength(2);
  const [start, end] = out;
  expect(start).toMatchObject({ kind: "span", name: "dispatch.match", phase: "start", node_id: "n1", service: "test" });
  expect(end).toMatchObject({ kind: "span", phase: "end", status: "ok", eligible: 3 });
  expect(end.trace_id).toBe(start.trace_id);
  expect(end.span_id).toBe(start.span_id);
  expect(end.duration_ms).toBeTypeOf("number");
  expect(end.events).toHaveLength(1);
  expect(end.events[0].name).toBe("candidate");
});

it("child spans share the parent trace; events and metrics emit standalone lines", () => {
  const file = join(tmpdir_(), "t.jsonl");
  const tel = initTelemetry({ backend: "file", file });
  const parent = tel.span("job.execute", { job_id: "j1" });
  const child = tel.span("executor.spawn", { harness: "claude" }, parent);
  child.end();
  parent.end("error", new Error("boom"));
  tel.event("node.poll", { outcome: "empty", eligible: 5 });
  tel.metric("queue.depth", 12, { node_id: "n1" });

  const out = lines(file);
  const childStart = out.find(l => l.name === "executor.spawn" && l.phase === "start");
  expect(childStart.trace_id).toBe(parent.trace_id);
  expect(childStart.parent_span_id).toBe(parent.span_id);
  expect(out.find(l => l.name === "job.execute" && l.phase === "end")).toMatchObject({ status: "error", error: "boom" });
  expect(out.find(l => l.kind === "event")).toMatchObject({ name: "node.poll", outcome: "empty" });
  expect(out.find(l => l.kind === "metric")).toMatchObject({ name: "queue.depth", value: 12 });
});

it("withSpan ends ok on success and error on throw", async () => {
  const file = join(tmpdir_(), "t.jsonl");
  initTelemetry({ backend: "file", file });
  await withSpan("op", {}, async () => 42);
  await expect(withSpan("op2", {}, async () => { throw new Error("nope"); })).rejects.toThrow("nope");
  const out = lines(file);
  expect(out.find(l => l.name === "op" && l.phase === "end")).toMatchObject({ status: "ok" });
  expect(out.find(l => l.name === "op2" && l.phase === "end")).toMatchObject({ status: "error", error: "nope" });
});

it("telemetry defaults to off and never throws from library callers", () => {
  initTelemetry({ backend: "off" });
  telemetry().event("anything", { x: 1 });
  telemetry().span("s").end();
  telemetry().metric("m", 1);
});

it("poll updates last_poll_at distinct from last_seen_at", async () => {
  const dir = tmpdir_();
  const store: any = new SqliteStore(join(dir, "store.db"));
  cleanup.push(() => store.close());
  const secret = randomBytes(32).toString("hex");
  const e = await store.createNodeEnrollment({ version: 1, name: "n", device_secret_hash: createHash("sha256").update(secret).digest("hex"), platform: "linux", arch: "x64" });
  await store.approveNodeEnrollment(e.id, e.code, { allowed_task_types: ["launch-agent"], workspace_ids: [], repository_ids: [] }, "admin");
  const issued = await store.exchangeNodeEnrollment(e.id, secret);
  const session = await store.startNodeSession(issued.token);

  const before = store.listNodes().find((n: any) => n.id === issued.node_id);
  expect(before.last_poll_at).toBeFalsy();
  expect(before.poll_liveness).toBe("unknown");

  await store.pollNodeJob(issued.token, session.session_id, 0);
  const after = store.listNodes().find((n: any) => n.id === issued.node_id);
  expect(after.last_poll_at).toBeTruthy();
  expect(after.poll_liveness).toBe("polling");
});

it("empty poll emits a node.poll event and dispatch emits a match span", async () => {
  const dir = tmpdir_();
  const telFile = join(dir, "tel.jsonl");
  initTelemetry({ backend: "file", file: telFile });
  const store: any = new SqliteStore(join(dir, "store.db"));
  cleanup.push(() => store.close());
  const secret = randomBytes(32).toString("hex");
  const e = await store.createNodeEnrollment({ version: 1, name: "n", device_secret_hash: createHash("sha256").update(secret).digest("hex"), platform: "linux", arch: "x64" });
  await store.approveNodeEnrollment(e.id, e.code, { allowed_task_types: ["launch-agent"], workspace_ids: ["underwright"], repository_ids: [] }, "admin");
  const issued = await store.exchangeNodeEnrollment(e.id, secret);
  const session = await store.startNodeSession(issued.token);
  await store.putNodeCapabilities(issued.token, session.session_id, 1, {
    protocol_version: 1, max_concurrency: 4, supported_operation_kinds: ["launch-agent"], features: ["launch-model-flag"],
    harnesses: [{ id: "claude", installed: true, auth_status: "ready", quota: { state: "available" } }],
  });

  // no tasks → dispatch span records no match, poll event records the outcome
  const r = await store.pollNodeJob(issued.token, session.session_id, 0);
  expect(r.empty).toBe(true);
  const out = lines(telFile);
  expect(out.some(l => l.kind === "span" && l.name === "dispatch.match" && l.phase === "end")).toBe(true);
  const poll = out.find(l => l.kind === "event" && l.name === "node.poll");
  expect(poll).toMatchObject({ outcome: "empty", node_id: issued.node_id });
  // telemetry must not carry secrets
  expect(JSON.stringify(out)).not.toMatch(/uw_node_|lease_token|device_secret/);
});

it("projectNode flags heartbeat-alive-but-poll-silent as 'silent'", () => {
  const now = Date.now();
  const wedged = projectNode({
    id: "n1", name: "n1", state: "approved",
    last_seen_at: new Date(now - 1000).toISOString(),                    // heartbeat fresh
    last_poll_at: new Date(now - NODE_STALE_MS - 60_000).toISOString(),  // poll dead
  }, now);
  expect(wedged.liveness).toBe("online");
  expect(wedged.poll_liveness).toBe("silent");

  const healthy = projectNode({ id: "n2", name: "n2", state: "approved",
    last_seen_at: new Date(now - 1000).toISOString(),
    last_poll_at: new Date(now - 1000).toISOString() }, now);
  expect(healthy.poll_liveness).toBe("polling");

  const dead = projectNode({ id: "n3", name: "n3", state: "approved",
    last_seen_at: new Date(now - NODE_ONLINE_MS - 60_000).toISOString(),
    last_poll_at: new Date(now - NODE_ONLINE_MS - 60_000).toISOString() }, now);
  expect(dead.poll_liveness).not.toBe("silent");
});
