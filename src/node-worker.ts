/** Separate task-scoped MCP surface. Every invocation rechecks the durable lease. */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { IStore } from './istore.js';

export function createWorkerServer(store: IStore, token: string) {
  const server = new McpServer({ name: 'underwright-worker', version: '1.0.0' });
  const scope = { task_id: z.string().optional(), agent_id: z.string().optional() };
  const register = (name: string, schema: Record<string, z.ZodType>) => {
    server.tool(name, schema, async args => {
      const result = await store.workerTool(token, name, args);
      return { content: [{ type: 'text' as const, text: JSON.stringify(result) }], ...(result?.error ? { isError: true } : {}) };
    });
  };
  for (const name of ['board', 'get_task', 'get_evidence', 'list_artifacts', 'claim_task', 'renew_lease', 'release_task', 'complete_task']) register(name, scope);
  register('post_artifact', { ...scope, kind: z.enum(['spec', 'design', 'handoff', 'note', 'review', 'blocked']), title: z.string().max(512).optional(), content: z.string().max(64000) });
  register('report_evidence', { ...scope, kind: z.enum(['test_run', 'ci_check', 'review', 'coverage', 'deploy', 'contract_test', 'security_scan', 'smoke_test', 'mutation']), command: z.string().max(8192).optional(), exit_code: z.number().int().optional(), output: z.string().max(64000).optional(), ac_ids: z.array(z.string()).max(128).optional() });
  register('record_progress', { ...scope, status: z.enum(['started', 'progress', 'blocked', 'done', 'cancelled']), summary: z.string().min(1).max(500), details: z.string().max(20000).optional(), operation_id: z.string().max(64).optional() });
  return server;
}
