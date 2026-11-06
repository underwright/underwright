import { afterEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteStore } from "../src/store.js";
import { agentInvocation, executeLeasedJob, runSupervisor, type JobCall } from "../src/runner.js";

const cleanups: (() => void)[] = [];
afterEach(() => { vi.useRealTimers(); cleanups.splice(0).reverse().forEach(f => f()); });
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "uw-jobs-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "jobs.db");
  const store = new SqliteStore(path);
  cleanups.push(() => store.close());
  return { store, path };
}
function caller(store: SqliteStore): JobCall {
  return async (name, a: any) => name === "next_job" ? store.nextJob(a.agent_id, a.host, a.ttl_seconds) :
    name === "renew_job" ? store.renewJob(a.job_id, a.agent_id, a.lease_token, a.ttl_seconds, a.result) :
    store.finishJob(a.job_id, a.status, a.result, a.agent_id, a.lease_token);
}

describe("remote queue leases", () => {
  it("respects combined affinity, bypasses ineligible jobs, and grants one owner across connections", async () => {
    const { store, path } = fixture();
    const second = new SqliteStore(path); cleanups.push(() => second.close());
    const pinned = store.submitJob({ agent_id: "submitter", type: "build", command: "echo pinned", host: "A", target_agent_id: "runner-A" });
    const any = store.submitJob({ agent_id: "submitter", type: "test", command: "echo any" });
    expect(second.nextJob("runner-B", "B").id).toBe(any.id);
    expect(store.nextJob("runner-B", "A")).toBeNull();
    expect(store.nextJob("runner-A", "B")).toBeNull();
    const claimed = store.nextJob("runner-A", "A");
    expect(claimed.id).toBe(pinned.id);
    expect(second.nextJob("runner-A", "A")).toBeNull();
    expect(second.finishJob(pinned.id, "done", "stolen", "runner-B", claimed.lease_token).error).toMatch(/lease/);
    expect(store.finishJob(pinned.id, "done", "bad token", "runner-A", "wrong").error).toMatch(/lease/);
    expect(store.renewJob(pinned.id, "runner-B", claimed.lease_token).error).toMatch(/lease/);
    expect(store.renewJob(pinned.id, "runner-A", claimed.lease_token, 120, "live output").error).toBeUndefined();
    expect(second.getJob(pinned.id).result).toBe("live output");
    expect(store.finishJob(pinned.id, "done", "ok", "runner-A", claimed.lease_token).status).toBe("done");
    expect(store.finishJob(pinned.id, "failed", "duplicate", "runner-A", claimed.lease_token).error).toMatch(/lease/);
    expect(store.auditLog().some(e => e.action === "renewed" && e.actor === "runner-A")).toBe(true);
  });

  it("rejects expired leases, reclaims with a new token, and fences the same runner's old attempt", () => {
    const { store } = fixture();
    vi.useFakeTimers();
    const j = store.submitJob({ agent_id: "a", type: "test", command: "echo hi", host: "A" });
    const old = store.nextJob("runner", "A", 5);
    vi.setSystemTime(Date.now() + 6000);
    expect(store.finishJob(j.id, "done", "late", "runner", old.lease_token).error).toMatch(/lease/);
    expect(store.renewJob(j.id, "runner", old.lease_token).error).toMatch(/lease/);
    expect(store.nextJob("other", "B")).toBeNull();
    const fresh = store.nextJob("runner", "A");
    expect(fresh.lease_token).not.toBe(old.lease_token);
    expect(store.finishJob(j.id, "done", "late", "runner", old.lease_token).error).toMatch(/lease/);
    expect(store.finishJob(j.id, "done", "fresh", "runner", fresh.lease_token).status).toBe("done");
  });

  it("migrates existing jobs without losing history, requeues orphaned running work, and accepts agent jobs", () => {
    const dir = mkdtempSync(join(tmpdir(), "uw-old-jobs-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const path = join(dir, "old.db");
    const db = new Database(path);
    db.exec(`CREATE TABLE jobs (id TEXT PRIMARY KEY, task_id TEXT, agent_id TEXT, type TEXT CHECK(type IN ('test','build','deploy','review')),
      status TEXT, command TEXT, result TEXT, created_at TEXT, started_at TEXT, finished_at TEXT);
      INSERT INTO jobs VALUES ('old',NULL,'a','test','done','echo old','history','2020',NULL,NULL);
      INSERT INTO jobs VALUES ('orphan',NULL,'a','build','running','echo orphan','','2020',NULL,NULL);
      PRAGMA user_version=5;`);
    db.close();
    const store = new SqliteStore(path); cleanups.push(() => store.close());
    expect(store.getJob("old").result).toBe("history");
    expect(store.getJob("orphan").status).toBe("queued");
    expect(store.submitJob({ agent_id: "a", type: "agent", agent: { executable: "codex", args: ["exec"], prompt: "task" } }).status).toBe("queued");
  });
});

describe("runner execution", () => {
  it("passes a templated prompt literally to a harness without shell evaluation", async () => {
    const { store } = fixture();
    const prompt = 'hello {{agent_id}} on {{host}} $(exit 99) `exit 99` "quoted"\n{{job_id}}';
    const submitted = store.submitJob({ agent_id: "a", type: "agent", agent: {
      executable: process.execPath, args: ["-e", "console.log(process.argv[1])", "{{prompt}}"], prompt,
    } });
    const job = store.nextJob("codex@A", "A");
    expect(agentInvocation(job, "codex@A", "A").args.at(-1)).toContain("hello codex@A on A");
    await executeLeasedJob(job, caller(store), { agentId: "codex@A", host: "A" });
    const done = store.getJob(submitted.id);
    expect(done.status).toBe("done");
    expect(done.result).toContain('$(exit 99) `exit 99` "quoted"');
    expect(done.result).toContain(submitted.id);
  });

  it("captures both output streams and records failed commands, spawn errors and timeouts", async () => {
    const { store } = fixture();
    for (const command of ["echo stdout; echo stderr >&2; exit 7", "sleep 30"]) {
      const j = store.submitJob({ agent_id: "a", type: "test", command });
      await executeLeasedJob(store.nextJob("r", "A"), caller(store), { agentId: "r", host: "A", timeoutMs: 100 });
      expect(store.getJob(j.id).status).toBe("failed");
      if (command.startsWith("echo")) expect(store.getJob(j.id).result).toMatch(/stdout\nstderr/);
      else expect(store.getJob(j.id).result).toContain("timed out");
    }
    const j = store.submitJob({ agent_id: "a", type: "agent", agent: { executable: "/no/such/harness", args: [], prompt: "hello" } });
    await executeLeasedJob(store.nextJob("r", "A"), caller(store), { agentId: "r", host: "A" });
    expect(store.getJob(j.id).status).toBe("failed");
    expect(store.getJob(j.id).result).toContain("ENOENT");
  });

  it("uploads live output, survives a transient renewal failure, and bounds the final result", async () => {
    const { store } = fixture();
    const j = store.submitJob({ agent_id: "a", type: "test", command: "echo live; sleep 3; echo final" });
    const call = caller(store);
    let renewals = 0;
    let live = "";
    const flaky: JobCall = async (name, args) => {
      if (name === "renew_job") {
        renewals++;
        if (renewals === 1) throw new Error("temporary network failure");
        const result = await call(name, args);
        live = store.getJob(j.id).result;
        return result;
      }
      return call(name, args);
    };
    await executeLeasedJob(store.nextJob("r", "A", 5), flaky, { agentId: "r", host: "A", ttlSeconds: 5 });
    expect(renewals).toBeGreaterThanOrEqual(2);
    expect(live).toContain("live");
    expect(store.getJob(j.id).result).toContain("final");
    expect(store.getJob(j.id).status).toBe("done");
    const large = store.submitJob({ agent_id: "a", type: "test", command: "echo large" });
    const job = store.nextJob("r", "A");
    store.finishJob(large.id, "done", "x".repeat(100000), "r", job.lease_token);
    expect(store.getJob(large.id).result).toHaveLength(64000);
  });

  it("retries polling after a transport failure", async () => {
    const { store } = fixture();
    const j = store.submitJob({ agent_id: "a", type: "test", command: "echo retry" });
    const abort = new AbortController();
    const call = caller(store);
    let polls = 0;
    const flaky: JobCall = async (name, args) => {
      if (name === "next_job" && ++polls === 1) throw new Error("connection refused");
      const result = await call(name, args);
      if (name === "finish_job") abort.abort();
      return result;
    };
    await runSupervisor(flaky, { agentId: "r", host: "A", signal: abort.signal, pollMs: 100 });
    expect(polls).toBe(2);
    expect(store.getJob(j.id).status).toBe("done");
  });

  it("renews while running and stops the child on loss of ownership", async () => {
    const { store } = fixture();
    store.submitJob({ agent_id: "a", type: "test", command: "echo live; sleep 30" });
    const call = caller(store);
    let snapshot = "";
    const loseLease: JobCall = async (name, args) => {
      if (name === "renew_job") { snapshot = String(args.result); return { error: "lost" }; }
      return call(name, args);
    };
    await expect(executeLeasedJob(store.nextJob("r", "A"), loseLease, { agentId: "r", host: "A" })).rejects.toThrow(/lost lease/);
    expect(snapshot).toContain("live");
  });

  it("runs one supervisor iteration and shuts down an active child", async () => {
    const { store } = fixture();
    const abort = new AbortController();
    const j = store.submitJob({ agent_id: "a", type: "test", command: "echo started; sleep 30" });
    const call = caller(store);
    const shutdownCall: JobCall = async (name, args) => {
      const result = await call(name, args);
      if (name === "next_job") setTimeout(() => abort.abort(), 100);
      return result;
    };
    await runSupervisor(shutdownCall, { agentId: "r", host: "A", signal: abort.signal, once: true });
    expect(store.getJob(j.id).status).toBe("failed");
    expect(store.getJob(j.id).result).toContain("shutting down");
  });
});
