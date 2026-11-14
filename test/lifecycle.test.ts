import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteStore } from "../src/store.js";
import { checkTransition, getLifecyclePolicy, pipelineFor, TRANSITIONS } from "../src/lifecycle.js";

const ON = getLifecyclePolicy({ dod: {}, enforcement: "warn", lifecycle: {} } as any);
const OFF = getLifecyclePolicy({ dod: {}, enforcement: "warn" });

describe("state-machine (pure)", () => {
  const task = (status: any, extra: object = {}) => ({ id: "t", type: "feature", status, ...extra });

  it("is permissive when no lifecycle block is configured", () => {
    expect(OFF.enabled).toBe(false);
    expect(checkTransition({ task: task("open") }, "done", "complete", OFF)).toBeNull();
  });

  it("rejects edges outside the transition table", () => {
    expect(TRANSITIONS.done).toEqual(["open"]);
    expect(checkTransition({ task: task("done") }, "in_review", "status", ON)).toContain("done → in_review");
    expect(checkTransition({ task: task("blocked") }, "claimed", "claim", ON)).toContain("blocked → claimed");
    expect(checkTransition({ task: task("open") }, "in_review", "status", ON)).toContain("open → in_review");
  });

  it("cannot complete from open, cannot enter claimed except via claim_task", () => {
    expect(checkTransition({ task: task("open") }, "done", "complete", ON)).toContain("cannot complete from 'open'");
    expect(checkTransition({ task: task("in_review") }, "claimed", "status", ON)).toContain("claim_task");
    expect(checkTransition({ task: task("claimed") }, "open", "status", ON)).toContain("release_task");
  });

  it("cannot verify without evidence", () => {
    const t = task("claimed");
    expect(checkTransition({ task: t, evidence: [] }, "done", "complete", ON)).toContain("verifying");
    expect(checkTransition({ task: t, evidence: [{ kind: "test_run", exit_code: 1 }] }, "done", "complete", ON)).toContain("verifying");
    expect(checkTransition({ task: t, evidence: [{ kind: "test_run", exit_code: 0 }] }, "done", "complete", ON)).toBeNull();
  });

  it("allows sync reconciliation to done/open via set status", () => {
    expect(checkTransition({ task: task("open") }, "done", "status", ON)).toBeNull();
    expect(checkTransition({ task: task("done") }, "open", "status", ON)).toBeNull();
  });
});

describe("per-type-pipelines (pure)", () => {
  it("docs skips verifying, architecture requires design, bug requires reproduction", () => {
    expect(pipelineFor("docs", ON).verify).toBe(false);
    expect(pipelineFor("architecture", ON).design).toBe(true);
    expect(pipelineFor("bug", ON).reproduction).toBe(true);
    expect(pipelineFor("unknown-type", ON)).toEqual(pipelineFor("default", ON));
  });

  it("docs completes on review evidence alone", () => {
    const t = { id: "d", type: "docs", status: "claimed" as const };
    expect(checkTransition({ task: t, evidence: [{ kind: "review" }] }, "done", "complete", ON)).toBeNull();
  });

  it("architecture and L-estimate tasks need a design artifact before reviewing or done", () => {
    const arch = { id: "a", type: "architecture", status: "claimed" as const };
    expect(checkTransition({ task: arch, artifacts: [] }, "in_review", "status", ON)).toContain("design");
    expect(checkTransition({ task: arch, artifacts: [] }, "done", "complete", ON)).toContain("design");
    expect(checkTransition({ task: arch, artifacts: [{ kind: "design" }] }, "done", "complete", ON)).toBeNull();
    const big = { id: "b", type: "feature", estimate: "L", status: "claimed" as const };
    expect(checkTransition({ task: big, artifacts: [], evidence: [{ kind: "test_run", exit_code: 0 }] }, "done", "complete", ON)).toContain("design");
    expect(checkTransition({ task: big, artifacts: [{ kind: "spec" }], evidence: [{ kind: "test_run", exit_code: 0 }] }, "done", "complete", ON)).toBeNull();
  });

  it("bug needs a failing reproduction before a passing verification", () => {
    const bug = { id: "g", type: "bug", status: "claimed" as const };
    expect(checkTransition({ task: bug, evidence: [{ kind: "test_run", exit_code: 0 }] }, "done", "complete", ON)).toContain("reproduction");
    expect(checkTransition({ task: bug, evidence: [{ kind: "test_run", exit_code: 1 }, { kind: "test_run", exit_code: 0 }] }, "done", "complete", ON)).toBeNull();
  });

  it("policy pipelines override defaults, including a required reviewing phase", () => {
    const lc = getLifecyclePolicy({ dod: {}, enforcement: "warn", lifecycle: { pipelines: { feature: { review: true }, docs: { verify: true } } } } as any);
    expect(pipelineFor("docs", lc).verify).toBe(true);
    const ev = [{ kind: "test_run", exit_code: 0 }];
    expect(checkTransition({ task: { id: "f", type: "feature", status: "claimed" }, evidence: ev }, "done", "complete", lc)).toContain("reviewing");
    expect(checkTransition({ task: { id: "f", type: "feature", status: "in_review" }, evidence: ev }, "done", "complete", lc)).toBeNull();
  });

  it("lifecycle.enabled=false disables enforcement", () => {
    const lc = getLifecyclePolicy({ dod: {}, enforcement: "warn", lifecycle: { enabled: false } } as any);
    expect(checkTransition({ task: { id: "x", status: "open" } }, "done", "complete", lc)).toBeNull();
  });
});

describe("state-machine (store)", () => {
  const DB = "/tmp/uw-test-lifecycle.db";
  let store: SqliteStore;
  let dir: string;

  beforeEach(() => {
    for (const s of ["", "-wal", "-shm"]) rmSync(`${DB}${s}`, { force: true });
    dir = mkdtempSync(join(tmpdir(), "uw-lifecycle-"));
    const policy = join(dir, "policy.json");
    writeFileSync(policy, JSON.stringify({
      enforcement: "warn",
      lifecycle: { pipelines: { feature: { review: true } } },
    }));
    process.env.UNDERWRIGHT_POLICY = policy;
    store = new SqliteStore(DB);
  });
  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
    process.env.UNDERWRIGHT_POLICY = "/tmp/uw-no-policy.json";
  });

  it("walks claimed → in_review → done and rejects shortcuts", () => {
    const t = store.createTask({ title: "f", type: "feature", ac_ids: ["ac1"] });
    store.reportEvidence({ task_id: t.id, agent_id: "a", kind: "test_run", exit_code: 0, ac_ids: ["ac1"] });
    expect(store.completeTask(t.id, "a").error).toContain("cannot complete from 'open'");
    expect(store.setTaskStatus(t.id, "in_review", "a").error).toContain("open → in_review");
    expect(store.claimTask(t.id, "a")).not.toHaveProperty("error");
    expect(store.completeTask(t.id, "a").error).toContain("reviewing");
    expect(store.setTaskStatus(t.id, "open", "a").error).toContain("release_task");
    expect(store.setTaskStatus(t.id, "in_review", "a")).toEqual({ id: t.id, status: "in_review" });
    expect(store.completeTask(t.id, "a")).toHaveProperty("completed", t.id);
    expect(store.setTaskStatus(t.id, "blocked", "a").error).toContain("done → blocked");
  });

  it("rejects claiming a manually blocked task until it is unblocked", () => {
    const t = store.createTask({ title: "b", type: "docs" });
    expect(store.setTaskStatus(t.id, "blocked", "human")).toHaveProperty("status", "blocked");
    expect(store.claimTask(t.id, "a").error).toContain("blocked → claimed");
    expect(store.setTaskStatus(t.id, "open", "human")).toHaveProperty("status", "open");
    expect(store.claimTask(t.id, "a")).not.toHaveProperty("error");
  });

  it("drops the claim when a claimed task is walked back to open via blocked", () => {
    const t = store.createTask({ title: "c", type: "docs" });
    store.claimTask(t.id, "a");
    expect(store.setTaskStatus(t.id, "blocked", "b")).toHaveProperty("status", "blocked");
    expect(store.setTaskStatus(t.id, "open", "b")).toHaveProperty("status", "open");
    expect((store.getTask(t.id) as any).claim).toBeNull();
    expect(store.claimTask(t.id, "c")).not.toHaveProperty("error");
  });

  it("refuses to verify a bug without reproduction evidence", () => {
    const t = store.createTask({ title: "g", type: "bug", ac_ids: ["fix"] });
    store.claimTask(t.id, "a");
    store.reportEvidence({ task_id: t.id, agent_id: "a", kind: "test_run", exit_code: 0, ac_ids: ["fix"] });
    expect(store.completeTask(t.id, "a").error).toContain("reproduction");
    store.reportEvidence({ task_id: t.id, agent_id: "a", kind: "test_run", exit_code: 1 });
    expect(store.completeTask(t.id, "a")).toHaveProperty("completed", t.id);
  });
});
