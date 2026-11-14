import { nodeEnrollmentSchema, nodePolicySchema, nodeHash, nodeSecret, nodeExpiry, nodeError, NODE_SCOPES, NODE_LEASE_SECONDS, NODE_POLL_MAX_WAIT, nodeSpecSchema, nodeInventorySchema, boundNodeResult, nodeReceiptDigest, publicNodeJob, projectNode, sleepSignal, nodeSpecAllowed, quotaAllows, selectNode, type NodeCandidate, type NodeEnrollmentInput, type NodePolicy, type NodePrincipal, type NodeError } from "./node-protocol.js";
import { NODES_SCHEMA } from "./schema.js";
import postgres from "postgres";
import { TASK_DEPENDENCIES_SCHEMA, PG_JOBS_MIGRATION, PG_ARTIFACTS_MIGRATION, ARTIFACT_KIND_SQL, isArtifactKind, LEDGER_STATUSES, LEDGER_SCHEMA } from "./schema.js";
import { randomUUID } from "node:crypto";
import { loadPolicy, evaluateDoD, evaluateDoR, expandTemplate, listTemplates as allTemplates, getDispatcherPolicy, type DispatcherPolicy } from "./policy.js";
import { parseCoverage } from "./coverage.js";
import { chooseReassignAgent, chooseReviewer, DISPATCHER_AGENT, implementerFromRecords, isSystemActor, leaseActive, linkedReviewArgs, nextTaskMessage, overCap, reviewIndependenceError, taskIdFromNextTaskMessage } from "./dispatcher.js";
import { buildDigest, normalizeDigestArgs, sendHumanNotification } from "./digest.js";
import { importSpecKit, type ImportSpecKitArgs } from "./speckit.js";
import type { IStore, TaskStatus, CreateTaskArgs, SubmitJobArgs, SubmitNodeTaskArgs, DigestArgs, DigestResult } from "./istore.js";

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

  private async nodeTransaction(work: (s: PgStore) => Promise<any>): Promise<any> {
    return this.sql.begin(async sql => {
      // Serialize enrollment quotas and auth transitions across control-plane replicas.
      await sql.unsafe('LOCK TABLE node_enrollments, nodes, node_tokens, node_workers, node_rate_limits, task_dependencies IN SHARE ROW EXCLUSIVE MODE');
      return work(new PgStore(sql as unknown as postgres.Sql));
    });
  }

  private async nodeQuery(query: string, params: any[] = []): Promise<any[]> {
    let i = 0;
    return this.sql.unsafe(query.replace(/\?/g, () => `$${++i}`), params) as any;
  }

  private async nodeAudit(id: string, action: string, actor = 'node-protocol') {
    await this.log('node', id, action, actor);
  }

  private async nodeRate(bucket: string, limit: number): Promise<boolean> {
    const now = new Date().toISOString();
    const cutoff = new Date(Date.now() - 60000).toISOString();
    await this.nodeQuery('DELETE FROM node_rate_limits WHERE window_start < ?', [cutoff]);
    const rows = await this.nodeQuery(`INSERT INTO node_rate_limits(bucket,window_start,attempts) VALUES (?,?,1)
      ON CONFLICT(bucket) DO UPDATE SET attempts=node_rate_limits.attempts+1 RETURNING attempts`, [bucket, now]);
    return rows[0].attempts <= limit;
  }

  async createNodeEnrollment(input: NodeEnrollmentInput): Promise<any> {
    const parsed = nodeEnrollmentSchema.safeParse(input);
    if (!parsed.success) return nodeError('invalid enrollment', 400);
    return this.nodeTransaction(async s => {
      const now = new Date().toISOString();
      await s.nodeQuery('DELETE FROM node_enrollments WHERE expires_at < ?', [new Date(Date.now() - 86400000).toISOString()]);
      await s.nodeQuery('DELETE FROM node_tokens WHERE expires_at < ?', [new Date(Date.now() - 86400000).toISOString()]);
      const count = await s.nodeQuery('SELECT COUNT(*) AS n FROM node_enrollments WHERE expires_at > ?', [now]);
      if (!await s.nodeRate('enrollment-create', 30) || Number(count[0].n) >= 100) return nodeError('enrollment limit reached', 429);
      const id = 'enroll-' + randomUUID();
      const code = nodeSecret().slice(0, 16).toUpperCase();
      const expires = nodeExpiry(600);
      const { device_secret_hash, ...metadata } = parsed.data;
      await s.nodeQuery(`INSERT INTO node_enrollments(id,code_hash,device_secret_hash,metadata_json,status,expires_at)
        VALUES (?,?,?,?,'pending',?)`, [id, nodeHash(code), device_secret_hash, JSON.stringify(metadata), expires]);
      await s.nodeAudit(id, 'enrollment_created');
      return { id, code, expires_at: expires, retry_after: 3 };
    });
  }

  async listNodeEnrollments(): Promise<any[]> {
    return this.nodeQuery(`SELECT id,metadata_json,status,expires_at,approved_by,approved_at,node_id,redeemed_at
      FROM node_enrollments ORDER BY expires_at DESC LIMIT 100`);
  }

  async approveNodeEnrollment(id: string, code: string, policy: NodePolicy, actor: string): Promise<any> {
    const parsed = nodePolicySchema.safeParse(policy);
    if (!parsed.success) return nodeError('invalid node policy', 400);
    return this.nodeTransaction(async s => {
      if (!await s.nodeRate('enrollment-approve', 60)) return nodeError('approval limit reached', 429);
      const e = (await s.nodeQuery('SELECT * FROM node_enrollments WHERE id=?', [id]))[0];
      if (!e || e.status !== 'pending' || e.expires_at <= new Date().toISOString() || nodeHash(code) !== e.code_hash) {
        await s.nodeAudit('enrollment', 'approval_denied', actor);
        return nodeError('enrollment unavailable', 409);
      }
      const node_id = 'node-' + randomUUID();
      const now = new Date().toISOString();
      await s.nodeQuery(`INSERT INTO nodes(id,name,state,policy_json,created_at) VALUES (?,?,'approved',?,?)`,
        [node_id, JSON.parse(e.metadata_json).name, JSON.stringify(parsed.data), now]);
      await s.nodeQuery(`UPDATE node_enrollments SET status='approved',approved_by=?,approved_at=?,node_id=? WHERE id=?`, [actor, now, node_id, id]);
      await s.nodeAudit(node_id, 'enrollment_approved', actor);
      return { node_id, status: 'approved' };
    });
  }

  async rejectNodeEnrollment(id: string, actor: string): Promise<any> {
    return this.nodeTransaction(async s => {
      const rows = await s.nodeQuery(`UPDATE node_enrollments SET status='rejected' WHERE id=? AND status='pending' RETURNING id`, [id]);
      await s.nodeAudit(rows.length ? id : 'enrollment', rows.length ? 'enrollment_rejected' : 'rejection_denied', actor);
      return rows.length ? { id, status: 'rejected' } : nodeError('enrollment unavailable', 409);
    });
  }

  async exchangeNodeEnrollment(id: string, secret: string): Promise<any> {
    return this.nodeTransaction(async s => {
      if (!await s.nodeRate('enrollment-exchange', 240)) return nodeError('exchange limit reached', 429);
      const e = (await s.nodeQuery('SELECT * FROM node_enrollments WHERE id=?', [id]))[0];
      if (!e || e.expires_at <= new Date().toISOString() || nodeHash(secret) !== e.device_secret_hash || !['pending','approved'].includes(e.status)) {
        await s.nodeAudit('enrollment', 'exchange_denied');
        return nodeError('enrollment unavailable; revoke and reenroll if response was lost', 409);
      }
      if (e.status === 'pending') return { status: 'pending', retry_after: 3 };
      const node = (await s.nodeQuery("SELECT id FROM nodes WHERE id=? AND state='approved'", [e.node_id]))[0];
      if (!node) return nodeError();
      const token = 'uw_node_' + nodeSecret();
      const expires_at = nodeExpiry(30 * 86400);
      const token_id = 'nt-' + randomUUID();
      await s.nodeQuery('INSERT INTO node_tokens(id,node_id,secret_hash,scopes_json,expires_at) VALUES (?,?,?,?,?)',
        [token_id, e.node_id, nodeHash(token), JSON.stringify(NODE_SCOPES), expires_at]);
      await s.nodeQuery("UPDATE node_enrollments SET status='redeemed',redeemed_at=? WHERE id=?", [new Date().toISOString(), id]);
      await s.nodeAudit(e.node_id, 'credential_issued');
      return { node_id: e.node_id, token, token_id, expires_at };
    });
  }

  async listNodes(): Promise<any[]> {
    const now = Date.now();
    const rows = await this.nodeQuery(`SELECT n.id,n.name,n.state,n.policy_json,n.created_at,n.last_seen_at,n.session_expires_at,
      n.capabilities_json,n.capabilities_version,n.capabilities_observed_at,
      (SELECT id FROM jobs j WHERE j.type='node' AND j.target_node_id=n.id AND j.status='running' LIMIT 1) AS current_job_id
      FROM nodes n ORDER BY n.created_at DESC LIMIT 1000`);
    return rows.map(row => projectNode(row, now));
  }

  async revokeNode(id: string, actor: string): Promise<any> {
    return this.nodeTransaction(async s => {
      const rows = await s.nodeQuery("UPDATE nodes SET state='revoked',session_epoch=NULL,session_expires_at=NULL WHERE id=? RETURNING id", [id]);
      if (!rows.length) return nodeError('node unavailable', 404);
      await s.nodeQuery('UPDATE node_tokens SET revoked_at=? WHERE node_id=? AND revoked_at IS NULL', [new Date().toISOString(), id]);
      await s.nodeAudit(id, 'revoked', actor);
      return { node_id: id, state: 'revoked' };
    });
  }

  async authenticateNode(token: string, sessionId?: string): Promise<NodePrincipal | NodeError> {
    if (!/^uw_node_[a-f0-9]{64}$/.test(token)) return nodeError();
    const rows = await this.nodeQuery(`SELECT t.id AS token_id,t.node_id,t.expires_at,n.session_epoch,n.session_expires_at,n.policy_json
      FROM node_tokens t JOIN nodes n ON n.id=t.node_id
      WHERE t.secret_hash=? AND t.revoked_at IS NULL AND t.expires_at>? AND n.state IN ('approved','draining')`, [nodeHash(token), new Date().toISOString()]);
    const r = rows[0];
    if (!r || (sessionId !== undefined && (r.session_epoch !== sessionId || r.session_expires_at <= new Date().toISOString()))) {
      await this.nodeAudit('credential', 'authorization_denied');
      return nodeError();
    }
    return { node_id: r.node_id, token_id: r.token_id, expires_at: r.expires_at, session_id: r.session_epoch, policy: JSON.parse(r.policy_json) };
  }

  async startNodeSession(token: string): Promise<any> {
    return this.nodeTransaction(async s => {
      const principal = await s.authenticateNode(token);
      if ('error' in principal) return principal;
      const session_id = randomUUID();
      const expires_at = nodeExpiry(3600);
      await s.nodeQuery('UPDATE nodes SET session_epoch=?,session_expires_at=? WHERE id=?', [session_id, expires_at, principal.node_id]);
      await s.nodeAudit(principal.node_id, 'session_started');
      return { policy: principal.policy, node_id: principal.node_id, session_id, expires_at, server_time: new Date().toISOString(), heartbeat_seconds: 15, lease_seconds: NODE_LEASE_SECONDS };
    });
  }

  private nodePolicyAllows(policy: NodePolicy, spec: { kind: string; workspace_id?: string; payload?: Record<string, unknown> }, capabilitiesJson?: string, observedAt?: unknown) {
    return nodeSpecAllowed(policy, spec, capabilitiesJson, observedAt);
  }

  async submitNodeTask(args: SubmitNodeTaskArgs) {
    const parsed = nodeSpecSchema.safeParse(args.node_spec);
    if (!parsed.success) return nodeError("invalid node_spec", 400);
    const spec = parsed.data;
    return this.sql.begin(async sql => {
      const s = new PgStore(sql as unknown as postgres.Sql);
      await sql.unsafe('LOCK TABLE jobs IN SHARE ROW EXCLUSIVE MODE');
      const targetId = args.target_node_id ?? selectNode(
        (await s.nodeQuery("SELECT id,policy_json,capabilities_json,capabilities_observed_at,last_seen_at FROM nodes WHERE state='approved'"))
          .map((n: any) => ({ ...n, policy_json: typeof n.policy_json === "string" ? n.policy_json : JSON.stringify(n.policy_json), capabilities_json: typeof n.capabilities_json === "string" ? n.capabilities_json : JSON.stringify(n.capabilities_json ?? {}) })) as NodeCandidate[],
        spec,
      );
      if (!targetId) return nodeError(args.target_node_id ? "node unavailable" : "no capable node", 404);
      const node = (await s.nodeQuery("SELECT * FROM nodes WHERE id=? AND state='approved'", [targetId]))[0];
      if (!node) return nodeError("node unavailable", 404);
      const policy = typeof node.policy_json === "string" ? JSON.parse(node.policy_json) : node.policy_json;
      const capabilities = typeof node.capabilities_json === "string" ? node.capabilities_json : JSON.stringify(node.capabilities_json ?? {});
      if (!s.nodePolicyAllows(policy, spec, capabilities, node.capabilities_observed_at)) return nodeError(spec.kind === "launch-agent" ? "launch requires fresh ready capability and approved policy" : "operation not permitted", 403);
      if (spec.kind === 'launch-agent') {
        const inventory = JSON.parse(node.capabilities_json || '{}');
        const harness = inventory.harnesses?.find((h: any) => h.id === spec.payload.harness);
        if (!args.task_id || !args.agent_id || !spec.workspace_id || spec.payload.workspace_id !== spec.workspace_id ||
            !node.capabilities_observed_at || Date.now() - Date.parse(String(node.capabilities_observed_at)) > 120000 ||
            !harness?.installed || harness.auth_status !== 'ready' || !quotaAllows(harness.quota)) return nodeError('launch requires task, agent and fresh ready harness capability', 403);
        const reserved = (await s.nodeQuery("SELECT * FROM jobs WHERE type='node' AND task_id=? AND agent_id=? AND status IN ('queued','running') AND dedupe_key LIKE 'launch:%'", [args.task_id, args.agent_id]))[0];
        if (reserved) return { ...publicNodeJob(reserved), deduped: true };
      }
      if (args.retry_of) {
        const prior = (await s.nodeQuery("SELECT id FROM jobs WHERE id=? AND type='node'", [args.retry_of]))[0];
        if (!prior) return nodeError("retry_of not found", 404);
      }
      const dedupe = spec.kind === 'launch-agent' ? 'launch:' + nodeHash(args.task_id + ':' + args.agent_id) : args.dedupe_key ?? spec.idempotency_key ?? null;
      if (dedupe) {
        const existing = (await s.nodeQuery(
          "SELECT * FROM jobs WHERE target_node_id=? AND dedupe_key=? AND status IN ('queued','running')",
          [targetId, dedupe],
        ))[0];
        if (existing) return { ...publicNodeJob(existing), deduped: true };
      }
      const id = `job-${randomUUID().slice(0, 8)}`;
      try {
        await s.nodeQuery(
          `INSERT INTO jobs (id,task_id,agent_id,type,command,target_node_id,node_spec,dedupe_key,retry_of)
           VALUES (?,?,?,'node','',?,?,?,?)`,
          [id, args.task_id ?? null, args.agent_id ?? "admin", targetId, JSON.stringify(spec), dedupe, args.retry_of ?? null],
        );
      } catch (error: any) {
        if (error?.code === "23505") {
          const existing = (await s.nodeQuery(
            "SELECT * FROM jobs WHERE target_node_id=? AND dedupe_key=? AND status IN ('queued','running')",
            [targetId, dedupe],
          ))[0];
          if (existing) return { ...publicNodeJob(existing), deduped: true };
        }
        throw error;
      }
      await s.log("job", id, "submitted", args.agent_id ?? "admin", { type: "node", target_node_id: targetId, kind: spec.kind, retry_of: args.retry_of ?? null });
      return { id, status: "queued", target_node_id: targetId };
    });
  }

  async issueNodeWorker(token: string, sessionId: string, jobId: string, leaseToken: string) {
    return this.nodeTransaction(async s => {
      const principal = await s.authenticateNode(token, sessionId);
      if ('error' in principal) return principal;
      const job = (await s.nodeQuery("SELECT * FROM jobs WHERE id=? AND target_node_id=? AND status='running' AND session_id=? AND lease_token=? AND lease_expires>?", [jobId, principal.node_id, sessionId, leaseToken, new Date().toISOString()]))[0];
      if (!job || !job.task_id || JSON.parse(job.node_spec).kind !== 'launch-agent') return nodeError('worker requires a live task launch', 403);
      const worker = 'uw_worker_' + nodeSecret();
      await s.nodeQuery('DELETE FROM node_workers WHERE job_id=?', [jobId]);
      await s.nodeQuery('INSERT INTO node_workers(secret_hash,node_id,token_id,session_id,task_id,agent_id,job_id,attempt_id) VALUES (?,?,?,?,?,?,?,?)', [nodeHash(worker), principal.node_id, principal.token_id, sessionId, job.task_id, job.agent_id, jobId, job.attempt_id]);
      await s.log('job', jobId, 'worker_issued', principal.node_id, { attempt_id: job.attempt_id });
      return { token: worker, task_id: job.task_id, agent_id: job.agent_id, job_id: jobId, attempt_id: job.attempt_id };
    });
  }

  async workerTool(token: string, name: string, args: Record<string, unknown>) {
    if (!/^uw_worker_[a-f0-9]{64}$/.test(token)) return nodeError();
    return this.nodeTransaction(async s => {
      const now = new Date().toISOString();
      const w = (await s.nodeQuery(`SELECT w.* FROM node_workers w
        JOIN jobs j ON j.id=w.job_id AND j.attempt_id=w.attempt_id AND j.session_id=w.session_id
        AND j.task_id=w.task_id AND j.agent_id=w.agent_id AND j.target_node_id=w.node_id AND j.type='node'
        JOIN nodes n ON n.id=w.node_id AND n.session_epoch=w.session_id
        JOIN node_tokens t ON t.id=w.token_id
        WHERE w.secret_hash=? AND j.status='running' AND j.lease_expires>?
        AND n.state IN ('approved','draining') AND n.session_expires_at>?
        AND t.revoked_at IS NULL AND t.expires_at>?`, [nodeHash(token), now, now, now]))[0];
      if (!w) return nodeError();
      if ((args.task_id !== undefined && args.task_id !== w.task_id) || (args.agent_id !== undefined && args.agent_id !== w.agent_id)) return nodeError('worker scope mismatch', 403);
      const task = await s.getTask(w.task_id);
      switch (name) {
        case 'get_task': return task;
        case 'board': return { tasks: task ? [task] : [] };
        case 'get_evidence': return s.getEvidence(w.task_id);
        case 'list_artifacts': return s.listArtifacts(w.task_id);
        case 'claim_task': return s.claimTaskAtomic(w.task_id, w.agent_id, 1800);
        case 'renew_lease': return s.renewLease(w.task_id, w.agent_id);
        case 'release_task': return s.releaseTaskAtomic(w.task_id, w.agent_id, true);
        case 'complete_task': { const { _notify, ...result } = await s.completeTaskAtomic(w.task_id, w.agent_id, true) as any; return result; }
        case 'post_artifact': return s.postArtifact({ ...args, task_id: w.task_id, agent_id: w.agent_id } as any);
        case 'report_evidence': return s.reportEvidence({ ...args, task_id: w.task_id, agent_id: w.agent_id } as any);
        case 'record_progress': return s.recordProgress({ ...args, task_id: w.task_id, agent_id: w.agent_id, job_id: w.job_id, attempt_id: w.attempt_id } as any);
        default: return nodeError('worker tool denied', 403);
      }
    });
  }

  private async nodeRetryDepth(jobId: string, s: PgStore = this): Promise<number> {
    let depth = 0, cur = jobId;
    while (depth < 100) {
      const parent = (await s.nodeQuery("SELECT retry_of FROM jobs WHERE id=?", [cur]))[0]?.retry_of;
      if (!parent) return depth;
      cur = parent; depth++;
    }
    return depth;
  }

  async sweepExpiredNodeJobs() {
    return this.sql.begin(async sql => {
      const s = new PgStore(sql as unknown as postgres.Sql);
      await sql.unsafe('LOCK TABLE jobs IN SHARE ROW EXCLUSIVE MODE');
      const expired = await s.nodeQuery(
        "SELECT * FROM jobs WHERE type='node' AND status='running' AND lease_expires<=now()", []) as any[];
      // Opt-in requeue for retryable kinds; outcome_unknown stays deliberate by default.
      const retry = getDispatcherPolicy().node_retry;
      const retried: string[] = [];
      for (const job of expired) {
        let successor: string | undefined;
        let spec: any = {};
        try { spec = typeof job.node_spec === "string" ? JSON.parse(job.node_spec || "{}") : (job.node_spec ?? {}); } catch {}
        if (retry.max_attempts > 1 && retry.kinds.includes(spec.kind) && await s.nodeRetryDepth(job.id) + 1 < retry.max_attempts) {
          successor = `job-${randomUUID().slice(0, 8)}`;
          await s.nodeQuery(
            `INSERT INTO jobs (id,task_id,agent_id,type,command,target_node_id,node_spec,dedupe_key,retry_of)
             VALUES (?,?,?,'node','',?,?,?,?)`,
            [successor, job.task_id ?? null, job.agent_id, job.target_node_id, typeof job.node_spec === "string" ? job.node_spec : JSON.stringify(job.node_spec), job.dedupe_key ?? null, job.id],
          );
          retried.push(successor);
        }
        const reason = successor ? "lease_lost/requeued" : "lease_lost/outcome_unknown";
        await s.nodeQuery(
          `UPDATE jobs SET status='failed', finished_at=now(), outcome_reason=?, lease_expires=NULL WHERE id=?`,
          [reason, job.id],
        );
        await s.log("job", job.id, "failed", "lease-sweeper", { reason, ...(successor ? { successor } : {}) });
      }
      return { expired: expired.map((row: any) => row.id as string), retried };
    });
  }

  private async leaseNodeJob(token: string, sessionId: string, exclude: string[] = []) {
    await this.sweepExpiredNodeJobs();
    const principal = await this.authenticateNode(token, sessionId);
    if ("error" in principal) return principal;
    return this.sql.begin(async sql => {
      const s = new PgStore(sql as unknown as postgres.Sql);
      await s.nodeQuery("UPDATE nodes SET last_seen_at=? WHERE id=?", [new Date().toISOString(), principal.node_id]);
      const node = (await s.nodeQuery("SELECT policy_json, capabilities_json, capabilities_observed_at, state FROM nodes WHERE id=?", [principal.node_id]))[0];
      if (!node || (node.state !== "approved" && node.state !== "draining")) return nodeError();
      // gh-91: capacity is the node's attested max_concurrency, not 1.
      const running = (await s.nodeQuery(
        "SELECT * FROM jobs WHERE type='node' AND target_node_id=? AND status='running' AND lease_expires>now() FOR UPDATE",
        [principal.node_id],
      )) as any[];
      let maxConcurrency = 1;
      try {
        const capsJson = typeof node.capabilities_json === "string" ? JSON.parse(node.capabilities_json) : (node.capabilities_json ?? {});
        const advertised = Number(capsJson.max_concurrency);
        if (Number.isFinite(advertised)) maxConcurrency = Math.max(1, Math.min(8, Math.floor(advertised)));
      } catch { /* default 1 */ }
      const held = running.find((j: any) => j.session_id === sessionId && !exclude.includes(j.id));
      const queued = running.length < maxConcurrency ? (await s.nodeQuery(
        "SELECT * FROM jobs WHERE type='node' AND target_node_id=? AND status='queued' ORDER BY created_at,id LIMIT 1 FOR UPDATE SKIP LOCKED",
        [principal.node_id],
      ))[0] : undefined;
      if (!queued) return held ? publicNodeJob(held) : { empty: true, status_code: 204 };
      let spec: any = queued.node_spec;
      if (typeof spec === "string") { try { spec = JSON.parse(spec); } catch { spec = {}; } }
      const policy = typeof node.policy_json === "string" ? JSON.parse(node.policy_json) : node.policy_json;
      const capabilities = typeof node.capabilities_json === "string" ? node.capabilities_json : JSON.stringify(node.capabilities_json ?? {});
      if (!s.nodePolicyAllows(policy, spec, capabilities, node.capabilities_observed_at)) {
        await s.nodeQuery(
          "UPDATE jobs SET status='failed', finished_at=now(), outcome_reason='policy_denied', lease_expires=NULL WHERE id=? AND status='queued'",
          [queued.id],
        );
        await s.log("job", queued.id, "failed", principal.node_id, { reason: "policy_denied" });
        return { empty: true, status_code: 204 };
      }
      const attempt_id = randomUUID();
      const lease_token = randomUUID();
      const lease_expires = nodeExpiry(NODE_LEASE_SECONDS);
      const updated = await s.nodeQuery(
        `UPDATE jobs SET status='running', started_at=now(), finished_at=NULL, result='',
         runner_id=?, lease_token=?, lease_expires=?, attempt_id=?, session_id=?
         WHERE id=? AND status='queued' RETURNING *`,
        [principal.node_id, lease_token, lease_expires, attempt_id, sessionId, queued.id],
      );
      if (!updated[0]) return { empty: true, status_code: 204 };
      await s.log("job", queued.id, "started", principal.node_id, { attempt_id, lease_expires });
      return publicNodeJob(updated[0]);
    });
  }

  async pollNodeJob(token: string, sessionId: string, waitSeconds = 0, signal?: AbortSignal, exclude: string[] = []) {
    const waitMs = Math.max(0, Math.min(NODE_POLL_MAX_WAIT, waitSeconds)) * 1000;
    const deadline = Date.now() + waitMs;
    try {
      while (true) {
        if (signal?.aborted) return nodeError("canceled", 499);
        const leased = await this.leaseNodeJob(token, sessionId, exclude);
        if (!leased || !("empty" in leased)) return leased;
        if (Date.now() >= deadline) return leased;
        await sleepSignal(Math.min(50, Math.max(1, deadline - Date.now())), signal);
      }
    } catch (error) {
      if ((error as { canceled?: boolean }).canceled) return nodeError("canceled", 499);
      throw error;
    }
  }

  async renewNodeJob(token: string, sessionId: string, jobId: string, leaseToken: string, result?: string) {
    const principal = await this.authenticateNode(token, sessionId);
    if ("error" in principal) return principal;
    const lease_expires = new Date(Date.now() + NODE_LEASE_SECONDS * 1000);
    const updated = await this.nodeQuery(
      `UPDATE jobs SET lease_expires=?, result=COALESCE(?,result)
       WHERE id=? AND type='node' AND status='running' AND target_node_id=? AND runner_id=?
       AND session_id=? AND lease_token=? AND lease_expires>now() RETURNING id`,
      [lease_expires.toISOString(), result === undefined ? null : boundNodeResult(result), jobId, principal.node_id, principal.node_id, sessionId, leaseToken],
    );
    if (!updated.length) return nodeError("job lease not owned or expired", 409);
    await this.log("job", jobId, "renewed", principal.node_id);
    return { id: jobId, lease_expires: lease_expires.toISOString() };
  }

  async finishNodeJob(token: string, sessionId: string, jobId: string, leaseToken: string, status: "done" | "failed", result: string, resultMetadata?: unknown) {
    const principal = await this.authenticateNode(token, sessionId);
    if ("error" in principal) return principal;
    const bounded = boundNodeResult(result);
    return this.sql.begin(async sql => {
      const s = new PgStore(sql as unknown as postgres.Sql);
      const job = (await s.nodeQuery("SELECT * FROM jobs WHERE id=? AND type='node' AND target_node_id=? FOR UPDATE", [jobId, principal.node_id]))[0];
      if (!job) return nodeError("job lease not owned or expired", 409);
      if (job.lease_token !== leaseToken || job.session_id !== sessionId) return nodeError("job lease not owned or expired", 409);
      const digest = nodeReceiptDigest(job.attempt_id ?? "", status, bounded);
      if (job.status === "done" || job.status === "failed") {
        if (job.receipt_status === status && job.receipt_digest === digest) {
          return { id: jobId, status: job.status, attempt_id: job.attempt_id, receipt_digest: job.receipt_digest, idempotent: true };
        }
        return nodeError("conflicting completion", 409);
      }
      const expires = job.lease_expires instanceof Date ? job.lease_expires : new Date(job.lease_expires);
      if (job.status !== "running" || !job.lease_expires || expires.getTime() <= Date.now()) {
        return nodeError("job lease not owned or expired", 409);
      }
      const metadata = resultMetadata == null ? null : JSON.stringify(resultMetadata);
      const updated = await s.nodeQuery(
        `UPDATE jobs SET status=?, result=?, finished_at=now(), lease_expires=NULL, receipt_digest=?, receipt_status=?, result_metadata=?
         WHERE id=? AND status='running' AND lease_token=? AND session_id=? AND lease_expires>now() RETURNING id`,
        [status, bounded, digest, status, metadata, jobId, leaseToken, sessionId],
      );
      if (!updated.length) return nodeError("job lease not owned or expired", 409);
      await s.log("job", jobId, status, principal.node_id, { attempt_id: job.attempt_id, receipt_digest: digest });
      if (job.task_id) await s.notifyWatchers(job.task_id, `job ${jobId} (node) → ${status}`);
      return { id: jobId, status, attempt_id: job.attempt_id, receipt_digest: digest };
    });
  }

  async nodeHeartbeat(token: string, sessionId: string, body: { capabilities_version?: number; active_job_id?: string; phase?: string } = {}) {
    const principal = await this.authenticateNode(token, sessionId);
    if ("error" in principal) return principal;
    const now = new Date().toISOString();
    await this.nodeQuery("UPDATE nodes SET last_seen_at=? WHERE id=?", [now, principal.node_id]);
    await this.log("node", principal.node_id, "heartbeat", principal.node_id, { phase: body.phase ?? null, active_job_id: body.active_job_id ?? null, capabilities_version: body.capabilities_version ?? null });
    const [row] = await this.nodeQuery("SELECT * FROM nodes WHERE id=?", [principal.node_id]);
    return { node_id: principal.node_id, server_time: now, ...projectNode(row) };
  }

  async putNodeCapabilities(token: string, sessionId: string, version: number, inventory: unknown) {
    const parsed = nodeInventorySchema.safeParse(inventory);
    if (!parsed.success) return nodeError("invalid inventory", 400);
    const principal = await this.authenticateNode(token, sessionId);
    if ("error" in principal) return principal;
    const now = new Date().toISOString();
    const inventoryJson = JSON.stringify(parsed.data);
    if (inventoryJson.includes("uw_node_")) return nodeError("invalid inventory", 400);
    const [prior] = await this.nodeQuery("SELECT capabilities_json FROM nodes WHERE id=?", [principal.node_id]);
    let priorHarnesses: Record<string, { state?: string; resets_at?: string }> = {};
    try {
      for (const h of JSON.parse(prior?.capabilities_json || "{}").harnesses ?? []) if (h?.id) priorHarnesses[h.id] = h.quota ?? {};
    } catch { /* first attestation */ }
    for (const h of parsed.data.harnesses ?? []) {
      if (!h?.id) continue;
      const before = priorHarnesses[h.id]?.state ?? "unattested";
      const after = h.quota?.state ?? "unknown";
      if (before === after) continue;
      const action = after === "exhausted" ? "quota_exhausted" : before === "exhausted" ? "quota_recovered" : "quota_changed";
      await this.log("node", principal.node_id, action, "capabilities", { harness: h.id, from: before, to: after, resets_at: h.quota?.resets_at ?? null });
    }
    await this.nodeQuery(
      "UPDATE nodes SET last_seen_at=?, capabilities_json=?, capabilities_version=?, capabilities_observed_at=? WHERE id=?",
      [now, inventoryJson, version, now, principal.node_id],
    );
    await this.log("node", principal.node_id, "capabilities", principal.node_id, { version, harnesses: parsed.data.harnesses.map(h => h.id) });
    return { node_id: principal.node_id, version, server_time: now };
  }

  private constructor(sql: postgres.Sql) {
    this.sql = sql;
  }

  static async connect(url: string) {
    const sql = postgres(url, { max: 5 });
    await sql.unsafe(DDL);
    await sql.unsafe(NODES_SCHEMA);
    await sql.unsafe(PG_JOBS_MIGRATION);
    await sql.unsafe(PG_ARTIFACTS_MIGRATION);
    await sql.unsafe(LEDGER_SCHEMA);
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
      artifacts: await this.listArtifacts(id), ledger: await this.listLedger(id), reviews: await this.reviewIds(id),
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

  async releaseTask(taskId: string, agentId: string, scoped = false) {
    return this.sql.begin(async sql => {
      const tx = new PgStore(sql as unknown as postgres.Sql);
      return tx.releaseTaskAtomic(taskId, agentId, scoped);
    });
  }

  private async releaseTaskAtomic(taskId: string, agentId: string, scoped = false) {
    const [claim] = await this.sql<any[]>`SELECT agent_id FROM claims WHERE task_id=${taskId}`;
    if (!claim) return { error: `task ${taskId} is not claimed` };
    if (claim.agent_id !== agentId) return { error: `task ${taskId} is claimed by ${claim.agent_id}` };
    await this.sql`DELETE FROM claims WHERE task_id=${taskId}`;
    await this.sql`UPDATE tasks SET status='open', updated_at=now() WHERE id=${taskId}`;
    await this.log("task", taskId, "released", agentId);
    const dispatched = scoped ? undefined : await this.dispatchNext(agentId, taskId, "release");
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

  /** Append a progress event to the task ledger (gh-112). Idempotent by
   *  operation_id: a retried write with the same payload returns the prior
   *  row, a reused operation_id with a different payload is an error. */
  async recordProgress(a: { task_id: string; agent_id: string; status: string; summary: string; details?: string; operation_id?: string; job_id?: string; attempt_id?: string }) {
    if (!a.summary?.trim()) return { error: "summary is required" };
    if (a.summary.length > 500) return { error: "summary exceeds 500 characters" };
    if (a.details && a.details.length > 20000) return { error: "details exceeds 20000 characters" };
    if (!(LEDGER_STATUSES as readonly string[]).includes(a.status)) return { error: `unknown ledger status: ${a.status}` };
    const op = a.operation_id ?? `op-${randomUUID().slice(0, 8)}`;
    return this.sql.begin(async sql => {
      const [prior] = await sql<any[]>`SELECT * FROM task_ledger WHERE operation_id = ${op}`;
      if (prior) {
        const same = prior.task_id === a.task_id && prior.agent_id === a.agent_id && prior.status === a.status
          && prior.summary === a.summary && prior.details === (a.details ?? "")
          && prior.job_id === (a.job_id ?? null) && prior.attempt_id === (a.attempt_id ?? null);
        if (!same) throw new Error("operation_id already used with different input");
        return prior;
      }
      const [task] = await sql<any[]>`SELECT status FROM tasks WHERE id = ${a.task_id}`;
      if (!task) throw new Error(`task ${a.task_id} not found`);
      if (task.status === "done") throw new Error(`task ${a.task_id} is completed; ledger is closed`);
      const [claim] = await sql<any[]>`SELECT agent_id FROM claims WHERE task_id = ${a.task_id}`;
      if (claim && claim.agent_id !== a.agent_id) throw new Error(`task ${a.task_id} is claimed by ${claim.agent_id}`);
      const [row] = await sql<any[]>`INSERT INTO task_ledger (operation_id, task_id, agent_id, job_id, attempt_id, status, summary, details)
        VALUES (${op},${a.task_id},${a.agent_id},${a.job_id ?? null},${a.attempt_id ?? null},${a.status},${a.summary},${a.details ?? ""}) RETURNING *`;
      await sql`INSERT INTO events (entity_type, entity_id, action, actor, data) VALUES ('task',${a.task_id},'ledger',${a.agent_id},${sql.json({ operation_id: op, status: a.status, job_id: a.job_id ?? null })})`;
      return row;
    }).catch((e: Error) => ({ error: e.message }));
  }

  async listLedger(taskId: string, limit = 20) {
    return this.sql<any[]>`SELECT operation_id, task_id, agent_id, job_id, attempt_id, status, summary, details, created_at FROM task_ledger WHERE task_id = ${taskId} ORDER BY created_at DESC, operation_id DESC LIMIT ${Math.max(1, Math.min(limit, 500))}`;
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

  async completeTask(taskId: string, agentId: string, scoped = false) {
    const res = await this.dependencyTransaction(store => store.completeTaskAtomic(taskId, agentId, scoped));
    if (res && res._notify) {
      const { _notify, ...publicRes } = res;
      await sendHumanNotification(_notify, loadPolicy());
      return publicRes;
    }
    return res;
  }

  private async completeTaskAtomic(taskId: string, agentId: string, scoped = false) {
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
    const dispatched = scoped ? undefined : await this.dispatchNext(agentId, taskId, "complete");
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
    if (a.type === "node") return { error: "use submit_node_task for node jobs" };
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
      AND type<>'node' AND target_node_id IS NULL
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
    const unread = await this.sql`SELECT to_agent, COUNT(*)::int AS n FROM messages WHERE read=false GROUP BY to_agent`;
    const activity = await this.sql`SELECT actor, MAX(created_at) AS last_at FROM events GROUP BY actor ORDER BY last_at DESC LIMIT 50`;
    return {
      tasks: await Promise.all(tasks.map(async t => ({ ...t, ...await this.dependencies(t.id, t.status) }))),
      job_counts,
      helpers_registered: n,
      nodes: await this.listNodes(),
      unread_messages: Object.fromEntries(unread.map(r => [r.to_agent, r.n])),
      agent_activity: Object.fromEntries(activity.map(r => [r.actor, r.last_at])),
    };
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
