import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { rmSync } from "node:fs";
import { SqliteStore } from "../src/store.js";
import { renderDashboard } from "../src/dashboard.js";

const DB = "/tmp/uw-test-dashboard.db";
let store: SqliteStore;

beforeEach(() => {
  for (const suffix of ["", "-wal", "-shm"]) rmSync(`${DB}${suffix}`, { force: true });
  process.env.UNDERWRIGHT_POLICY = "/tmp/uw-no-policy.json";
  store = new SqliteStore(DB);
});
afterEach(() => store.close());

describe("dashboard data", () => {
  it("collects tasks with claims, active locks, open jobs and recent events", () => {
    const t = store.createTask({ title: "Dashboard task", ac_ids: ["a"], type: "triage", estimate: "S" });
    store.claimTask(t.id, "agent-A");
    store.claimResources(["src/*.ts"], "agent-A", t.id);
    store.submitJob({ agent_id: "agent-A", task_id: t.id, type: "test", command: "npm test" });

    const d = store.dashboard();
    expect(d.tasks).toContainEqual(expect.objectContaining({
      id: t.id, status: "claimed", claimed_by: "agent-A",
    }));
    expect(d.locks).toContainEqual(expect.objectContaining({ resource: "src/*.ts", agent_id: "agent-A" }));
    expect(d.jobs).toContainEqual(expect.objectContaining({ task_id: t.id, status: "queued", command: "npm test" }));
    expect(d.events.length).toBeGreaterThan(0);
  });

  it("excludes expired locks and finished jobs", () => {
    const t = store.createTask({ title: "x", ac_ids: ["a"], type: "triage", estimate: "S" });
    store.claimResources(["expired.ts"], "agent-A", t.id, -1);
    const job = store.submitJob({ agent_id: "agent-A", task_id: t.id, type: "test", command: "true" });
    store.finishJob(job.id, "done", "ok");

    const d = store.dashboard();
    expect(d.locks).toEqual([]);
    expect(d.jobs).toEqual([]);
  });
});

describe("dashboard rendering", () => {
  it("renders every required section with auto-refresh", () => {
    const html = renderDashboard({
      tasks: [{ id: "task-1", title: "Ship it", status: "open", priority: 1, claimed_by: null, lease_expires: null }],
      locks: [{ resource: "src/**", agent_id: "agent-A", task_id: "task-1", lease_expires: "2026-01-01T00:00:00.000Z" }],
      jobs: [{ id: "job-1", type: "test", task_id: "task-1", status: "queued", agent_id: "agent-A", command: "npm test", created_at: "2026-01-01 00:00:00" }],
      events: [{ created_at: "2026-01-01 00:00:00", actor: "agent-A", action: "claimed", entity_type: "task", entity_id: "task-1" }],
      job_counts: [{ status: "queued", n: 1 }],
    });

    expect(html).toContain('http-equiv="refresh"');
    expect(html).toContain("Tasks");
    expect(html).toContain("Active resource locks");
    expect(html).toContain("Open jobs");
    expect(html).toContain("Recent events");
    expect(html).toContain("Ship it");
    expect(html).toContain("src/**");
    expect(html).toContain("npm test");
  });

  it("escapes untrusted values and exposes no mutation form", () => {
    const html = renderDashboard({
      tasks: [{ id: "task-1", title: "<script>alert(1)</script>", status: "open", priority: 1 }],
    });

    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).not.toContain("<form");
  });
});
