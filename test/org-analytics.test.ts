import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Database from "better-sqlite3";
import { readFileSync, rmSync } from "node:fs";
import { SqliteStore } from "../src/store.js";

// gh-31: the premium org-analytics design (docs/org-analytics.md) must be
// implementable purely by reading the OSS database. This test extracts every
// `-- metric:` SQL block from the doc, seeds a workspace through the public
// Store API, and runs each block over a READ-ONLY connection. Schema drift that
// breaks the design fails here.

const DB = "/tmp/uw-test-org-analytics.db";
const DOC = new URL("../docs/org-analytics.md", import.meta.url);

function metricQueries(): Record<string, string> {
  const md = readFileSync(DOC, "utf8");
  const out: Record<string, string> = {};
  for (const m of md.matchAll(/```sql\n-- metric: (\w+)\n([\s\S]*?)```/g)) out[m[1]] = m[2].trim();
  return out;
}

const PARAMS = { since: "1970-01-01T00:00:00.000Z" };
const AUDIT_PARAMS = { ...PARAMS, entity_type: null, actor: null, action: null, before_id: Number.MAX_SAFE_INTEGER };

let store: SqliteStore;
let ro: Database.Database;
const q = metricQueries();
const run = (name: string, extra: Record<string, unknown> = {}) => ro.prepare(q[name]).all({ ...PARAMS, ...extra }) as any[];
const row = (rows: any[], agent: string) => rows.find(r => r.agent_id === agent);
const ok = (r: any) => { expect(r?.error, JSON.stringify(r)).toBeUndefined(); return r; };

beforeAll(() => {
  for (const s of ["", "-wal", "-shm"]) rmSync(`${DB}${s}`, { force: true });
  process.env.UNDERWRIGHT_POLICY = "/tmp/uw-no-policy.json";
  store = new SqliteStore(DB);
  const A = "claude@minipc", B = "codex@laptop-2";

  // A: renews by re-claiming (one fresh claim), fails then passes, completes; task is later reopened (rework).
  const t1 = store.createTask({ title: "t1", ac_ids: ["a1"] });
  ok(store.claimTask(t1.id, A));
  ok(store.claimTask(t1.id, A));
  ok(store.reportEvidence({ task_id: t1.id, agent_id: A, kind: "test_run", command: "npm test", exit_code: 1, output: "fail" }));
  ok(store.reportEvidence({ task_id: t1.id, agent_id: A, kind: "test_run", command: "npm test", exit_code: 0, output: "pass", ac_ids: ["a1"] }));
  ok(store.completeTask(t1.id, A));
  ok(store.setTaskStatus(t1.id, "open", "human"));

  // B: abandons t2 (release + blocked artifact), completes t3 with coverage evidence.
  const t2 = store.createTask({ title: "t2" });
  ok(store.claimTask(t2.id, B));
  ok(store.releaseTask(t2.id, B));
  ok(store.postArtifact({ task_id: t2.id, agent_id: B, kind: "blocked", content: "tried X, Y" }));
  const t3 = store.createTask({ title: "t3", ac_ids: ["a1"] });
  ok(store.claimTask(t3.id, B));
  ok(store.reportEvidence({ task_id: t3.id, agent_id: B, kind: "coverage", command: "vitest --coverage", exit_code: 0, output: "All files | 90 | 80 | 85 | 90", ac_ids: ["a1"] }));
  ok(store.completeTask(t3.id, B));

  // A job that ran to completion.
  const job = ok(store.submitJob({ agent_id: A, type: "test", command: "npm test", task_id: t1.id } as any));
  const leased = store.nextJob("runner-1") as any;
  expect(leased?.id).toBe(job.id);
  ok(store.finishJob(job.id, "done", "ok", "runner-1", leased.lease_token));

  ro = new Database(DB, { readonly: true, fileMustExist: true });
});

afterAll(() => { ro?.close(); store?.close(); });

describe("org analytics design (docs/org-analytics.md)", () => {
  it("documents every metric the design names", () => {
    expect(Object.keys(q).sort()).toEqual(
      ["agent_activity", "agent_evidence_quality", "agent_rework", "audit_page", "board_by_status", "job_runtime", "task_wall_clock"]);
  });

  it("every query runs read-only against the OSS schema (boundary-check)", () => {
    for (const name of Object.keys(q)) {
      expect(() => run(name, name === "audit_page" ? AUDIT_PARAMS : {}), name).not.toThrow();
      expect(ro.prepare(q[name]).readonly, `${name} must not write`).toBe(true);
    }
  });

  it("agent_activity: dedupes lease renewals, attributes release/blocked, rolls up harness", () => {
    const rows = run("agent_activity");
    expect(row(rows, "claude@minipc")).toMatchObject({ harness: "claude", claims: 1, completed: 1, released: 0, completion_rate: 1 });
    expect(row(rows, "codex@laptop-2")).toMatchObject({ harness: "codex", claims: 2, completed: 1, released: 1, blocked: 1, completion_rate: 0.5 });
    expect(row(rows, "dispatcher")).toBeUndefined();
  });

  it("task_wall_clock: one non-negative duration per completion", () => {
    const rows = run("task_wall_clock");
    expect(rows).toHaveLength(2);
    for (const r of rows) expect(r.wall_clock_s).toBeGreaterThanOrEqual(0);
  });

  it("agent_rework: a reopened completion counts as rework", () => {
    const rows = run("agent_rework");
    expect(row(rows, "claude@minipc")).toMatchObject({ completed: 1, reworked: 1, rework_rate: 1 });
    expect(row(rows, "codex@laptop-2")).toMatchObject({ completed: 1, reworked: 0, rework_rate: 0 });
  });

  it("agent_evidence_quality: pass ratio, AC citation, kinds, per-completion", () => {
    const rows = run("agent_evidence_quality");
    expect(row(rows, "claude@minipc")).toMatchObject({ evidence_rows: 2, evidence_pass_ratio: 0.5, ac_cited_ratio: 0.5, evidence_kinds: 1, coverage_reports: 0, evidence_per_completion: 2 });
    expect(row(rows, "codex@laptop-2")).toMatchObject({ evidence_rows: 1, evidence_pass_ratio: 1, ac_cited_ratio: 1, coverage_reports: 1, evidence_per_completion: 1 });
  });

  it("job_runtime: wall-clock from jobs; inference_ms is NULL unless an executor reports it", () => {
    const rows = run("job_runtime");
    expect(rows).toHaveLength(1);
    expect(rows[0].job_runtime_s).toBeGreaterThanOrEqual(0);
    expect(rows[0].inference_ms).toBeNull();
  });

  it("board_by_status and audit_page (keyset paging + filters)", () => {
    const board = Object.fromEntries(run("board_by_status").map(r => [r.status, r.n]));
    expect(board).toMatchObject({ open: 2, done: 1 });
    const page = run("audit_page", AUDIT_PARAMS);
    expect(page.length).toBeGreaterThan(5);
    expect(page[0].id).toBeGreaterThan(page[1].id);
    const older = run("audit_page", { ...AUDIT_PARAMS, before_id: page[2].id });
    expect(older[0].id).toBeLessThan(page[2].id);
    const onlyA = run("audit_page", { ...AUDIT_PARAMS, actor: "claude@minipc", action: "completed" });
    expect(onlyA).toHaveLength(1);
  });
});
