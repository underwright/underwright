import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Store } from "../src/store.js";
import { rmSync } from "node:fs";

const DB = "/tmp/uw-test-store.db";
let store: Store;

beforeEach(() => {
  rmSync(DB, { force: true });
  rmSync(`${DB}-wal`, { force: true });
  rmSync(`${DB}-shm`, { force: true });
  store = new Store(DB);
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
