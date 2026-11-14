import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { SqliteStore } from "../src/store.js";
import { saveNodeCredential } from "../src/node-client.js";
import { runNode } from "../src/node-run.js";
import { NODE_ONLINE_MS, NODE_STALE_MS, nodeSecret } from "../src/node-protocol.js";
import { renderDashboard } from "../src/dashboard.js";
import { serveHttp } from "../src/server.js";

const cleanup: (() => unknown)[] = [];
afterEach(async () => { vi.useRealTimers(); for (const f of cleanup.splice(0).reverse()) await f(); });
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "uw-node-run-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "store.db");
  const store: any = new SqliteStore(path);
  cleanup.push(() => store.close());
  return { store, path, dir };
}
async function enrolled(store: any) {
  const secret = randomBytes(32).toString("hex");
  const e = await store.createNodeEnrollment({ version: 1, name: "desktop", device_secret_hash: hash(secret), platform: "linux", arch: "x64" });
  const approved = await store.approveNodeEnrollment(e.id, e.code, { allowed_task_types: ["run-script"], workspace_ids: [] }, "admin");
  const issued = await store.exchangeNodeEnrollment(e.id, secret);
  return { ...issued, approved };
}

it("projects online/stale/offline and revoked liveness from server time", async () => {
  const { store } = fixture();
  const node = await enrolled(store);
  const session = await store.startNodeSession(node.token);
  expect(store.listNodes()[0].liveness).toBe("offline");
  await store.nodeHeartbeat(node.token, session.session_id, { phase: "idle" });
  expect(store.listNodes()[0].liveness).toBe("online");
  const row = store.listNodes()[0];
  expect(row.last_heartbeat_age_ms).toBeLessThan(NODE_ONLINE_MS);
  store.nodeQuery("UPDATE nodes SET last_seen_at=? WHERE id=?", [new Date(Date.now() - 60_000).toISOString(), node.node_id]);
  expect(store.listNodes()[0].liveness).toBe("stale");
  store.nodeQuery("UPDATE nodes SET last_seen_at=? WHERE id=?", [new Date(Date.now() - (NODE_STALE_MS + 1000)).toISOString(), node.node_id]);
  expect(store.listNodes()[0].liveness).toBe("offline");
  await store.revokeNode(node.node_id, "admin");
  expect(store.listNodes()[0].liveness).toBe("revoked");
});

it("heartbeats independently while a job is running and redacts inventory secrets", async () => {
  const { store, path, dir } = fixture();
  const http = await serveHttp(path, "127.0.0.1", 0, "admin-secret");
  cleanup.push(() => new Promise<void>(resolve => { http.close(() => resolve()); http.closeAllConnections(); }));
  const url = `http://127.0.0.1:${(http.address() as any).port}`;
  const node = await enrolled(store);
  saveNodeCredential({ version: 1, url, node_id: node.node_id, token: node.token, expires_at: node.expires_at, insecure_transport: true }, dir);
  await store.submitNodeTask({ target_node_id: node.node_id, node_spec: { version: 1, kind: "run-script", payload: {} } });
  let heartbeats = 0;
  const blocked = new Promise<{ status: "done"; result: string }>(resolve => {
    const timer = setInterval(() => {
      const listed = store.listNodes()[0];
      if (listed.liveness === "online") heartbeats++;
      if (heartbeats >= 2) { clearInterval(timer); resolve({ status: "done", result: "harmless:run-script" }); }
    }, 20);
    cleanup.push(() => clearInterval(timer));
  });
  const shutdown = new AbortController();
  const running = runNode({
    dir, signal: shutdown.signal, heartbeatMs: 30, capabilitiesMs: 40,
    executor: async () => blocked,
    probe: () => ({ protocol_version: 1, harnesses: [{ id: "grok", version: "unknown", installed: false, auth_status: "unknown", quota: { state: "unknown" } }] }),
  });
  const finished = await blocked;
  expect(finished.result).toContain("harmless");
  expect(heartbeats).toBeGreaterThanOrEqual(2);
  await vi.waitFor(() => expect(store.listNodes()[0].capabilities_freshness).toBe("fresh"));
  expect(JSON.stringify(store.listNodes()[0])).not.toContain(node.token);
  expect(JSON.stringify(store.auditLog(200))).not.toContain(node.token);
  shutdown.abort();
  await running.catch(() => undefined);
});

it("runs two jobs in parallel when config.concurrency is 2 (gh-91)", async () => {
  const { store, path, dir } = fixture();
  const http = await serveHttp(path, "127.0.0.1", 0, "admin-secret");
  cleanup.push(() => new Promise<void>(resolve => { http.close(() => resolve()); http.closeAllConnections(); }));
  const url = `http://127.0.0.1:${(http.address() as any).port}`;
  const node = await enrolled(store);
  saveNodeCredential({ version: 1, url, node_id: node.node_id, token: node.token, expires_at: node.expires_at, insecure_transport: true }, dir);
  const j1 = await store.submitNodeTask({ target_node_id: node.node_id, node_spec: { version: 1, kind: "run-script", payload: {} } });
  const j2 = await store.submitNodeTask({ target_node_id: node.node_id, node_spec: { version: 1, kind: "run-script", payload: {} } });
  let inFlight = 0, maxInFlight = 0;
  const seen = new Set<string>();
  const executor = async (job: any) => {
    inFlight += 1; maxInFlight = Math.max(maxInFlight, inFlight); seen.add(job.id);
    // Hold each job open until both slots are occupied (or give up) — proves
    // overlap rather than relying on executor-vs-stagger timing.
    for (let i = 0; i < 400 && seen.size < 2; i += 1) await new Promise(resolve => setTimeout(resolve, 25));
    inFlight -= 1;
    return { status: "done" as const, result: `done:${job.id}` };
  };
  const shutdown = new AbortController();
  const running = runNode({
    dir, signal: shutdown.signal, heartbeatMs: 40, capabilitiesMs: 60,
    executor, config: { workspaces: {}, concurrency: 2 },
    probe: () => ({ protocol_version: 1, harnesses: [] }),
  });
  await vi.waitFor(() => expect(seen.size).toBe(2), { timeout: 10_000 });
  expect(maxInFlight).toBe(2);
  await vi.waitFor(() => {
    const jobs = store.nodeQuery("SELECT status FROM jobs WHERE type='node' AND target_node_id=?", [node.node_id]).map((j: any) => j.status);
    expect(jobs.length).toBe(2);
    expect(jobs.every((s: string) => s === "done")).toBe(true);
  }, { timeout: 10_000 });
  const caps = JSON.parse(store.listNodes()[0] ? (store as any).nodeQuery("SELECT capabilities_json FROM nodes WHERE id=?", [node.node_id])[0]?.capabilities_json ?? "{}" : "{}");
  expect(caps.max_concurrency).toBe(2);
  shutdown.abort();
  await running.catch(() => undefined);
});

it("clamps config.concurrency to the protocol cap of 8 (gh-91)", async () => {
  const { store, path, dir } = fixture();
  const http = await serveHttp(path, "127.0.0.1", 0, "admin-secret");
  cleanup.push(() => new Promise<void>(resolve => { http.close(() => resolve()); http.closeAllConnections(); }));
  const url = `http://127.0.0.1:${(http.address() as any).port}`;
  const node = await enrolled(store);
  saveNodeCredential({ version: 1, url, node_id: node.node_id, token: node.token, expires_at: node.expires_at, insecure_transport: true }, dir);
  const shutdown = new AbortController();
  const running = runNode({
    dir, signal: shutdown.signal, heartbeatMs: 40, capabilitiesMs: 60,
    executor: async () => ({ status: "done" as const, result: "x" }),
    config: { workspaces: {}, concurrency: 99 },
    probe: () => ({ protocol_version: 1, harnesses: [] }),
  });
  await vi.waitFor(() => {
    const caps = JSON.parse((store as any).nodeQuery("SELECT capabilities_json FROM nodes WHERE id=?", [node.node_id])[0]?.capabilities_json ?? "{}");
    expect(caps.max_concurrency).toBe(8);
  }, { timeout: 10_000 });
  shutdown.abort();
  await running.catch(() => undefined);
});

it("re-authenticates when the server session expires instead of exiting (gh-110)", async () => {
  const { store, path, dir } = fixture();
  const http = await serveHttp(path, "127.0.0.1", 0, "admin-secret");
  cleanup.push(() => new Promise<void>(resolve => { http.close(() => resolve()); http.closeAllConnections(); }));
  const url = `http://127.0.0.1:${(http.address() as any).port}`;
  const node = await enrolled(store);
  saveNodeCredential({ version: 1, url, node_id: node.node_id, token: node.token, expires_at: node.expires_at, insecure_transport: true }, dir);
  const shutdown = new AbortController();
  let settled = false;
  const running = runNode({
    dir, signal: shutdown.signal, heartbeatMs: 30, capabilitiesMs: 60,
    executor: async () => ({ status: "done" as const, result: "x" }),
    probe: () => ({ protocol_version: 1, harnesses: [] }),
  }).finally(() => { settled = true; });
  await vi.waitFor(() => expect(store.listNodes()[0].liveness).toBe("online"), { timeout: 10_000 });
  // Expire the server-side session: the next heartbeat/poll gets a 401.
  store.nodeQuery("UPDATE nodes SET session_expires_at=? WHERE id=?", [new Date(Date.now() - 1000).toISOString(), node.node_id]);
  await new Promise(resolve => setTimeout(resolve, 400));
  expect(settled).toBe(false);
  // Work must still flow on the re-established session.
  await store.submitNodeTask({ target_node_id: node.node_id, node_spec: { version: 1, kind: "run-script", payload: {} } });
  await vi.waitFor(() => {
    const statuses = store.nodeQuery("SELECT status FROM jobs WHERE type='node' AND target_node_id=?", [node.node_id]).map((j: any) => j.status);
    expect(statuses.length).toBe(1);
    expect(statuses[0]).toBe("done");
  }, { timeout: 15_000 });
  shutdown.abort();
  await running.catch(() => undefined);
});

it("retries session establishment instead of exiting on session-denied (gh-110)", async () => {
  const { path, dir } = fixture();
  const http = await serveHttp(path, "127.0.0.1", 0, "admin-secret");
  cleanup.push(() => new Promise<void>(resolve => { http.close(() => resolve()); http.closeAllConnections(); }));
  const url = `http://127.0.0.1:${(http.address() as any).port}`;
  saveNodeCredential({ version: 1, url, node_id: "node-x", token: `uw_node_${"0".repeat(64)}`, expires_at: new Date(Date.now() + 86400000).toISOString(), insecure_transport: true }, dir);
  const shutdown = new AbortController();
  let settled = false;
  const running = runNode({
    dir, signal: shutdown.signal, heartbeatMs: 30, capabilitiesMs: 60,
    executor: async () => ({ status: "done" as const, result: "x" }),
    probe: () => ({ protocol_version: 1, harnesses: [] }),
  }).finally(() => { settled = true; });
  await new Promise(resolve => setTimeout(resolve, 500));
  expect(settled).toBe(false);
  shutdown.abort();
  await running.catch(() => undefined);
});

it("escapes node names on the dashboard and refuses credential-bearing inventory", async () => {
  const { store } = fixture();
  const node = await enrolled(store);
  const session = await store.startNodeSession(node.token);
  store.nodeQuery("UPDATE nodes SET name=? WHERE id=?", ["<script>xss</script>", node.node_id]);
  await store.nodeHeartbeat(node.token, session.session_id);
  expect((await store.putNodeCapabilities(node.token, session.session_id, 1, {
    protocol_version: 1, harnesses: [{ id: "uw_node_ab", version: "1", installed: true, auth_status: "ready", quota: { state: "available" } }],
  })).error).toBeTruthy();
  const html = renderDashboard(store.dashboard());
  expect(html).toContain("Nodes");
  expect(html).toContain("&lt;script&gt;xss&lt;/script&gt;");
  expect(html).not.toContain("<script>xss</script>");
  expect(html).not.toContain(node.token);
});

it("attests operation kinds and workspaces derived from config, not a partial inventory snapshot", async () => {
  const { store, path, dir } = fixture();
  const http = await serveHttp(path, "127.0.0.1", 0, "admin-secret");
  cleanup.push(() => new Promise<void>(resolve => { http.close(() => resolve()); http.closeAllConnections(); }));
  const url = `http://127.0.0.1:${(http.address() as any).port}`;
  const node = await enrolled(store);
  saveNodeCredential({ version: 1, url, node_id: node.node_id, token: node.token, expires_at: node.expires_at, insecure_transport: true }, dir);
  const shutdown = new AbortController();
  const running = runNode({
    dir, signal: shutdown.signal, heartbeatMs: 40, capabilitiesMs: 60,
    executor: async () => ({ status: "done" as const, result: "x" }),
    config: {
      workspaces: { home: "/tmp", underwright: "/tmp" },
      scripts: { smoke: { executable: "echo" } },
      harnesses: { codex: { executable: "true" } },
      // Partial snapshot with no operational arrays — must not blank the attestation.
      inventory: { harnesses: [{ id: "codex", installed: true, auth_status: "ready", quota: { state: "unknown" } }] },
    },
  });
  await vi.waitFor(() => {
    const caps = JSON.parse((store as any).nodeQuery("SELECT capabilities_json FROM nodes WHERE id=?", [node.node_id])[0]?.capabilities_json ?? "{}");
    expect(caps.supported_operation_kinds).toEqual(["run-script", "launch-agent"]);
    expect(caps.approved_workspace_ids.sort()).toEqual(["home", "underwright"]);
    expect(caps.harnesses[0].auth_status).toBe("ready");
  }, { timeout: 10_000 });
  shutdown.abort();
  await running.catch(() => undefined);
});
