import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseCoverage, checkCoverage } from "../src/coverage.js";
import { SqliteStore } from "../src/store.js";

const DB = "/tmp/uw-test-coverage.db";
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

const TABLE = ` % Coverage report from v8
-------------------|---------|----------|---------|---------|-------------------
File               | % Stmts | % Branch | % Funcs | % Lines | Uncovered Line #s
-------------------|---------|----------|---------|---------|-------------------
All files          |   85.23 |    78.9 |   80.00 |   85.23 |
-------------------|---------|----------|---------|---------|-------------------
`;

const SUMMARY = JSON.stringify({
  total: {
    lines: { pct: 91.5 },
    statements: { pct: 90 },
    branches: { pct: 70 },
    functions: { pct: 80 },
  },
});

describe("parseCoverage", () => {
  it("parses the vitest text table into structured percentages", () => {
    expect(parseCoverage(TABLE)).toEqual({
      statements: 85.23,
      branches: 78.9,
      functions: 80,
      lines: 85.23,
    });
  });

  it("parses coverage-summary.json totals", () => {
    expect(parseCoverage(SUMMARY)).toEqual({
      lines: 91.5,
      statements: 90,
      branches: 70,
      functions: 80,
    });
  });

  it("parses text-summary lines, key/value pairs, and bare percentages", () => {
    expect(parseCoverage("Lines : 88.8% ( 8/9 )\nStatements : 90%\n")).toEqual({
      lines: 88.8,
      statements: 90,
    });
    expect(parseCoverage("lines: 85.3, branches: 70%")).toEqual({ lines: 85.3, branches: 70 });
    expect(parseCoverage("72.5")).toEqual({ lines: 72.5 });
    expect(parseCoverage("nonsense")).toBeNull();
  });

  it("checks numeric thresholds per metric", () => {
    expect(checkCoverage({ lines: 85, branches: 78 }, 80)).toEqual([]);
    expect(checkCoverage({ lines: 85, branches: 78 }, { lines: 80, branches: 80 }))
      .toEqual(["coverage branches 78% below minimum 80%"]);
    expect(checkCoverage({ lines: 85 }, { lines: 80, statements: 80 }))
      .toEqual(["coverage statements not reported (minimum 80%)"]);
    expect(checkCoverage(null, 80)).toEqual(["coverage could not be parsed"]);
  });
});

describe("coverage evidence", () => {
  it("report_evidence kind=coverage returns structured fields and stores them", () => {
    const t = store.createTask({ title: "cov" });
    const r: any = store.reportEvidence({
      task_id: t.id, agent_id: "agent-A", kind: "coverage", output: TABLE, ac_ids: ["cov"],
    });
    expect(r.id).toMatch(/^ev-/);
    expect(r.coverage).toEqual({ statements: 85.23, branches: 78.9, functions: 80, lines: 85.23 });

    const [row] = store.getEvidence(t.id) as any[];
    expect(row.coverage.lines).toBe(85.23);
    expect(JSON.parse(row.ac_ids)).toEqual(["cov"]);
  });

  it("warns instead of failing when coverage output is unrecognisable", () => {
    const t = store.createTask({ title: "cov" });
    const r: any = store.reportEvidence({
      task_id: t.id, agent_id: "agent-A", kind: "coverage", output: "not coverage",
    });
    expect(r.coverage).toBeUndefined();
    expect(r.warning).toMatch(/could not be parsed/);
  });

  it("blocks completion below the per-type min_coverage threshold", () => {
    const dir = mkdtempSync(join(tmpdir(), "uwcov-"));
    writeFileSync(join(dir, "pol.json"), JSON.stringify({
      dod: { feature: { evidence: ["coverage"], min_coverage: { lines: 90 } } },
      enforcement: "block",
    }));
    process.env.UNDERWRIGHT_POLICY = join(dir, "pol.json");
    try {
      const t = store.createTask({ title: "below", type: "feature" });
      store.reportEvidence({ task_id: t.id, agent_id: "agent-A", kind: "coverage", output: TABLE });
      const r = store.completeTask(t.id, "agent-A") as any;
      expect(r.error).toMatch(/coverage lines 85\.23% below minimum 90%/);

      const ok = store.createTask({ title: "above", type: "feature" });
      store.reportEvidence({ task_id: ok.id, agent_id: "agent-A", kind: "coverage", output: SUMMARY });
      expect(store.completeTask(ok.id, "agent-A")).toHaveProperty("completed", ok.id);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
