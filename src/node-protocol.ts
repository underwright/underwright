/** Versioned node wire contract. Device credentials never authorize the admin MCP. */
import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
export const NODE_SCOPES = ['session', 'poll', 'heartbeat', 'capabilities', 'renew', 'finish'] as const;
export const nodePolicySchema = z.object({
  allowed_task_types: z.array(z.enum(['launch-agent', 'provision', 'install-harness', 'run-script'])).max(4),
  workspace_ids: z.array(z.string().min(1).max(128)).max(32),
  repository_ids: z.array(z.string().min(1).max(128)).max(32).default([]),
}).strict();
export type NodePolicy = z.input<typeof nodePolicySchema>;
export const nodeEnrollmentSchema = z.object({
  version: z.literal(1), name: z.string().min(1).max(128),
  device_secret_hash: z.string().regex(/^[a-f0-9]{64}$/),
  platform: z.string().max(32), arch: z.string().max(32),
  insecure_transport: z.boolean().default(false),
}).strict();
export type NodeEnrollmentInput = z.input<typeof nodeEnrollmentSchema>;
export type NodeError = { error: string; status_code: number };
export interface NodePrincipal { node_id: string; token_id: string; expires_at: string; session_id: string | null; policy: NodePolicy }
export interface NodeEnrollment { id: string; code: string; expires_at: string; retry_after: number }
export interface NodeCredential { version: 1; url: string; node_id: string; token: string; expires_at: string; insecure_transport: boolean }
export const nodeCredentialSchema = z.object({ version: z.literal(1), url: z.string().url(), node_id: z.string(), token: z.string().regex(/^uw_node_[a-f0-9]{64}$/), expires_at: z.string().datetime(), insecure_transport: z.boolean() }).strict();
export const NODE_JOB_KINDS = ['launch-agent', 'provision', 'install-harness', 'run-script'] as const;
export const NODE_RESULT_LIMIT = 64000;
export const NODE_POLL_MAX_WAIT = 25;
export const NODE_LEASE_SECONDS = 60;
export const nodeSpecSchema = z.object({
  version: z.literal(1),
  kind: z.enum(NODE_JOB_KINDS),
  workspace_id: z.string().min(1).max(128).optional(),
  timeout_seconds: z.number().int().min(1).max(3600).optional(),
  idempotency_key: z.string().min(1).max(128).optional(),
  payload: z.record(z.string(), z.unknown()).default({}),
}).strict().superRefine((value, ctx) => {
  if (JSON.stringify(value.payload).length > 8192) {
    ctx.addIssue({ code: 'custom', message: 'payload too large', path: ['payload'] });
  }
});
export type NodeSpec = z.output<typeof nodeSpecSchema>;
/** Protocol cap on a node's advertised worker slots (gh-91). */
export const NODE_MAX_CONCURRENCY = 8;
export const nodePollSchema = z.object({
  session_id: z.string().min(1).max(64),
  wait_seconds: z.number().int().min(0).max(NODE_POLL_MAX_WAIT).default(0),
  /** Job ids this daemon already holds (gh-91). The lease path skips
   *  re-delivering held jobs the caller is already running, so idle slots
   *  wait for real work instead of livelock-looping on a held job. */
  held_job_ids: z.array(z.string().max(64)).max(NODE_MAX_CONCURRENCY).default([]),
}).strict();
export const nodeRenewSchema = z.object({
  session_id: z.string().min(1).max(64),
  lease_token: z.string().min(1).max(128),
  result: z.string().max(NODE_RESULT_LIMIT).optional(),
}).strict();
export const nodeFinishSchema = z.object({
  session_id: z.string().min(1).max(64),
  lease_token: z.string().min(1).max(128),
  status: z.enum(['done', 'failed']),
  result: z.string().max(NODE_RESULT_LIMIT),
  result_metadata: z.record(z.string(), z.unknown()).optional(),
}).strict().superRefine((value, ctx) => {
  if (value.result_metadata && JSON.stringify(value.result_metadata).length > 4096) {
    ctx.addIssue({ code: 'custom', message: 'result_metadata too large', path: ['result_metadata'] });
  }
});
export const nodeHash = (value: string) => createHash('sha256').update(value).digest('hex');
export const nodeSecret = () => randomBytes(32).toString('hex');
export const nodeExpiry = (seconds: number) => new Date(Date.now() + seconds * 1000).toISOString();
export const NODE_ONLINE_MS = 45_000;
export const NODE_STALE_MS = 120_000;
export const nodeHeartbeatSchema = z.object({
  session_id: z.string().min(1).max(64),
  capabilities_version: z.number().int().nonnegative().optional(),
  active_job_id: z.string().max(64).optional(),
  phase: z.enum(['idle', 'polling', 'running']).optional(),
}).strict();
export const nodeHarnessSchema = z.object({
  id: z.string().min(1).max(64),
  version: z.string().max(64).default('unknown'),
  installed: z.boolean().default(false),
  auth_status: z.enum(['ready', 'missing', 'unknown']).default('unknown'),
  quota: z.object({
    state: z.enum(['available', 'unknown', 'stale', 'exhausted']).default('unknown'),
    observed_at: z.string().optional(),
    /** When the operator says the quota window resets; exhausted entries with
     *  a past resets_at are eligible again (the next attest clears the state). */
    resets_at: z.string().optional(),
  }).strict().default({ state: 'unknown' }),
}).strict();
export const nodeInventorySchema = z.object({
  protocol_version: z.literal(1).default(1),
  daemon_version: z.string().max(32).optional(),
  os: z.string().max(32).optional(),
  arch: z.string().max(32).optional(),
  labels: z.array(z.string().max(64)).max(16).default([]),
  supported_operation_kinds: z.array(z.enum(NODE_JOB_KINDS)).max(4).default([]),
  approved_workspace_ids: z.array(z.string().max(128)).max(32).default([]),
  max_concurrency: z.number().int().min(1).max(NODE_MAX_CONCURRENCY).default(1),
  current_slots: z.number().int().min(0).max(NODE_MAX_CONCURRENCY).default(0),
  harnesses: z.array(nodeHarnessSchema).max(16).default([]),
}).strict();
export const nodeCapabilitiesSchema = z.object({
  session_id: z.string().min(1).max(64),
  version: z.number().int().nonnegative(),
  inventory: nodeInventorySchema,
}).strict();
export function nodePresence(lastSeenAt: unknown, now = Date.now()) {
  const seen = lastSeenAt ? Date.parse(isoTimestamp(lastSeenAt) ?? '') : NaN;
  const age = Number.isFinite(seen) ? now - seen : Number.POSITIVE_INFINITY;
  if (age <= NODE_ONLINE_MS) return 'online';
  if (age <= NODE_STALE_MS) return 'stale';
  return 'offline';
}
export function projectNode(node: any, now = Date.now()) {
  const last_seen_at = isoTimestamp(node.last_seen_at);
  const capabilities_observed_at = isoTimestamp(node.capabilities_observed_at);
  const presence = nodePresence(last_seen_at, now);
  const liveness = node.state === 'revoked' ? 'revoked' : node.state === 'draining' ? `draining:${presence}` : presence;
  const capAge = capabilities_observed_at ? now - Date.parse(capabilities_observed_at) : Number.POSITIVE_INFINITY;
  const capabilities_freshness = !capabilities_observed_at ? 'unknown' : capAge <= NODE_STALE_MS ? 'fresh' : 'stale';
  let inventory: any = {};
  try { inventory = typeof node.capabilities_json === 'string' ? JSON.parse(node.capabilities_json || '{}') : (node.capabilities_json ?? {}); }
  catch { inventory = {}; }
  const harnesses = Array.isArray(inventory.harnesses) ? inventory.harnesses.map((h: any) => ({
    id: h.id, version: h.version ?? 'unknown', installed: Boolean(h.installed),
    auth_status: h.auth_status ?? 'unknown', quota: h.quota ?? { state: 'unknown' },
  })) : [];
  return {
    id: node.id, name: node.name, state: node.state, liveness,
    last_seen_at, last_heartbeat_age_ms: last_seen_at ? now - Date.parse(last_seen_at) : null,
    current_job_id: node.current_job_id ?? null,
    capabilities_version: node.capabilities_version ?? 0,
    capabilities_freshness, capabilities_observed_at,
    supported_operation_kinds: inventory.supported_operation_kinds ?? [],
    harnesses,
  };
}
/** Quota gate shared by routing and job submission: available/unknown always
 *  pass; exhausted blocks until its resets_at window has passed. */
export function quotaAllows(quota: { state?: string; resets_at?: string } | undefined, now = Date.now()): boolean {
  const state = quota?.state ?? 'unknown';
  if (state === 'available' || state === 'unknown') return true;
  if (state === 'exhausted' && quota?.resets_at) {
    const resets = Date.parse(quota.resets_at);
    return Number.isFinite(resets) && resets <= now;
  }
  return false;
}

export const nodeError = (error = 'unauthorized', status_code = 401): NodeError => ({ error, status_code });
export const boundNodeResult = (value: string) => value
  .replace(/uw_(?:node|worker)_[a-f0-9]+/g, '[redacted]')
  .replace(/\b(Bearer\s+)[A-Za-z0-9._~+\/=-]{8,}/gi, '$1[redacted]')
  .slice(-NODE_RESULT_LIMIT);
export const nodeReceiptDigest = (attemptId: string, status: string, result: string) =>
  nodeHash(`${attemptId}:${status}:${result}`);
export function isoTimestamp(value: unknown): string | null {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString();
  return String(value);
}
export function publicNodeJob(job: any) {
  if (!job) return null;
  let node_spec = job.node_spec;
  if (typeof node_spec === 'string') {
    try { node_spec = JSON.parse(node_spec); } catch { node_spec = {}; }
  }
  return {
    id: job.id, type: job.type, status: job.status, task_id: job.task_id ?? null,
    agent_id: job.agent_id, target_node_id: job.target_node_id, runner_id: job.runner_id ?? null,
    attempt_id: job.attempt_id ?? null, lease_token: job.lease_token ?? null,
    lease_expires: isoTimestamp(job.lease_expires), session_id: job.session_id ?? null,
    node_spec, result: job.result ?? '', outcome_reason: job.outcome_reason ?? null,
    receipt_digest: job.receipt_digest ?? null, receipt_status: job.receipt_status ?? null,
    retry_of: job.retry_of ?? null, created_at: isoTimestamp(job.created_at),
  };
}
export async function sleepSignal(ms: number, signal?: AbortSignal) {
  if (signal?.aborted) throw Object.assign(new Error('canceled'), { canceled: true });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
    const onAbort = () => { clearTimeout(timer); reject(Object.assign(new Error('canceled'), { canceled: true })); };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** Node fields needed for capability routing — what submit_node_task selects over. */
export interface NodeCandidate {
  id: string;
  policy_json: string;
  capabilities_json?: string | null;
  capabilities_observed_at?: string | null;
  last_seen_at?: string | null;
}

/** Shared policy+capability gate: may this node run spec?
 *  Mirrors the per-store nodePolicyAllows; kept here so both stores and the
 *  router apply one rule. Launch-agent additionally needs fresh capability
 *  observation plus an installed/auth-ready harness. */
export function nodeSpecAllowed(
  policy: NodePolicy,
  spec: { kind: string; workspace_id?: string; payload?: Record<string, unknown> },
  capabilitiesJson?: string,
  observedAt?: unknown,
  now = Date.now(),
): boolean {
  if (!policy.allowed_task_types.includes(spec.kind as NodePolicy["allowed_task_types"][number])) return false;
  if (spec.workspace_id && !policy.workspace_ids.includes(spec.workspace_id)) return false;
  try {
    const capabilities = JSON.parse(capabilitiesJson || "{}");
    if (spec.kind === 'launch-agent') {
      const harness = capabilities.harnesses?.find((h: any) => h.id === spec.payload?.harness);
      const observed = observedAt ? Date.parse(isoTimestamp(observedAt) ?? '') : NaN;
      if (!Number.isFinite(observed) || now - observed > NODE_STALE_MS || !harness?.installed || harness.auth_status !== 'ready' || !quotaAllows(harness.quota, now)) return false;
    }
    const kinds = capabilities.supported_operation_kinds;
    if (Array.isArray(kinds) && kinds.length && !kinds.includes(spec.kind)) return false;
  } catch { return false; }
  return true;
}

/** Pick the best eligible approved node for spec, or null when none can run it.
 *  Preference: online nodes with a free slot first, then online-busy, then
 *  offline (work queues until they return); deterministic id order breaks ties. */
export function selectNode(candidates: NodeCandidate[], spec: NodeSpec, now = Date.now()): string | null {
  const eligible = candidates.filter(n => {
    try { return nodeSpecAllowed(JSON.parse(n.policy_json), spec, n.capabilities_json ?? "{}", n.capabilities_observed_at, now); }
    catch { return false; }
  });
  if (!eligible.length) return null;
  const rank = (n: NodeCandidate) => {
    const online = nodePresence(n.last_seen_at, now) === 'online' ? 2 : 0;
    let free = 0;
    try {
      const caps = JSON.parse(n.capabilities_json || "{}");
      const max = Number(caps.max_concurrency ?? 1), cur = Number(caps.current_slots ?? 0);
      free = Number.isFinite(max) && Number.isFinite(cur) && cur < max ? 1 : 0;
    } catch { free = 1; }
    return online + free;
  };
  eligible.sort((a, b) => rank(b) - rank(a) || a.id.localeCompare(b.id));
  return eligible[0].id;
}
