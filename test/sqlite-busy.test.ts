import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { SqliteStore } from "../src/store.js";
import { rmSync } from "node:fs";

// task-d35372ce: concurrent writers (HTTP server + node daemon + CLI) on the
// same WAL database must not surface SQLITE_BUSY as "node task insert failed".

const DB = "/tmp/uw-test-sqlite-busy.db";
let store: SqliteStore;
let other: Database.Database;

beforeEach(() => {
  for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) rmSync(f, { force: true });
  process.env.UNDERWRIGHT_POLICY = "/tmp/uw-no-policy.json";
  store = new SqliteStore(DB);
  other = new Database(DB, { timeout: 0 });
});
afterEach(() => {
  other.close();
  store.close();
});

describe("SQLITE_BUSY under concurrent writers", () => {
  it("sets an explicit busy_timeout so lock contention waits instead of failing", () => {
    const db = (store as any).db as Database.Database;
    expect(db.pragma("busy_timeout", { simple: true })).toBeGreaterThanOrEqual(5000);
  });

  it("node transactions take the write lock up front (no read→write upgrade race)", () => {
    // Repro: inside a node transaction we read, another connection commits a
    // write, then we write. A DEFERRED transaction fails here with
    // SQLITE_BUSY_SNAPSHOT immediately — busy_timeout can't retry it.
    // An IMMEDIATE transaction holds the write lock, so the other writer is
    // the one that waits (and, with timeout 0, gets SQLITE_BUSY) instead.
    let otherError: any = null;
    const result = (store as any).nodeTransaction((s: any) => {
      s.nodeQuery("SELECT count(*) AS n FROM jobs");
      try {
        other.prepare("INSERT INTO events (entity_type, entity_id, action, actor) VALUES ('t','x','write','other')").run();
      } catch (e: any) {
        otherError = e;
      }
      s.nodeQuery("INSERT INTO events (entity_type, entity_id, action, actor) VALUES ('t','y','write','store')");
      return "ok";
    });
    expect(result).toBe("ok");
    expect(otherError?.code).toBe("SQLITE_BUSY");
  });
});
