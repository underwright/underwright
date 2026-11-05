import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { SqliteStore } from "../src/store.js";
import { PgStore } from "../src/pstore.js";
import type { IStore } from "../src/istore.js";

for (const backend of ["sqlite", "postgres"]) {
  describe.skipIf(backend === "postgres" && !process.env.DATABASE_URL)(`${backend} dependency edges`, () => {
    let store: IStore;
    let dir: string;
    let oldPolicy: string | undefined;
    beforeEach(async () => {
      dir = mkdtempSync(join(tmpdir(), "uw-deps-"));
      oldPolicy = process.env.UNDERWRIGHT_POLICY;
      process.env.UNDERWRIGHT_POLICY = join(dir, "no-policy.json");
      store = backend === "sqlite" ? new SqliteStore(join(dir, "store.db"))
        : await PgStore.connect(process.env.DATABASE_URL!);
    });
    afterEach(async () => {
      await store.close();
      if (oldPolicy === undefined) delete process.env.UNDERWRIGHT_POLICY;
      else process.env.UNDERWRIGHT_POLICY = oldPolicy;
      rmSync(dir, { recursive: true, force: true });
    });

    async function finish(id: string) {
      await store.reportEvidence({ task_id: id, agent_id: "a", kind: "test_run", exit_code: 0, ac_ids: ["ac"] });
      expect(await store.completeTask(id, "a")).toHaveProperty("completed", id);
    }

    it("creates deduplicated edges, exposes both directions, and filters the board/list", async () => {
      const a = await store.createTask({ title: "blocker" });
      const b = await store.createTask({ title: "dependent", blocked_by: [a.id, a.id] });
      expect(b).toMatchObject({ status: "blocked", blocked_by: [a.id], unfinished_blockers: [a.id], blocks: [] });
      expect(await store.getTask(a.id)).toHaveProperty("blocks", [b.id]);
      expect((await store.board()).tasks.find((t: any) => t.id === b.id)).toMatchObject({ status: "blocked", blocked_by: [a.id] });
      expect((await store.listTasks("blocked")).some(t => t.id === b.id)).toBe(true);
      expect((await store.listTasks("open")).some(t => t.id === b.id)).toBe(false);
    });

    it("replaces and clears edges without losing them on unrelated updates", async () => {
      const a = await store.createTask({ title: "a" });
      const b = await store.createTask({ title: "b" });
      const c = await store.createTask({ title: "c", blocked_by: [a.id] });
      expect(await store.updateTask(c.id, { title: "renamed" }, "a")).toHaveProperty("blocked_by", [a.id]);
      expect(await store.updateTask(c.id, { blocked_by: [b.id] }, "a")).toHaveProperty("blocked_by", [b.id]);
      expect(await store.getTask(a.id)).toHaveProperty("blocks", []);
      expect(await store.getTask(b.id)).toHaveProperty("blocks", [c.id]);
      expect(await store.updateTask(c.id, { blocked_by: [] }, "a")).toMatchObject({ status: "open", blocked_by: [] });
      expect(await store.getTask(b.id)).toHaveProperty("blocks", []);
    });

    it("rejects missing blockers and self edges with no partial writes", async () => {
      const a = await store.createTask({ title: "a" });
      expect(await store.createTask({ id: "invalid-create", title: "bad", blocked_by: [a.id, "missing"] })).toHaveProperty("error");
      expect(await store.getTask("invalid-create")).toBeNull();
      expect(await store.createTask({ id: "self-create", title: "bad", blocked_by: ["self-create"] })).toHaveProperty("error");
      const b = await store.createTask({ title: "b", blocked_by: [a.id] });
      expect(await store.updateTask(b.id, { title: "bad", blocked_by: ["missing"] }, "a")).toHaveProperty("error");
      expect(await store.getTask(b.id)).toMatchObject({ title: "b", blocked_by: [a.id] });
      expect(await store.updateTask(b.id, { blocked_by: [b.id] }, "a")).toHaveProperty("error");
    });

    it("rejects transitive cycles without altering existing edges", async () => {
      const a = await store.createTask({ title: "a" });
      const b = await store.createTask({ title: "b", blocked_by: [a.id] });
      const c = await store.createTask({ title: "c", blocked_by: [b.id] });
      expect((await store.updateTask(a.id, { blocked_by: [c.id] }, "a")).error).toContain("cycle");
      expect(await store.getTask(a.id)).toHaveProperty("blocked_by", []);
      expect(await store.getTask(c.id)).toHaveProperty("blocked_by", [b.id]);
    });

    it("gates claims even without DoR policy and allows them after all blockers finish", async () => {
      const a = await store.createTask({ title: "a" });
      const b = await store.createTask({ title: "b" });
      await store.setTaskStatus(a.id, "in_review", "a");
      const c = await store.createTask({ title: "c", blocked_by: [a.id, b.id] });
      expect((await store.claimTask(c.id, "a")).error).toContain(a.id);
      expect(await store.getTask(c.id)).toHaveProperty("claim", null);
      await finish(a.id);
      expect((await store.claimTask(c.id, "a")).error).toContain(b.id);
      await finish(b.id);
      expect(await store.claimTask(c.id, "a")).not.toHaveProperty("error");
    });

    it("reports blocker progress and publishes one unblocked event on the final completion", async () => {
      const a = await store.createTask({ title: "a" });
      const b = await store.createTask({ title: "b" });
      const c = await store.createTask({ title: "c", blocked_by: [a.id, b.id] });
      await store.watchTask("dep-watcher", c.id);
      // Drain messages from previous Postgres runs, if any.
      await store.inbox("dep-watcher");
      expect(await store.completeTask(a.id, "a")).toHaveProperty("error");
      expect(await store.inbox("dep-watcher")).toEqual([]);
      await finish(a.id);
      const progress = await store.inbox("dep-watcher");
      expect(progress).toHaveLength(1);
      expect(progress[0].body).toContain(b.id);
      expect(progress[0].body).not.toContain("unblocked");
      expect((await store.auditLog(100)).some(e => e.entity_id === c.id && e.action === "blocker_completed")).toBe(true);
      expect(await store.getTask(c.id)).toHaveProperty("status", "blocked");
      await finish(b.id);
      expect(await store.getTask(c.id)).toMatchObject({ status: "open", blocked_by: [a.id, b.id].sort(), unfinished_blockers: [] });
      const notes = await store.inbox("dep-watcher");
      expect(notes).toHaveLength(1);
      expect(notes[0]).toMatchObject({ task_id: c.id, from_agent: "underwright" });
      expect(notes[0].body).toContain("unblocked");
      const events = (await store.auditLog(100)).filter(e => e.entity_id === c.id && e.action === "unblocked");
      expect(events).toHaveLength(1);
      const data = typeof events[0].data === "string" ? JSON.parse(events[0].data) : events[0].data;
      expect(data.blocker_id).toBe(b.id);
      await store.completeTask(b.id, "a");
      expect(await store.inbox("dep-watcher")).toEqual([]);
      expect((await store.auditLog(100)).filter(e => e.entity_id === c.id && e.action === "unblocked")).toHaveLength(1);
    });

    it("handles sync status completion and reopening, while preserving manual blocks", async () => {
      const a = await store.createTask({ title: "a" });
      const b = await store.createTask({ title: "b", blocked_by: [a.id] });
      const c = await store.createTask({ title: "c", blocked_by: [a.id] });
      await store.setTaskStatus(c.id, "blocked", "human");
      await store.watchTask("sync-watcher", b.id);
      await store.inbox("sync-watcher");
      await store.setTaskStatus(a.id, "done", "sync");
      expect(await store.getTask(b.id)).toHaveProperty("status", "open");
      expect(await store.getTask(c.id)).toHaveProperty("status", "blocked");
      expect(await store.inbox("sync-watcher")).toHaveLength(1);
      await store.setTaskStatus(a.id, "open", "sync");
      expect(await store.getTask(b.id)).toHaveProperty("status", "blocked");
      expect(await store.claimTask(b.id, "a")).toHaveProperty("error");
    });

    it("accepts already completed blockers without blocking or sending spurious events", async () => {
      const a = await store.createTask({ title: "a" });
      await finish(a.id);
      const b = await store.createTask({ title: "b", blocked_by: [a.id] });
      expect(b).toMatchObject({ status: "open", blocked_by: [a.id], unfinished_blockers: [] });
      expect(await store.claimTask(b.id, "a")).not.toHaveProperty("error");
    });
  });
}

it("adds edge storage to an existing SQLite database and preserves it across reopen", () => {
  const dir = mkdtempSync(join(tmpdir(), "uw-deps-migration-"));
  const path = join(dir, "store.db");
  let store = new SqliteStore(path);
  try {
    const a = store.createTask({ title: "legacy task" });
    store.close();
    const db = new Database(path);
    db.exec("DROP TABLE task_dependencies"); // simulate the pre-edge schema
    db.close();
    store = new SqliteStore(path);
    const b = store.createTask({ title: "new task", blocked_by: [a.id] });
    store.close();
    store = new SqliteStore(path);
    expect(store.getTask(b.id)).toMatchObject({ status: "blocked", blocked_by: [a.id] });
    expect(store.getTask(a.id)).toHaveProperty("blocks", [b.id]);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
