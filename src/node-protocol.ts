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
export const nodePollSchema = z.object({
  session_id: z.string().min(1).max(64),
  wait_seconds: z.number().int().min(0).max(NODE_POLL_MAX_WAIT).default(0),
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
export const nodeError = (error = 'unauthorized', status_code = 401): NodeError => ({ error, status_code });
export const boundNodeResult = (value: string) => value.slice(-NODE_RESULT_LIMIT);
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
    target_node_id: job.target_node_id, runner_id: job.runner_id ?? null,
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
