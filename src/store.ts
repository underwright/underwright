import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { SCHEMA } from "./schema.js";
import type { IStore } from "./istore.js";

export type { TaskStatus } from "./istore.js";
import type { TaskStatus } from "./istore.js";
import { PgStore } from "./pstore.js";

export class SqliteStore implements IStore {
  private db: Database.Database;

  constructor(path = "underwright.db") {
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.db.exec(SCHEMA);
    this.migrate();
  }

  /** Schema versioning via PRAGMA user_version. */
  private migrate() {
    const v = (this.db.pragma("user_version", { simple: true }) as number) ?? 0;
    if (v < 1) {
      // v1: widen evidence.kind CHECK to the full taxonomy.
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS evidence_v1 (
          id          TEXT PRIMARY KEY,
          task_id     TEXT NOT NULL REFERENCES tasks(id),
          agent_id    TEXT NOT NULL,
          kind        TEXT NOT NULL CHECK (kind IN ('test_run','ci_check','review','coverage','deploy','contract_test','security_scan','smoke_test','mutation')),
          command     TEXT NOT NULL DEFAULT '',
          exit_code   INTEGER,
          output      TEXT NOT NULL DEFAULT '',
          ac_ids      TEXT NOT NULL DEFAULT '[]',
          created_at  TEXT NOT NULL DEFAULT (datetime('now'))
        );
        INSERT OR IGNORE INTO evidence_v1 SELECT * FROM evidence;
        DROP TABLE evidence;
        ALTER TABLE evidence_v1 RENAME TO evidence;
        PRAGMA user_version = 1;
      `);
    }
  }

  private log(entityType: string, entityId: string, action: string, actor: string, data: unknown = {}) {
    this.db
      .prepare("INSERT INTO events (entity_type, entity_id, action, actor, data) VALUES (?,?,?,?,?)")
      .run(entityType, entityId, action, actor, JSON.stringify(data));
  }

  private index(entityType: string, entityId: string, title: string, content: string) {
    this.db
      .prepare("INSERT INTO search_idx (entity_type, entity_id, title, content) VALUES (?,?,?,?)")
      .run(entityType, entityId, title, content);
  }

  createTask(args: {
    title: string; description?: string; spec_ref?: string; ac_ids?: string[];
    priority?: number; ownership?: object; created_by?: string; id?: string;
  }) {
    const id = args.id ?? `task-${randomUUID().slice(0, 8)}`;
    this.db
      .prepare(
        `INSERT INTO tasks (id, title, description, spec_ref, ac_ids, priority, ownership, created_by)
         VALUES (?,?,?,?,?,?,?,?)`
      )
      .run(
        id, args.title, args.description ?? "", args.spec_ref ?? null,
        JSON.stringify(args.ac_ids ?? []), args.priority ?? 2,
        JSON.stringify(args.ownership ?? {}), args.created_by ?? "human"
      );
    this.log("task", id, "created", args.created_by ?? "human", args);
    return this.getTask(id);
  }

  getTask(id: string) {
    const t = this.db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as any;
    if (!t) return null;
    const claim = this.db.prepare("SELECT * FROM claims WHERE task_id = ?").get(id) ?? null;
    return { ...t, ac_ids: JSON.parse(t.ac_ids), ownership: JSON.parse(t.ownership), claim };
  }

  setTaskStatus(id: string, status: TaskStatus, actor: string) {
    const t = this.getTask(id);
    if (!t) return { error: `task ${id} not found` };
    if (t.status === status) return { id, status };
    this.db.prepare("UPDATE tasks SET status=?, updated_at=datetime('now') WHERE id=?").run(status, id);
    this.log("task", id, `status:${status}`, actor);
    return { id, status };
  }

  listTasks(status?: TaskStatus) {
    const rows = status
      ? this.db.prepare("SELECT id, title, status, priority FROM tasks WHERE status = ? ORDER BY priority, created_at").all(status)
      : this.db.prepare("SELECT id, title, status, priority FROM tasks ORDER BY priority, created_at").all();
    return rows;
  }

  /** Atomic claim with lease. Returns the claim or an error string. */
  claimTask(taskId: string, agentId: string, ttlSeconds = 1800, scope: object = {}) {
    const task = this.getTask(taskId);
    if (!task) return { error: `task ${taskId} not found` };
    if (task.status === "done") return { error: `task ${taskId} is already done` };

    const existing = this.db.prepare("SELECT * FROM claims WHERE task_id = ?").get(taskId) as any;
    const now = new Date().toISOString();
    if (existing && existing.lease_expires > now && existing.agent_id !== agentId) {
      return { error: `task ${taskId} is claimed by ${existing.agent_id} until ${existing.lease_expires}` };
    }

    const expires = new Date(Date.now() + ttlSeconds * 1000).toISOString();
    this.db
      .prepare(
        `INSERT INTO claims (task_id, agent_id, lease_expires, scope) VALUES (?,?,?,?)
         ON CONFLICT(task_id) DO UPDATE SET agent_id=excluded.agent_id, lease_expires=excluded.lease_expires, scope=excluded.scope`
      )
      .run(taskId, agentId, expires, JSON.stringify(scope));
    this.db.prepare("UPDATE tasks SET status='claimed', updated_at=datetime('now') WHERE id=?").run(taskId);
    this.log("task", taskId, "claimed", agentId, { ttlSeconds, scope });
    return { task_id: taskId, agent_id: agentId, lease_expires: expires };
  }

  releaseTask(taskId: string, agentId: string) {
    const claim = this.db.prepare("SELECT agent_id FROM claims WHERE task_id = ?").get(taskId) as any;
    if (!claim) return { error: `task ${taskId} is not claimed` };
    if (claim.agent_id !== agentId) return { error: `task ${taskId} is claimed by ${claim.agent_id}` };
    this.db.prepare("DELETE FROM claims WHERE task_id = ?").run(taskId);
    this.db.prepare("UPDATE tasks SET status='open', updated_at=datetime('now') WHERE id=?").run(taskId);
    this.log("task", taskId, "released", agentId);
    return { released: taskId };
  }

  renewLease(taskId: string, agentId: string, ttlSeconds = 1800) {
    const claim = this.db.prepare("SELECT agent_id FROM claims WHERE task_id = ?").get(taskId) as any;
    if (!claim || claim.agent_id !== agentId) return { error: `task ${taskId} not claimed by ${agentId}` };
    const expires = new Date(Date.now() + ttlSeconds * 1000).toISOString();
    this.db.prepare("UPDATE claims SET lease_expires=? WHERE task_id=?").run(expires, taskId);
    return { task_id: taskId, lease_expires: expires };
  }

  postArtifact(args: { task_id?: string; agent_id: string; kind: string; title?: string; content: string }) {
    const id = `art-${randomUUID().slice(0, 8)}`;
    this.db
      .prepare("INSERT INTO artifacts (id, task_id, agent_id, kind, title, content) VALUES (?,?,?,?,?,?)")
      .run(id, args.task_id ?? null, args.agent_id, args.kind, args.title ?? "", args.content);
    this.index("artifact", id, args.title ?? args.kind, args.content);
    this.log("artifact", id, "posted", args.agent_id, { task_id: args.task_id, kind: args.kind });
    return { id };
  }

  reportEvidence(args: {
    task_id: string; agent_id: string; kind: string; command?: string;
    exit_code?: number; output?: string; ac_ids?: string[];
  }) {
    const id = `ev-${randomUUID().slice(0, 8)}`;
    this.db
      .prepare(
        "INSERT INTO evidence (id, task_id, agent_id, kind, command, exit_code, output, ac_ids) VALUES (?,?,?,?,?,?,?,?)"
      )
      .run(id, args.task_id, args.agent_id, args.kind, args.command ?? "",
        args.exit_code ?? null, args.output ?? "", JSON.stringify(args.ac_ids ?? []));
    this.log("evidence", id, "reported", args.agent_id, { task_id: args.task_id, kind: args.kind });
    return { id };
  }

  /** Close a task. Requires evidence for every declared acceptance criterion. */
  completeTask(taskId: string, agentId: string) {
    const task = this.getTask(taskId);
    if (!task) return { error: `task ${taskId} not found` };
    const claim = this.db.prepare("SELECT agent_id FROM claims WHERE task_id=?").get(taskId) as any;
    if (claim && claim.agent_id !== agentId) return { error: `task ${taskId} is claimed by ${claim.agent_id}` };

    const rows = this.db.prepare("SELECT ac_ids FROM evidence WHERE task_id=?").all(taskId) as any[];
    const proven = new Set(rows.flatMap((r) => JSON.parse(r.ac_ids)));
    const missing = (task.ac_ids as string[]).filter((ac) => !proven.has(ac));
    if (missing.length > 0) {
      return { error: `unproven acceptance criteria: ${missing.join(", ")}. Attach evidence citing these ac_ids.` };
    }
    if ((task.ac_ids as string[]).length === 0 && rows.length === 0) {
      return { error: "no evidence attached. Done requires proof." };
    }

    this.db.prepare("UPDATE tasks SET status='done', updated_at=datetime('now') WHERE id=?").run(taskId);
    this.db.prepare("DELETE FROM claims WHERE task_id=?").run(taskId);
    this.log("task", taskId, "completed", agentId);
    return { completed: taskId };
  }

  getEvidence(taskId: string) {
    return this.db
      .prepare("SELECT * FROM evidence WHERE task_id=? ORDER BY created_at")
      .all(taskId) as any[];
  }

  registerHelper(args: { agent_id: string; path: string; symbol?: string; kind: string; summary: string }) {
    const id = `hlp-${randomUUID().slice(0, 8)}`;
    this.db
      .prepare(
        `INSERT INTO helpers (id, agent_id, path, symbol, kind, summary) VALUES (?,?,?,?,?,?)
         ON CONFLICT(path, symbol) DO UPDATE SET summary=excluded.summary, agent_id=excluded.agent_id`
      )
      .run(id, args.agent_id, args.path, args.symbol ?? "", args.kind, args.summary);
    this.index("helper", id, `${args.symbol || args.path}`, args.summary);
    this.log("helper", id, "registered", args.agent_id, args);
    return { id };
  }

  /** Pre-flight: what already exists? Search helpers + artifacts. */
  searchContext(query: string, kinds?: string[]) {
    const rows = this.db
      .prepare(
        `SELECT entity_type, entity_id, title, snippet(search_idx, 3, '>>>', '<<<', '…', 20) AS snippet
         FROM search_idx WHERE search_idx MATCH ? ORDER BY rank LIMIT 20`
      )
      .all(query) as any[];
    return kinds?.length ? rows.filter((r) => kinds.includes(r.entity_type)) : rows;
  }

  submitJob(args: { task_id?: string; agent_id: string; type: string; command: string }) {
    const id = `job-${randomUUID().slice(0, 8)}`;
    this.db
      .prepare("INSERT INTO jobs (id, task_id, agent_id, type, command) VALUES (?,?,?,?,?)")
      .run(id, args.task_id ?? null, args.agent_id, args.type, args.command);
    this.log("job", id, "submitted", args.agent_id, args);
    return { id, status: "queued" };
  }

  nextJob(agentId?: string) {
    const job = this.db
      .prepare("SELECT * FROM jobs WHERE status='queued' ORDER BY created_at LIMIT 1")
      .get() as any;
    if (!job) return null;
    this.db.prepare("UPDATE jobs SET status='running', started_at=datetime('now') WHERE id=?").run(job.id);
    this.log("job", job.id, "started", agentId ?? "runner");
    return job;
  }

  finishJob(jobId: string, status: "done" | "failed", result: string) {
    this.db.prepare("UPDATE jobs SET status=?, result=?, finished_at=datetime('now') WHERE id=?")
      .run(status, result, jobId);
    this.log("job", jobId, status, "runner", { result: result.slice(0, 500) });
    return { id: jobId, status };
  }

  getJob(id: string) {
    return this.db.prepare("SELECT * FROM jobs WHERE id=?").get(id) ?? null;
  }

  board() {
    const tasks = this.db
      .prepare(
        `SELECT t.id, t.title, t.status, t.priority, c.agent_id AS claimed_by, c.lease_expires
         FROM tasks t LEFT JOIN claims c ON c.task_id = t.id ORDER BY t.priority, t.created_at`
      )
      .all();
    const jobs = this.db.prepare("SELECT status, COUNT(*) n FROM jobs GROUP BY status").all();
    const helpers = (this.db.prepare("SELECT COUNT(*) n FROM helpers").get() as any).n;
    return { tasks, job_counts: jobs, helpers_registered: helpers };
  }

  auditLog(limit = 50) {
    return this.db.prepare("SELECT * FROM events ORDER BY id DESC LIMIT ?").all(limit);
  }

  close() {
    this.db.close();
  }
}

/** Open the configured backend. DATABASE_URL → Postgres/Lakebase;
 *  otherwise a local SQLite file. Backend selection is pure config. */
export async function openStore(dbPath: string): Promise<IStore> {
  const url = process.env.DATABASE_URL;
  if (url) return PgStore.connect(url);
  return new SqliteStore(dbPath);
}
