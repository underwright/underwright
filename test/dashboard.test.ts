import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { rmSync } from "node:fs";
import { SqliteStore } from "../src/store.js";
import { renderDashboard, parseTaskQuery, filterSortTasks, handleDashboardRequest } from "../src/dashboard.js";

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
    const leased = store.nextJob("runner-A");
    store.finishJob(leased.id, "done", "ok", "runner-A", leased.lease_token);

    const d = store.dashboard();
    expect(d.locks).toEqual([]);
    expect(d.jobs).toEqual([]);
  });
});

describe("task list filters + sorting", () => {
  const tasks = [
    { id: "task-b", title: "Beta dashboard", status: "claimed", priority: 2, claimed_by: "agent-B", updated_at: "2026-01-02 00:00:00", blocked_artifacts: 0 },
    { id: "task-a", title: "Alpha board", status: "open", priority: 1, claimed_by: null, updated_at: "2026-01-01 00:00:00", blocked_artifacts: 0 },
    { id: "task-c", title: "Gamma fix", status: "blocked", priority: 3, claimed_by: "agent-C", updated_at: "2026-01-03 00:00:00", blocked_artifacts: 0 },
    { id: "task-d", title: "Delta escalated", status: "open", priority: 2, claimed_by: null, updated_at: "2026-01-04 00:00:00", blocked_artifacts: 1 },
    { id: "task-e", title: "Done thing", status: "done", priority: 1, claimed_by: null, updated_at: "2025-12-01 00:00:00", blocked_artifacts: 0 },
  ];
  const q = (over: Partial<{ status: string; q: string; sort: string }> = {}) => ({ status: "all", q: "", sort: "priority", ...over });
  const ids = (list: any[]) => list.map((t) => t.id);

  it("parses query params and falls back to defaults on unknown values", () => {
    expect(parseTaskQuery(new URL("http://x/board?status=open&q=%20board%20&sort=updated"))).toEqual({ status: "open", q: "board", sort: "updated" });
    expect(parseTaskQuery(new URL("http://x/board?status=bogus&sort=nope"))).toEqual({ status: "active", q: "", sort: "priority" });
  });

  it("defaults to active — every status except done — and isolates in_review", () => {
    expect(parseTaskQuery(new URL("http://x/board"))).toEqual({ status: "active", q: "", sort: "priority" });
    expect(ids(filterSortTasks(tasks, q({ status: "active" })))).toEqual(["task-a", "task-b", "task-d", "task-c"]);
    const withReview = [...tasks, { id: "task-f", title: "In review", status: "in_review", priority: 1, claimed_by: null, updated_at: "2026-01-05 00:00:00", blocked_artifacts: 0 }];
    expect(ids(filterSortTasks(withReview, q({ status: "in_review" })))).toEqual(["task-f"]);
    expect(ids(filterSortTasks(withReview, q({ status: "all" })))).toHaveLength(6);
  });

  it("filters by status, including blocked = status blocked or has escalations", () => {
    expect(ids(filterSortTasks(tasks, q({ status: "open" })))).toEqual(["task-a", "task-d"]);
    expect(ids(filterSortTasks(tasks, q({ status: "claimed" })))).toEqual(["task-b"]);
    expect(ids(filterSortTasks(tasks, q({ status: "done" })))).toEqual(["task-e"]);
    expect(ids(filterSortTasks(tasks, q({ status: "blocked" }))).sort()).toEqual(["task-c", "task-d"]);
  });

  it("searches id and title case-insensitively and combines with the status filter", () => {
    expect(ids(filterSortTasks(tasks, q({ q: "DASHBOARD" })))).toEqual(["task-b"]);
    expect(ids(filterSortTasks(tasks, q({ q: "task-a" })))).toEqual(["task-a"]);
    expect(ids(filterSortTasks(tasks, q({ status: "open", q: "delta" })))).toEqual(["task-d"]);
    expect(ids(filterSortTasks(tasks, q({ status: "done", q: "alpha" })))).toEqual([]);
  });

  it("sorts by priority, status, updated (newest first) and claimed_by (unclaimed last)", () => {
    expect(ids(filterSortTasks(tasks, q()))).toEqual(["task-a", "task-e", "task-b", "task-d", "task-c"]);
    // status alpha (blocked, claimed, done, open), priority within a status
    expect(ids(filterSortTasks(tasks, q({ sort: "status" })))).toEqual(["task-c", "task-b", "task-e", "task-a", "task-d"]);
    expect(ids(filterSortTasks(tasks, q({ sort: "updated" })))).toEqual(["task-d", "task-c", "task-b", "task-a", "task-e"]);
    // claimed names alpha, unclaimed last (by priority: a(1), e(1), d(2))
    expect(ids(filterSortTasks(tasks, q({ sort: "claimed_by" })))).toEqual(["task-b", "task-c", "task-a", "task-e", "task-d"]);
  });

  it("does not mutate the input array", () => {
    const copy = tasks.map((t) => t.id);
    filterSortTasks(tasks, q({ sort: "updated" }));
    expect(tasks.map((t) => t.id)).toEqual(copy);
  });

  it("renders the GET controls with the token as a hidden field when a task query is supplied", () => {
    const html = renderDashboard({ tasks }, { tasks: { query: q({ status: "open", q: "alpha" }), token: "s3cret" } });
    expect(html).toContain('<form class="inline task-filters" method="get" action="/board">');
    expect(html).toContain('<input type="hidden" name="token" value="s3cret">');
    expect(html).toContain('<option value="open" selected>');
    expect(html).toContain('value="alpha"');
    expect(html).toContain('<h2>Tasks <span class="count">1</span></h2>');
    expect(html).toContain("Alpha board");
    expect(html).not.toContain("Beta dashboard");
  });
});

describe("/board route with filters", () => {
  it("applies status/q/sort and preserves the token through the form", async () => {
    store.createTask({ title: "Dashboard filters work", ac_ids: ["a"], type: "triage", estimate: "S" });
    store.createTask({ title: "Unrelated chore", ac_ids: ["a"], type: "triage", estimate: "S" });
    const url = new URL("http://x/board?status=open&q=dashboard&sort=priority&token=tok123");
    const res = await handleDashboardRequest(store, "GET", url, new URLSearchParams(), "tok123");
    expect(res.html).toContain("Dashboard filters work");
    expect(res.html).not.toContain("Unrelated chore");
    expect(res.html).toContain('<input type="hidden" name="token" value="tok123">');
    expect(res.html).toContain('value="dashboard"');
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
    expect(html).toContain("Nodes");
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
