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
export const nodeHash = (value: string) => createHash('sha256').update(value).digest('hex');
export const nodeSecret = () => randomBytes(32).toString('hex');
export const nodeExpiry = (seconds: number) => new Date(Date.now() + seconds * 1000).toISOString();
export const nodeError = (error = 'unauthorized', status_code = 401): NodeError => ({ error, status_code });
