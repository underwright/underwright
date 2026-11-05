import postgres from "postgres";
import { randomUUID } from "node:crypto";
import { loadPolicy, evaluateDoD, evaluateDoR } from "./policy.js";
import type { IStore, TaskStatus, CreateTaskArgs } from "./istore.js";

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
  status      TEXT NOT NULL DEFAULT 'open'
              CHECK (status IN ('open','claimed','in_review','done','blocked')),
  priority    INT NOT NULL DEFAULT 2,
  ownership   JSONB NOT NULL DEFAULT '{}',
  created_by  TEXT NOT NULL DEFAULT 'human',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
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
  kind       TEXT NOT NULL CHECK (kind IN ('spec','design','handoff','note','review')),
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
    await sql`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS type TEXT NOT NULL DEFAULT 'feature'`;
    await sql`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS severity TEXT NOT NULL DEFAULT 'normal'`;
    await sql`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS estimate TEXT NOT NULL DEFAULT ''`;
    return new PgStore(sql);
  }

  private async log(entityType: string, entityId: string, action: string, actor: string, data: unknown = {}) {
    await this.sql`INSERT INTO events (entity_type, entity_id, action, actor, data) VALUES (${entityType},${entityId},${action},${actor},${this.sql.json(data as any)})`;
  }

  async createTask(a: CreateTaskArgs) {
    const id = a.id ?? `task-${randomUUID().slice(0, 8)}`;
    await this.sql`
      INSERT INTO tasks (id, title, description, spec_ref, ac_ids, priority, ownership, created_by, type, severity, estimate)
      VALUES (${id},${a.title},${a.description ?? ""},${a.spec_ref ?? null},
              ${this.sql.json(a.ac_ids ?? [])},${a.priority ?? 2},
              ${this.sql.json(a.ownership ?? {})},${a.created_by ?? "human"},${a.type ?? "feature"},
              ${a.severity ?? "normal"},${a.estimate ?? ""})`;
    await this.log("task", id, "created", a.created_by ?? "human", a);
    return this.getTask(id);
  }

  async getTask(id: string) {
    const [t] = await this.sql<any[]>`SELECT * FROM tasks WHERE id = ${id}`;
    if (!t) return null;
    const [claim] = await this.sql<any[]>`SELECT * FROM claims WHERE task_id = ${id}`;
    return { ...t, claim: claim ?? null };
  }

  async setTaskStatus(id: string, status: TaskStatus, actor: string) {
    const t = await this.getTask(id);
    if (!t) return { error: `task ${id} not found` };
    if (t.status === status) return { id, status };
    await this.sql`UPDATE tasks SET status=${status}, updated_at=now() WHERE id=${id}`;
    await this.log("task", id, `status:${status}`, actor);
    await this.notifyWatchers(id, `task ${id} → ${status}`);
    return { id, status };
  }

  async updateTask(id: string, patch: Partial<CreateTaskArgs>, actor: string) {
    const t = await this.getTask(id);
    if (!t) return { error: `task ${id} not found` };
    const sets: string[] = [];
    const vals: any[] = [];
    for (const k of ["title", "description", "spec_ref", "type", "severity", "estimate"] as const) {
      if (patch[k] !== undefined) { sets.push(`${k}=$${vals.length + 2}`); vals.push(patch[k]); }
    }
    if (patch.ac_ids !== undefined) { sets.push(`ac_ids=$${vals.length + 2}`); vals.push(JSON.stringify(patch.ac_ids)); }
    if (!sets.length) return { id, unchanged: true };
    await this.sql.unsafe(`UPDATE tasks SET ${sets.join(",")}, updated_at=now() WHERE id=$1`, [id, ...vals]);
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
    return status
      ? this.sql`SELECT id, title, status, priority FROM tasks WHERE status=${status} ORDER BY priority, created_at`
      : this.sql`SELECT id, title, status, priority FROM tasks ORDER BY priority, created_at`;
  }

  async claimTask(taskId: string, agentId: string, ttlSeconds = 1800, scope: object = {}) {
    const task = await this.getTask(taskId);
    if (!task) return { error: `task ${taskId} not found` };
    if (task.status === "done") return { error: `task ${taskId} is already done` };
    const claim = task.claim;
    if (claim && new Date(claim.lease_expires) > new Date() && claim.agent_id !== agentId) {
      return { error: `task ${taskId} is claimed by ${claim.agent_id} until ${claim.lease_expires}` };
    }

    const dor = evaluateDoR(task, loadPolicy());
    if (!dor.ready) {
      return { error: `task ${taskId} is not ready to claim: ${dor.missing.join("; ")}. Triage it first (update_task).` };
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
    const [claim] = await this.sql<any[]>`SELECT agent_id FROM claims WHERE task_id=${taskId}`;
    if (!claim) return { error: `task ${taskId} is not claimed` };
    if (claim.agent_id !== agentId) return { error: `task ${taskId} is claimed by ${claim.agent_id}` };
    await this.sql`DELETE FROM claims WHERE task_id=${taskId}`;
    await this.sql`UPDATE tasks SET status='open', updated_at=now() WHERE id=${taskId}`;
    await this.log("task", taskId, "released", agentId);
    return { released: taskId };
  }

  async renewLease(taskId: string, agentId: string, ttlSeconds = 1800) {
    const [claim] = await this.sql<any[]>`SELECT agent_id FROM claims WHERE task_id=${taskId}`;
    if (!claim || claim.agent_id !== agentId) return { error: `task ${taskId} not claimed by ${agentId}` };
    const expires = new Date(Date.now() + ttlSeconds * 1000);
    await this.sql`UPDATE claims SET lease_expires=${expires} WHERE task_id=${taskId}`;
    return { task_id: taskId, lease_expires: expires.toISOString() };
  }

  async sweepExpiredClaims() {
    return this.sql.begin(async sql => {
      // DELETE locks the expired rows: a concurrent renewal/reclaim is checked
      // before deletion, and another sweeper cannot publish the same expiry.
      const expired = await sql`DELETE FROM claims WHERE lease_expires <= now() RETURNING *`;
      for (const claim of expired) {
        const reopened = await sql`
          UPDATE tasks SET status='open', updated_at=now()
          WHERE id=${claim.task_id} AND status='claimed' RETURNING id`;
        await sql`
          INSERT INTO events (entity_type, entity_id, action, actor, data)
          VALUES ('task',${claim.task_id},'lease_expired','lease-sweeper',
            ${sql.json({ agent_id: claim.agent_id, lease_expires: claim.lease_expires, reopened: reopened.length > 0 })})`;
        const body = `task ${claim.task_id} lease expired (${claim.agent_id})${reopened.length ? " → open" : ""}`;
        await sql`
          INSERT INTO messages (to_agent, from_agent, task_id, body)
          SELECT agent_id, 'underwright', task_id, ${body} FROM watches WHERE task_id=${claim.task_id}`;
      }
      return { reclaimed: expired.map(claim => claim.task_id as string) };
    });
  }

  async postArtifact(a: { task_id?: string; agent_id: string; kind: string; title?: string; content: string }) {
    const id = `art-${randomUUID().slice(0, 8)}`;
    await this.sql`INSERT INTO artifacts (id, task_id, agent_id, kind, title, content)
      VALUES (${id},${a.task_id ?? null},${a.agent_id},${a.kind},${a.title ?? ""},${a.content})`;
    await this.log("artifact", id, "posted", a.agent_id, { task_id: a.task_id, kind: a.kind });
    return { id };
  }

  async reportEvidence(a: { task_id: string; agent_id: string; kind: string; command?: string; exit_code?: number; output?: string; ac_ids?: string[] }) {
    if (!EVIDENCE_KINDS.includes(a.kind)) return { error: `unknown evidence kind ${a.kind}` };
    const id = `ev-${randomUUID().slice(0, 8)}`;
    await this.sql`INSERT INTO evidence (id, task_id, agent_id, kind, command, exit_code, output, ac_ids)
      VALUES (${id},${a.task_id},${a.agent_id},${a.kind},${a.command ?? ""},${a.exit_code ?? null},${a.output ?? ""},${this.sql.json(a.ac_ids ?? [])})`;
    await this.log("evidence", id, "reported", a.agent_id, { task_id: a.task_id, kind: a.kind });
    return { id };
  }

  async listArtifacts(taskId: string) {
    return this.sql`SELECT * FROM artifacts WHERE task_id=${taskId} ORDER BY created_at`;
  }

  async getEvidence(taskId: string) {
    return this.sql`SELECT * FROM evidence WHERE task_id=${taskId} ORDER BY created_at`;
  }

  async completeTask(taskId: string, agentId: string) {
    const task = await this.getTask(taskId);
    if (!task) return { error: `task ${taskId} not found` };
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
    return { completed: taskId, ...(dod.missing.length ? { warnings: dod.missing } : {}) };
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

  async submitJob(a: { task_id?: string; agent_id: string; type: string; command: string }) {
    const id = `job-${randomUUID().slice(0, 8)}`;
    await this.sql`INSERT INTO jobs (id, task_id, agent_id, type, command) VALUES (${id},${a.task_id ?? null},${a.agent_id},${a.type},${a.command})`;
    await this.log("job", id, "submitted", a.agent_id, a);
    return { id, status: "queued" };
  }

  async nextJob(agentId?: string) {
    const [job] = await this.sql<any[]>`
      UPDATE jobs SET status='running', started_at=now()
      WHERE id = (SELECT id FROM jobs WHERE status='queued' ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED)
      RETURNING *`;
    if (!job) return null;
    await this.log("job", job.id, "started", agentId ?? "runner");
    return job;
  }

  async finishJob(jobId: string, status: "done" | "failed", result: string) {
    await this.sql`UPDATE jobs SET status=${status}, result=${result}, finished_at=now() WHERE id=${jobId}`;
    await this.log("job", jobId, status, "runner", { result: result.slice(0, 500) });
    const job = await this.getJob(jobId);
    if (job?.task_id) await this.notifyWatchers(job.task_id, `job ${jobId} (${job.type}) → ${status}`);
    return { id: jobId, status };
  }

  async getJob(id: string) {
    const [job] = await this.sql<any[]>`SELECT * FROM jobs WHERE id=${id}`;
    return job ?? null;
  }

  async board() {
    const tasks = await this.sql`
      SELECT t.id, t.title, t.status, t.priority, c.agent_id AS claimed_by, c.lease_expires
      FROM tasks t LEFT JOIN claims c ON c.task_id = t.id ORDER BY t.priority, t.created_at`;
    const job_counts = await this.sql`SELECT status, COUNT(*)::int AS n FROM jobs GROUP BY status`;
    const [{ n }] = await this.sql<[{ n: number }]>`SELECT COUNT(*)::int AS n FROM helpers`;
    return { tasks, job_counts, helpers_registered: n };
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

  private async notifyWatchers(taskId: string, body: string) {
    const watchers = await this.sql`SELECT agent_id FROM watches WHERE task_id=${taskId}`;
    for (const w of watchers as any[]) {
      await this.sql`INSERT INTO messages (to_agent, from_agent, task_id, body) VALUES (${w.agent_id},'underwright',${taskId},${body})`;
    }
  }

  async auditLog(limit = 50) {
    return this.sql`SELECT * FROM events ORDER BY id DESC LIMIT ${limit}`;
  }

  async close() {
    await this.sql.end();
  }
}
