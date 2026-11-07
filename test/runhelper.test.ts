import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { rmSync } from "node:fs";
import Database from "better-sqlite3";
import { SqliteStore } from "../src/store.js";
import { PLAYBOOKS, getPlaybook, renderCommand } from "../src/playbooks.js";

// gh-36: executable helpers — run_helper MCP tool + routine playbooks.

const DB = "/tmp/uw-test-runhelper.db";
let store: SqliteStore;

beforeEach(() => {
  rmSync(DB, { force: true });
  rmSync(`${DB}-wal`, { force: true });
  rmSync(`${DB}-shm`, { force: true });
  process.env.UNDERWRIGHT_POLICY = "/tmp/uw-no-policy.json";
  store = new SqliteStore(DB);
});
afterEach(() => {
  store.close();
  delete process.env.UNDERWRIGHT_POLICY;
});

describe("playbook catalog", () => {
  it("ships the five gh-36 routines as command templates", () => {
    expect(PLAYBOOKS.map((p) => p.name).sort()).toEqual([
      "branch-worktree-setup",
      "evidence-attach",
      "github-sync",
      "index-refresh",
      "merge-and-verify",
    ]);
  });

  it("renders placeholders from args; leftover placeholders are an error", () => {
    const pb = getPlaybook("merge-and-verify")!;
    expect(renderCommand(pb.command, { branch: "feature-x" }).command)
      .toBe("git merge --no-edit feature-x && npm run build && npm test");
    const missing = renderCommand(pb.command, {});
    expect(missing.error).toContain("branch");
  });

  it("seeded playbooks are discoverable via search_context", () => {
    const hits = store.searchContext("worktree") as any[];
    expect(hits.some((h) => h.entity_type === "helper" && h.title === "branch-worktree-setup")).toBe(true);
  });
});

describe("run_helper", () => {
  it("queues a job with the rendered playbook command by default", async () => {
    const r = await store.runHelper({ name: "index-refresh", agent_id: "agent-A", args: { root: "." } });
    expect(r).toMatchObject({ helper: "index-refresh", mode: "job", status: "queued" });
    expect(r.command).toBe("node dist/cli.js index --root .");
    const job = store.getJob((r as any).job_id);
    expect(job.command).toBe(r.command);
    expect(job.type).toBe("build");
  });

  it("task_id flows into the template and onto the queued job", async () => {
    const t = store.createTask({ title: "x" });
    const r = await store.runHelper({ name: "evidence-attach", agent_id: "agent-A", task_id: t.id, args: { kind: "test_run", file: "out.txt" } });
    expect((r as any).command).toBe(`node dist/cli.js evidence --task ${t.id} --kind test_run --file out.txt --by agent-A`);
    expect(store.getJob((r as any).job_id).task_id).toBe(t.id);
  });

  it("errors when a required arg is missing", async () => {
    const r = await store.runHelper({ name: "github-sync", agent_id: "agent-A" });
    expect((r as any).error).toContain("repo");
  });

  it("executes a registered executable helper synchronously and returns the result", async () => {
    store.registerHelper({
      agent_id: "agent-A", path: "scripts/greet.sh", symbol: "greet", kind: "executable",
      summary: "prints a greeting", entry_point: 'echo "hello {{name}}"',
    });
    const r = await store.runHelper({ name: "greet", agent_id: "agent-A", args: { name: "kimi" }, sync: true });
    expect(r).toMatchObject({ helper: "greet", mode: "sync", status: "done", exit_code: 0 });
    expect((r as any).output).toContain("hello kimi");
    expect((r as any).duration_ms).toBeGreaterThanOrEqual(0);
  });

  it("captures failures instead of throwing", async () => {
    store.registerHelper({
      agent_id: "agent-A", path: "scripts/boom.sh", symbol: "boom", kind: "executable",
      summary: "always fails", entry_point: "exit 3",
    });
    const r = await store.runHelper({ name: "boom", agent_id: "agent-A", sync: true });
    expect((r as any).status).toBe("failed");
    expect((r as any).exit_code).toBe(3);
  });

  it("refuses to run a helper that is not executable", async () => {
    store.registerHelper({ agent_id: "agent-A", path: "src/u/log.ts", symbol: "log", kind: "util", summary: "logger" });
    const r = await store.runHelper({ name: "log", agent_id: "agent-A" });
    expect((r as any).error).toContain("not executable");
  });

  it("errors on unknown helper names and lists playbooks", async () => {
    const r = await store.runHelper({ name: "nope", agent_id: "agent-A" });
    expect((r as any).error).toContain("not found");
    expect((r as any).error).toContain("github-sync");
  });

  it("executable registration requires an entry_point and a known kind", () => {
    expect(store.registerHelper({
      agent_id: "a", path: "p", symbol: "x", kind: "executable", summary: "no entry",
    })).toHaveProperty("error");
    expect(store.registerHelper({
      agent_id: "a", path: "p", symbol: "x", kind: "wat", summary: "bad kind",
    })).toHaveProperty("error");
  });

  it("a re-registered executable helper keeps working (upsert)", async () => {
    store.registerHelper({ agent_id: "a", path: "s.sh", symbol: "tool", kind: "executable", summary: "v1", entry_point: "echo one" });
    store.registerHelper({ agent_id: "b", path: "s.sh", symbol: "tool", kind: "executable", summary: "v2", entry_point: "echo two" });
    const r = await store.runHelper({ name: "tool", agent_id: "agent-A", sync: true });
    expect((r as any).output).toContain("two");
  });
});

describe("helper metrics (gh-36 helper-metrics)", () => {
  it("counts helper invocations vs agent control-plane actions per task", async () => {
    const t = store.createTask({ title: "x", ac_ids: ["a1"] });
    store.claimTask(t.id, "agent-A");
    store.reportEvidence({ task_id: t.id, agent_id: "agent-A", kind: "test_run", exit_code: 0, ac_ids: ["a1"] });
    await store.runHelper({ name: "index-refresh", agent_id: "agent-A", task_id: t.id, args: { root: "." } });
    await store.runHelper({ name: "index-refresh", agent_id: "agent-A", task_id: t.id, args: { root: "src" } });

    const m = store.helperMetrics(t.id) as any;
    expect(m.per_task).toHaveLength(1);
    expect(m.per_task[0]).toMatchObject({ task_id: t.id, helper_runs: 2 });
    // claim + release-by-completion are agent actions; human 'cli' creation is not.
    expect(m.per_task[0].agent_prompts).toBeGreaterThanOrEqual(1);
    expect(m.totals.helper_runs).toBe(2);
  });

  it("aggregates across tasks and isolates by task_id", async () => {
    const t1 = store.createTask({ title: "one" });
    const t2 = store.createTask({ title: "two" });
    await store.runHelper({ name: "index-refresh", agent_id: "a", task_id: t1.id, args: { root: "." } });
    await store.runHelper({ name: "index-refresh", agent_id: "a", task_id: t2.id, args: { root: "." } });
    expect((store.helperMetrics() as any).totals.helper_runs).toBe(2);
    expect((store.helperMetrics(t1.id) as any).totals.helper_runs).toBe(1);
  });
});

describe("v8 migration", () => {
  it("upgrades a v7 helpers table, preserving rows", async () => {
    const V7 = "/tmp/uw-test-runhelper-v7.db";
    rmSync(V7, { force: true });
    rmSync(`${V7}-wal`, { force: true });
    rmSync(`${V7}-shm`, { force: true });
    const raw = new Database(V7);
    raw.exec(`
      CREATE TABLE helpers (
        id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, path TEXT NOT NULL,
        symbol TEXT NOT NULL DEFAULT '', kind TEXT NOT NULL CHECK (kind IN ('util','pattern','config','fixture')),
        summary TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')), UNIQUE (path, symbol));
      INSERT INTO helpers (id, agent_id, path, symbol, kind, summary) VALUES ('hlp-old', 'agent-A', 'src/u/log.ts', 'log', 'util', 'old logger');
    `);
    raw.pragma("user_version = 7");
    raw.close();

    const upgraded = new SqliteStore(V7);
    const hits = upgraded.searchContext("logger") as any[];
    expect(hits.some((h) => h.entity_id === "hlp-old")).toBe(true);
    const r = await upgraded.runHelper({ name: "log", agent_id: "agent-A" });
    expect((r as any).error).toContain("not executable");
    upgraded.close();
    rmSync(V7, { force: true });
    rmSync(`${V7}-wal`, { force: true });
    rmSync(`${V7}-shm`, { force: true });
  });
});
