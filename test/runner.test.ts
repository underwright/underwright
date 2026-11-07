import { afterEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteStore } from "../src/store.js";
import { getHarnessBackend, type Policy } from "../src/policy.js";
import {
  agentInvocation,
  executeLeasedJob,
  extractOmnigentSession,
  OMNIGENT_HARNESS_SUPPORT,
  runSupervisor,
  type JobCall,
} from "../src/runner.js";

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

describe("omnigent backend", () => {
  const jobWith = (agent_spec: object) => ({
    id: "job-omni", task_id: "task-9", agent_spec,
    lease_token: "tok", lease_expires: new Date(Date.now() + 60000).toISOString(),
  });
  const spec = { executable: "codex", args: ["exec"], prompt: "do the thing" };
  const matrix: Policy = {
    harness_matrix: {
      "codex@A": { harness: "codex", backend: "omnigent" },
      "*": { backend: "raw" },
    },
  } as Policy;

  it("templates `omni run --harness H -p PROMPT` when the spec requests omnigent", () => {
    const inv = agentInvocation(jobWith({ ...spec, backend: "omnigent", harness: "codex" }), "codex@A", "A", { omniAvailable: true });
    expect(inv.executable).toBe("omni");
    expect(inv.args).toEqual(["run", "--harness", "codex", "-p", "do the thing"]);
    expect(inv.backend).toBe("omnigent");
  });

  it("templates --server when the spec names a remote omnigent server", () => {
    const inv = agentInvocation(jobWith({ ...spec, backend: "omnigent", harness: "claude-sdk", server: "https://omni.internal" }),
      "a@A", "A", { omniAvailable: true });
    expect(inv.args).toEqual(["run", "--harness", "claude-sdk", "--server", "https://omni.internal", "-p", "do the thing"]);
  });

  it("expands prompt placeholders inside the omnigent prompt", () => {
    const inv = agentInvocation(jobWith({ executable: "codex", args: [], prompt: "claim {{task_id}} as {{agent_id}} on {{host}}", backend: "omnigent", harness: "codex" }),
      "codex@A", "A", { omniAvailable: true });
    expect(inv.args.at(-1)).toBe("claim task-9 as codex@A on A");
  });

  it("derives the harness from the executable basename when unspecified", () => {
    const inv = agentInvocation(jobWith({ executable: "/usr/local/bin/codex", args: [], prompt: "x", backend: "omnigent" }),
      "a@A", "A", { omniAvailable: true });
    expect(inv.args).toEqual(["run", "--harness", "codex", "-p", "x"]);
  });

  it("falls back to the raw CLI when omni is unavailable or the harness is unsupported", () => {
    const unavailable = agentInvocation(jobWith({ ...spec, backend: "omnigent", harness: "codex" }), "codex@A", "A", { omniAvailable: false });
    expect(unavailable.executable).toBe("codex");
    expect(unavailable.args).toEqual(["exec", "do the thing"]);
    expect(unavailable.backend).toBe("raw");
    const unsupported = agentInvocation(jobWith({ ...spec, backend: "omnigent", harness: "cmdc" }), "cmdc@A", "A", { omniAvailable: true });
    expect(unsupported.executable).toBe("codex");
    expect(unsupported.backend).toBe("raw");
  });

  it("covers codex and claude-sdk through omnigent while cmdc stays raw-only", () => {
    expect(OMNIGENT_HARNESS_SUPPORT.codex).toBe(true);
    expect(OMNIGENT_HARNESS_SUPPORT["claude-sdk"]).toBe(true);
    expect(OMNIGENT_HARNESS_SUPPORT.cmdc).toBe(false);
  });

  it("resolves the policy matrix with the spec and the exact agent id winning", () => {
    expect(getHarnessBackend("codex@A", matrix)).toEqual({ harness: "codex", backend: "omnigent" });
    expect(getHarnessBackend("grok@B", matrix)).toEqual({ backend: "raw" });
    expect(getHarnessBackend("grok@B", {} as Policy)).toEqual({});
    const viaMatrix = agentInvocation(jobWith(spec), "codex@A", "A", { omniAvailable: true, policy: matrix });
    expect(viaMatrix.executable).toBe("omni");
    expect(viaMatrix.args).toEqual(["run", "--harness", "codex", "-p", "do the thing"]);
    const specWins = agentInvocation(jobWith({ ...spec, backend: "raw" }), "codex@A", "A", { omniAvailable: true, policy: matrix });
    expect(specWins.executable).toBe("codex");
    expect(specWins.backend).toBe("raw");
  });

  it("extracts the last omnigent session marker, or a matching transcript URL", () => {
    expect(extractOmnigentSession("noise\nomnigent session: https://omni.example/s/one\nmore\nomnigent session: abc123-def\n")).toBe("abc123-def");
    expect(extractOmnigentSession("banner https://omni.example/transcript/zzz99 tail")).toBe("https://omni.example/transcript/zzz99");
    expect(extractOmnigentSession("no marker here")).toBeNull();
  });

  it("launches through a PATH-visible omni and records the session link in the job result", async () => {
    const { store } = fixture();
    const dir = mkdtempSync(join(tmpdir(), "uw-omni-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    writeFileSync(join(dir, "omni"), "#!/bin/sh\necho \"omnigent session: https://omni.example/s/abc123\"\n", { mode: 0o755 });
    const oldPath = process.env.PATH;
    process.env.PATH = oldPath ? `${dir}:${oldPath}` : dir;
    try {
      const j = store.submitJob({ agent_id: "a", type: "agent", agent: { executable: "definitely-not-a-real-harness", args: ["exec"], prompt: "hello", backend: "omnigent", harness: "codex" } });
      await executeLeasedJob(store.nextJob("r", "A"), caller(store), { agentId: "r", host: "A" });
      const done = store.getJob(j.id);
      expect(done.status).toBe("done");
      expect(done.result).toContain("omnigent session: https://omni.example/s/abc123");
    } finally {
      process.env.PATH = oldPath;
    }
  });
});
