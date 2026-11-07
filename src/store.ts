import { nodeEnrollmentSchema, nodePolicySchema, nodeHash, nodeSecret, nodeExpiry, nodeError, NODE_SCOPES, NODE_LEASE_SECONDS, NODE_POLL_MAX_WAIT, nodeSpecSchema, nodeInventorySchema, boundNodeResult, nodeReceiptDigest, publicNodeJob, projectNode, sleepSignal, type NodeEnrollmentInput, type NodePolicy, type NodePrincipal, type NodeError } from "./node-protocol.js";
import { NODES_SCHEMA } from "./schema.js";
import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { SCHEMA, JOBS_SCHEMA, JOBS_INDEXES, ARTIFACT_KIND_SQL, isArtifactKind } from "./schema.js";
import { loadPolicy, evaluateDoD, evaluateDoR, expandTemplate, listTemplates as allTemplates, getDispatcherPolicy, type DispatcherPolicy } from "./policy.js";
import { parseCoverage } from "./coverage.js";
import { chooseReassignAgent, DISPATCHER_AGENT, isSystemActor, leaseActive, nextTaskMessage, overCap, taskIdFromNextTaskMessage } from "./dispatcher.js";
import { buildDigest, normalizeDigestArgs, sendHumanNotification } from "./digest.js";
import { importSpecKit, type ImportSpecKitArgs } from "./speckit.js";
import type { IStore, CreateTaskArgs, SubmitJobArgs, SubmitNodeTaskArgs, DigestArgs, DigestResult } from "./istore.js";
import type { SymbolRec, RefRec } from "./codeindex.js";

export type { TaskStatus } from "./istore.js";
import type { TaskStatus } from "./istore.js";
import { PgStore } from "./pstore.js";

export class SqliteStore implements IStore {
  private db: Database.Database;

  private nodeTransaction(work: (s: SqliteStore) => any): any {
    return this.db.transaction(() => work(this))();
  }
  private nodeQuery(query: string, params: any[] = []): any[] {
    const statement = this.db.prepare(query);
    if (statement.reader) return statement.all(...params);
    statement.run(...params);
    return [];
  }

  private nodeAudit(id: string, action: string, actor = 'node-protocol') {
    this.log('node', id, action, actor);
  }

  private nodeRate(bucket: string, limit: number): boolean {
    const now = new Date().toISOString();
    const cutoff = new Date(Date.now() - 60000).toISOString();
    this.nodeQuery('DELETE FROM node_rate_limits WHERE window_start < ?', [cutoff]);
    const rows = this.nodeQuery(`INSERT INTO node_rate_limits(bucket,window_start,attempts) VALUES (?,?,1)
      ON CONFLICT(bucket) DO UPDATE SET attempts=node_rate_limits.attempts+1 RETURNING attempts`, [bucket, now]);
    return rows[0].attempts <= limit;
  }

  createNodeEnrollment(input: NodeEnrollmentInput): any {
    const parsed = nodeEnrollmentSchema.safeParse(input);
    if (!parsed.success) return nodeError('invalid enrollment', 400);
    return this.nodeTransaction(s => {
      const now = new Date().toISOString();
      s.nodeQuery('DELETE FROM node_enrollments WHERE expires_at < ?', [new Date(Date.now() - 86400000).toISOString()]);
      s.nodeQuery('DELETE FROM node_tokens WHERE expires_at < ?', [new Date(Date.now() - 86400000).toISOString()]);
      const count = s.nodeQuery('SELECT COUNT(*) AS n FROM node_enrollments WHERE expires_at > ?', [now]);
      if (!s.nodeRate('enrollment-create', 30) || Number(count[0].n) >= 100) return nodeError('enrollment limit reached', 429);
      const id = 'enroll-' + randomUUID();
      const code = nodeSecret().slice(0, 16).toUpperCase();
      const expires = nodeExpiry(600);
      const { device_secret_hash, ...metadata } = parsed.data;
      s.nodeQuery(`INSERT INTO node_enrollments(id,code_hash,device_secret_hash,metadata_json,status,expires_at)
        VALUES (?,?,?,?,'pending',?)`, [id, nodeHash(code), device_secret_hash, JSON.stringify(metadata), expires]);
      s.nodeAudit(id, 'enrollment_created');
      return { id, code, expires_at: expires, retry_after: 3 };
    });
  }

  listNodeEnrollments(): any[] {
    return this.nodeQuery(`SELECT id,metadata_json,status,expires_at,approved_by,approved_at,node_id,redeemed_at
      FROM node_enrollments ORDER BY expires_at DESC LIMIT 100`);
  }

  approveNodeEnrollment(id: string, code: string, policy: NodePolicy, actor: string): any {
    const parsed = nodePolicySchema.safeParse(policy);
    if (!parsed.success) return nodeError('invalid node policy', 400);
    return this.nodeTransaction(s => {
      if (!s.nodeRate('enrollment-approve', 60)) return nodeError('approval limit reached', 429);
      const e = (s.nodeQuery('SELECT * FROM node_enrollments WHERE id=?', [id]))[0];
      if (!e || e.status !== 'pending' || e.expires_at <= new Date().toISOString() || nodeHash(code) !== e.code_hash) {
        s.nodeAudit('enrollment', 'approval_denied', actor);
        return nodeError('enrollment unavailable', 409);
      }
      const node_id = 'node-' + randomUUID();
      const now = new Date().toISOString();
      s.nodeQuery(`INSERT INTO nodes(id,name,state,policy_json,created_at) VALUES (?,?,'approved',?,?)`,
        [node_id, JSON.parse(e.metadata_json).name, JSON.stringify(parsed.data), now]);
      s.nodeQuery(`UPDATE node_enrollments SET status='approved',approved_by=?,approved_at=?,node_id=? WHERE id=?`, [actor, now, node_id, id]);
      s.nodeAudit(node_id, 'enrollment_approved', actor);
      return { node_id, status: 'approved' };
    });
  }

  rejectNodeEnrollment(id: string, actor: string): any {
    return this.nodeTransaction(s => {
      const rows = s.nodeQuery(`UPDATE node_enrollments SET status='rejected' WHERE id=? AND status='pending' RETURNING id`, [id]);
      s.nodeAudit(rows.length ? id : 'enrollment', rows.length ? 'enrollment_rejected' : 'rejection_denied', actor);
      return rows.length ? { id, status: 'rejected' } : nodeError('enrollment unavailable', 409);
    });
  }

  exchangeNodeEnrollment(id: string, secret: string): any {
    return this.nodeTransaction(s => {
      if (!s.nodeRate('enrollment-exchange', 240)) return nodeError('exchange limit reached', 429);
      const e = (s.nodeQuery('SELECT * FROM node_enrollments WHERE id=?', [id]))[0];
      if (!e || e.expires_at <= new Date().toISOString() || nodeHash(secret) !== e.device_secret_hash || !['pending','approved'].includes(e.status)) {
        s.nodeAudit('enrollment', 'exchange_denied');
        return nodeError('enrollment unavailable; revoke and reenroll if response was lost', 409);
      }
      if (e.status === 'pending') return { status: 'pending', retry_after: 3 };
      const node = (s.nodeQuery("SELECT id FROM nodes WHERE id=? AND state='approved'", [e.node_id]))[0];
      if (!node) return nodeError();
      const token = 'uw_node_' + nodeSecret();
      const expires_at = nodeExpiry(30 * 86400);
      const token_id = 'nt-' + randomUUID();
      s.nodeQuery('INSERT INTO node_tokens(id,node_id,secret_hash,scopes_json,expires_at) VALUES (?,?,?,?,?)',
        [token_id, e.node_id, nodeHash(token), JSON.stringify(NODE_SCOPES), expires_at]);
      s.nodeQuery("UPDATE node_enrollments SET status='redeemed',redeemed_at=? WHERE id=?", [new Date().toISOString(), id]);
      s.nodeAudit(e.node_id, 'credential_issued');
      return { node_id: e.node_id, token, token_id, expires_at };
    });
  }

  listNodes(): any[] {
    const now = Date.now();
    const rows = this.nodeQuery(`SELECT n.id,n.name,n.state,n.policy_json,n.created_at,n.last_seen_at,n.session_expires_at,
      n.capabilities_json,n.capabilities_version,n.capabilities_observed_at,
      (SELECT id FROM jobs j WHERE j.type='node' AND j.target_node_id=n.id AND j.status='running' LIMIT 1) AS current_job_id
      FROM nodes n ORDER BY n.created_at DESC LIMIT 1000`);
    return rows.map(row => projectNode(row, now));
  }

  revokeNode(id: string, actor: string): any {
    return this.nodeTransaction(s => {
      const rows = s.nodeQuery("UPDATE nodes SET state='revoked',session_epoch=NULL,session_expires_at=NULL WHERE id=? RETURNING id", [id]);
      if (!rows.length) return nodeError('node unavailable', 404);
      s.nodeQuery('UPDATE node_tokens SET revoked_at=? WHERE node_id=? AND revoked_at IS NULL', [new Date().toISOString(), id]);
      s.nodeAudit(id, 'revoked', actor);
      return { node_id: id, state: 'revoked' };
    });
  }

  authenticateNode(token: string, sessionId?: string): NodePrincipal | NodeError {
    if (!/^uw_node_[a-f0-9]{64}$/.test(token)) return nodeError();
    const rows = this.nodeQuery(`SELECT t.id AS token_id,t.node_id,t.expires_at,n.session_epoch,n.session_expires_at,n.policy_json
      FROM node_tokens t JOIN nodes n ON n.id=t.node_id
      WHERE t.secret_hash=? AND t.revoked_at IS NULL AND t.expires_at>? AND n.state IN ('approved','draining')`, [nodeHash(token), new Date().toISOString()]);
    const r = rows[0];
    if (!r || (sessionId !== undefined && (r.session_epoch !== sessionId || r.session_expires_at <= new Date().toISOString()))) {
      this.nodeAudit('credential', 'authorization_denied');
      return nodeError();
    }
    return { node_id: r.node_id, token_id: r.token_id, expires_at: r.expires_at, session_id: r.session_epoch, policy: JSON.parse(r.policy_json) };
  }

  startNodeSession(token: string): any {
    return this.nodeTransaction(s => {
      const principal = s.authenticateNode(token);
      if ('error' in principal) return principal;
      const session_id = randomUUID();
      const expires_at = nodeExpiry(3600);
      s.nodeQuery('UPDATE nodes SET session_epoch=?,session_expires_at=? WHERE id=?', [session_id, expires_at, principal.node_id]);
      s.nodeAudit(principal.node_id, 'session_started');
      return { policy: principal.policy, node_id: principal.node_id, session_id, expires_at, server_time: new Date().toISOString(), heartbeat_seconds: 15, lease_seconds: NODE_LEASE_SECONDS };
    });
  }

  private nodePolicyAllows(policy: NodePolicy, spec: { kind: string; workspace_id?: string; payload?: Record<string, unknown> }, capabilitiesJson?: string, observedAt?: unknown) {
    if (!policy.allowed_task_types.includes(spec.kind as NodePolicy["allowed_task_types"][number])) return false;
    if (spec.workspace_id && !policy.workspace_ids.includes(spec.workspace_id)) return false;
    try {
      const capabilities = JSON.parse(capabilitiesJson || "{}");
      if (spec.kind === 'launch-agent') {
        const harness = capabilities.harnesses?.find((h: any) => h.id === spec.payload?.harness);
        if (!observedAt || Date.now() - Date.parse(String(observedAt)) > 120000 || !harness?.installed || harness.auth_status !== 'ready' || !['available', 'unknown'].includes(harness.quota?.state)) return false;
      }
      const kinds = capabilities.supported_operation_kinds;
      if (Array.isArray(kinds) && kinds.length && !kinds.includes(spec.kind)) return false;
    } catch { return false; }
    return true;
  }

  submitNodeTask(args: SubmitNodeTaskArgs) {
    const parsed = nodeSpecSchema.safeParse(args.node_spec);
    if (!parsed.success) return nodeError("invalid node_spec", 400);
    const spec = parsed.data;
    return this.nodeTransaction(s => {
      const node = (s.nodeQuery("SELECT * FROM nodes WHERE id=? AND state='approved'", [args.target_node_id]))[0];
      if (!node) return nodeError("node unavailable", 404);
      const policy = JSON.parse(node.policy_json) as NodePolicy;
      if (!s.nodePolicyAllows(policy, spec, node.capabilities_json, node.capabilities_observed_at)) return nodeError(spec.kind === "launch-agent" ? "launch requires fresh ready capability and approved policy" : "operation not permitted", 403);
      if (spec.kind === 'launch-agent') {
        const inventory = JSON.parse(node.capabilities_json || '{}');
        const harness = inventory.harnesses?.find((h: any) => h.id === spec.payload.harness);
        if (!args.task_id || !args.agent_id || !spec.workspace_id || spec.payload.workspace_id !== spec.workspace_id ||
            !node.capabilities_observed_at || Date.now() - Date.parse(String(node.capabilities_observed_at)) > 120000 ||
            !harness?.installed || harness.auth_status !== 'ready' || !['available', 'unknown'].includes(harness.quota?.state)) return nodeError('launch requires task, agent and fresh ready harness capability', 403);
        const reserved = (s.nodeQuery("SELECT * FROM jobs WHERE type='node' AND task_id=? AND agent_id=? AND status IN ('queued','running') AND dedupe_key LIKE 'launch:%'", [args.task_id, args.agent_id]))[0];
        if (reserved) return { ...publicNodeJob(reserved), deduped: true };
      }
      if (args.retry_of) {
        const prior = (s.nodeQuery("SELECT id FROM jobs WHERE id=? AND type='node'", [args.retry_of]))[0];
        if (!prior) return nodeError("retry_of not found", 404);
      }
      const dedupe = spec.kind === 'launch-agent' ? 'launch:' + nodeHash(args.task_id + ':' + args.agent_id) : args.dedupe_key ?? spec.idempotency_key ?? null;
      if (dedupe) {
        const existing = (s.nodeQuery(
          "SELECT * FROM jobs WHERE target_node_id=? AND dedupe_key=? AND status IN ('queued','running')",
          [args.target_node_id, dedupe],
        ))[0];
        if (existing) return { ...publicNodeJob(existing), deduped: true };
      }
      const id = `job-${randomUUID().slice(0, 8)}`;
      try {
        s.nodeQuery(
          `INSERT INTO jobs (id,task_id,agent_id,type,command,target_node_id,node_spec,dedupe_key,retry_of)
           VALUES (?,?,?,'node','',?,?,?,?)`,
          [id, args.task_id ?? null, args.agent_id ?? "admin", args.target_node_id, JSON.stringify(spec), dedupe, args.retry_of ?? null],
        );
      } catch {
        const existing = (s.nodeQuery(
          "SELECT * FROM jobs WHERE target_node_id=? AND dedupe_key=? AND status IN ('queued','running')",
          [args.target_node_id, dedupe],
        ))[0];
        if (existing) return { ...publicNodeJob(existing), deduped: true };
        throw new Error("node task insert failed");
      }
      s.log("job", id, "submitted", args.agent_id ?? "admin", { type: "node", target_node_id: args.target_node_id, kind: spec.kind, retry_of: args.retry_of ?? null });
      return { id, status: "queued", target_node_id: args.target_node_id };
    });
  }

  issueNodeWorker(token: string, sessionId: string, jobId: string, leaseToken: string) {
    return this.nodeTransaction(s => {
      const principal = s.authenticateNode(token, sessionId);
      if ('error' in principal) return principal;
      const job = s.nodeQuery("SELECT * FROM jobs WHERE id=? AND target_node_id=? AND status='running' AND session_id=? AND lease_token=? AND lease_expires>?", [jobId, principal.node_id, sessionId, leaseToken, new Date().toISOString()])[0];
      if (!job || !job.task_id || JSON.parse(job.node_spec).kind !== 'launch-agent') return nodeError('worker requires a live task launch', 403);
      const worker = 'uw_worker_' + nodeSecret();
      s.nodeQuery('DELETE FROM node_workers WHERE job_id=?', [jobId]);
      s.nodeQuery('INSERT INTO node_workers(secret_hash,node_id,token_id,session_id,task_id,agent_id,job_id,attempt_id) VALUES (?,?,?,?,?,?,?,?)', [nodeHash(worker), principal.node_id, principal.token_id, sessionId, job.task_id, job.agent_id, jobId, job.attempt_id]);
      s.log('job', jobId, 'worker_issued', principal.node_id, { attempt_id: job.attempt_id });
      return { token: worker, task_id: job.task_id, agent_id: job.agent_id, job_id: jobId, attempt_id: job.attempt_id };
    });
  }

  workerTool(token: string, name: string, args: Record<string, unknown>) {
    if (!/^uw_worker_[a-f0-9]{64}$/.test(token)) return nodeError();
    return this.nodeTransaction(s => {
      const now = new Date().toISOString();
      const w = s.nodeQuery(`SELECT w.* FROM node_workers w
        JOIN jobs j ON j.id=w.job_id AND j.attempt_id=w.attempt_id AND j.session_id=w.session_id
        AND j.task_id=w.task_id AND j.agent_id=w.agent_id AND j.target_node_id=w.node_id AND j.type='node'
        JOIN nodes n ON n.id=w.node_id AND n.session_epoch=w.session_id
        JOIN node_tokens t ON t.id=w.token_id
        WHERE w.secret_hash=? AND j.status='running' AND j.lease_expires>?
        AND n.state IN ('approved','draining') AND n.session_expires_at>?
        AND t.revoked_at IS NULL AND t.expires_at>?`, [nodeHash(token), now, now, now])[0];
      if (!w) return nodeError();
      if ((args.task_id !== undefined && args.task_id !== w.task_id) || (args.agent_id !== undefined && args.agent_id !== w.agent_id)) return nodeError('worker scope mismatch', 403);
      const task = s.getTask(w.task_id);
      switch (name) {
        case 'get_task': return task;
        case 'board': return { tasks: task ? [task] : [] };
        case 'get_evidence': return s.getEvidence(w.task_id);
        case 'list_artifacts': return s.listArtifacts(w.task_id);
        case 'claim_task': return s.claimTask(w.task_id, w.agent_id);
        case 'renew_lease': return s.renewLease(w.task_id, w.agent_id);
        case 'release_task': return s.releaseTask(w.task_id, w.agent_id, true);
        case 'complete_task': return s.completeTask(w.task_id, w.agent_id, true);
        case 'post_artifact': return s.postArtifact({ ...args, task_id: w.task_id, agent_id: w.agent_id } as any);
        case 'report_evidence': return s.reportEvidence({ ...args, task_id: w.task_id, agent_id: w.agent_id } as any);
        default: return nodeError('worker tool denied', 403);
      }
    });
  }

  sweepExpiredNodeJobs() {
    const now = new Date().toISOString();
    return this.nodeTransaction(s => {
      const rows = s.nodeQuery(
        `UPDATE jobs SET status='failed', finished_at=?, outcome_reason='lease_lost/outcome_unknown', lease_expires=NULL
         WHERE type='node' AND status='running' AND lease_expires<=? RETURNING id`,
        [now, now],
      );
      for (const row of rows) s.log("job", row.id, "failed", "lease-sweeper", { reason: "lease_lost/outcome_unknown" });
      return { expired: rows.map((row: any) => row.id as string) };
    });
  }

  private leaseNodeJob(token: string, sessionId: string) {
    this.sweepExpiredNodeJobs();
    const principal = this.authenticateNode(token, sessionId);
    if ("error" in principal) return principal;
    const now = new Date().toISOString();
    return this.nodeTransaction(s => {
      s.nodeQuery("UPDATE nodes SET last_seen_at=? WHERE id=?", [now, principal.node_id]);
      const held = (s.nodeQuery(
        "SELECT * FROM jobs WHERE type='node' AND target_node_id=? AND status='running' AND lease_expires>? AND session_id=?",
        [principal.node_id, now, sessionId],
      ))[0];
      if (held) return publicNodeJob(held);
      const busy = (s.nodeQuery(
        "SELECT id FROM jobs WHERE type='node' AND target_node_id=? AND status='running' AND lease_expires>?",
        [principal.node_id, now],
      ))[0];
      if (busy) return { empty: true, status_code: 204 };
      const queued = (s.nodeQuery(
        "SELECT * FROM jobs WHERE type='node' AND target_node_id=? AND status='queued' ORDER BY created_at,id LIMIT 1",
        [principal.node_id],
      ))[0];
      if (!queued) return { empty: true, status_code: 204 };
      let spec: any = {};
      try { spec = JSON.parse(queued.node_spec || "{}"); } catch { spec = {}; }
      const node = (s.nodeQuery("SELECT policy_json, capabilities_json, capabilities_observed_at, state FROM nodes WHERE id=?", [principal.node_id]))[0];
      if (!node || (node.state !== "approved" && node.state !== "draining")) return nodeError();
      if (!s.nodePolicyAllows(JSON.parse(node.policy_json), spec, node.capabilities_json, node.capabilities_observed_at)) {
        s.nodeQuery(
          "UPDATE jobs SET status='failed', finished_at=?, outcome_reason='policy_denied', lease_expires=NULL WHERE id=? AND status='queued'",
          [now, queued.id],
        );
        s.log("job", queued.id, "failed", principal.node_id, { reason: "policy_denied" });
        return { empty: true, status_code: 204 };
      }
      const attempt_id = randomUUID();
      const lease_token = randomUUID();
      const lease_expires = nodeExpiry(NODE_LEASE_SECONDS);
      const updated = s.nodeQuery(
        `UPDATE jobs SET status='running', started_at=?, finished_at=NULL, result='',
         runner_id=?, lease_token=?, lease_expires=?, attempt_id=?, session_id=?
         WHERE id=? AND status='queued' RETURNING *`,
        [now, principal.node_id, lease_token, lease_expires, attempt_id, sessionId, queued.id],
      );
      if (!updated[0]) return { empty: true, status_code: 204 };
      s.log("job", queued.id, "started", principal.node_id, { attempt_id, lease_expires });
      return publicNodeJob(updated[0]);
    });
  }

  async pollNodeJob(token: string, sessionId: string, waitSeconds = 0, signal?: AbortSignal) {
    const waitMs = Math.max(0, Math.min(NODE_POLL_MAX_WAIT, waitSeconds)) * 1000;
    const deadline = Date.now() + waitMs;
    try {
      while (true) {
        if (signal?.aborted) return nodeError("canceled", 499);
        const leased = this.leaseNodeJob(token, sessionId);
        if (!leased || !("empty" in leased)) return leased;
        if (Date.now() >= deadline) return leased;
        await sleepSignal(Math.min(50, Math.max(1, deadline - Date.now())), signal);
      }
    } catch (error) {
      if ((error as { canceled?: boolean }).canceled) return nodeError("canceled", 499);
      throw error;
    }
  }

  renewNodeJob(token: string, sessionId: string, jobId: string, leaseToken: string, result?: string) {
    const principal = this.authenticateNode(token, sessionId);
    if ("error" in principal) return principal;
    const now = new Date().toISOString();
    const lease_expires = nodeExpiry(NODE_LEASE_SECONDS);
    const updated = this.nodeQuery(
      `UPDATE jobs SET lease_expires=?, result=COALESCE(?,result)
       WHERE id=? AND type='node' AND status='running' AND target_node_id=? AND runner_id=?
       AND session_id=? AND lease_token=? AND lease_expires>? RETURNING id`,
      [lease_expires, result === undefined ? null : boundNodeResult(result), jobId, principal.node_id, principal.node_id, sessionId, leaseToken, now],
    );
    if (!updated.length) return nodeError("job lease not owned or expired", 409);
    this.log("job", jobId, "renewed", principal.node_id);
    return { id: jobId, lease_expires };
  }

  finishNodeJob(token: string, sessionId: string, jobId: string, leaseToken: string, status: "done" | "failed", result: string, resultMetadata?: unknown) {
    const principal = this.authenticateNode(token, sessionId);
    if ("error" in principal) return principal;
    const bounded = boundNodeResult(result);
    return this.nodeTransaction(s => {
      const job = (s.nodeQuery("SELECT * FROM jobs WHERE id=? AND type='node' AND target_node_id=?", [jobId, principal.node_id]))[0];
      if (!job) return nodeError("job lease not owned or expired", 409);
      if (job.lease_token !== leaseToken || job.session_id !== sessionId) return nodeError("job lease not owned or expired", 409);
      const digest = nodeReceiptDigest(job.attempt_id ?? "", status, bounded);
      if (job.status === "done" || job.status === "failed") {
        if (job.receipt_status === status && job.receipt_digest === digest) {
          return { id: jobId, status: job.status, attempt_id: job.attempt_id, receipt_digest: job.receipt_digest, idempotent: true };
        }
        return nodeError("conflicting completion", 409);
      }
      const now = new Date().toISOString();
      if (job.status !== "running" || !job.lease_expires || job.lease_expires <= now) {
        return nodeError("job lease not owned or expired", 409);
      }
      const metadata = resultMetadata == null ? null : JSON.stringify(resultMetadata);
      const updated = s.nodeQuery(
        `UPDATE jobs SET status=?, result=?, finished_at=?, lease_expires=NULL, receipt_digest=?, receipt_status=?, result_metadata=?
         WHERE id=? AND status='running' AND lease_token=? AND session_id=? AND lease_expires>? RETURNING id`,
        [status, bounded, now, digest, status, metadata, jobId, leaseToken, sessionId, now],
      );
      if (!updated.length) return nodeError("job lease not owned or expired", 409);
      s.log("job", jobId, status, principal.node_id, { attempt_id: job.attempt_id, receipt_digest: digest });
      if (job.task_id) s.notifyWatchers(job.task_id, `job ${jobId} (node) → ${status}`);
      return { id: jobId, status, attempt_id: job.attempt_id, receipt_digest: digest };
    });
  }

  nodeHeartbeat(token: string, sessionId: string, body: { capabilities_version?: number; active_job_id?: string; phase?: string } = {}) {
    const principal = this.authenticateNode(token, sessionId);
    if ("error" in principal) return principal;
    const now = new Date().toISOString();
    this.nodeQuery("UPDATE nodes SET last_seen_at=? WHERE id=?", [now, principal.node_id]);
    this.log("node", principal.node_id, "heartbeat", principal.node_id, { phase: body.phase ?? null, active_job_id: body.active_job_id ?? null, capabilities_version: body.capabilities_version ?? null });
    const [row] = this.nodeQuery("SELECT * FROM nodes WHERE id=?", [principal.node_id]);
    return { node_id: principal.node_id, server_time: now, ...projectNode(row) };
  }

  putNodeCapabilities(token: string, sessionId: string, version: number, inventory: unknown) {
    const parsed = nodeInventorySchema.safeParse(inventory);
    if (!parsed.success) return nodeError("invalid inventory", 400);
    const principal = this.authenticateNode(token, sessionId);
    if ("error" in principal) return principal;
    const now = new Date().toISOString();
    const inventoryJson = JSON.stringify(parsed.data);
    if (inventoryJson.includes("uw_node_")) return nodeError("invalid inventory", 400);
    this.nodeQuery(
      "UPDATE nodes SET last_seen_at=?, capabilities_json=?, capabilities_version=?, capabilities_observed_at=? WHERE id=?",
      [now, inventoryJson, version, now, principal.node_id],
    );
    this.log("node", principal.node_id, "capabilities", principal.node_id, { version, harnesses: parsed.data.harnesses.map(h => h.id) });
    return { node_id: principal.node_id, version, server_time: now };
  }

  constructor(path = "underwright.db") {
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.db.exec(SCHEMA);
    this.migrate();
    this.db.exec(JOBS_INDEXES);
    this.db.exec(NODES_SCHEMA);
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
    if (v < 2) {
      // v2: task type drives DoD policy dispatch.
      const hasType = this.db
        .prepare("SELECT 1 FROM pragma_table_info('tasks') WHERE name='type'")
        .get();
      if (!hasType) {
        this.db.exec("ALTER TABLE tasks ADD COLUMN type TEXT NOT NULL DEFAULT 'feature';");
      }
      this.db.exec("PRAGMA user_version = 2;");
    }
    if (v < 3) {
      // v3: triage fields — severity + effort estimate (definition of ready).
      const cols = new Set(
        this.db.prepare("SELECT name FROM pragma_table_info('tasks')").all().map((r: any) => r.name)
      );
      if (!cols.has("severity")) this.db.exec("ALTER TABLE tasks ADD COLUMN severity TEXT NOT NULL DEFAULT 'normal';");
      if (!cols.has("estimate")) this.db.exec("ALTER TABLE tasks ADD COLUMN estimate TEXT NOT NULL DEFAULT '';");
      this.db.exec("PRAGMA user_version = 3;");
    }
    if (v < 4) {
      // v4: resource locks (file/folder/entity claims) for dedupe below task level.
      const has = this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='locks'").get();
      if (!has) {
        this.db.exec(`CREATE TABLE locks (
          resource TEXT PRIMARY KEY, agent_id TEXT NOT NULL, task_id TEXT,
          lease_expires TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')))`);
      }
      this.db.exec("PRAGMA user_version = 4;");
    }
    if (v < 5) {
      for (const tbl of ["messages", "watches"]) {
        const has = this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(tbl);
        if (!has) {
          this.db.exec(tbl === "messages"
            ? `CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, to_agent TEXT NOT NULL, from_agent TEXT NOT NULL, task_id TEXT, body TEXT NOT NULL, read INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT (datetime('now')))`
            : `CREATE TABLE watches (agent_id TEXT NOT NULL, task_id TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')), PRIMARY KEY (agent_id, task_id))`);
        }
      }
      this.db.exec("PRAGMA user_version = 5;");
    }
    if (v < 6) {
      this.db.transaction(() => {
        this.db.exec("ALTER TABLE jobs RENAME TO jobs_v5");
        this.db.exec(JOBS_SCHEMA);
        this.db.exec(`INSERT INTO jobs (id,task_id,agent_id,type,status,command,result,created_at,started_at,finished_at)
          SELECT id,task_id,agent_id,type,CASE WHEN status='running' THEN 'queued' ELSE status END,
          command,result,created_at,started_at,finished_at FROM jobs_v5`);
        this.db.exec("DROP TABLE jobs_v5; PRAGMA user_version = 6;");
      })();
    }
    if (v < 7) {
      // v7: artifacts.kind gains 'blocked' for escalation records.
      this.db.transaction(() => {
        this.db.exec(`
          CREATE TABLE artifacts_v7 (
            id          TEXT PRIMARY KEY,
            task_id     TEXT REFERENCES tasks(id),
            agent_id    TEXT NOT NULL,
            kind        TEXT NOT NULL CHECK (kind IN (${ARTIFACT_KIND_SQL})),
            title       TEXT NOT NULL DEFAULT '',
            content     TEXT NOT NULL,
            created_at  TEXT NOT NULL DEFAULT (datetime('now'))
          );
          INSERT INTO artifacts_v7 (id, task_id, agent_id, kind, title, content, created_at)
            SELECT id, task_id, agent_id, kind, title, content, created_at FROM artifacts;
          DROP TABLE artifacts;
          ALTER TABLE artifacts_v7 RENAME TO artifacts;
          PRAGMA user_version = 7;
        `);
      })();
    }
    if (v < 8) {
      this.db.transaction(() => {
        this.db.exec("ALTER TABLE jobs RENAME TO jobs_v7");
        this.db.exec(JOBS_SCHEMA);
        this.db.exec(`INSERT INTO jobs (id,task_id,agent_id,type,status,command,host,target_agent_id,runner_id,lease_token,lease_expires,agent_spec,result,created_at,started_at,finished_at)
          SELECT id,task_id,agent_id,type,status,command,host,target_agent_id,runner_id,lease_token,lease_expires,agent_spec,result,created_at,started_at,finished_at FROM jobs_v7`);
        this.db.exec("DROP TABLE jobs_v7;");
        this.db.exec(JOBS_INDEXES);
        this.db.exec("PRAGMA user_version = 8;");
      })();
    }
  }

  notifyWatchers(taskId: string, body: string) {
    const watchers = this.db.prepare("SELECT agent_id FROM watches WHERE task_id=?").all(taskId) as any[];
    const stmt = this.db.prepare("INSERT INTO messages (to_agent, from_agent, task_id, body) VALUES (?,?,?,?)");
    for (const w of watchers) stmt.run(w.agent_id, "underwright", taskId, body);
  }

  log(entityType: string, entityId: string, action: string, actor: string, data: unknown = {}) {
    this.db
      .prepare("INSERT INTO events (entity_type, entity_id, action, actor, data, created_at) VALUES (?,?,?,?,?,?)")
      .run(entityType, entityId, action, actor, JSON.stringify(data), new Date().toISOString());
  }

  private index(entityType: string, entityId: string, title: string, content: string) {
    this.db
      .prepare("INSERT INTO search_idx (entity_type, entity_id, title, content) VALUES (?,?,?,?)")
      .run(entityType, entityId, title, content);
  }

  private dependencies(id: string, status: TaskStatus) {
    const blockers = this.db.prepare(`SELECT t.id, t.status FROM task_dependencies d
      JOIN tasks t ON t.id=d.blocker_id WHERE d.task_id=? ORDER BY t.id`).all(id) as any[];
    const blocks = this.db.prepare("SELECT task_id FROM task_dependencies WHERE blocker_id=? ORDER BY task_id").all(id) as any[];
    const unfinished_blockers = blockers.filter(t => t.status !== "done").map(t => t.id as string);
    return { blocked_by: blockers.map(t => t.id as string), blocks: blocks.map(t => t.task_id as string),
      unfinished_blockers, status: status === "open" && unfinished_blockers.length ? "blocked" : status };
  }

  private validateDependencies(id: string, blockers: string[]) {
    for (const blocker of new Set(blockers)) {
      if (blocker === id) return `task ${id} cannot depend on itself`;
      if (!this.db.prepare("SELECT 1 FROM tasks WHERE id=?").get(blocker)) return `blocker ${blocker} not found`;
      const cycle = this.db.prepare(`WITH RECURSIVE ancestors(id) AS (
        SELECT blocker_id FROM task_dependencies WHERE task_id=?
        UNION SELECT d.blocker_id FROM task_dependencies d JOIN ancestors a ON d.task_id=a.id
      ) SELECT 1 FROM ancestors WHERE id=?`).get(blocker, id);
      if (cycle) return `dependency on ${blocker} would create a cycle`;
    }
  }

  private replaceDependencies(id: string, blockers: string[]) {
    this.db.prepare("DELETE FROM task_dependencies WHERE task_id=?").run(id);
    const insert = this.db.prepare("INSERT INTO task_dependencies (task_id, blocker_id) VALUES (?,?)");
    for (const blocker of new Set(blockers)) insert.run(id, blocker);
  }

  private unblockDependents(blockerId: string, actor: string) {
    const dependents = this.db.prepare(`SELECT t.id, t.status FROM task_dependencies d
      JOIN tasks t ON t.id=d.task_id WHERE d.blocker_id=?`).all(blockerId) as any[];
    for (const t of dependents) {
      if (t.status === "done") continue;
      const remaining = this.dependencies(t.id, t.status).unfinished_blockers;
      const unblocked = t.status === "open" && remaining.length === 0;
      this.log("task", t.id, unblocked ? "unblocked" : "blocker_completed", actor,
        { blocker_id: blockerId, unfinished_blockers: remaining });
      this.notifyWatchers(t.id, unblocked
        ? `task ${t.id} unblocked: all blockers done (completed ${blockerId})`
        : `task ${t.id}: blocker ${blockerId} completed; remaining blockers: ${remaining.join(", ") || "none"}`);
    }
  }

  createTask(args: CreateTaskArgs) {
    const { args: seeded, error } = expandTemplate(args, loadPolicy());
    if (error) return { error };
    return this.db.transaction(() => this.createTaskAtomic(seeded)).immediate();
  }

  private createTaskAtomic(a: CreateTaskArgs) {
    const id = a.id ?? `task-${randomUUID().slice(0, 8)}`;
    const invalid = this.validateDependencies(id, a.blocked_by ?? []);
    if (invalid) return { error: invalid };
    this.db
      .prepare(
        `INSERT INTO tasks (id, title, description, spec_ref, ac_ids, priority, ownership, created_by, type, severity, estimate)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`
      )
      .run(
        id, a.title, a.description ?? "", a.spec_ref ?? null,
        JSON.stringify(a.ac_ids ?? []), a.priority ?? 2,
        JSON.stringify(a.ownership ?? {}), a.created_by ?? "human",
        a.type ?? "feature", a.severity ?? "normal", a.estimate ?? ""
      );
    this.replaceDependencies(id, a.blocked_by ?? []);
    this.log("task", id, "created", a.created_by ?? "human", a);
    return this.getTask(id);
  }

  listTemplates() {
    return allTemplates(loadPolicy());
  }

  getTask(id: string) {
    const t = this.db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as any;
    if (!t) return null;
    const claim = this.db.prepare("SELECT * FROM claims WHERE task_id = ?").get(id) ?? null;
    return {
      ...t, ...this.dependencies(id, t.status),
      ac_ids: JSON.parse(t.ac_ids), ownership: JSON.parse(t.ownership), claim,
      artifacts: this.listArtifacts(id),
    };
  }

  setTaskStatus(id: string, status: TaskStatus, actor: string) {
    return this.db.transaction(() => this.setTaskStatusAtomic(id, status, actor)).immediate();
  }

  private setTaskStatusAtomic(id: string, status: TaskStatus, actor: string) {
    const t = this.getTask(id);
    if (!t) return { error: `task ${id} not found` };
    const raw = this.db.prepare("SELECT status FROM tasks WHERE id=?").get(id) as any;
    if (raw.status === status) return { id, status };
    this.db.prepare("UPDATE tasks SET status=?, updated_at=datetime('now') WHERE id=?").run(status, id);
    this.log("task", id, `status:${status}`, actor);
    this.notifyWatchers(id, `task ${id} → ${status}`);
    if (status === "done" && t.status !== "done") this.unblockDependents(id, actor);
    return { id, status };
  }

  updateTask(id: string, patch: Partial<CreateTaskArgs>, actor: string) {
    return this.db.transaction(() => this.updateTaskAtomic(id, patch, actor)).immediate();
  }

  private updateTaskAtomic(id: string, patch: Partial<CreateTaskArgs>, actor: string) {
    const t = this.getTask(id);
    if (!t) return { error: `task ${id} not found` };
    const sets: string[] = [];
    const vals: any[] = [];
    for (const k of ["title", "description", "spec_ref", "type", "severity", "estimate"] as const) {
      if (patch[k] !== undefined) { sets.push(`${k}=?`); vals.push(patch[k]); }
    }
    if (patch.ac_ids !== undefined) { sets.push("ac_ids=?"); vals.push(JSON.stringify(patch.ac_ids)); }
    if (patch.blocked_by !== undefined) {
      const invalid = this.validateDependencies(id, patch.blocked_by);
      if (invalid) return { error: invalid };
      this.replaceDependencies(id, patch.blocked_by);
    }
    if (!sets.length && patch.blocked_by === undefined) return { id, unchanged: true };
    sets.push("updated_at=datetime('now')");
    this.db.prepare(`UPDATE tasks SET ${sets.join(",")} WHERE id=?`).run(...vals, id);
    this.log("task", id, "updated", actor, patch);
    return this.getTask(id);
  }

  linkTask(id: string, spec_ref: string) {
    const t = this.getTask(id);
    if (!t) return { error: `task ${id} not found` };
    this.db.prepare("UPDATE tasks SET spec_ref=?, updated_at=datetime('now') WHERE id=?").run(spec_ref, id);
    this.log("task", id, "linked", "sync", { spec_ref });
    return { id, spec_ref };
  }

  listTasks(status?: TaskStatus) {
    const rows = this.db.prepare("SELECT id, title, status, priority FROM tasks ORDER BY priority, created_at").all() as any[];
    return rows.map(t => ({ ...t, ...this.dependencies(t.id, t.status) }))
      .filter(t => !status || t.status === status);
  }

  /** Atomic claim with lease. Returns the claim or an error string. */
  claimTask(taskId: string, agentId: string, ttlSeconds = 1800, scope: object = {}) {
    return this.db.transaction(() => this.claimTaskAtomic(taskId, agentId, ttlSeconds, scope)).immediate();
  }

  private claimTaskAtomic(taskId: string, agentId: string, ttlSeconds = 1800, scope: object = {}) {
    const task = this.getTask(taskId);
    if (!task) return { error: `task ${taskId} not found` };
    if (task.status === "done") return { error: `task ${taskId} is already done` };

    const existing = this.db.prepare("SELECT * FROM claims WHERE task_id = ?").get(taskId) as any;
    const now = new Date().toISOString();
    if (existing && existing.lease_expires > now && existing.agent_id !== agentId) {
      return { error: `task ${taskId} is claimed by ${existing.agent_id} until ${existing.lease_expires}` };
    }

    if (task.unfinished_blockers.length) {
      return { error: `task ${taskId} is blocked by unfinished tasks: ${task.unfinished_blockers.join(", ")}` };
    }

    const dor = evaluateDoR(task, loadPolicy());
    if (!dor.ready) {
      return { error: `task ${taskId} is not ready to claim: ${dor.missing.join("; ")}. Triage it first (update_task).` };
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

    // Auto-lock the task's declared ownership paths — dedupe below task level.
    const paths = (task.ownership as any)?.paths ?? [];
    if (paths.length) {
      const lr = this.claimResources(paths, agentId, taskId, ttlSeconds);
      if ((lr as any).error) return { task_id: taskId, agent_id: agentId, lease_expires: expires, warning: `claimed task but resource locks conflict: ${JSON.stringify((lr as any).conflicts)}` };
    }
    return { task_id: taskId, agent_id: agentId, lease_expires: expires };
  }

  claimResources(resources: string[], agentId: string, taskId?: string, ttlSeconds = 1800) {
    const now = new Date().toISOString();
    const conflicts = (this.checkLocks(resources) as any[]).filter(
      (l: any) => l.agent_id !== agentId && l.lease_expires > now
    );
    if (conflicts.length) return { error: "locked", conflicts };
    const expires = new Date(Date.now() + ttlSeconds * 1000).toISOString();
    const stmt = this.db.prepare(
      `INSERT INTO locks (resource, agent_id, task_id, lease_expires) VALUES (?,?,?,?)
       ON CONFLICT(resource) DO UPDATE SET agent_id=excluded.agent_id, task_id=excluded.task_id, lease_expires=excluded.lease_expires`
    );
    for (const r of resources) stmt.run(r, agentId, taskId ?? null, expires);
    this.log("locks", resources.join(","), "claimed", agentId, { task_id: taskId, ttlSeconds });
    return { claimed: resources, lease_expires: expires };
  }

  releaseResources(resources: string[], agentId: string) {
    const stmt = this.db.prepare("DELETE FROM locks WHERE resource=? AND agent_id=?");
    for (const r of resources) stmt.run(r, agentId);
    this.log("locks", resources.join(","), "released", agentId);
    return { released: resources };
  }

  checkLocks(resources: string[]) {
    if (!resources.length) return [];
    const now = new Date().toISOString();
    const marks = resources.map(() => "?").join(",");
    return this.db
      .prepare(`SELECT * FROM locks WHERE resource IN (${marks}) AND lease_expires > ?`)
      .all(...resources, now);
  }

  sendMessage(to: string, from: string, body: string, taskId?: string) {
    this.db.prepare("INSERT INTO messages (to_agent, from_agent, task_id, body) VALUES (?,?,?,?)")
      .run(to, from, taskId ?? null, body);
    this.log("message", to, "sent", from, { task_id: taskId });
    return { sent: to };
  }

  inbox(agentId: string, unreadOnly = true) {
    const rows = unreadOnly
      ? this.db.prepare("SELECT * FROM messages WHERE to_agent=? AND read=0 ORDER BY id").all(agentId)
      : this.db.prepare("SELECT * FROM messages WHERE to_agent=? ORDER BY id").all(agentId);
    this.db.prepare("UPDATE messages SET read=1 WHERE to_agent=? AND read=0").run(agentId);
    return rows;
  }

  watchTask(agentId: string, taskId: string) {
    this.db.prepare("INSERT OR IGNORE INTO watches (agent_id, task_id) VALUES (?,?)").run(agentId, taskId);
    this.log("watch", taskId, "watching", agentId);
    return { watching: taskId };
  }

  releaseTask(taskId: string, agentId: string, scoped = false) {
    return this.db.transaction(() => {
      const claim = this.db.prepare("SELECT agent_id FROM claims WHERE task_id = ?").get(taskId) as any;
      if (!claim) return { error: `task ${taskId} is not claimed` };
      if (claim.agent_id !== agentId) return { error: `task ${taskId} is claimed by ${claim.agent_id}` };
      this.db.prepare("DELETE FROM claims WHERE task_id = ?").run(taskId);
      this.db.prepare("UPDATE tasks SET status='open', updated_at=datetime('now') WHERE id=?").run(taskId);
      this.log("task", taskId, "released", agentId);
      const dispatched = scoped ? undefined : this.dispatchNext(agentId, taskId, "release");
      return { released: taskId, ...(dispatched ? { dispatched } : {}) };
    }).immediate();
  }

  renewLease(taskId: string, agentId: string, ttlSeconds = 1800) {
    const claim = this.db.prepare("SELECT agent_id FROM claims WHERE task_id = ?").get(taskId) as any;
    if (!claim || claim.agent_id !== agentId) return { error: `task ${taskId} not claimed by ${agentId}` };
    const expires = new Date(Date.now() + ttlSeconds * 1000).toISOString();
    this.db.prepare("UPDATE claims SET lease_expires=? WHERE task_id=?").run(expires, taskId);
    return { task_id: taskId, lease_expires: expires };
  }

  /** Reclaim leases and publish their effects atomically, even across servers. */
  sweepExpiredClaims() {
    const { reclaimed, notifications } = this.db.transaction(() => {
      const now = new Date().toISOString();
      const expired = this.db.prepare("SELECT * FROM claims WHERE lease_expires <= ?").all(now) as any[];
      const remove = this.db.prepare("DELETE FROM claims WHERE task_id=?");
      const reopen = this.db.prepare("UPDATE tasks SET status='open', updated_at=datetime('now') WHERE id=? AND status='claimed'");
      const taskTitle = this.db.prepare("SELECT title FROM tasks WHERE id=?");
      const notes: { task_id: string; title: string; agent_id: string; reopened: boolean; lease_expires: string }[] = [];
      for (const claim of expired) {
        remove.run(claim.task_id);
        const reopened = reopen.run(claim.task_id).changes > 0;
        const row = taskTitle.get(claim.task_id) as { title?: string } | undefined;
        this.log("task", claim.task_id, "lease_expired", "lease-sweeper", {
          agent_id: claim.agent_id, lease_expires: claim.lease_expires, reopened,
        });
        this.notifyWatchers(claim.task_id,
          `task ${claim.task_id} lease expired (${claim.agent_id})${reopened ? " → open" : ""}`);
        notes.push({
          task_id: claim.task_id as string,
          title: row?.title ?? "",
          agent_id: claim.agent_id as string,
          reopened,
          lease_expires: claim.lease_expires as string,
        });
      }
      return { reclaimed: expired.map(claim => claim.task_id as string), notifications: notes };
    }).immediate();
    if (notifications.length > 0) {
      const policy = loadPolicy();
      for (const n of notifications) {
        void sendHumanNotification({ event: "claim_reclaimed", ...n }, policy);
      }
    }
    return { reclaimed };
  }

  postArtifact(args: { task_id?: string; agent_id: string; kind: string; title?: string; content: string }) {
    if (!isArtifactKind(args.kind)) return { error: `unknown artifact kind: ${args.kind}` };
    const id = `art-${randomUUID().slice(0, 8)}`;
    this.db
      .prepare("INSERT INTO artifacts (id, task_id, agent_id, kind, title, content) VALUES (?,?,?,?,?,?)")
      .run(id, args.task_id ?? null, args.agent_id, args.kind, args.title ?? "", args.content);
    this.index("artifact", id, args.title ?? args.kind, args.content);
    const action = args.kind === "blocked" ? "blocked" : "posted";
    this.log("artifact", id, action, args.agent_id, { task_id: args.task_id, kind: args.kind });
    if (args.kind === "blocked" && args.task_id) {
      this.log("task", args.task_id, "blocked", args.agent_id, { artifact_id: id });
      this.notifyWatchers(args.task_id, `task ${args.task_id} escalation: blocked artifact ${id}`);
    }
    return { id };
  }

  importSpecKit(args: ImportSpecKitArgs) {
    return importSpecKit(this, args);
  }

  reportEvidence(args: {
    task_id: string; agent_id: string; kind: string; command?: string;
    exit_code?: number; output?: string; ac_ids?: string[];
  }) {
    const id = `ev-${randomUUID().slice(0, 8)}`;
    this.db
      .prepare(
        "INSERT INTO evidence (id, task_id, agent_id, kind, command, exit_code, output, ac_ids, created_at) VALUES (?,?,?,?,?,?,?,?,?)"
      )
      .run(id, args.task_id, args.agent_id, args.kind, args.command ?? "",
        args.exit_code ?? null, args.output ?? "", JSON.stringify(args.ac_ids ?? []),
        new Date().toISOString());
    this.log("evidence", id, "reported", args.agent_id, { task_id: args.task_id, kind: args.kind });
    if (args.kind !== "coverage") return { id };
    const coverage = parseCoverage(args.output ?? "");
    return coverage
      ? { id, coverage }
      : { id, warning: "coverage output could not be parsed (expected vitest table, JSON summary, or a percentage)" };
  }

  /** Close a task. Requires evidence for every declared acceptance criterion. */
  completeTask(taskId: string, agentId: string, scoped = false) {
    const res = this.db.transaction(() => this.completeTaskAtomic(taskId, agentId, scoped)).immediate() as any;
    if (res && res._notify) {
      const { _notify, ...publicRes } = res;
      void sendHumanNotification(_notify, loadPolicy());
      return publicRes;
    }
    return res;
  }

  private completeTaskAtomic(taskId: string, agentId: string, scoped = false) {
    const task = this.getTask(taskId);
    if (!task) return { error: `task ${taskId} not found` };
    if (task.status === "done") return { completed: taskId };
    const claim = this.db.prepare("SELECT agent_id FROM claims WHERE task_id=?").get(taskId) as any;
    if (claim && claim.agent_id !== agentId) return { error: `task ${taskId} is claimed by ${claim.agent_id}` };

    const rows = this.getEvidence(taskId) as any[];
    const proven = new Set(rows.flatMap((r) => JSON.parse(r.ac_ids)));
    const missing = (task.ac_ids as string[]).filter((ac) => !proven.has(ac));
    if (missing.length > 0) {
      return { error: `unproven acceptance criteria: ${missing.join(", ")}. Attach evidence citing these ac_ids.` };
    }
    if ((task.ac_ids as string[]).length === 0 && rows.length === 0) {
      return { error: "no evidence attached. Done requires proof." };
    }

    const policy = loadPolicy();
    const dod = evaluateDoD({
      task, evidence: rows, artifacts: this.listArtifacts(taskId),
      claimAgent: claim?.agent_id ?? agentId, policy,
    });
    if (dod.blocked) {
      return { error: `definition of done not met (${task.type}): ${dod.missing.join("; ")}` };
    }

    this.db.prepare("UPDATE tasks SET status='done', updated_at=datetime('now') WHERE id=?").run(taskId);
    this.db.prepare("DELETE FROM claims WHERE task_id=?").run(taskId);
    this.log("task", taskId, "completed", agentId, { dod: dod.missing });
    this.notifyWatchers(taskId, `task ${taskId} → done`);
    this.unblockDependents(taskId, agentId);
    const dispatched = scoped ? undefined : this.dispatchNext(agentId, taskId, "complete");
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

  /** Assign the next open, unblocked task to the agent who just finished one. */
  private dispatchNext(agentId: string, excludeTaskId: string, trigger: "complete" | "release") {
    const policy = getDispatcherPolicy(loadPolicy());
    if (!policy.enabled) return null;
    const workload = this.agentWorkload(agentId);
    if (overCap(workload, policy.max_tasks_per_agent)) {
      this.log("task", excludeTaskId, "dispatch_capped", DISPATCHER_AGENT, {
        agent_id: agentId, workload, max: policy.max_tasks_per_agent, trigger,
      });
      return null;
    }
    for (const taskId of this.dispatchCandidates(excludeTaskId)) {
      const claimed = this.claimTaskAtomic(taskId, agentId) as { error?: string };
      if (claimed.error) continue;
      this.sendMessage(agentId, DISPATCHER_AGENT, nextTaskMessage(taskId), taskId);
      this.log("task", taskId, "dispatched", DISPATCHER_AGENT, { agent_id: agentId, trigger, from_task: excludeTaskId });
      return { task_id: taskId, agent_id: agentId };
    }
    return null;
  }

  private agentWorkload(agentId: string) {
    const claims = (this.db.prepare("SELECT COUNT(*) AS n FROM claims WHERE agent_id=?").get(agentId) as any).n as number;
    const done = (this.db.prepare(
      "SELECT COUNT(DISTINCT entity_id) AS n FROM events WHERE entity_type='task' AND action='completed' AND actor=?"
    ).get(agentId) as any).n as number;
    return Number(claims) + Number(done);
  }

  private dispatchCandidates(excludeTaskId: string) {
    const now = new Date().toISOString();
    const rows = this.db.prepare(`
      SELECT t.id FROM tasks t
      WHERE t.status = 'open' AND t.id <> ?
        AND NOT EXISTS (
          SELECT 1 FROM task_dependencies d
          JOIN tasks b ON b.id = d.blocker_id
          WHERE d.task_id = t.id AND b.status <> 'done'
        )
        AND NOT EXISTS (
          SELECT 1 FROM claims c WHERE c.task_id = t.id AND c.lease_expires > ?
        )
      ORDER BY t.priority ASC, t.created_at ASC, t.id ASC
    `).all(excludeTaskId, now) as { id: string }[];
    return rows.map((row) => row.id);
  }

  private staleNextTasks(idleMinutes: number) {
    const rows = this.db.prepare(`
      SELECT id, to_agent, task_id, body FROM messages
      WHERE from_agent = ?
        AND body LIKE 'your next task: %'
        AND created_at <= datetime('now', ?)
        AND NOT EXISTS (
          SELECT 1 FROM events e
          WHERE e.entity_type = 'message'
            AND e.entity_id = CAST(messages.id AS TEXT)
            AND e.action IN ('dispatch_idle', 'reassigned')
        )
      ORDER BY id
    `).all(DISPATCHER_AGENT, `-${idleMinutes} minutes`) as any[];
    return rows.flatMap((row) => {
      const taskId = (row.task_id as string | null) || taskIdFromNextTaskMessage(row.body);
      if (!taskId) return [];
      return [{ messageId: String(row.id), assignee: row.to_agent as string, taskId }];
    });
  }

  private rawClaim(taskId: string) {
    const row = this.db.prepare(`
      SELECT t.status AS status, c.agent_id AS claim_agent, c.lease_expires AS lease_expires
      FROM tasks t LEFT JOIN claims c ON c.task_id = t.id WHERE t.id = ?
    `).get(taskId) as any;
    if (!row) return null;
    return {
      status: row.status as string,
      claimAgent: (row.claim_agent ?? null) as string | null,
      leaseExpires: row.lease_expires ?? null,
    };
  }

  private knownAgentWorkloads() {
    const rows = this.db.prepare(`
      SELECT DISTINCT actor AS id FROM events
      WHERE entity_type = 'task' AND action IN ('claimed', 'completed', 'released')
    `).all() as { id: string }[];
    return rows
      .filter((row) => row.id && !isSystemActor(row.id))
      .map((row) => ({ id: row.id, workload: this.agentWorkload(row.id) }));
  }

  /** Mailbox "your next task" older than idle_minutes, task no longer held → reassign or log once. */
  sweepIdleDispatches() {
    const policy = getDispatcherPolicy(loadPolicy());
    if (!policy.enabled) return { reassigned: [], logged: [] };
    return this.db.transaction(() => this.sweepIdleAtomic(policy)).immediate();
  }

  private sweepIdleAtomic(policy: DispatcherPolicy) {
    const reassigned: string[] = [];
    const logged: string[] = [];
    for (const row of this.staleNextTasks(policy.idle_minutes)) {
      const task = this.rawClaim(row.taskId);
      const mark = (reason: string, extra: object = {}) => {
        this.log("message", row.messageId, "dispatch_idle", DISPATCHER_AGENT, {
          task_id: row.taskId, agent_id: row.assignee, reason, ...extra,
        });
        logged.push(row.taskId);
      };
      if (!task) { mark("missing_task"); continue; }
      if (leaseActive(task.leaseExpires) && task.claimAgent) continue;
      if (task.status !== "open" && task.status !== "claimed") {
        mark("not_open", { status: task.status });
        continue;
      }
      const next = chooseReassignAgent({
        assignee: row.assignee,
        agents: this.knownAgentWorkloads(),
        max: policy.max_tasks_per_agent,
      });
      if (!next) { mark("no_alternate_agent"); continue; }
      const claimed = this.claimTaskAtomic(row.taskId, next) as { error?: string };
      if (claimed.error) { mark("claim_failed", { error: claimed.error }); continue; }
      this.sendMessage(next, DISPATCHER_AGENT, nextTaskMessage(row.taskId), row.taskId);
      this.log("message", row.messageId, "reassigned", DISPATCHER_AGENT, {
        task_id: row.taskId, from: row.assignee, to: next,
      });
      this.log("task", row.taskId, "dispatched", DISPATCHER_AGENT, {
        agent_id: next, trigger: "idle_sweep", from_agent: row.assignee,
      });
      reassigned.push(row.taskId);
    }
    return { reassigned, logged };
  }

  listArtifacts(taskId: string) {
    return this.db.prepare("SELECT * FROM artifacts WHERE task_id=? ORDER BY created_at").all(taskId);
  }

  getEvidence(taskId: string) {
    const rows = this.db
      .prepare("SELECT * FROM evidence WHERE task_id=? ORDER BY created_at")
      .all(taskId) as any[];
    return rows.map((r) => (r.kind === "coverage" ? { ...r, coverage: parseCoverage(r.output ?? "") } : r));
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

  /** Pre-flight: what already exists? Search helpers + artifacts + indexed code symbols. */
  searchContext(query: string, kinds?: string[]) {
    const wantsSymbols = !kinds?.length || kinds.includes("symbol");
    const ftsKinds = kinds?.filter((k) => k !== "symbol");
    let rows: any[] = [];
    if (!kinds?.length || ftsKinds!.length) {
      rows = this.db
        .prepare(
          `SELECT entity_type, entity_id, title, snippet(search_idx, 3, '>>>', '<<<', '…', 20) AS snippet
           FROM search_idx WHERE search_idx MATCH ? ORDER BY rank LIMIT 20`
        )
        .all(query) as any[];
      if (ftsKinds?.length) rows = rows.filter((r) => ftsKinds.includes(r.entity_type));
    }
    if (wantsSymbols) {
      for (const s of this.searchSymbols(query, undefined, 10)) {
        rows.push({
          entity_type: "symbol", entity_id: `${s.path}:${s.line}`, title: s.name,
          snippet: `${s.kind}${s.exported ? " (exported)" : ""} ${s.path}:${s.line}-${s.end_line}`,
        });
      }
    }
    return rows;
  }

  // ---- code index (tree-sitter; see codeindex.ts) ----

  codeFileHashes(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const r of this.db.prepare("SELECT path, hash FROM code_files").all() as any[]) out[r.path] = r.hash;
    return out;
  }

  /** Replace everything known about one file atomically (incremental update unit). */
  upsertCodeFile(path: string, hash: string, symbols: SymbolRec[], refs: RefRec[], actor: string) {
    this.db.transaction(() => {
      this.db.prepare("DELETE FROM code_files WHERE path=?").run(path); // cascades symbols/refs
      this.db.prepare("INSERT INTO code_files (path, hash) VALUES (?,?)").run(path, hash);
      const si = this.db.prepare("INSERT INTO code_symbols (path,name,kind,line,end_line,exported) VALUES (?,?,?,?,?,?)");
      for (const s of symbols) si.run(path, s.name, s.kind, s.line, s.end_line, s.exported ? 1 : 0);
      const ri = this.db.prepare("INSERT INTO code_refs (path,name,line,container) VALUES (?,?,?,?)");
      for (const r of refs) ri.run(path, r.name, r.line, r.container);
      this.log("code_file", path, "indexed", actor, { symbols: symbols.length, refs: refs.length });
    })();
  }

  removeCodeFile(path: string, actor: string) {
    this.db.transaction(() => {
      this.db.prepare("DELETE FROM code_files WHERE path=?").run(path);
      this.log("code_file", path, "removed", actor);
    })();
  }

  /** Symbol definitions by name: exact matches first, then prefix, then substring. */
  searchSymbols(query: string, kind?: string, limit = 20) {
    const q = query.trim();
    if (!q) return [];
    const esc = q.replace(/[\\%_]/g, "\\$&");
    return this.db
      .prepare(
        `SELECT name, kind, path, line, end_line, exported FROM code_symbols
         WHERE name LIKE ? ESCAPE '\\' ${kind ? "AND kind = ?" : ""}
         ORDER BY (name = ?) DESC, (name LIKE ? ESCAPE '\\') DESC, exported DESC, length(name), path, line
         LIMIT ?`
      )
      .all(...[`%${esc}%`, ...(kind ? [kind] : []), q, `${esc}%`, limit])
      .map((r: any) => ({ ...r, exported: !!r.exported }));
  }

  /** Every place an identifier is referenced (calls, `new`, type uses, imports). */
  findReferences(name: string) {
    return this.db
      .prepare("SELECT path, line, container FROM code_refs WHERE name=? ORDER BY path, line")
      .all(name) as any[];
  }

  /**
   * Blast radius: transitive callers/users of `name`, breadth-first to `depth`.
   * Name-based, so same-named symbols are conflated — an over-approximation by design.
   */
  blastRadius(name: string, depth = 3) {
    const defs = this.db.prepare("SELECT path, line, kind FROM code_symbols WHERE name=?").all(name) as any[];
    const levels: { depth: number; symbol: string; path: string }[] = [];
    const visited = new Set<string>([name]);
    const files = new Set<string>(defs.map((d) => d.path));
    let frontier = [name];
    for (let d = 1; d <= depth && frontier.length; d++) {
      const next: string[] = [];
      for (const n of frontier) {
        const rows = this.db
          .prepare("SELECT DISTINCT path, container FROM code_refs WHERE name=?")
          .all(n) as any[];
        for (const r of rows) {
          files.add(r.path);
          const key = r.container || `<top-level>@${r.path}`;
          if (visited.has(key)) continue;
          visited.add(key);
          levels.push({ depth: d, symbol: r.container || "<top-level>", path: r.path });
          if (r.container) next.push(r.container);
        }
      }
      frontier = next;
    }
    return { symbol: name, definitions: defs, impacted: levels, files: [...files].sort() };
  }

  submitJob(args: SubmitJobArgs) {
    if (args.type === "node") return { error: "use submit_node_task for node jobs" };
    if (args.type === "agent" ? !args.agent?.executable || !args.agent.prompt : !args.command)
      return { error: "command required, or executable and prompt for agent jobs" };
    const id = `job-${randomUUID().slice(0, 8)}`;
    this.db.prepare(`INSERT INTO jobs (id,task_id,agent_id,type,command,host,target_agent_id,agent_spec)
      VALUES (?,?,?,?,?,?,?,?)`).run(id, args.task_id ?? null, args.agent_id, args.type,
        args.command ?? "", args.host ?? null, args.target_agent_id ?? null, args.agent ? JSON.stringify(args.agent) : null);
    this.log("job", id, "submitted", args.agent_id, args);
    return { id, status: "queued" };
  }

  nextJob(agentId: string, host?: string, ttlSeconds = 60) {
    const now = new Date().toISOString();
    const expires = new Date(Date.now() + Math.max(1, ttlSeconds) * 1000).toISOString();
    return this.db.transaction(() => {
      const job = this.db.prepare(`UPDATE jobs SET status='running', started_at=?, finished_at=NULL,
        result='', runner_id=?, lease_token=?, lease_expires=? WHERE id=(
        SELECT id FROM jobs WHERE (status='queued' OR (status='running' AND lease_expires<=?))
        AND type<>'node' AND target_node_id IS NULL
        AND (host IS NULL OR host=?) AND (target_agent_id IS NULL OR target_agent_id=?)
        ORDER BY created_at,id LIMIT 1) RETURNING *`)
        .get(now, agentId, randomUUID(), expires, now, host ?? null, agentId) as any;
      if (!job) return null;
      this.log("job", job.id, "started", agentId, { host, lease_expires: expires });
      return job;
    })();
  }

  renewJob(jobId: string, agentId: string, token: string, ttlSeconds = 60, result?: string) {
    const expires = new Date(Date.now() + Math.max(1, ttlSeconds) * 1000).toISOString();
    const updated = this.db.prepare(`UPDATE jobs SET lease_expires=?, result=COALESCE(?,result)
      WHERE id=? AND status='running' AND runner_id=? AND lease_token=? AND lease_expires>?`)
      .run(expires, result?.slice(-64000) ?? null, jobId, agentId, token, new Date().toISOString());
    if (!updated.changes) return { error: "job lease not owned or expired" };
    this.log("job", jobId, "renewed", agentId);
    return { id: jobId, lease_expires: expires };
  }

  finishJob(jobId: string, status: "done" | "failed", result: string, agentId: string, token: string) {
    return this.db.transaction(() => {
      const updated = this.db.prepare(`UPDATE jobs SET status=?, result=?, finished_at=datetime('now'), lease_expires=NULL
        WHERE id=? AND status='running' AND runner_id=? AND lease_token=? AND lease_expires>?`)
        .run(status, result.slice(-64000), jobId, agentId, token, new Date().toISOString());
      if (!updated.changes) return { error: "job lease not owned or expired" };
      this.log("job", jobId, status, agentId, { result: result.slice(0, 500) });
      const job = this.getJob(jobId) as any;
      if (job?.task_id) this.notifyWatchers(job.task_id, `job ${jobId} (${job.type}) → ${status}`);
      return { id: jobId, status };
    })();
  }

  getJob(id: string) {
    return this.db.prepare("SELECT * FROM jobs WHERE id=?").get(id) ?? null;
  }

  board() {
    const tasks = this.db
      .prepare(
        `SELECT t.id, t.title, t.status, t.priority, c.agent_id AS claimed_by, c.lease_expires,
                (SELECT COUNT(*) FROM artifacts a WHERE a.task_id = t.id AND a.kind = 'blocked') AS blocked_artifacts
         FROM tasks t LEFT JOIN claims c ON c.task_id = t.id ORDER BY t.priority, t.created_at`
      )
      .all();
    const jobs = this.db.prepare("SELECT status, COUNT(*) n FROM jobs GROUP BY status").all();
    const helpers = (this.db.prepare("SELECT COUNT(*) n FROM helpers").get() as any).n;
    return { tasks: (tasks as any[]).map(t => ({ ...t, ...this.dependencies(t.id, t.status) })), job_counts: jobs, helpers_registered: helpers, nodes: this.listNodes() };
  }

  /** Standup-style summary of board delta since a timestamp, optionally sent to an agent's mailbox. */
  digest(sinceOrArgs?: string | DigestArgs): DigestResult {
    const args = normalizeDigestArgs(sinceOrArgs);
    const board = this.board();
    const events = this.db.prepare("SELECT * FROM events ORDER BY id ASC").all();
    const built = buildDigest({
      since: args.since,
      tasks: board.tasks,
      events,
    });
    const recipient = (args.to_agent ?? args.to)?.trim() || null;
    if (recipient) {
      this.sendMessage(recipient, args.from_agent ?? "underwright", built.summary);
    }
    return { ...built, sent_to: recipient };
  }

  /** Everything the read-only web dashboard needs in one round trip. */
  dashboard(eventsLimit = 25) {
    const now = new Date().toISOString();
    const locks = this.db.prepare("SELECT * FROM locks WHERE lease_expires > ? ORDER BY resource").all(now);
    const jobs = this.db
      .prepare("SELECT * FROM jobs WHERE status IN ('queued','running') ORDER BY created_at DESC")
      .all();
    return { ...this.board(), locks, jobs, events: this.auditLog(eventsLimit) };
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
