import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteStore } from "../src/store.js";
import { startLeaseSweeper } from "../src/sweeper.js";
import {
  buildRetro, getSdlcPolicy, groomFindings, isDue, retroMarkdown, sprintReport, toMs, validateSprint,
} from "../src/sdlc.js";

const DAY = 86_400_000;
const T0 = Date.parse("2026-11-01T00:00:00Z");
const at = (days: number) => new Date(T0 + days * DAY).toISOString();

describe("sdlc policy + time (pure)", () => {
  it("ceremonies are off without an sdlc block and default sensibly when present", () => {
    const off = getSdlcPolicy({ dod: {}, enforcement: "warn" });
    expect(off.retro.enabled).toBe(false);
    expect(off.grooming.enabled).toBe(false);
    const on = getSdlcPolicy({ dod: {}, enforcement: "warn", sdlc: { retro: {}, grooming: { stale_open_days: 3 } } } as any);
    expect(on.retro).toEqual({ enabled: true, every_days: 7 });
    expect(on.grooming).toMatchObject({ enabled: true, every_minutes: 60, stale_open_days: 3, reset_estimates: false });
  });

  it("parses SQLite datetime, ISO and Date alike", () => {
    expect(toMs("2026-11-01 00:00:00")).toBe(T0);
    expect(toMs("2026-11-01T00:00:00.000Z")).toBe(T0);
    expect(toMs(new Date(T0))).toBe(T0);
    expect(isDue(null, DAY, T0)).toBe(true);
    expect(isDue(at(-0.5), DAY, T0)).toBe(false);
    expect(isDue(at(-1), DAY, T0)).toBe(true);
  });
});

describe("retro (pure)", () => {
  const ev = (entity_id: string, action: string, d: number) =>
    ({ entity_type: "task", entity_id, action, actor: "a", created_at: at(d) });

  it("counts review failures, rework and blockers inside the window only", () => {
    const stats = buildRetro({
      since: T0, until: T0 + 7 * DAY,
      events: [
        ev("t1", "completed", 1), ev("t2", "completed", 2), ev("t3", "completed", 3),
        ev("t2", "status:open", 4),                      // reopened after done → rework
        ev("t3", "claimed", 1), ev("t3", "claimed", 2),  // re-claimed, not after done → churn
        ev("t4", "blocked", 2), ev("t5", "status:blocked", 2),
        ev("t6", "lease_expired", 3),
        ev("old", "completed", -3),                     // outside window
      ],
      evidence: [
        { task_id: "t1", kind: "review", exit_code: 1, created_at: at(1) },
        { task_id: "t1", kind: "review", exit_code: 0, created_at: at(1.5) },
        { task_id: "t3", kind: "review", exit_code: null, created_at: at(2) },
      ],
    });
    expect(stats.tasks_completed).toBe(3);
    expect(stats.review).toEqual({ reviews: 3, failed: 1, failed_tasks: ["t1"] });
    expect(stats.rework.reopened).toEqual(["t2"]);
    expect(stats.rework.reclaimed).toEqual(["t3"]);
    expect(stats.rework.tasks).toEqual(["t1", "t2"]);
    expect(stats.rework.rate).toBe(0.667);
    expect(stats.churn).toEqual({ tasks: ["t3"], rate: 0.333 });
    expect(stats.blockers).toEqual({ escalations: 1, tasks_blocked: ["t4", "t5"], leases_expired: 1 });
    expect(stats.recommendations.join("\n")).toMatch(/review failure rate 33%[\s\S]*rework rate 67%[\s\S]*claim churn 33%/);
    expect(retroMarkdown(stats)).toContain("## Policy tuning (DoR / DoD)");
  });

  it("separates claim churn (expiry, release, dispatcher hand-off) from true rework", () => {
    const stats = buildRetro({
      since: T0, until: T0 + 7 * DAY,
      events: [
        // churn: lease expired, someone else claims, then completes
        ev("c1", "claimed", 1), ev("c1", "lease_expired", 1.1), ev("c1", "claimed", 1.2), ev("c1", "completed", 1.5),
        // churn: released, re-claimed
        ev("c2", "claimed", 1), ev("c2", "released", 1.1), ev("c2", "claimed", 1.2),
        // churn: idle-sweep hand-off with no intervening event
        ev("c3", "claimed", 1), ev("c3", "claimed", 1.3),
        // rework: claimed again after it was done
        ev("r1", "claimed", 1), ev("r1", "completed", 2), ev("r1", "claimed", 3), ev("r1", "completed", 4),
        ev("ok", "claimed", 1), ev("ok", "completed", 2),
      ],
      evidence: [],
    });
    expect(stats.rework.reclaimed).toEqual(["c1", "c2", "c3", "r1"]);
    expect(stats.rework.tasks).toEqual(["r1"]);
    expect(stats.churn.tasks).toEqual(["c1", "c2", "c3"]);
    // touched = completed {c1, r1, ok} ∪ rework {r1} ∪ churn {c1, c2, c3} = 5
    expect(stats.rework.rate).toBe(0.2);
    expect(stats.churn.rate).toBe(0.6);
    const recs = stats.recommendations.join("\n");
    expect(recs).not.toMatch(/rework rate/);
    expect(recs).toMatch(/claim churn 60%[\s\S]*live_minutes/);
    expect(retroMarkdown(stats)).toMatch(/Claim churn: 60% — c1, c2, c3/);
  });

  it("suggests no change on a clean window", () => {
    const stats = buildRetro({ since: T0, until: T0 + DAY, events: [ev("t1", "completed", 0.5)], evidence: [] });
    expect(stats.rework.rate).toBe(0);
    expect(stats.recommendations).toEqual(["no policy change suggested — keep current DoR/DoD"]);
  });

  it("counts an event logged in the same millisecond as the window end", () => {
    const stats = buildRetro({ since: T0, until: T0 + DAY, events: [ev("t1", "completed", 1)], evidence: [] });
    expect(stats.tasks_completed).toBe(1);
  });
});

describe("grooming (pure)", () => {
  const policy = getSdlcPolicy({ dod: {}, enforcement: "warn", sdlc: { grooming: { stale_open_days: 14, stale_claim_minutes: 60 } } } as any).grooming;
  const now = T0 + 30 * DAY;

  it("finds stale open tasks, stale live claims and bad dependency edges", () => {
    const f = groomFindings({
      now, policy,
      tasks: [
        { id: "stale", status: "open", estimate: "M", updated_at: at(1) },
        { id: "fresh", status: "open", estimate: "S", updated_at: at(1), last_activity: at(29) },
        { id: "claimed", status: "claimed", updated_at: at(1) },
      ],
      claims: [
        { task_id: "c1", agent_id: "zombie", lease_expires: at(31), claimed_at: at(29), last_holder_activity: at(29) },
        { task_id: "c2", agent_id: "busy", lease_expires: at(31), claimed_at: at(29), last_holder_activity: new Date(now - 5 * 60_000).toISOString() },
        { task_id: "c3", agent_id: "gone", lease_expires: at(29), claimed_at: at(1) },
      ],
      edges: [
        { task_id: "d1", task_status: "done", blocker_id: "b1", blocker_status: "open" },
        { task_id: "d2", task_status: "claimed", blocker_id: "b2", blocker_status: "claimed" },
        { task_id: "d3", task_status: "blocked", blocker_id: "b3", blocker_status: "done" },
        { task_id: "ok", task_status: "open", blocker_id: "b4", blocker_status: "claimed" },
      ],
    });
    expect(f.stale_open).toEqual([{ task_id: "stale", idle_days: 29, estimate: "M" }]);
    expect(f.stale_claims).toEqual([{ task_id: "c1", agent_id: "zombie", idle_minutes: 1440 }]);
    expect(f.dependency_issues.map((d) => d.task_id)).toEqual(["d1", "d2", "d3"]);
    expect(f.dependency_issues[2].issue).toContain("unblock");
  });
});

describe("sprints (pure)", () => {
  const sprint = { id: "s1", name: "S1", starts_at: "2026-11-01", ends_at: "2026-11-05" };

  it("validates windows", () => {
    expect(validateSprint({ name: "", starts_at: "2026-11-01", ends_at: "2026-11-02" })).toContain("name");
    expect(validateSprint({ name: "x", starts_at: "nope", ends_at: "2026-11-02" })).toContain("dates");
    expect(validateSprint({ name: "x", starts_at: "2026-11-02", ends_at: "2026-11-01" })).toContain("after");
    expect(validateSprint(sprint)).toBeNull();
    // A date-only end runs through that day: a one-day sprint is valid; an ISO instant equal to the start is not.
    expect(validateSprint({ name: "x", starts_at: "2026-11-01", ends_at: "2026-11-01" })).toBeNull();
    expect(validateSprint({ name: "x", starts_at: "2026-11-01T09:00:00Z", ends_at: "2026-11-01T09:00:00Z" })).toContain("after");
  });

  it("burns down per day, then carries unfinished work over once closed", () => {
    const tasks = [
      { id: "a", status: "done", completed_at: at(1.5) },
      { id: "b", status: "done", completed_at: at(3.2) },
      { id: "c", status: "open" },
      { id: "d", status: "done", completed_at: at(9) }, // finished after the sprint
    ];
    const mid = sprintReport(sprint, tasks, T0 + 2.5 * DAY);
    expect(mid.state).toBe("active");
    expect(mid.burndown.map((p) => p.remaining)).toEqual([4, 4, 3, 3]);
    expect(mid.burndown[0]).toEqual({ date: "2026-11-01", remaining: 4, ideal: 4 });
    expect(mid.carry_over).toEqual([]);

    const closed = sprintReport(sprint, tasks, T0 + 10 * DAY, ["c", "zzz"]);
    expect(closed.state).toBe("closed");
    expect(closed).toMatchObject({ committed: 4, done: 2, remaining: 2, carry_over: ["c", "d"], carried_in: ["c"] });
    expect(closed.burndown).toHaveLength(6);
    expect(closed.burndown.at(-1)).toMatchObject({ date: "2026-11-06", remaining: 2, ideal: 0 });
    expect(sprintReport(sprint, [], T0 - DAY).state).toBe("planned");
  });
});

describe("sdlc ceremonies (store)", () => {
  const DB = "/tmp/uw-test-sdlc.db";
  let store: SqliteStore;
  let dir: string;
  const db = () => (store as any).db;

  const usePolicy = (p: object) => writeFileSync(process.env.UNDERWRIGHT_POLICY!, JSON.stringify({ enforcement: "warn", ...p }));

  beforeEach(() => {
    for (const s of ["", "-wal", "-shm"]) rmSync(`${DB}${s}`, { force: true });
    dir = mkdtempSync(join(tmpdir(), "uw-sdlc-"));
    process.env.UNDERWRIGHT_POLICY = join(dir, "policy.json");
    usePolicy({ lifecycle: {}, sdlc: { retro: { every_days: 7 }, grooming: { stale_open_days: 14, stale_claim_minutes: 60, reset_estimates: true } } });
    store = new SqliteStore(DB);
  });
  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
    process.env.UNDERWRIGHT_POLICY = "/tmp/uw-no-policy.json";
  });

  it("migrates to v10 with a sprint column and sprints table", () => {
    expect(db().pragma("user_version", { simple: true })).toBeGreaterThanOrEqual(10);
    expect(db().prepare("SELECT 1 FROM pragma_table_info('tasks') WHERE name='sprint'").get()).toBeTruthy();
    expect(db().prepare("SELECT name FROM sqlite_master WHERE name='sprints'").get()).toBeTruthy();
  });

  it("sprint-scope: assign, board burndown, carry-over flagged", () => {
    const today = new Date().toISOString().slice(0, 10);
    const plus = (d: number) => new Date(Date.now() + d * DAY).toISOString().slice(0, 10);
    expect(store.createSprint({ name: "", starts_at: today, ends_at: plus(7), actor: "pm" })).toHaveProperty("error");
    const old = store.createSprint({ id: "s0", name: "Old", starts_at: plus(-20), ends_at: plus(-10), actor: "pm" }) as any;
    const cur = store.createSprint({ id: "s1", name: "Now", starts_at: today, ends_at: plus(7), goal: "ship", actor: "pm" }) as any;
    expect(cur.id).toBe("s1");
    expect(store.createSprint({ id: "s1", name: "dup", starts_at: today, ends_at: plus(1), actor: "pm" })).toHaveProperty("error");
    expect(store.listSprints().map((s: any) => [s.id, s.state])).toEqual([["s1", "active"], ["s0", "closed"]]);

    const a = store.createTask({ title: "a", type: "docs", estimate: "S", ac_ids: ["x"] });
    const b = store.createTask({ title: "b", type: "docs", estimate: "S", ac_ids: ["x"] });
    // A closed sprint takes no new commitments; seed one task there directly.
    expect(store.assignSprint([a.id], old.id, "pm")).toHaveProperty("error");
    db().prepare("UPDATE tasks SET sprint='s0' WHERE id=?").run(a.id);
    expect(store.assignSprint([a.id, "nope"], "s1", "pm")).toHaveProperty("error");

    const moved = store.assignSprint([a.id, b.id], "s1", "pm") as any;
    expect(moved).toEqual({ sprint: "s1", assigned: [a.id, b.id], carried_over: [a.id] });

    store.claimTask(b.id, "dev");
    store.reportEvidence({ task_id: b.id, agent_id: "rev", kind: "review", ac_ids: ["x"] });
    expect(store.completeTask(b.id, "dev")).toHaveProperty("completed", b.id);

    const board = store.board() as any;
    expect(board.tasks.find((t: any) => t.id === a.id).sprint).toBe("s1");
    expect(board.sprint).toMatchObject({ state: "active", committed: 2, done: 1, remaining: 1, carried_in: [a.id] });
    expect(board.sprint.burndown[0]).toMatchObject({ date: today, ideal: 2 });
    expect(store.sprintReport("missing")).toHaveProperty("error");
    expect(store.assignSprint([a.id], null, "pm")).toMatchObject({ assigned: [a.id] });
  });

  it("retro: creates one retro task per window with stats and tuning advice", () => {
    const t = store.createTask({ title: "f", type: "docs", estimate: "S", ac_ids: ["x"] });
    store.claimTask(t.id, "dev");
    store.reportEvidence({ task_id: t.id, agent_id: "rev", kind: "review", exit_code: 1, ac_ids: ["x"] });
    store.releaseTask(t.id, "dev");
    store.claimTask(t.id, "dev");
    store.reportEvidence({ task_id: t.id, agent_id: "rev", kind: "review", exit_code: 0, ac_ids: ["x"] });
    expect(store.completeTask(t.id, "dev")).toHaveProperty("completed", t.id);

    const r =store.runRetro({ actor: "pm" }) as any;
    expect(r.task_id).toMatch(/^retro-\d{4}-\d{2}-\d{2}$/);
    expect(r.stats).toMatchObject({ tasks_completed: 1, review: { reviews: 2, failed: 1 }, rework: { reclaimed: [t.id], rate: 1 } });
    const retro = store.getTask(r.task_id) as any;
    expect(retro).toMatchObject({ type: "retro", status: "open", ac_ids: ["actions"] });
    expect(retro.description).toContain("Rework rate: 100%");
    expect(retro.artifacts[0]).toMatchObject({ kind: "note", title: "Retro stats" });
    expect(store.runRetro({ actor: "pm" })).toMatchObject({ task_id: r.task_id, existing: true });
    expect(store.runRetro({ actor: "pm", since: "2026-02-01", until: "2026-01-01" })).toHaveProperty("error");
    // Retro tasks skip the verifying phase under the lifecycle.
    store.claimTask(r.task_id, "pm");
    store.reportEvidence({ task_id: r.task_id, agent_id: "pm", kind: "review", ac_ids: ["actions"] });
    expect(store.completeTask(r.task_id, "pm")).toHaveProperty("completed", r.task_id);
  });

  it("backlog-grooming: re-estimates stale tasks, pings stale claims, re-validates edges", () => {
    const stale = store.createTask({ title: "stale", type: "docs", estimate: "M", ac_ids: ["x"] });
    const fresh = store.createTask({ title: "fresh", type: "docs", estimate: "S", ac_ids: ["x"] });
    const held = store.createTask({ title: "held", type: "docs", estimate: "S", ac_ids: ["x"] });
    const blocker = store.createTask({ title: "blocker", type: "docs", estimate: "S", ac_ids: ["x"] });
    const dep = store.createTask({ title: "dep", type: "docs", estimate: "S", ac_ids: ["x"], blocked_by: [blocker.id] });
    store.claimTask(held.id, "zombie", 3600);
    const old = new Date(Date.now() - 30 * DAY).toISOString();
    db().prepare("UPDATE tasks SET updated_at='2020-01-01 00:00:00' WHERE id=?").run(stale.id);
    db().prepare("UPDATE events SET created_at=? WHERE entity_id IN (?,?)").run(old, stale.id, held.id);
    db().prepare("UPDATE claims SET created_at='2020-01-01 00:00:00' WHERE task_id=?").run(held.id);
    db().prepare("UPDATE tasks SET status='done' WHERE id=?").run(dep.id); // closed before its blocker

    const g = store.groomBacklog("pm") as any;
    expect(g.stale_open.map((t: any) => t.task_id)).toEqual([stale.id]);
    expect(g.estimates_reset).toEqual([stale.id]);
    expect(g.stale_claims).toMatchObject([{ task_id: held.id, agent_id: "zombie" }]);
    expect(g.dependency_issues).toMatchObject([{ task_id: dep.id, blocker_id: blocker.id }]);
    expect(g.artifact_id).toMatch(/^art-/);
    expect((store.getTask(stale.id) as any).estimate).toBe("");
    expect((store.getTask(fresh.id) as any).estimate).toBe("S");
    // Reset estimate means the DoR gate (when it requires one) blocks the claim until re-estimated.
    usePolicy({ dor: { require_estimate: true } });
    expect(store.claimTask(stale.id, "dev").error).toContain("estimate");
    expect(store.inbox("zombie")[0].body).toContain(`stale claim on ${held.id}`);

    // A second pass still reports the state but does not re-act on known findings.
    const again = store.groomBacklog("pm") as any;
    expect(again.stale_claims).toMatchObject([{ task_id: held.id }]);
    expect(again.new_findings).toBe(0);
    expect(again.artifact_id).toBeUndefined();
    expect(store.inbox("zombie")).toHaveLength(0);
    expect(db().prepare("SELECT COUNT(*) n FROM events WHERE action='stale_claim'").get().n).toBe(1);
  });

  it("sweepSdlc runs grooming and retro when due, then waits for the interval", async () => {
    const first = store.sweepSdlc();
    expect(first.groomed).toBe(true);
    expect(first.retro).toMatch(/^retro-/);
    expect(store.sweepSdlc()).toEqual({});
    usePolicy({});
    db().prepare("DELETE FROM events WHERE entity_type='sdlc'").run();
    expect(store.sweepSdlc()).toEqual({});

    usePolicy({ sdlc: { grooming: {} } });
    const stop = startLeaseSweeper(store, 60_000);
    await stop();
    expect(db().prepare("SELECT COUNT(*) n FROM events WHERE entity_type='sdlc' AND action='groomed'").get().n).toBe(1);
  });
});
