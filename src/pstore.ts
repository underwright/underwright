import postgres from "postgres";
import { TASK_DEPENDENCIES_SCHEMA, PG_JOBS_MIGRATION, PG_ARTIFACTS_MIGRATION, ARTIFACT_KIND_SQL, isArtifactKind } from "./schema.js";
import { randomUUID } from "node:crypto";
import { loadPolicy, evaluateDoD, evaluateDoR, expandTemplate, listTemplates as allTemplates, getDispatcherPolicy, type DispatcherPolicy } from "./policy.js";
import { parseCoverage } from "./coverage.js";
import { chooseReassignAgent, chooseReviewer, DISPATCHER_AGENT, implementerFromRecords, isSystemActor, leaseActive, linkedReviewArgs, nextTaskMessage, overCap, reviewIndependenceError, taskIdFromNextTaskMessage } from "./dispatcher.js";
import { buildDigest, normalizeDigestArgs, sendHumanNotification } from "./digest.js";
import { importSpecKit, type ImportSpecKitArgs } from "./speckit.js";
import type { IStore, TaskStatus, CreateTaskArgs, SubmitJobArgs, DigestArgs, DigestResult } from "./istore.js";

const DDL = `
CREATE TABLE IF NOT EXISTS tasks (
  id          TEXT PRIMARY KEY,
  title       TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  spec_ref    TEXT,
  ac_ids      JSONB NOT NULL DEFAULT '[]',
  type        TEXT NOT NULL DEFAULT 'feature',
  severity    TEXT NOT NULL DEFAULT 'normal',
  estimate    TEXT NOT NULL DEFAULT '',
  review_of   TEXT,
  review_kind TEXT,
  status      TEXT NOT NULL DEFAULT 'open'
              CHECK (status IN ('open','claimed','in_review','done','blocked')),
  priority    INT NOT NULL DEFAULT 2,
  ownership   JSONB NOT NULL DEFAULT '{}',
  created_by  TEXT NOT NULL DEFAULT 'human',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
${TASK_DEPENDENCIES_SCHEMA}
CREATE TABLE IF NOT EXISTS claims (
  task_id       TEXT PRIMARY KEY REFERENCES tasks(id),
  agent_id      TEXT NOT NULL,
  lease_expires TIMESTAMPTZ NOT NULL,
  scope         JSONB NOT NULL DEFAULT '{}',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS artifacts (
  id         TEXT PRIMARY KEY,
  task_id    TEXT REFERENCES tasks(id),
  agent_id   TEXT NOT NULL,
  kind       TEXT NOT NULL CHECK (kind IN (${ARTIFACT_KIND_SQL})),
  title      TEXT NOT NULL DEFAULT '',
  content    TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS evidence (
  id         TEXT PRIMARY KEY,
  task_id    TEXT NOT NULL REFERENCES tasks(id),
  agent_id   TEXT NOT NULL,
  kind       TEXT NOT NULL CHECK (kind IN ('test_run','ci_check','review','coverage','deploy','contract_test','security_scan','smoke_test','mutation')),
  command    TEXT NOT NULL DEFAULT '',
  exit_code  INT,
  output     TEXT NOT NULL DEFAULT '',
  ac_ids     JSONB NOT NULL DEFAULT '[]',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS helpers (
  id         TEXT PRIMARY KEY,
  agent_id   TEXT NOT NULL,
  path       TEXT NOT NULL,
  symbol     TEXT NOT NULL DEFAULT '',
  kind       TEXT NOT NULL CHECK (kind IN ('util','pattern','config','fixture')),
  summary    TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (path, symbol)
);
CREATE TABLE IF NOT EXISTS jobs (
  id          TEXT PRIMARY KEY,
  task_id     TEXT REFERENCES tasks(id),
  agent_id    TEXT NOT NULL,
  type        TEXT NOT NULL CHECK (type IN ('test','build','deploy','review')),
  status      TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','done','failed')),
  command     TEXT NOT NULL,
  result      TEXT NOT NULL DEFAULT '',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at  TIMESTAMPTZ,
  finished_at TIMESTAMPTZ
);
CREATE TABLE IF NOT EXISTS messages (
  id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  to_agent   TEXT NOT NULL,
  from_agent TEXT NOT NULL,
  task_id    TEXT,
  body       TEXT NOT NULL,
  read       BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS watches (
  agent_id   TEXT NOT NULL,
  task_id    TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (agent_id, task_id)
);
CREATE TABLE IF NOT EXISTS locks (
  resource      TEXT PRIMARY KEY,
  agent_id      TEXT NOT NULL,
  task_id       TEXT,
  lease_expires TIMESTAMPTZ NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS events (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  entity_type TEXT NOT NULL,
  entity_id   TEXT NOT NULL,
  action      TEXT NOT NULL,
  actor       TEXT NOT NULL,
  data        JSONB NOT NULL DEFAULT '{}',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS helpers_search ON helpers USING gin(to_tsvector('english', path || ' ' || symbol || ' ' || summary));
CREATE INDEX IF NOT EXISTS artifacts_search ON artifacts USING gin(to_tsvector('english', title || ' ' || content));
`;

const EVIDENCE_KINDS = ["test_run","ci_check","review","coverage","deploy","contract_test","security_scan","smoke_test","mutation"];

/** Postgres control-plane store — also works against Databricks Lakebase
 *  (managed Postgres) unchanged: point DATABASE_URL at the instance. */
export class PgStore implements IStore {
  private sql: postgres.Sql;

  private constructor(sql: postgres.Sql) {
    this.sql = sql;
  }

  static async connect(url: string) {
    const sql = postgres(url, { max: 5 });
    await sql.unsafe(DDL);
    await sql.unsafe(PG_JOBS_MIGRATION);
    await sql.unsafe(PG_ARTIFACTS_MIGRATION);
    await sql`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS type TEXT NOT NULL DEFAULT 'feature'`;
    await sql`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS severity TEXT NOT NULL DEFAULT 'normal'`;
    await sql`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS estimate TEXT NOT NULL DEFAULT ''`;
    await sql`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS review_of TEXT`;
    await sql`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS review_kind TEXT`;
    await sql`CREATE INDEX IF NOT EXISTS tasks_review_of ON tasks(review_of)`;
    return new PgStore(sql);
  }

  async log(entityType: string, entityId: string, action: string, actor: string, data: unknown = {}) {
    await this.sql`INSERT INTO events (entity_type, entity_id, action, actor, data) VALUES (${entityType},${entityId},${action},${actor},${this.sql.json(data as any)})`;
  }

  private async dependencyTransaction(work: (store: PgStore) => Promise<any>): Promise<any> {
    return this.sql.begin(async sql => {
      // Serialize graph edits with claim/completion checks across server instances.
      await sql`LOCK TABLE task_dependencies IN SHARE ROW EXCLUSIVE MODE`;
      return work(new PgStore(sql as unknown as postgres.Sql));
    });
  }

  private async dependencies(id: string, status: TaskStatus) {
    const blockers = await this.sql`SELECT t.id, t.status FROM task_dependencies d
      JOIN tasks t ON t.id=d.blocker_id WHERE d.task_id=${id} ORDER BY t.id`;
    const blocks = await this.sql`SELECT task_id FROM task_dependencies WHERE blocker_id=${id} ORDER BY task_id`;
    const unfinished_blockers = blockers.filter(t => t.status !== "done").map(t => t.id as string);
    return { blocked_by: blockers.map(t => t.id as string), blocks: blocks.map(t => t.task_id as string),
      unfinished_blockers, status: status === "open" && unfinished_blockers.length ? "blocked" : status };
  }

  private async validateDependencies(id: string, blockers: string[]) {
    for (const blocker of new Set(blockers)) {
      if (blocker === id) return `task ${id} cannot depend on itself`;
      const found = await this.sql`SELECT 1 FROM tasks WHERE id=${blocker}`;
      if (!found.length) return `blocker ${blocker} not found`;
      const cycle = await this.sql`WITH RECURSIVE ancestors(id) AS (
        SELECT blocker_id FROM task_dependencies WHERE task_id=${blocker}
        UNION SELECT d.blocker_id FROM task_dependencies d JOIN ancestors a ON d.task_id=a.id
      ) SELECT 1 FROM ancestors WHERE id=${id}`;
      if (cycle.length) return `dependency on ${blocker} would create a cycle`;
    }
  }

  private async replaceDependencies(id: string, blockers: string[]) {
    await this.sql`DELETE FROM task_dependencies WHERE task_id=${id}`;
    for (const blocker of new Set(blockers)) {
      await this.sql`INSERT INTO task_dependencies (task_id, blocker_id) VALUES (${id},${blocker})`;
    }
  }

  private async unblockDependents(blockerId: string, actor: string) {
    const dependents = await this.sql`SELECT t.id, t.status FROM task_dependencies d
      JOIN tasks t ON t.id=d.task_id WHERE d.blocker_id=${blockerId}`;
    for (const t of dependents) {
      if (t.status === "done") continue;
      const remaining = (await this.dependencies(t.id, t.status)).unfinished_blockers;
      const unblocked = t.status === "open" && remaining.length === 0;
      await this.log("task", t.id, unblocked ? "unblocked" : "blocker_completed", actor,
        { blocker_id: blockerId, unfinished_blockers: remaining });
      await this.notifyWatchers(t.id, unblocked
        ? `task ${t.id} unblocked: all blockers done (completed ${blockerId})`
        : `task ${t.id}: blocker ${blockerId} completed; remaining blockers: ${remaining.join(", ") || "none"}`);
    }
  }

  async createTask(args: CreateTaskArgs) {
    const { args: seeded, error } = expandTemplate(args, loadPolicy());
    if (error) return { error };
    return this.dependencyTransaction(store => store.createTaskAtomic(seeded));
  }

  private async createTaskAtomic(a: CreateTaskArgs) {
    const id = a.id ?? `task-${randomUUID().slice(0, 8)}`;
    const subject = a.review_of?.trim()
      ? (await this.sql<{ id: string; type: string }[]>`SELECT id, type FROM tasks WHERE id=${a.review_of.trim()}`)[0]
      : undefined;
    const linked = linkedReviewArgs(a, subject ?? null);
    if (linked.error) return { error: linked.error };
    a = linked.args;
    const invalid = await this.validateDependencies(id, a.blocked_by ?? []);
    if (invalid) return { error: invalid };
    await this.sql`
      INSERT INTO tasks (id, title, description, spec_ref, ac_ids, priority, ownership, created_by, type, severity, estimate, review_of, review_kind)
      VALUES (${id},${a.title},${a.description ?? ""},${a.spec_ref ?? null},
              ${this.sql.json(a.ac_ids ?? [])},${a.priority ?? 2},
              ${this.sql.json(a.ownership ?? {})},${a.created_by ?? "human"},${a.type ?? "feature"},
              ${a.severity ?? "normal"},${a.estimate ?? ""},${linked.reviewOf},${a.review_kind ?? null})`;
    await this.replaceDependencies(id, a.blocked_by ?? []);
    await this.log("task", id, "created", a.created_by ?? "human", a);
    return this.getTask(id);
  }

  async listTemplates() {
    return allTemplates(loadPolicy());
  }

  async getTask(id: string) {
    const [t] = await this.sql<any[]>`SELECT * FROM tasks WHERE id = ${id}`;
    if (!t) return null;
    const [claim] = await this.sql<any[]>`SELECT * FROM claims WHERE task_id = ${id}`;
    return {
      ...t, ...await this.dependencies(id, t.status), claim: claim ?? null,
      artifacts: await this.listArtifacts(id), reviews: await this.reviewIds(id),
    };
  }

  private async reviewIds(id: string): Promise<string[]> {
    const rows = await this.sql<{ id: string }[]>`SELECT id FROM tasks WHERE review_of=${id} ORDER BY id`;
    return rows.map((row) => row.id);
  }

  async setTaskStatus(id: string, status: TaskStatus, actor: string) {
    return this.dependencyTransaction(store => store.setTaskStatusAtomic(id, status, actor));
  }

  private async setTaskStatusAtomic(id: string, status: TaskStatus, actor: string) {
    const t = await this.getTask(id);
    if (!t) return { error: `task ${id} not found` };
    const [raw] = await this.sql`SELECT status FROM tasks WHERE id=${id}`;
    if (raw.status === status) return { id, status };
    await this.sql`UPDATE tasks SET status=${status}, updated_at=now() WHERE id=${id}`;
    await this.log("task", id, `status:${status}`, actor);
    await this.notifyWatchers(id, `task ${id} → ${status}`);
    if (status === "done" && t.status !== "done") await this.unblockDependents(id, actor);
    return { id, status };
  }

  async updateTask(id: string, patch: Partial<CreateTaskArgs>, actor: string) {
    return this.dependencyTransaction(store => store.updateTaskAtomic(id, patch, actor));
  }

  private async updateTaskAtomic(id: string, patch: Partial<CreateTaskArgs>, actor: string) {
    const t = await this.getTask(id);
    if (!t) return { error: `task ${id} not found` };
    const sets: string[] = [];
    const vals: any[] = [];
    for (const k of ["title", "description", "spec_ref", "type", "severity", "estimate"] as const) {
      if (patch[k] !== undefined) { sets.push(`${k}=$${vals.length + 2}`); vals.push(patch[k]); }
    }
    if (patch.ac_ids !== undefined) { sets.push(`ac_ids=$${vals.length + 2}`); vals.push(JSON.stringify(patch.ac_ids)); }
    if (patch.blocked_by !== undefined) {
      const invalid = await this.validateDependencies(id, patch.blocked_by);
      if (invalid) return { error: invalid };
      await this.replaceDependencies(id, patch.blocked_by);
    }
    if (!sets.length && patch.blocked_by === undefined) return { id, unchanged: true };
    await this.sql.unsafe(`UPDATE tasks SET ${[...sets, "updated_at=now()"].join(",")} WHERE id=$1`, [id, ...vals]);
    await this.log("task", id, "updated", actor, patch);
    return this.getTask(id);
  }

  async linkTask(id: string, spec_ref: string) {
    const t = await this.getTask(id);
    if (!t) return { error: `task ${id} not found` };
    await this.sql`UPDATE tasks SET spec_ref=${spec_ref}, updated_at=now() WHERE id=${id}`;
    await this.log("task", id, "linked", "sync", { spec_ref });
    return { id, spec_ref };
  }

  async listTasks(status?: TaskStatus) {
    const rows = await this.sql`SELECT id, title, status, priority FROM tasks ORDER BY priority, created_at`;
    const tasks = await Promise.all(rows.map(async t => ({ ...t, ...await this.dependencies(t.id, t.status) })));
    return tasks.filter(t => !status || t.status === status);
  }

  async claimTask(taskId: string, agentId: string, ttlSeconds = 1800, scope: object = {}) {
    return this.dependencyTransaction(store => store.claimTaskAtomic(taskId, agentId, ttlSeconds, scope));
  }

  private async claimTaskAtomic(taskId: string, agentId: string, ttlSeconds = 1800, scope: object = {}) {
    const task = await this.getTask(taskId);
    if (!task) return { error: `task ${taskId} not found` };
    if (task.status === "done") return { error: `task ${taskId} is already done` };
    const claim = task.claim;
    if (claim && new Date(claim.lease_expires) > new Date() && claim.agent_id !== agentId) {
      return { error: `task ${taskId} is claimed by ${claim.agent_id} until ${claim.lease_expires}` };
    }

    if (task.unfinished_blockers.length) {
      return { error: `task ${taskId} is blocked by unfinished tasks: ${task.unfinished_blockers.join(", ")}` };
    }

    const dor = evaluateDoR(task, loadPolicy());
    if (!dor.ready) {
      return { error: `task ${taskId} is not ready to claim: ${dor.missing.join("; ")}. Triage it first (update_task).` };
    }

    if (task.type === "review" && task.review_of && claim?.agent_id !== agentId) {
      const independence = reviewIndependenceError(agentId, await this.implementerOf(task.review_of), task.review_of);
      if (independence) return { error: independence };
    }

    const expires = new Date(Date.now() + ttlSeconds * 1000);
    await this.sql`
      INSERT INTO claims (task_id, agent_id, lease_expires, scope) VALUES (${taskId},${agentId},${expires},${this.sql.json(scope)})
      ON CONFLICT(task_id) DO UPDATE SET agent_id=EXCLUDED.agent_id, lease_expires=EXCLUDED.lease_expires, scope=EXCLUDED.scope`;
    await this.sql`UPDATE tasks SET status='claimed', updated_at=now() WHERE id=${taskId}`;
    await this.log("task", taskId, "claimed", agentId, { ttlSeconds, scope });

    // Auto-lock the task's declared ownership paths — dedupe below task level.
    const paths = (task.ownership as any)?.paths ?? [];
    if (paths.length) {
      const lr = await this.claimResources(paths, agentId, taskId, ttlSeconds);
      if ((lr as any).error) return { task_id: taskId, agent_id: agentId, lease_expires: expires.toISOString(), warning: `claimed task but resource locks conflict: ${JSON.stringify((lr as any).conflicts)}` };
    }
    return { task_id: taskId, agent_id: agentId, lease_expires: expires.toISOString() };
  }

  async claimResources(resources: string[], agentId: string, taskId?: string, ttlSeconds = 1800) {
    const conflicts = (await this.checkLocks(resources)).filter((l: any) => l.agent_id !== agentId);
    if (conflicts.length) return { error: "locked", conflicts };
    const expires = new Date(Date.now() + ttlSeconds * 1000);
    for (const r of resources) {
      await this.sql`INSERT INTO locks (resource, agent_id, task_id, lease_expires) VALUES (${r},${agentId},${taskId ?? null},${expires})
        ON CONFLICT(resource) DO UPDATE SET agent_id=EXCLUDED.agent_id, task_id=EXCLUDED.task_id, lease_expires=EXCLUDED.lease_expires`;
    }
    await this.log("locks", resources.join(","), "claimed", agentId, { task_id: taskId, ttlSeconds });
    return { claimed: resources, lease_expires: expires.toISOString() };
  }

  async releaseResources(resources: string[], agentId: string) {
    for (const r of resources) {
      await this.sql`DELETE FROM locks WHERE resource=${r} AND agent_id=${agentId}`;
    }
    await this.log("locks", resources.join(","), "released", agentId);
    return { released: resources };
  }

  async checkLocks(resources: string[]) {
    if (!resources.length) return [];
    return this.sql`SELECT * FROM locks WHERE resource = ANY(${resources}) AND lease_expires > now()`;
  }

  async releaseTask(taskId: string, agentId: string) {
    return this.sql.begin(async sql => {
      const tx = new PgStore(sql as unknown as postgres.Sql);
      return tx.releaseTaskAtomic(taskId, agentId);
    });
  }

  private async releaseTaskAtomic(taskId: string, agentId: string) {
    const [claim] = await this.sql<any[]>`SELECT agent_id FROM claims WHERE task_id=${taskId}`;
    if (!claim) return { error: `task ${taskId} is not claimed` };
    if (claim.agent_id !== agentId) return { error: `task ${taskId} is claimed by ${claim.agent_id}` };
    await this.sql`DELETE FROM claims WHERE task_id=${taskId}`;
    await this.sql`UPDATE tasks SET status='open', updated_at=now() WHERE id=${taskId}`;
    await this.log("task", taskId, "released", agentId);
    const dispatched = await this.dispatchNext(agentId, taskId, "release");
    return { released: taskId, ...(dispatched ? { dispatched } : {}) };
  }

  async renewLease(taskId: string, agentId: string, ttlSeconds = 1800) {
    const [claim] = await this.sql<any[]>`SELECT agent_id FROM claims WHERE task_id=${taskId}`;
    if (!claim || claim.agent_id !== agentId) return { error: `task ${taskId} not claimed by ${agentId}` };
    const expires = new Date(Date.now() + ttlSeconds * 1000);
    await this.sql`UPDATE claims SET lease_expires=${expires} WHERE task_id=${taskId}`;
    return { task_id: taskId, lease_expires: expires.toISOString() };
  }

  async sweepExpiredClaims() {
    const { reclaimed, notifications } = await this.sql.begin(async sql => {
      // DELETE locks the expired rows: a concurrent renewal/reclaim is checked
      // before deletion, and another sweeper cannot publish the same expiry.
      const expired = await sql`DELETE FROM claims WHERE lease_expires <= now() RETURNING *`;
      const notes: { task_id: string; title: string; agent_id: string; reopened: boolean; lease_expires: string | Date }[] = [];
      for (const claim of expired) {
        const reopened = await sql`
          UPDATE tasks SET status='open', updated_at=now()
          WHERE id=${claim.task_id} AND status='claimed' RETURNING id`;
        const [taskRow] = await sql<{ title: string }[]>`SELECT title FROM tasks WHERE id=${claim.task_id}`;
        await sql`
          INSERT INTO events (entity_type, entity_id, action, actor, data)
          VALUES ('task',${claim.task_id},'lease_expired','lease-sweeper',
            ${sql.json({ agent_id: claim.agent_id, lease_expires: claim.lease_expires, reopened: reopened.length > 0 })})`;
        const body = `task ${claim.task_id} lease expired (${claim.agent_id})${reopened.length ? " → open" : ""}`;
        await sql`
          INSERT INTO messages (to_agent, from_agent, task_id, body)
          SELECT agent_id, 'underwright', task_id, ${body} FROM watches WHERE task_id=${claim.task_id}`;
        notes.push({
          task_id: claim.task_id as string,
          title: taskRow?.title ?? "",
          agent_id: claim.agent_id as string,
          reopened: reopened.length > 0,
          lease_expires: claim.lease_expires,
        });
      }
      return { reclaimed: expired.map(claim => claim.task_id as string), notifications: notes };
    });
    if (notifications.length > 0) {
      const policy = loadPolicy();
      for (const n of notifications) {
        await sendHumanNotification({ event: "claim_reclaimed", ...n }, policy);
      }
    }
    return { reclaimed };
  }

  async postArtifact(a: { task_id?: string; agent_id: string; kind: string; title?: string; content: string }) {
    if (!isArtifactKind(a.kind)) return { error: `unknown artifact kind: ${a.kind}` };
    const id = `art-${randomUUID().slice(0, 8)}`;
    await this.sql`INSERT INTO artifacts (id, task_id, agent_id, kind, title, content)
      VALUES (${id},${a.task_id ?? null},${a.agent_id},${a.kind},${a.title ?? ""},${a.content})`;
    const action = a.kind === "blocked" ? "blocked" : "posted";
    await this.log("artifact", id, action, a.agent_id, { task_id: a.task_id, kind: a.kind });
    if (a.kind === "blocked" && a.task_id) {
      await this.log("task", a.task_id, "blocked", a.agent_id, { artifact_id: id });
      await this.notifyWatchers(a.task_id, `task ${a.task_id} escalation: blocked artifact ${id}`);
    }
    return { id };
  }

  async importSpecKit(a: ImportSpecKitArgs) {
    return importSpecKit(this, a);
  }

  async reportEvidence(a: { task_id: string; agent_id: string; kind: string; command?: string; exit_code?: number; output?: string; ac_ids?: string[] }) {
    if (!EVIDENCE_KINDS.includes(a.kind)) return { error: `unknown evidence kind ${a.kind}` };
    const id = `ev-${randomUUID().slice(0, 8)}`;
    await this.sql`INSERT INTO evidence (id, task_id, agent_id, kind, command, exit_code, output, ac_ids)
      VALUES (${id},${a.task_id},${a.agent_id},${a.kind},${a.command ?? ""},${a.exit_code ?? null},${a.output ?? ""},${this.sql.json(a.ac_ids ?? [])})`;
    await this.log("evidence", id, "reported", a.agent_id, { task_id: a.task_id, kind: a.kind });
    if (a.kind !== "coverage") return { id };
    const coverage = parseCoverage(a.output ?? "");
    return coverage
      ? { id, coverage }
      : { id, warning: "coverage output could not be parsed (expected vitest table, JSON summary, or a percentage)" };
  }

  async listArtifacts(taskId: string) {
    return this.sql`SELECT * FROM artifacts WHERE task_id=${taskId} ORDER BY created_at`;
  }

  async getEvidence(taskId: string) {
    const rows = await this.sql<any[]>`SELECT * FROM evidence WHERE task_id=${taskId} ORDER BY created_at`;
    return rows.map((r) => (r.kind === "coverage" ? { ...r, coverage: parseCoverage(r.output ?? "") } : r));
  }

  async completeTask(taskId: string, agentId: string) {
    const res = await this.dependencyTransaction(store => store.completeTaskAtomic(taskId, agentId));
    if (res && res._notify) {
      const { _notify, ...publicRes } = res;
      await sendHumanNotification(_notify, loadPolicy());
      return publicRes;
    }
    return res;
  }

  private async completeTaskAtomic(taskId: string, agentId: string) {
    const task = await this.getTask(taskId);
    if (!task) return { error: `task ${taskId} not found` };
    if (task.status === "done") return { completed: taskId };
    const claim = task.claim;
    if (claim && claim.agent_id !== agentId) return { error: `task ${taskId} is claimed by ${claim.agent_id}` };
    const rows = await this.getEvidence(taskId);
    const proven = new Set(rows.flatMap((r: any) => r.ac_ids as string[]));
    const acs = task.ac_ids as string[];
    const missing = acs.filter((ac) => !proven.has(ac));
    if (missing.length > 0) {
      return { error: `unproven acceptance criteria: ${missing.join(", ")}. Attach evidence citing these ac_ids.` };
    }
    if (acs.length === 0 && rows.length === 0) {
      return { error: "no evidence attached. Done requires proof." };
    }

    const policy = loadPolicy();
    const artifacts = await this.listArtifacts(taskId);
    const dod = evaluateDoD({
      task, evidence: rows, artifacts,
      claimAgent: claim?.agent_id ?? agentId, policy,
    });
    if (dod.blocked) {
      return { error: `definition of done not met (${task.type}): ${dod.missing.join("; ")}` };
    }

    await this.sql`UPDATE tasks SET status='done', updated_at=now() WHERE id=${taskId}`;
    await this.sql`DELETE FROM claims WHERE task_id=${taskId}`;
    await this.log("task", taskId, "completed", agentId, { dod: dod.missing });
    await this.notifyWatchers(taskId, `task ${taskId} → done`);
    await this.unblockDependents(taskId, agentId);
    const dispatched = await this.dispatchNext(agentId, taskId, "complete");
    return {
      completed: taskId,
      ...(dod.missing.length ? { warnings: dod.missing } : {}),
      ...(dispatched ? { dispatched } : {}),
      _notify: {
        event: "task_completed" as const,
        task_id: taskId,
        title: String(task.title ?? ""),
        agent_id: agentId,
      },
    };
  }

  private async taskRouteMeta(id: string) {
    const [row] = await this.sql<{ type: string; review_of: string | null; review_kind: string | null }[]>`
      SELECT type, review_of, review_kind FROM tasks WHERE id=${id}`;
    if (!row) return null;
    return { type: row.type, review_of: row.review_of ?? null, review_kind: row.review_kind ?? null };
  }

  private async implementerOf(subjectId: string): Promise<string | null> {
    const [completed] = await this.sql<{ actor: string }[]>`
      SELECT actor FROM events WHERE entity_type='task' AND entity_id=${subjectId} AND action='completed' ORDER BY id DESC LIMIT 1`;
    const [claim] = await this.sql<{ agent_id: string }[]>`SELECT agent_id FROM claims WHERE task_id=${subjectId}`;
    const [claimed] = await this.sql<{ actor: string }[]>`
      SELECT actor FROM events WHERE entity_type='task' AND entity_id=${subjectId} AND action='claimed' ORDER BY id DESC LIMIT 1`;
    const [artifact] = await this.sql<{ agent_id: string }[]>`
      SELECT agent_id FROM artifacts WHERE task_id=${subjectId} AND kind IN ('design','spec') ORDER BY created_at DESC LIMIT 1`;
    const [created] = await this.sql<{ created_by: string }[]>`SELECT created_by FROM tasks WHERE id=${subjectId}`;
    return implementerFromRecords({
      completedBy: completed?.actor,
      claimAgent: claim?.agent_id,
      lastClaimedBy: claimed?.actor,
      artifactAuthor: artifact?.agent_id,
      createdBy: created?.created_by,
    });
  }

  /** Assign the next open task. Review tasks go to a different harness than the implementer. */
  private async dispatchNext(agentId: string, excludeTaskId: string, trigger: "complete" | "release") {
    const policy = getDispatcherPolicy(loadPolicy());
    if (!policy.enabled) return null;
    const workload = await this.agentWorkload(agentId);
    const capped = overCap(workload, policy.max_tasks_per_agent);
    if (capped) {
      await this.log("task", excludeTaskId, "dispatch_capped", DISPATCHER_AGENT, {
        agent_id: agentId, workload, max: policy.max_tasks_per_agent, trigger,
      });
    }
    const candidates = await this.dispatchCandidates(excludeTaskId);
    const normals: string[] = [];
    let self: { task_id: string; agent_id: string } | null = null;
    for (const taskId of candidates) {
      const meta = await this.taskRouteMeta(taskId);
      if (meta?.type !== "review") {
        normals.push(taskId);
        continue;
      }
      const reviewer = chooseReviewer({
        implementer: meta.review_of ? await this.implementerOf(meta.review_of) : null,
        agents: (await this.knownAgentWorkloads()).filter((a) => !(capped && a.id === agentId)),
        max: policy.max_tasks_per_agent,
        requireDifferentHarness: policy.review.require_different_harness,
        preferStronger: policy.review.prefer_stronger,
        designReview: meta.review_kind === "design",
      });
      if (!reviewer || (self && reviewer === agentId)) continue;
      const claimed = await this.claimTaskAtomic(taskId, reviewer) as { error?: string };
      if (claimed.error) continue;
      await this.sendMessage(reviewer, DISPATCHER_AGENT, nextTaskMessage(taskId), taskId);
      await this.log("task", taskId, "dispatched", DISPATCHER_AGENT, {
        agent_id: reviewer, trigger, from_task: excludeTaskId, review: true,
      });
      if (reviewer === agentId) self = { task_id: taskId, agent_id: agentId };
    }
    if (self || capped) return self;
    for (const taskId of normals) {
      const claimed = await this.claimTaskAtomic(taskId, agentId) as { error?: string };
      if (claimed.error) continue;
      await this.sendMessage(agentId, DISPATCHER_AGENT, nextTaskMessage(taskId), taskId);
      await this.log("task", taskId, "dispatched", DISPATCHER_AGENT, { agent_id: agentId, trigger, from_task: excludeTaskId });
      return { task_id: taskId, agent_id: agentId };
    }
    return null;
  }

  private async agentWorkload(agentId: string) {
    const [row] = await this.sql<[{ n: number }]>`
      SELECT (
        (SELECT COUNT(*)::int FROM claims WHERE agent_id = ${agentId}) +
        (SELECT COUNT(DISTINCT entity_id)::int FROM events
          WHERE entity_type = 'task' AND action = 'completed' AND actor = ${agentId})
      ) AS n`;
    return Number(row?.n ?? 0);
  }

  private async dispatchCandidates(excludeTaskId: string) {
    const now = new Date();
    const rows = await this.sql<{ id: string }[]>`
      SELECT t.id FROM tasks t
      WHERE t.status = 'open' AND t.id <> ${excludeTaskId}
        AND NOT EXISTS (
          SELECT 1 FROM task_dependencies d
          JOIN tasks b ON b.id = d.blocker_id
          WHERE d.task_id = t.id AND b.status <> 'done'
        )
        AND NOT EXISTS (
          SELECT 1 FROM claims c WHERE c.task_id = t.id AND c.lease_expires > ${now}
        )
      ORDER BY t.priority ASC, t.created_at ASC, t.id ASC`;
    return rows.map((row) => row.id);
  }

  private async staleNextTasks(idleMinutes: number) {
    const rows = await this.sql<any[]>`
      SELECT m.id, m.to_agent, m.task_id, m.body FROM messages m
      WHERE m.from_agent = ${DISPATCHER_AGENT}
        AND m.body LIKE 'your next task: %'
        AND m.created_at <= now() - make_interval(mins => ${idleMinutes}::int)
        AND NOT EXISTS (
          SELECT 1 FROM events e
          WHERE e.entity_type = 'message'
            AND e.entity_id = m.id::text
            AND e.action IN ('dispatch_idle', 'reassigned')
        )
      ORDER BY m.id
      FOR UPDATE OF m SKIP LOCKED`;
    return rows.flatMap((row) => {
      const taskId = (row.task_id as string | null) || taskIdFromNextTaskMessage(row.body);
      if (!taskId) return [];
      return [{ messageId: String(row.id), assignee: row.to_agent as string, taskId }];
    });
  }

  private async rawClaim(taskId: string) {
    const [row] = await this.sql<any[]>`
      SELECT t.status AS status, c.agent_id AS claim_agent, c.lease_expires AS lease_expires
      FROM tasks t LEFT JOIN claims c ON c.task_id = t.id WHERE t.id = ${taskId}`;
    if (!row) return null;
    return {
      status: row.status as string,
      claimAgent: (row.claim_agent ?? null) as string | null,
      leaseExpires: row.lease_expires ?? null,
    };
  }

  private async knownAgentWorkloads() {
    const rows = await this.sql<{ id: string }[]>`
      SELECT DISTINCT actor AS id FROM events
      WHERE entity_type = 'task' AND action IN ('claimed', 'completed', 'released')`;
    const out: { id: string; workload: number }[] = [];
    for (const row of rows) {
      if (!row.id || isSystemActor(row.id)) continue;
      out.push({ id: row.id, workload: await this.agentWorkload(row.id) });
    }
    return out;
  }

  async sweepIdleDispatches() {
    const policy = getDispatcherPolicy(loadPolicy());
    if (!policy.enabled) return { reassigned: [] as string[], logged: [] as string[] };
    return this.sql.begin(async sql => {
      const tx = new PgStore(sql as unknown as postgres.Sql);
      return tx.sweepIdleAtomic(policy);
    });
  }

  private async sweepIdleAtomic(policy: DispatcherPolicy) {
    const reassigned: string[] = [];
    const logged: string[] = [];
    for (const row of await this.staleNextTasks(policy.idle_minutes)) {
      const task = await this.rawClaim(row.taskId);
      const mark = async (reason: string, extra: object = {}) => {
        await this.log("message", row.messageId, "dispatch_idle", DISPATCHER_AGENT, {
          task_id: row.taskId, agent_id: row.assignee, reason, ...extra,
        });
        logged.push(row.taskId);
      };
      if (!task) { await mark("missing_task"); continue; }
      if (leaseActive(task.leaseExpires) && task.claimAgent) continue;
      if (task.status !== "open" && task.status !== "claimed") {
        await mark("not_open", { status: task.status });
        continue;
      }
      const meta = await this.taskRouteMeta(row.taskId);
      const next = meta?.type === "review"
        ? chooseReviewer({
          implementer: meta.review_of ? await this.implementerOf(meta.review_of) : null,
          agents: (await this.knownAgentWorkloads()).filter((a) => a.id !== row.assignee),
          max: policy.max_tasks_per_agent,
          requireDifferentHarness: policy.review.require_different_harness,
          preferStronger: policy.review.prefer_stronger,
          designReview: meta.review_kind === "design",
        })
        : chooseReassignAgent({
          assignee: row.assignee,
          agents: await this.knownAgentWorkloads(),
          max: policy.max_tasks_per_agent,
        });
      if (!next) { await mark("no_alternate_agent"); continue; }
      const claimed = await this.claimTaskAtomic(row.taskId, next) as { error?: string };
      if (claimed.error) { await mark("claim_failed", { error: claimed.error }); continue; }
      await this.sendMessage(next, DISPATCHER_AGENT, nextTaskMessage(row.taskId), row.taskId);
      await this.log("message", row.messageId, "reassigned", DISPATCHER_AGENT, {
        task_id: row.taskId, from: row.assignee, to: next,
      });
      await this.log("task", row.taskId, "dispatched", DISPATCHER_AGENT, {
        agent_id: next, trigger: "idle_sweep", from_agent: row.assignee,
      });
      reassigned.push(row.taskId);
    }
    return { reassigned, logged };
  }

  async registerHelper(a: { agent_id: string; path: string; symbol?: string; kind: string; summary: string }) {
    const id = `hlp-${randomUUID().slice(0, 8)}`;
    await this.sql`INSERT INTO helpers (id, agent_id, path, symbol, kind, summary) VALUES (${id},${a.agent_id},${a.path},${a.symbol ?? ""},${a.kind},${a.summary})
      ON CONFLICT(path, symbol) DO UPDATE SET summary=EXCLUDED.summary, agent_id=EXCLUDED.agent_id`;
    await this.log("helper", id, "registered", a.agent_id, a);
    return { id };
  }

  async searchContext(query: string, kinds?: string[]) {
    const want = new Set(kinds?.length ? kinds : ["helper", "artifact"]);
    const q = query.trim().split(/\s+/).map((w) => w.replace(/[^\w]/g, "")).filter(Boolean).join(" & ");
    if (!q) return [];
    const out: any[] = [];
    if (want.has("helper")) {
      out.push(...await this.sql`
        SELECT 'helper' AS entity_type, id AS entity_id, coalesce(nullif(symbol,''), path) AS title,
               summary AS snippet FROM helpers
        WHERE to_tsvector('english', path || ' ' || symbol || ' ' || summary) @@ to_tsquery('english', ${q})
        LIMIT 15`);
    }
    if (want.has("artifact")) {
      out.push(...await this.sql`
        SELECT 'artifact' AS entity_type, id AS entity_id, title,
               left(content, 200) AS snippet FROM artifacts
        WHERE to_tsvector('english', title || ' ' || content) @@ to_tsquery('english', ${q})
        LIMIT 15`);
    }
    if (want.has("evidence")) {
      out.push(...await this.sql`
        SELECT 'evidence' AS entity_type, id AS entity_id, kind AS title,
               left(output, 200) AS snippet FROM evidence
        WHERE to_tsvector('english', kind || ' ' || output) @@ to_tsquery('english', ${q})
        LIMIT 15`);
    }
    return out;
  }

  async submitJob(a: SubmitJobArgs) {
    if (a.type === "agent" ? !a.agent?.executable || !a.agent.prompt : !a.command)
      return { error: "command required, or executable and prompt for agent jobs" };
    const id = `job-${randomUUID().slice(0, 8)}`;
    await this.sql`INSERT INTO jobs (id,task_id,agent_id,type,command,host,target_agent_id,agent_spec)
      VALUES (${id},${a.task_id ?? null},${a.agent_id},${a.type},${a.command ?? ""},${a.host ?? null},
      ${a.target_agent_id ?? null},${a.agent ? JSON.stringify(a.agent) : null})`;
    await this.log("job", id, "submitted", a.agent_id, a);
    return { id, status: "queued" };
  }

  async nextJob(agentId: string, host?: string, ttlSeconds = 60) {
    const expires = new Date(Date.now() + Math.max(1, ttlSeconds) * 1000);
    const [job] = await this.sql<any[]>`
      UPDATE jobs SET status='running', started_at=now(), finished_at=NULL, result='',
      runner_id=${agentId}, lease_token=${randomUUID()}, lease_expires=${expires}
      WHERE id = (SELECT id FROM jobs WHERE (status='queued' OR (status='running' AND lease_expires<=now()))
      AND (host IS NULL OR host=${host ?? null}) AND (target_agent_id IS NULL OR target_agent_id=${agentId})
      ORDER BY created_at,id LIMIT 1 FOR UPDATE SKIP LOCKED) RETURNING *`;
    if (!job) return null;
    await this.log("job", job.id, "started", agentId, { host, lease_expires: expires });
    return job;
  }

  async renewJob(jobId: string, agentId: string, token: string, ttlSeconds = 60, result?: string) {
    const expires = new Date(Date.now() + Math.max(1, ttlSeconds) * 1000);
    const [job] = await this.sql`UPDATE jobs SET lease_expires=${expires}, result=COALESCE(${result?.slice(-64000) ?? null},result)
      WHERE id=${jobId} AND status='running' AND runner_id=${agentId} AND lease_token=${token}
      AND lease_expires>now() RETURNING id`;
    if (!job) return { error: "job lease not owned or expired" };
    await this.log("job", jobId, "renewed", agentId);
    return { id: jobId, lease_expires: expires.toISOString() };
  }

  async finishJob(jobId: string, status: "done" | "failed", result: string, agentId: string, token: string) {
    const [job] = await this.sql`UPDATE jobs SET status=${status}, result=${result.slice(-64000)},
      finished_at=now(), lease_expires=NULL WHERE id=${jobId} AND status='running'
      AND runner_id=${agentId} AND lease_token=${token} AND lease_expires>now() RETURNING *`;
    if (!job) return { error: "job lease not owned or expired" };
    await this.log("job", jobId, status, agentId, { result: result.slice(0, 500) });
    if (job.task_id) await this.notifyWatchers(job.task_id, `job ${jobId} (${job.type}) → ${status}`);
    return { id: jobId, status };
  }

  async getJob(id: string) {
    const [job] = await this.sql<any[]>`SELECT * FROM jobs WHERE id=${id}`;
    return job ?? null;
  }

  async board() {
    const tasks = await this.sql`
      SELECT t.id, t.title, t.status, t.priority, c.agent_id AS claimed_by, c.lease_expires,
             (SELECT COUNT(*)::int FROM artifacts a WHERE a.task_id = t.id AND a.kind = 'blocked') AS blocked_artifacts
      FROM tasks t LEFT JOIN claims c ON c.task_id = t.id ORDER BY t.priority, t.created_at`;
    const job_counts = await this.sql`SELECT status, COUNT(*)::int AS n FROM jobs GROUP BY status`;
    const [{ n }] = await this.sql<[{ n: number }]>`SELECT COUNT(*)::int AS n FROM helpers`;
    return { tasks: await Promise.all(tasks.map(async t => ({ ...t, ...await this.dependencies(t.id, t.status) }))), job_counts, helpers_registered: n };
  }

  async digest(sinceOrArgs?: string | DigestArgs): Promise<DigestResult> {
    const args = normalizeDigestArgs(sinceOrArgs);
    const board = await this.board();
    const events = await this.sql`SELECT * FROM events ORDER BY id ASC`;
    const built = buildDigest({
      since: args.since,
      tasks: board.tasks,
      events,
    });
    const recipient = (args.to_agent ?? args.to)?.trim() || null;
    if (recipient) {
      await this.sendMessage(recipient, args.from_agent ?? "underwright", built.summary);
    }
    return { ...built, sent_to: recipient };
  }

  async sendMessage(to: string, from: string, body: string, taskId?: string) {
    await this.sql`INSERT INTO messages (to_agent, from_agent, task_id, body) VALUES (${to},${from},${taskId ?? null},${body})`;
    await this.log("message", to, "sent", from, { task_id: taskId });
    return { sent: to };
  }

  async inbox(agentId: string, unreadOnly = true) {
    const rows = unreadOnly
      ? await this.sql`SELECT * FROM messages WHERE to_agent=${agentId} AND NOT read ORDER BY id`
      : await this.sql`SELECT * FROM messages WHERE to_agent=${agentId} ORDER BY id`;
    await this.sql`UPDATE messages SET read=true WHERE to_agent=${agentId} AND NOT read`;
    return rows;
  }

  async watchTask(agentId: string, taskId: string) {
    await this.sql`INSERT INTO watches (agent_id, task_id) VALUES (${agentId},${taskId}) ON CONFLICT DO NOTHING`;
    await this.log("watch", taskId, "watching", agentId);
    return { watching: taskId };
  }

  async notifyWatchers(taskId: string, body: string) {
    const watchers = await this.sql`SELECT agent_id FROM watches WHERE task_id=${taskId}`;
    for (const w of watchers as any[]) {
      await this.sql`INSERT INTO messages (to_agent, from_agent, task_id, body) VALUES (${w.agent_id},'underwright',${taskId},${body})`;
    }
  }

  /** Everything the read-only web dashboard needs in one round trip. */
  async dashboard(eventsLimit = 25) {
    const locks = await this.sql`SELECT * FROM locks WHERE lease_expires > now() ORDER BY resource`;
    const jobs = await this.sql`SELECT * FROM jobs WHERE status IN ('queued','running') ORDER BY created_at DESC`;
    return { ...await this.board(), locks, jobs, events: await this.auditLog(eventsLimit) };
  }

  async auditLog(limit = 50) {
    return this.sql`SELECT * FROM events ORDER BY id DESC LIMIT ${limit}`;
  }

  async close() {
    await this.sql.end();
  }
}
