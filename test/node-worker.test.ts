import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SqliteStore } from '../src/store.js';
import { serveHttp } from '../src/server.js';
import { nodeHash, nodeSecret } from '../src/node-protocol.js';
const cleanup: (() => unknown)[] = [];
afterEach(async () => { for (const f of cleanup.splice(0).reverse()) await f(); });
async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'uw-worker-')); cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'db'); const store = new SqliteStore(path); cleanup.push(() => store.close());
  const http = await serveHttp(path, '127.0.0.1', 0, 'admin');
  cleanup.push(() => new Promise<void>(resolve => { http.close(() => resolve()); http.closeAllConnections(); }));
  const url = `http://127.0.0.1:${(http.address() as any).port}`;
  const post = (path: string, body: unknown, token: string) => fetch(url + path, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token }, body: JSON.stringify(body) });
  store.createTask({ id: 'mine', title: 'mine', ac_ids: ['proof'], type: 'docs' });
  store.createTask({ id: 'other', title: 'secret other task' });
  const secret = nodeSecret();
  const e = store.createNodeEnrollment({ version: 1, name: 'node', device_secret_hash: nodeHash(secret), platform: 'linux', arch: 'x64' });
  store.approveNodeEnrollment(e.id, e.code, { allowed_task_types: ['launch-agent'], workspace_ids: ['w'] }, 'admin');
  const node = store.exchangeNodeEnrollment(e.id, secret);
  const session = store.startNodeSession(node.token);
  const inventory = { harnesses: [{ id: 'fixture', installed: true, auth_status: 'ready', quota: { state: 'available' } }] };
  store.putNodeCapabilities(node.token, session.session_id, 1, inventory);
  const args = { target_node_id: node.node_id, task_id: 'mine', agent_id: 'worker', node_spec: { version: 1 as const, kind: 'launch-agent' as const, workspace_id: 'w', payload: { workspace_id: 'w', harness: 'fixture', prompt: 'test' } } };
  const submitted = store.submitNodeTask(args);
  const job = await store.pollNodeJob(node.token, session.session_id);
  const issued = await (await post(`/nodes/v1/jobs/${job.id}/worker`, { session_id: session.session_id, lease_token: job.lease_token }, node.token)).json() as any;
  async function client(token = issued.token) {
    const c = new Client({ name: 'worker-test', version: '1' });
    await c.connect(new StreamableHTTPClientTransport(new URL(url + '/worker/mcp'), { requestInit: { headers: { authorization: 'Bearer ' + token } } }));
    cleanup.push(() => c.close()); return c;
  }
  return { store, url, post, node, session, job, issued, client, args, submitted };
}
it('isolates worker MCP reads, identity and allowed mutations; stores only token hashes', async () => {
  const f = await fixture(); const c = await f.client();
  const list = await c.listTools();
  expect(list.tools.map(t => t.name)).not.toContain('submit_job');
  expect(list.tools.map(t => t.name)).not.toContain('send_message');
  expect(JSON.stringify(await c.callTool({ name: 'board', arguments: {} }))).not.toContain('secret other');
  expect(JSON.stringify(await c.callTool({ name: 'get_task', arguments: { task_id: 'other' } }))).toContain('scope mismatch');
  expect(JSON.stringify(await c.callTool({ name: 'claim_task', arguments: { agent_id: 'admin' } }))).toContain('scope mismatch');
  expect(JSON.stringify(await c.callTool({ name: 'claim_task', arguments: {} }))).toContain('mine');
  expect(JSON.stringify(await c.callTool({ name: 'post_artifact', arguments: { kind: 'note', content: 'local' } }))).toContain('art-');
  expect(f.store.listArtifacts('other')).toEqual([]);
  expect(JSON.stringify((f.store as any).nodeQuery('SELECT * FROM node_workers'))).not.toContain(f.issued.token);
  expect(JSON.stringify(f.store.auditLog(100))).not.toContain(f.issued.token);
  for (const path of ['/mcp', '/board', '/nodes/v1/session']) {
    expect((await f.post(path, { version: 1 }, f.issued.token)).status).toBe(401);
  }
  expect((await f.post('/worker/mcp', {}, f.node.token)).status).toBe(401);
  expect((await f.post(`/nodes/v1/jobs/${f.job.id}/worker`, { session_id: f.session.session_id, lease_token: 'wrong' }, f.node.token)).status).toBe(403);
});
it('scoped completion and release suppress dispatcher assignments', async () => {
  const f = await fixture(); const c = await f.client();
  await c.callTool({ name: 'claim_task', arguments: {} });
  const released = await c.callTool({ name: 'release_task', arguments: {} });
  expect(JSON.stringify(released)).not.toContain('dispatched');
  expect(f.store.inbox('worker')).toEqual([]);
  await c.callTool({ name: 'claim_task', arguments: {} });
  await c.callTool({ name: 'report_evidence', arguments: { kind: 'review', ac_ids: ['proof'], output: 'reviewed' } });
  const done = await c.callTool({ name: 'complete_task', arguments: {} });
  expect(JSON.stringify(done)).toContain('completed');
  expect(JSON.stringify(done)).not.toContain('dispatched');
  expect(f.store.inbox('worker')).toEqual([]);
  expect(f.store.getTask('other').claim).toBeNull();
});
it.each(['lease', 'session', 'attempt', 'finish', 'revoke'])('fences worker credentials after %s changes', async reason => {
  const f = await fixture();
  if (reason === 'lease') (f.store as any).nodeQuery('UPDATE jobs SET lease_expires=? WHERE id=?', ['2000-01-01T00:00:00Z', f.job.id]);
  if (reason === 'session') f.store.startNodeSession(f.node.token);
  if (reason === 'attempt') (f.store as any).nodeQuery('UPDATE jobs SET attempt_id=? WHERE id=?', ['new', f.job.id]);
  if (reason === 'finish') f.store.finishNodeJob(f.node.token, f.session.session_id, f.job.id, f.job.lease_token, 'done', 'ok');
  if (reason === 'revoke') f.store.revokeNode(f.node.node_id, 'admin');
  expect((await f.post('/worker/mcp', {}, f.issued.token)).status).toBe(401);
});
it('reserves task/agent launches despite client dedupe changes and denies stale/unready inventory', async () => {
  const f = await fixture();
  expect(f.store.submitNodeTask({ ...f.args, dedupe_key: 'different' }).id).toBe(f.submitted.id);
  const next = { ...f.args, agent_id: 'another' };
  (f.store as any).nodeQuery('UPDATE nodes SET capabilities_observed_at=?', ['2000-01-01T00:00:00Z']);
  expect(f.store.submitNodeTask(next).error).toContain('fresh ready');
  f.store.putNodeCapabilities(f.node.token, f.session.session_id, 2, { harnesses: [{ id: 'fixture', installed: true, auth_status: 'missing' }] });
  expect(f.store.submitNodeTask(next).error).toContain('fresh ready');
});
