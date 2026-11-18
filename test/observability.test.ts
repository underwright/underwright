import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { rmSync, mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SqliteStore } from "../src/store.js";
import { renderDashboard } from "../src/dashboard.js";
import { evaluateSlos, SLOS, type SloContext } from "../src/slo.js";
import { initTelemetry, telemetry } from "../src/telemetry.js";

const DB = join(mkdtempSync(join(tmpdir(), "uw-obs-")), "store.db");
let store: SqliteStore;

const cleanup: string[] = [DB];
beforeEach(() => {
  for (const suffix of ["", "-wal", "-shm"]) rmSync(`${DB}${suffix}`, { force: true });
  process.env.UNDERWRIGHT_POLICY = "/tmp/uw-no-policy.json";
  store = new SqliteStore(DB);
});
afterEach(() => {
  store.close();
  initTelemetry({ backend: "off" });
});

const emptyCtx = (): SloContext => ({
  counts: { jobs_done: 0, jobs_failed: 0, dispatch_total: 0, dispatch_within: 0,
    tasks_done: 0, tasks_done_with_evidence: 0, nodes_approved: 0, nodes_poll_fresh: 0 },
  series: {}, latest_metric_ts: null,
});

describe("persistent metrics sink", () => {
  it("records and lists datapoints with parsed attrs", () => {
    const r = store.recordMetric({ name: "queue.depth", value: 7, attrs: { node: "n1" } });
    expect(r).toMatchObject({ name: "queue.depth", value: 7 });
    const rows = store.listMetrics({ name: "queue.depth" });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ name: "queue.depth", value: 7, attrs: { node: "n1" } });
  });

  it("validates name and value", () => {
    expect(store.recordMetric({ name: "", value: 1 })).toHaveProperty("error");
    expect(store.recordMetric({ name: "x", value: NaN })).toHaveProperty("error");
    expect(store.recordMetric({ name: "x".repeat(200), value: 1 })).toHaveProperty("error");
  });

  it("persists across store reopen", () => {
    store.recordMetric({ name: "durable.metric", value: 42 });
    store.close();
    store = new SqliteStore(DB);
    expect(store.listMetrics({ name: "durable.metric" })).toHaveLength(1);
  });

  it("filters by name and since", () => {
    store.recordMetric({ name: "a.old", value: 1, ts: "2000-01-01T00:00:00Z" });
    store.recordMetric({ name: "b.new", value: 2 });
    expect(store.listMetrics({ name: "b.new" })).toHaveLength(1);
    expect(store.listMetrics({ since: "1h" }).map((m: any) => m.name)).toEqual(["b.new"]);
    expect(store.listMetrics()).toHaveLength(2);
  });

  it("collectMetrics snapshots gauges and prunes expired points", () => {
    store.createTask({ title: "x" });
    store.recordMetric({ name: "ancient", value: 1, ts: "2000-01-01T00:00:00Z" });
    const r = store.collectMetrics();
    expect(r.recorded).toBeGreaterThan(0);
    expect(r.pruned).toBe(1);
    const names = store.listMetrics({ limit: 5000 }).map((m: any) => m.name);
    expect(names).toContain("tasks.open");
    expect(names).toContain("metrics.collect.duration_ms");
    expect(names).not.toContain("ancient");
  });

  it("search_context latency lands in the sink for the p95 SLO", () => {
    store.searchContext("anything");
    const rows = store.listMetrics({ name: "search.duration_ms" });
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0].value).toBeGreaterThanOrEqual(0);
  });

  it("telemetry metric() calls persist into the sink when wired", () => {
    initTelemetry({ backend: "off", persist: store });
    telemetry().metric("wired.metric", 3, { tag: "t" });
    expect(store.listMetrics({ name: "wired.metric" })).toHaveLength(1);
  });

  it("a throwing sink never breaks telemetry callers", () => {
    initTelemetry({ backend: "off", persist: { recordMetric: () => { throw new Error("down"); } } });
    expect(() => telemetry().metric("x", 1)).not.toThrow();
  });
});

describe("structured logging", () => {
  it("log() emits levelled JSON lines alongside spans and metrics", () => {
    const dir = mkdtempSync(join(tmpdir(), "uw-obs-log-"));
    cleanup.push(dir);
    const file = join(dir, "t.jsonl");
    const tel = initTelemetry({ backend: "file", file });
    tel.log("warn", "webhook.failed", { error: "boom" });
    tel.log("error", "dashboard.request_failed", { path: "/x" });
    const out = readFileSync(file, "utf8").trim().split("\n").map(l => JSON.parse(l));
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ kind: "log", level: "warn", name: "webhook.failed", error: "boom" });
    expect(out[1]).toMatchObject({ kind: "log", level: "error", name: "dashboard.request_failed" });
  });

  it("persist wrapper forwards log() to the inner backend only", () => {
    const dir = mkdtempSync(join(tmpdir(), "uw-obs-log2-"));
    cleanup.push(dir);
    const file = join(dir, "t.jsonl");
    const tel = initTelemetry({ backend: "file", file, persist: store });
    tel.log("info", "just.a.log");
    tel.metric("persisted.metric", 5);
    const out = readFileSync(file, "utf8").trim().split("\n").map(l => JSON.parse(l));
    expect(out.map((l: any) => l.kind).sort()).toEqual(["log", "metric"]);
    expect(store.listMetrics({ name: "persisted.metric" })).toHaveLength(1);
    expect(store.listMetrics({ name: "just.a.log" })).toHaveLength(0);
  });
});

describe("SLO evaluation", () => {
  it("reports no_data when the window has no samples", () => {
    const statuses = evaluateSlos(() => emptyCtx());
    expect(statuses).toHaveLength(SLOS.length);
    for (const s of statuses) expect(s.status).toBe("no_data");
    expect(statuses.map(s => s.id)).toContain("job-success-rate");
  });

  it("marks a compliant ratio SLO ok and a breaching one breaching", () => {
    const ctx = emptyCtx();
    ctx.counts.jobs_done = 9; ctx.counts.jobs_failed = 1;
    const ok = evaluateSlos(() => ctx).find(s => s.id === "job-success-rate")!;
    expect(ok.status).toBe("ok");
    expect(ok.value).toBeCloseTo(0.9);

    ctx.counts.jobs_failed = 5; // 9/14 ≈ 0.64 < 0.9
    const bad = evaluateSlos(() => ctx).find(s => s.id === "job-success-rate")!;
    expect(bad.status).toBe("breaching");
    expect(bad.error_budget_consumed).toBeGreaterThan(0);
  });

  it("evaluates latency SLOs against the metric series", () => {
    const ctx = emptyCtx();
    ctx.series["search.duration_ms"] = [10, 20, 30, 4000];
    const s = evaluateSlos(() => ctx).find(s => s.id === "search-context-p95")!;
    expect(s.status).toBe("breaching");
    expect(s.unit).toBe("ms");
    ctx.series["search.duration_ms"] = [10, 20, 30];
    expect(evaluateSlos(() => ctx).find(s => s.id === "search-context-p95")!.status).toBe("ok");
  });

  it("metrics-sink-freshness breaches when the newest point is stale", () => {
    const ctx = emptyCtx();
    ctx.latest_metric_ts = new Date(Date.now() - 3600_000).toISOString();
    expect(evaluateSlos(() => ctx).find(s => s.id === "metrics-sink-freshness")!.status).toBe("breaching");
    ctx.latest_metric_ts = new Date().toISOString();
    expect(evaluateSlos(() => ctx).find(s => s.id === "metrics-sink-freshness")!.status).toBe("ok");
  });
});

describe("store SLO + dashboard integration", () => {
  it("sloStatus evaluates every defined SLO against live tables", () => {
    const statuses = store.sloStatus() as any[];
    expect(statuses).toHaveLength(SLOS.length);
    expect(statuses.map(s => s.id).sort()).toEqual(SLOS.map(s => s.id).sort());
    // fresh store: job-success-rate has no finished jobs → no_data
    expect(statuses.find(s => s.id === "job-success-rate")!.status).toBe("no_data");
  });

  it("a finished job feeds job-success-rate through sloStatus", () => {
    const t = store.createTask({ title: "x", ac_ids: ["a"] });
    store.submitJob({ agent_id: "agent-A", task_id: t.id, type: "test", command: "true" });
    const job = store.nextJob("runner-A");
    store.finishJob(job.id, "done", "ok", "runner-A", job.lease_token);
    const s = (store.sloStatus() as any[]).find(s => s.id === "job-success-rate")!;
    expect(s.status).toBe("ok");
    expect(s.value).toBe(1);
  });

  it("dashboard data carries slos and latest metrics; render shows the sections", () => {
    store.recordMetric({ name: "gauge.x", value: 1.5 });
    const d = store.dashboard();
    expect(d.slos).toHaveLength(SLOS.length);
    expect(d.metrics).toContainEqual(expect.objectContaining({ name: "gauge.x", value: 1.5 }));
    const html = renderDashboard(d);
    expect(html).toContain("SLO status");
    expect(html).toContain("Latest metrics");
    expect(html).toContain("gauge.x");
    expect(html).toContain("job-success-rate");
  });
});
