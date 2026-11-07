import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { SqliteStore } from "../src/store.js";
import { PgStore } from "../src/pstore.js";
import type { IStore } from "../src/istore.js";
import { startLeaseSweeper } from "../src/sweeper.js";
import { serve, serveHttp } from "../src/server.js";

beforeEach(() => {
  vi.stubEnv("UNDERWRIGHT_POLICY", "/tmp/uw-lease-no-policy.json");
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

function sweepContract(open: () => Promise<IStore>) {
  let store: IStore;
  beforeEach(async () => { store = await open(); });
  afterEach(async () => { await store.close(); });

  it("reclaims expired claims, reopens tasks and emits one event and watcher message", async () => {
    const task = await store.createTask({ title: "expired lease" });
    await store.claimTask(task.id, "old-holder", -1);
    const expiry = (await store.getTask(task.id)).claim.lease_expires;
    await store.watchTask("observer", task.id);

    expect(await store.sweepExpiredClaims()).toEqual({ reclaimed: [task.id] });
    expect(await store.getTask(task.id)).toMatchObject({ status: "open", claim: null });
    const events = (await store.auditLog(100)).filter(e => e.entity_id === task.id && e.action === "lease_expired");
    expect(events).toHaveLength(1);
    const data = typeof events[0].data === "string" ? JSON.parse(events[0].data) : events[0].data;
    expect(events[0]).toMatchObject({ entity_type: "task", actor: "lease-sweeper" });
    expect(data).toMatchObject({ agent_id: "old-holder", reopened: true });
    expect(new Date(data.lease_expires).getTime()).toBe(new Date(expiry).getTime());
    const messages = await store.inbox("observer");
    expect(messages).toHaveLength(1);
    expect(messages[0].body).toContain("lease expired");
    expect(await store.sweepExpiredClaims()).toEqual({ reclaimed: [] });
    expect(await store.inbox("observer")).toEqual([]);
    expect(await store.claimTask(task.id, "new-holder")).not.toHaveProperty("error");
  });

  it("leaves active and renewed claims intact", async () => {
    const active = await store.createTask({ title: "active" });
    const renewed = await store.createTask({ title: "renewed" });
    await store.claimTask(active.id, "active-holder");
    await store.claimTask(renewed.id, "renewed-holder", -1);
    await store.renewLease(renewed.id, "renewed-holder");
    expect(await store.sweepExpiredClaims()).toEqual({ reclaimed: [] });
    for (const task of [active, renewed]) {
      expect(await store.getTask(task.id)).toMatchObject({ status: "claimed", claim: { task_id: task.id } });
    }
  });

  it("removes expired claims without reopening tasks in other states", async () => {
    const ids: string[] = [];
    for (const status of ["in_review", "blocked", "done"] as const) {
      const task = await store.createTask({ title: status });
      ids.push(task.id);
      await store.claimTask(task.id, "holder", -1);
      await store.setTaskStatus(task.id, status, "reviewer");
    }
    expect((await store.sweepExpiredClaims()).reclaimed.sort()).toEqual(ids.sort());
    for (const id of ids) {
      const task = await store.getTask(id);
      expect(task.status).toBe(task.title);
      expect(task.claim).toBeNull();
    }
  });

  it("concurrent sweepers emit only one expiration for a claim", async () => {
    const task = await store.createTask({ title: "concurrent sweeps" });
    await store.claimTask(task.id, "holder", -1);
    const results = await Promise.all([store.sweepExpiredClaims(), store.sweepExpiredClaims()]);
    expect(results.flatMap(r => r.reclaimed)).toEqual([task.id]);
    expect((await store.auditLog(100)).filter(e => e.entity_id === task.id && e.action === "lease_expired")).toHaveLength(1);
  });
}

describe("SQLite lease sweeper", () => {
  sweepContract(async () => new SqliteStore(":memory:"));

  it("rolls back claims, task state and events when notification fails", () => {
    const store = new SqliteStore(":memory:");
    try {
      const task = store.createTask({ title: "atomic expiry" });
      store.claimTask(task.id, "holder", -1);
      store.watchTask("observer", task.id);
      const notify = vi.spyOn(store as any, "notifyWatchers")
        .mockImplementationOnce(() => { throw new Error("notification failed"); });
      expect(() => store.sweepExpiredClaims()).toThrow("notification failed");
      expect(store.getTask(task.id)).toMatchObject({ status: "claimed", claim: { agent_id: "holder" } });
      expect(store.auditLog().filter(e => e.action === "lease_expired")).toEqual([]);
      notify.mockRestore();
      expect(store.sweepExpiredClaims()).toEqual({ reclaimed: [task.id] });
      expect(store.inbox("observer")).toHaveLength(1);
    } finally { store.close(); }
  });

  it("expires leases at the exact boundary", () => {
    vi.useFakeTimers();
    const store = new SqliteStore(":memory:");
    try {
      const task = store.createTask({ title: "boundary" });
      store.claimTask(task.id, "holder", 1);
      vi.advanceTimersByTime(999);
      expect(store.sweepExpiredClaims()).toEqual({ reclaimed: [] });
      vi.advanceTimersByTime(1);
      expect(store.sweepExpiredClaims()).toEqual({ reclaimed: [task.id] });
    } finally { store.close(); }
  });
});

describe.skipIf(!process.env.DATABASE_URL)("Postgres lease sweeper", () => {
  sweepContract(() => PgStore.connect(process.env.DATABASE_URL!));
});

describe("background lease sweeper", () => {
  it("runs immediately, prevents overlap, retries errors and stops cleanly", async () => {
    vi.useFakeTimers();
    let finish!: () => void;
    const sweep = vi.fn().mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }))
      .mockRejectedValueOnce(new Error("temporary failure"))
      .mockResolvedValue({ reclaimed: [] });
    const onError = vi.fn();
    const stop = startLeaseSweeper({ sweepExpiredClaims: sweep }, 100, onError);
    expect(sweep).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(300);
    expect(sweep).toHaveBeenCalledTimes(1);
    finish();
    await vi.advanceTimersByTimeAsync(100);
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: "temporary failure" }));
    await vi.advanceTimersByTimeAsync(100);
    expect(sweep).toHaveBeenCalledTimes(3);
    await stop();
    await vi.advanceTimersByTimeAsync(300);
    expect(sweep).toHaveBeenCalledTimes(3);
  });

  it("sweeps idle dispatcher assignments after reclaiming leases", async () => {
    vi.useFakeTimers();
    const sweepExpiredClaims = vi.fn().mockResolvedValue({ reclaimed: ["t1"] });
    const sweepIdleDispatches = vi.fn().mockResolvedValue({ reassigned: [], logged: [] });
    const stop = startLeaseSweeper({ sweepExpiredClaims, sweepIdleDispatches }, 60_000);
    await vi.advanceTimersByTimeAsync(0);
    expect(sweepExpiredClaims).toHaveBeenCalledTimes(1);
    expect(sweepIdleDispatches).toHaveBeenCalledTimes(1);
    await stop();
  });

  it("sweeps expired node jobs after idle dispatch", async () => {
    vi.useFakeTimers();
    const sweepExpiredClaims = vi.fn().mockResolvedValue({ reclaimed: [] });
    const sweepIdleDispatches = vi.fn().mockResolvedValue({ reassigned: [], logged: [] });
    const sweepExpiredNodeJobs = vi.fn().mockResolvedValue({ expired: ["job-1"] });
    const stop = startLeaseSweeper({ sweepExpiredClaims, sweepIdleDispatches, sweepExpiredNodeJobs }, 60_000);
    await vi.advanceTimersByTimeAsync(0);
    expect(sweepExpiredNodeJobs).toHaveBeenCalledTimes(1);
    await stop();
  });

  it("reports lease and idle sweep failures separately", async () => {
    vi.useFakeTimers();
    const sweepExpiredClaims = vi.fn().mockRejectedValue(new Error("lease down"));
    const sweepIdleDispatches = vi.fn().mockRejectedValue(new Error("idle down"));
    const onError = vi.fn();
    const stop = startLeaseSweeper({ sweepExpiredClaims, sweepIdleDispatches }, 60_000, onError);
    await vi.advanceTimersByTimeAsync(0);
    expect(onError.mock.calls.map(c => c[0].message)).toEqual(["lease down", "idle down"]);
    await stop();
  });

  it("waits for an in-flight sweep before shutdown", async () => {
    vi.useFakeTimers();
    let finish!: () => void;
    const sweep = vi.fn(() => new Promise<any>(resolve => { finish = () => resolve({ reclaimed: [] }); }));
    const stop = startLeaseSweeper({ sweepExpiredClaims: sweep });
    const stopped = vi.fn();
    const pending = stop().then(stopped);
    await Promise.resolve();
    expect(stopped).not.toHaveBeenCalled();
    finish();
    await pending;
    expect(stopped).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
});

it("stdio server sweeps periodically and clears its timer on close", async () => {
  vi.stubEnv("DATABASE_URL", "");
  vi.useFakeTimers();
  const dir = mkdtempSync(join(tmpdir(), "uw-sweep-stdio-"));
  const store = new SqliteStore(join(dir, "store.db"));
  const task = store.createTask({ title: "abandoned after startup" });
  store.claimTask(task.id, "holder", 1);
  const server = await serve(join(dir, "store.db"));
  try {
    expect(store.getTask(task.id).status).toBe("claimed");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(store.getTask(task.id)).toMatchObject({ status: "open", claim: null });
  } finally {
    await server.close();
    expect(vi.getTimerCount()).toBe(0);
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

it("HTTP server sweeps on startup without requiring an MCP request", async () => {
  vi.stubEnv("DATABASE_URL", "");
  const dir = mkdtempSync(join(tmpdir(), "uw-sweep-http-"));
  const store = new SqliteStore(join(dir, "store.db"));
  const task = store.createTask({ title: "abandoned before startup" });
  store.claimTask(task.id, "holder", -1);
  let http: Awaited<ReturnType<typeof serveHttp>> | undefined;
  try {
    http = await serveHttp(join(dir, "store.db"), "127.0.0.1", 0);
    expect(store.getTask(task.id)).toMatchObject({ status: "open", claim: null });
  } finally {
    if (http) {
      const closed = once(http, "close");
      http.close();
      await closed;
    }
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
