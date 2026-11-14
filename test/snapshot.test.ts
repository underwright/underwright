import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import postgres from "postgres";
import { SqliteStore } from "../src/store.js";
import { PgStore } from "../src/pstore.js";
import type { IStore } from "../src/istore.js";
import { exportSnapshot, importSnapshot, type SnapshotTarget } from "../src/snapshot.js";

const root = fileURLToPath(new URL("..", import.meta.url));

/** Populate one of everything ids matter for: tasks, deps, claims, artifacts, evidence, helpers, messages, jobs, events. */
async function seed(store: IStore) {
  const a = await store.createTask({ title: "parent", ac_ids: ["ac1"], type: "feature", estimate: "S" });
  const b = await store.createTask({ title: "child", ac_ids: ["ac2"], blocked_by: [a.id] } as any);
  await store.claimTask(a.id, "agent@one");
  const art = await store.postArtifact({ task_id: a.id, agent_id: "agent@one", kind: "spec", title: "Zanzibar spec", content: "quokka migration plan" });
  const ev = await store.reportEvidence({ task_id: a.id, agent_id: "agent@one", kind: "test_run", exit_code: 0, ac_ids: ["ac1"], output: "ok" });
  await store.registerHelper({ agent_id: "agent@one", path: "src/x.ts", symbol: "wombatHelper", kind: "util", summary: "formats wombats" });
  await store.sendMessage("agent@two", "agent@one", "hello", a.id);
  const job = await store.submitJob({ agent_id: "agent@one", type: "test", command: "npm test", task_id: a.id } as any);
  return { a: a.id, b: b.id, artifact: art.id as string, evidence: ev.id as string, job: job.id as string };
}

async function snapshotLines(target: SnapshotTarget): Promise<string[]> {
  const lines: string[] = [];
  await exportSnapshot(target, line => { lines.push(line); });
  return lines;
}

const body = (lines: string[]) => lines.slice(1); // drop the header (exported_at differs)

describe("sqlite snapshot export/import", () => {
  let dir: string;
  let oldPolicy: string | undefined;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "uw-snap-"));
    oldPolicy = process.env.UNDERWRIGHT_POLICY;
    process.env.UNDERWRIGHT_POLICY = join(dir, "no-policy.json");
  });
  afterEach(() => {
    if (oldPolicy === undefined) delete process.env.UNDERWRIGHT_POLICY;
    else process.env.UNDERWRIGHT_POLICY = oldPolicy;
    rmSync(dir, { recursive: true, force: true });
  });

  it("roundtrip: export → import → export is identical, in schema order", async () => {
    const src = join(dir, "src.db");
    const store = new SqliteStore(src);
    await seed(store);
    store.close();

    const first = await snapshotLines({ kind: "sqlite", path: src });
    const header = JSON.parse(first[0]);
    expect(header).toMatchObject({ type: "header", format: "underwright-snapshot", version: 1, backend: "sqlite" });
    const end = JSON.parse(first.at(-1)!);
    expect(end.type).toBe("end");
    expect(end.counts.tasks).toBe(2);
    expect(end.counts.events).toBeGreaterThan(0);
    expect(Object.keys(end.counts)).not.toContain("search_idx");
    // Schema order: tasks rows come before claims, events come after evidence.
    const tables = first.slice(1, -1).map(l => JSON.parse(l).table);
    expect(tables.indexOf("tasks")).toBeLessThan(tables.indexOf("claims"));
    expect(tables.lastIndexOf("evidence")).toBeLessThan(tables.indexOf("events"));

    const dst = join(dir, "dst.db");
    const result = await importSnapshot({ kind: "sqlite", path: dst }, first);
    expect(result.counts).toEqual(Object.fromEntries(Object.entries(end.counts).filter(([, n]) => (n as number) > 0)));
    expect(result.dropped_columns).toEqual({});

    const second = await snapshotLines({ kind: "sqlite", path: dst });
    expect(body(second)).toEqual(body(first));
  });

  it("ids-preserved: tasks, claims, artifacts, evidence, jobs, events keep their ids and the store keeps working", async () => {
    const src = join(dir, "src.db");
    const store = new SqliteStore(src);
    const ids = await seed(store);
    const events = store.auditLog(1000);
    const maxEvent = Math.max(...events.map((e: any) => e.id));
    store.close();

    const dst = join(dir, "dst.db");
    await importSnapshot({ kind: "sqlite", path: dst }, await snapshotLines({ kind: "sqlite", path: src }));

    const restored = new SqliteStore(dst);
    try {
      const a = restored.getTask(ids.a) as any;
      expect(a.title).toBe("parent");
      expect(a.claim.agent_id).toBe("agent@one");
      expect(a.artifacts.map((x: any) => x.id)).toContain(ids.artifact);
      expect(restored.getEvidence(ids.a).map((e: any) => e.id)).toContain(ids.evidence);
      expect((restored.getTask(ids.b) as any).blocked_by).toEqual([ids.a]);
      expect(restored.getJob(ids.job).command).toBe("npm test");
      expect(restored.auditLog(1000).map((e: any) => e.id).sort()).toEqual(events.map((e: any) => e.id).sort());
      expect(restored.inbox("agent@two").map((m: any) => m.body)).toEqual(["hello"]);

      // FTS index is rebuilt: artifacts and helpers are searchable again.
      const hits = restored.searchContext("quokka") as any[];
      expect(hits.some(h => h.entity_id === ids.artifact)).toBe(true);
      expect((restored.searchContext("wombats") as any[]).length).toBeGreaterThan(0);

      // New writes continue past the imported ids.
      restored.createTask({ title: "after import" });
      const newest = restored.auditLog(1)[0] as any;
      expect(newest.id).toBeGreaterThan(maxEvent);
    } finally {
      restored.close();
    }
  });

  it("refuses a non-empty target", async () => {
    const src = join(dir, "src.db");
    const store = new SqliteStore(src);
    await seed(store);
    store.close();
    const lines = await snapshotLines({ kind: "sqlite", path: src });
    await expect(importSnapshot({ kind: "sqlite", path: src }, lines)).rejects.toThrow(/not empty/);
  });

  it("rejects a truncated snapshot and leaves the target empty", async () => {
    const src = join(dir, "src.db");
    const store = new SqliteStore(src);
    await seed(store);
    store.close();
    const lines = await snapshotLines({ kind: "sqlite", path: src });
    const dst = join(dir, "dst.db");
    await expect(importSnapshot({ kind: "sqlite", path: dst }, lines.slice(0, -1))).rejects.toThrow(/no end line/);
    const db = new Database(dst, { readonly: true });
    expect((db.prepare("SELECT COUNT(*) AS n FROM tasks").get() as any).n).toBe(0);
    db.close();

    // A dropped row with the end line intact is caught by the count check.
    const missingRow = lines.filter((_, i) => i !== 1);
    await expect(importSnapshot({ kind: "sqlite", path: join(dir, "dst2.db") }, missingRow)).rejects.toThrow(/end line says/);
  });

  it("rejects input without a header", async () => {
    await expect(importSnapshot({ kind: "sqlite", path: join(dir, "x.db") }, ['{"type":"end","counts":{}}']))
      .rejects.toThrow(/header/);
  });

  it("coerces a Postgres-shaped snapshot (jsonb objects, booleans, bigint ids as strings) into SQLite", async () => {
    const lines = [
      JSON.stringify({ type: "header", format: "underwright-snapshot", version: 1, backend: "postgres", exported_at: new Date().toISOString() }),
      JSON.stringify({ type: "row", table: "tasks", row: {
        id: "gh-7", title: "from pg", description: "", spec_ref: null, ac_ids: ["x", "y"], status: "open", priority: 2,
        ownership: { paths: ["src/a.ts"] }, created_by: "human", type: "feature", severity: "normal", estimate: "S",
        review_of: null, review_kind: null, created_at: "2026-11-09T15:10:04.123Z", updated_at: "2026-11-09T15:10:04.123Z",
        pg_only_col: "dropped",
      } }),
      JSON.stringify({ type: "row", table: "messages", row: {
        id: "42", to_agent: "a", from_agent: "b", task_id: "gh-7", body: "hi", read: true, created_at: "2026-11-09T15:10:05.000Z",
      } }),
      JSON.stringify({ type: "end", counts: { tasks: 1, messages: 1 } }),
    ];
    const dst = join(dir, "dst.db");
    const result = await importSnapshot({ kind: "sqlite", path: dst }, lines);
    expect(result.dropped_columns).toEqual({ tasks: ["pg_only_col"] });

    const store = new SqliteStore(dst);
    try {
      const t = store.getTask("gh-7") as any;
      expect(t.ac_ids).toEqual(["x", "y"]);
      expect(t.ownership).toEqual({ paths: ["src/a.ts"] });
      const msgs = store.inbox("a", false) as any[];
      expect(msgs).toHaveLength(1);
      expect(msgs[0].id).toBe(42);
      expect(msgs[0].read).toBe(1);
    } finally {
      store.close();
    }
  });
});

describe("CLI underwright export / import", () => {
  it("round-trips through dist/cli.js via --out and a file argument", () => {
    const dir = mkdtempSync(join(tmpdir(), "uw-snap-cli-"));
    try {
      const src = join(dir, "src.db");
      const store = new SqliteStore(src);
      const t = store.createTask({ title: "cli snapshot", ac_ids: ["a"] });
      store.close();
      const env = { ...process.env, DATABASE_URL: "", UNDERWRIGHT_POLICY: join(dir, "no-policy.json") };
      const out = join(dir, "snap.ndjson");
      execFileSync(process.execPath, [join(root, "dist/cli.js"), "export", "--out", out], {
        cwd: root, env: { ...env, UNDERWRIGHT_DB: src }, encoding: "utf8", stdio: "pipe",
      });
      const text = readFileSync(out, "utf8");
      expect(text.split("\n")[0]).toContain("underwright-snapshot");

      // stdout export matches the file body.
      const stdout = execFileSync(process.execPath, [join(root, "dist/cli.js"), "export"], {
        cwd: root, env: { ...env, UNDERWRIGHT_DB: src }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
      });
      expect(stdout.split("\n").slice(1)).toEqual(text.split("\n").slice(1));

      const dst = join(dir, "dst.db");
      execFileSync(process.execPath, [join(root, "dist/cli.js"), "import", out], {
        cwd: root, env: { ...env, UNDERWRIGHT_DB: dst }, encoding: "utf8", stdio: "pipe",
      });
      const restored = new SqliteStore(dst);
      expect((restored.getTask(t.id) as any).title).toBe("cli snapshot");
      restored.close();

      // Importing again into the now non-empty store fails with exit 1.
      let status = 0;
      try {
        execFileSync(process.execPath, [join(root, "dist/cli.js"), "import", out], {
          cwd: root, env: { ...env, UNDERWRIGHT_DB: dst }, encoding: "utf8", stdio: "pipe",
        });
      } catch (e: any) {
        status = e.status;
        expect(String(e.stderr)).toMatch(/not empty/);
      }
      expect(status).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// Postgres: each test gets its own schema via search_path so the import's
// "fresh store" check does not collide with other suites sharing DATABASE_URL.
describe.skipIf(!process.env.DATABASE_URL)("postgres snapshot export/import", () => {
  const base = process.env.DATABASE_URL!;
  const schemas: string[] = [];
  let admin: postgres.Sql;
  let dir: string;

  const schemaUrl = (schema: string) => {
    const u = new URL(base);
    u.searchParams.set("search_path", schema);
    return u.toString();
  };
  async function freshSchema() {
    const name = `uw_snap_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
    await admin.unsafe(`CREATE SCHEMA ${name}`);
    schemas.push(name);
    return schemaUrl(name);
  }

  beforeEach(() => {
    admin = postgres(base, { max: 1, onnotice: () => {} });
    dir = mkdtempSync(join(tmpdir(), "uw-snap-pg-"));
    process.env.UNDERWRIGHT_POLICY = join(dir, "no-policy.json");
  });
  afterEach(async () => {
    for (const s of schemas.splice(0)) await admin.unsafe(`DROP SCHEMA IF EXISTS ${s} CASCADE`);
    await admin.end();
    rmSync(dir, { recursive: true, force: true });
  });

  it("roundtrip + ids-preserved: pg → pg", async () => {
    const srcUrl = await freshSchema();
    const store = await PgStore.connect(srcUrl);
    const ids = await seed(store);
    await store.close();

    const first = await snapshotLines({ kind: "postgres", url: srcUrl });
    const dstUrl = await freshSchema();
    await importSnapshot({ kind: "postgres", url: dstUrl }, first);
    const second = await snapshotLines({ kind: "postgres", url: dstUrl });
    expect(body(second)).toEqual(body(first));

    const restored = await PgStore.connect(dstUrl);
    try {
      const a = await restored.getTask(ids.a) as any;
      expect(a.claim.agent_id).toBe("agent@one");
      expect((await restored.getEvidence(ids.a)).map((e: any) => e.id)).toContain(ids.evidence);
      const maxEvent = Math.max(...first.slice(1, -1).map(l => JSON.parse(l)).filter(r => r.table === "events").map(r => Number(r.row.id)));
      await restored.createTask({ title: "after import" });
      const [newest] = await restored.auditLog(1) as any[];
      expect(Number(newest.id)).toBeGreaterThan(maxEvent);
    } finally {
      await restored.close();
    }
  });

  it("ids-preserved across backends: sqlite → pg → sqlite", async () => {
    const src = join(dir, "src.db");
    const store = new SqliteStore(src);
    const ids = await seed(store);
    store.close();

    const pgUrl = await freshSchema();
    await importSnapshot({ kind: "postgres", url: pgUrl }, await snapshotLines({ kind: "sqlite", path: src }));
    const pg = await PgStore.connect(pgUrl);
    try {
      const a = await pg.getTask(ids.a) as any;
      expect(a.ac_ids).toEqual(["ac1"]);
      expect(a.claim.agent_id).toBe("agent@one");
    } finally {
      await pg.close();
    }

    const back = join(dir, "back.db");
    await importSnapshot({ kind: "sqlite", path: back }, await snapshotLines({ kind: "postgres", url: pgUrl }));
    const restored = new SqliteStore(back);
    try {
      expect((restored.getTask(ids.a) as any).ac_ids).toEqual(["ac1"]);
      expect(restored.getEvidence(ids.a).map((e: any) => e.id)).toContain(ids.evidence);
    } finally {
      restored.close();
    }
  });
});
