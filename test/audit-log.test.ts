import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { rmSync } from "node:fs";
import { SqliteStore } from "../src/store.js";

// audit_log keyset paging: before_id browses older (newest first), after_id is
// an incremental ingest cursor (oldest first).

const DB = "/tmp/uw-test-audit-log.db";
let store: SqliteStore;
let ids: number[];

beforeEach(() => {
  for (const s of ["", "-wal", "-shm"]) rmSync(`${DB}${s}`, { force: true });
  process.env.UNDERWRIGHT_POLICY = "/tmp/uw-no-policy.json";
  store = new SqliteStore(DB);
  for (let i = 0; i < 6; i++) store.createTask({ title: `t${i}` });
  ids = (store.auditLog(1000) as any[]).map(e => e.id).sort((a, b) => a - b);
  expect(ids.length).toBeGreaterThanOrEqual(6);
});
afterEach(() => store.close());

describe("auditLog paging", () => {
  it("defaults are unchanged: newest first, limit 50", () => {
    const rows = store.auditLog() as any[];
    expect(rows.map(e => e.id)).toEqual([...ids].reverse().slice(0, 50));
  });

  it("before_id pages older, newest first, with no overlap", () => {
    const first = store.auditLog(2) as any[];
    const next = store.auditLog(2, { before_id: first[1].id }) as any[];
    expect(next.map(e => e.id)).toEqual([...ids].reverse().slice(2, 4));
  });

  it("after_id walks forward oldest first and reaches the end", () => {
    const seen: number[] = [];
    let cursor = 0;
    for (;;) {
      const page = store.auditLog(2, { after_id: cursor }) as any[];
      if (!page.length) break;
      seen.push(...page.map(e => e.id));
      cursor = page[page.length - 1].id;
    }
    expect(seen).toEqual(ids);
    store.createTask({ title: "late" });
    const fresh = store.auditLog(10, { after_id: cursor }) as any[];
    expect(fresh).toHaveLength(1);
    expect(fresh[0]).toMatchObject({ action: "created" });
  });

  it("after_id + before_id bound a range", () => {
    const rows = store.auditLog(100, { after_id: ids[0], before_id: ids[3] }) as any[];
    expect(rows.map(e => e.id)).toEqual([ids[1], ids[2]]);
  });
});
