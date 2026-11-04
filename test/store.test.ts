import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { SqliteStore } from "../src/store.js";
import { rmSync } from "node:fs";

// Contract suite: the same expectations run against any backend.
// Point DATABASE_URL at Postgres/Lakebase to exercise PgStore identically.

const DB = "/tmp/uw-test-store.db";
let store: SqliteStore;

beforeEach(() => {
  rmSync(DB, { force: true });
  rmSync(`${DB}-wal`, { force: true });
  rmSync(`${DB}-shm`, { force: true });
  // isolate: tests opt into a policy explicitly
  process.env.UNDERWRIGHT_POLICY = "/tmp/uw-no-policy.json";
  store = new SqliteStore(DB);
});
afterEach(() => store.close());

describe("claims", () => {
  it("grants exclusive claims and rejects second agent", () => {
    const t = store.createTask({ title: "x" });
    const a = store.claimTask(t.id, "agent-A");
    expect(a).not.toHaveProperty("error");
    const b = store.claimTask(t.id, "agent-B");
    expect(b).toHaveProperty("error");
  });

  it("allows reclaim after lease expiry", () => {
    const t = store.createTask({ title: "x" });
    store.claimTask(t.id, "agent-A", -1); // already-expired lease
    const b = store.claimTask(t.id, "agent-B");
    expect(b).not.toHaveProperty("error");
  });

  it("release returns task to open", () => {
    const t = store.createTask({ title: "x" });
    store.claimTask(t.id, "agent-A");
    store.releaseTask(t.id, "agent-A");
    expect(store.getTask(t.id).status).toBe("open");
  });
});

describe("evidence gate", () => {
  it("refuses completion with unproven ACs and lists them", () => {
    const t = store.createTask({ title: "x", ac_ids: ["ac1", "ac2"] });
    const r = store.completeTask(t.id, "agent-A");
    expect(r.error).toContain("ac1");
    expect(r.error).toContain("ac2");
  });

  it("completes when every AC has evidence", () => {
    const t = store.createTask({ title: "x", ac_ids: ["ac1"] });
    store.reportEvidence({ task_id: t.id, agent_id: "agent-A", kind: "test_run", exit_code: 0, ac_ids: ["ac1"] });
    expect(store.completeTask(t.id, "agent-A")).toHaveProperty("completed", t.id);
  });

  it("refuses completion with no ACs and no evidence", () => {
    const t = store.createTask({ title: "x" });
    expect(store.completeTask(t.id, "agent-A")).toHaveProperty("error");
  });
});

describe("helper index", () => {
  it("registers helpers discoverable via search", () => {
    store.registerHelper({ agent_id: "a", path: "src/u/log.ts", symbol: "log", kind: "util", summary: "structured logger" });
    const hits = store.searchContext("logger");
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].entity_type).toBe("helper");
  });
});

describe("jobs", () => {
  it("queues, starts, finishes", () => {
    const j = store.submitJob({ agent_id: "a", type: "test", command: "echo hi" });
    const started = store.nextJob("runner");
    expect(started.id).toBe(j.id);
    store.finishJob(j.id, "done", "hi");
    expect(store.getJob(j.id).status).toBe("done");
  });
});

describe.skipIf(!process.env.DATABASE_URL)("pg backend", () => {
  it("PgStore implements the same contract", async () => {
    const { PgStore } = await import("../src/pstore.js");
    const pg = await PgStore.connect(process.env.DATABASE_URL!);
    const t = await pg.createTask({ title: "pg-contract", ac_ids: ["a1"] });
    expect(t.id).toMatch(/^task-/);
    expect(await pg.claimTask(t.id, "a")).not.toHaveProperty("error");
    expect((await pg.claimTask(t.id, "b")) as any).toHaveProperty("error");
    await pg.reportEvidence({ task_id: t.id, agent_id: "a", kind: "test_run", exit_code: 0, ac_ids: ["a1"] });
    expect(await pg.completeTask(t.id, "a")).toHaveProperty("completed", t.id);
    await pg.close();
  });
});

describe("definition of done", () => {
  it("warns (not blocks) when policy missing requirements at warn level", async () => {
    process.env.UNDERWRIGHT_POLICY = new URL("../underwright.policy.json", import.meta.url).pathname;
    const t = store.createTask({ title: "feat", type: "feature" });
    store.claimTask(t.id, "agent-A");
    store.reportEvidence({ task_id: t.id, agent_id: "agent-A", kind: "test_run", exit_code: 0 });
    const r = store.completeTask(t.id, "agent-A") as any;
    expect(r).toHaveProperty("completed", t.id);
    expect(r.warnings?.join(" ")).toContain("coverage");
    delete process.env.UNDERWRIGHT_POLICY;
  });

  it("blocks at block level, incl. self-review", () => {
    const { mkdtempSync, writeFileSync } = require("node:fs");
    const dir = mkdtempSync("/tmp/uwpol-");
    writeFileSync(`${dir}/pol.json`, JSON.stringify({
      dod: { bug: { evidence: ["test_run", "review"] } },
      enforcement: "block",
    }));
    process.env.UNDERWRIGHT_POLICY = `${dir}/pol.json`;
    const t = store.createTask({ title: "fix", type: "bug" });
    store.claimTask(t.id, "agent-A");
    store.reportEvidence({ task_id: t.id, agent_id: "agent-A", kind: "test_run", exit_code: 0 });
    // self-review doesn't count
    store.reportEvidence({ task_id: t.id, agent_id: "agent-A", kind: "review" });
    let r = store.completeTask(t.id, "agent-A") as any;
    expect(r.error).toContain("other than the claim holder");
    // independent review passes
    store.reportEvidence({ task_id: t.id, agent_id: "agent-B", kind: "review" });
    r = store.completeTask(t.id, "agent-A") as any;
    expect(r).toHaveProperty("completed", t.id);
    delete process.env.UNDERWRIGHT_POLICY;
  });
});

describe("definition of ready", () => {
  it("blocks claim until triaged under dor policy", () => {
    process.env.UNDERWRIGHT_POLICY = new URL("../underwright.policy.json", import.meta.url).pathname;
    const t = store.createTask({ title: "untriaged" });
    const r = store.claimTask(t.id, "agent-A") as any;
    expect(r.error).toContain("not ready");
    store.updateTask(t.id, { type: "bug", ac_ids: ["a1"], estimate: "S" }, "triage-bot");
    expect(store.claimTask(t.id, "agent-A")).not.toHaveProperty("error");
    delete process.env.UNDERWRIGHT_POLICY;
  });
});

describe("resource locks", () => {
  it("blocks second agent on same resource, allows others", () => {
    expect(store.claimResources(["src/db/**"], "agent-A")).not.toHaveProperty("error");
    const r = store.claimResources(["src/db/**"], "agent-B") as any;
    expect(r.error).toBe("locked");
    expect(r.conflicts[0].agent_id).toBe("agent-A");
    expect(store.claimResources(["src/api/**"], "agent-B")).not.toHaveProperty("error");
  });
  it("batch check returns only active locks; release frees them", () => {
    store.claimResources(["a.ts", "b.ts"], "agent-A");
    expect((store.checkLocks(["a.ts", "b.ts", "c.ts"]) as any[]).length).toBe(2);
    store.releaseResources(["a.ts"], "agent-A");
    expect((store.checkLocks(["a.ts"]) as any[]).length).toBe(0);
  });
  it("claim_task auto-locks ownership paths and warns on conflict", () => {
    const t = store.createTask({ title: "x", ownership: { paths: ["src/x/**"] } });
    store.claimResources(["src/x/**"], "agent-B");
    const r = store.claimTask(t.id, "agent-A") as any;
    expect(r.task_id).toBe(t.id);
    expect(r.warning).toContain("agent-B");
  });
});
