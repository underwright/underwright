import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync, statSync, readFileSync, chmodSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { serveHttp } from '../src/server.js';
import { SqliteStore } from '../src/store.js';
import { nodeHash, nodeSecret } from '../src/node-protocol.js';
import { saveNodeCredential, readNodeCredential, nodeOrigin, nodeStatus, enrollNode } from '../src/node-client.js';
const cleanups: (() => unknown)[] = [];
afterEach(async () => { for (const f of cleanups.splice(0).reverse()) await f(); });
function temp() { const dir = mkdtempSync(join(tmpdir(), 'uw-node-http-')); cleanups.push(() => rmSync(dir, { recursive: true, force: true })); return dir; }
async function server(token?: string) {
  const dir = temp(); const path = join(dir, 'db');
  const http = await serveHttp(path, '127.0.0.1', 0, token);
  cleanups.push(() => new Promise<void>(resolve => { http.close(() => resolve()); http.closeAllConnections(); }));
  const url = `http://127.0.0.1:${(http.address() as any).port}`;
  const store = new SqliteStore(path); cleanups.push(() => store.close());
  const post = (path: string, body: unknown, token?: string) => fetch(url + path, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer '+token } : {}) }, body: JSON.stringify(body) });
  return { url, path, post, store };
}
it('requires configured admin auth and refuses scoped credentials on MCP and board including query fallback', async () => {
  const { url, post } = await server();
  expect((await post('/nodes/v1/enrollments', {})).status).toBe(503);
  for (const path of ['/mcp', '/board', '/board?token=uw_node_fake']) {
    expect((await fetch(url + path, { headers: { authorization: 'Bearer uw_node_fake' } })).status).toBe(401);
  }
  const client = new Client({ name: 'test', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(url + '/mcp'))); cleanups.push(() => client.close());
  const denied = await client.callTool({ name: 'approve_node_enrollment', arguments: { enrollment_id: 'fake', code: 'fake', policy: { allowed_task_types: [], workspace_ids: [] } } });
  expect(JSON.stringify(denied)).toContain('Configure UNDERWRIGHT_TOKEN');
});
it('enrolls via admin MCP; rejects spoofed identity, unknown version/fields, oversized body, replay and revoked tokens', async () => {
  const { url, path, post } = await server('admin-secret');
  const secret = nodeSecret();
  const input = { version: 1, name: 'device', device_secret_hash: nodeHash(secret), platform: 'linux', arch: 'x64' };
  expect((await post('/nodes/v1/enrollments', { ...input, node_id: 'victim' })).status).toBe(400);
  expect((await post('/nodes/v1/enrollments', { ...input, version: 2 })).status).toBe(400);
  expect((await post('/nodes/v1/enrollments', { ...input, name: 'x'.repeat(9000) })).status).toBe(413);
  const e = await (await post('/nodes/v1/enrollments', input)).json() as any;
  const client = new Client({ name: 'admin', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(url + '/mcp'), { requestInit: { headers: { authorization: 'Bearer admin-secret' } } })); cleanups.push(() => client.close());
  const approved = await client.callTool({ name: 'approve_node_enrollment', arguments: { enrollment_id: e.id, code: e.code, policy: { allowed_task_types: [], workspace_ids: [] } } });
  expect(JSON.stringify(approved)).toContain('node_id');
  const issued = await (await post(`/nodes/v1/enrollments/${e.id}/exchange`, { device_secret: secret })).json() as any;
  expect(issued.token).toMatch(/^uw_node_/);
  expect((await post('/nodes/v1/session', { version: 1, node_id: 'victim' }, issued.token)).status).toBe(400);
  expect((await post('/nodes/v1/session', { version: 1 }, issued.token)).status).toBe(200);
  expect((await post(`/nodes/v1/enrollments/${e.id}/exchange`, { device_secret: secret })).status).toBe(409);
  expect((await fetch(url + '/board?token=' + issued.token)).status).toBe(401);
  const db = new Database(path);
  const rows = JSON.stringify(db.prepare('SELECT * FROM node_tokens').all());
  expect(rows).not.toContain(issued.token); expect(rows).toContain(nodeHash(issued.token));
  db.close();
  await client.callTool({ name: 'revoke_node', arguments: { node_id: issued.node_id } });
  expect((await post('/nodes/v1/session', { version: 1 }, issued.token)).status).toBe(401);
});
it('persists atomic private credentials outside repo, redacts status and rejects symlinks/public files', () => {
  const dir = join(temp(), 'state');
  const credential = { version: 1 as const, url: 'https://control.example', node_id: 'node', token: 'uw_node_' + nodeSecret(), expires_at: new Date(Date.now() + 60000).toISOString(), insecure_transport: false };
  saveNodeCredential(credential, dir);
  expect(statSync(dir).mode & 0o777).toBe(0o700);
  expect(statSync(join(dir, 'credential.json')).mode & 0o777).toBe(0o600);
  expect(readNodeCredential(dir)).toEqual(credential);
  expect(JSON.stringify(nodeStatus(dir))).not.toContain(credential.token);
  saveNodeCredential({ ...credential, node_id: 'replacement' }, dir);
  expect(JSON.parse(readFileSync(join(dir, 'credential.json'), 'utf8')).node_id).toBe('replacement');
  chmodSync(join(dir, 'credential.json'), 0o644);
  expect(() => readNodeCredential(dir)).toThrow(/0600/);
  const link = join(temp(), 'link'); symlinkSync(dir, link);
  expect(() => saveNodeCredential(credential, link)).toThrow(/real user directory/);
  expect(() => nodeOrigin('http://host')).toThrow(/HTTPS/);
  expect(nodeOrigin('http://host', true)).toBe('http://host');
  expect(() => nodeOrigin('https://user:secret@host')).toThrow();
});
it('CLI enrollment stores scoped credential and displays approval code without credential leakage', async () => {
  const { url, store } = await server('admin-secret');
  const state = join(temp(), 'state'); const output: string[] = [];
  await enrollNode(url, 'cli-test', true, state, line => {
    output.push(line);
    const match = line.match(/Enrollment (enroll-[\w-]+)\nCompare code (\w+)/);
    if (match) store.approveNodeEnrollment(match[1], match[2], { allowed_task_types: [], workspace_ids: [] }, 'test-admin');
  });
  expect(readNodeCredential(state).node_id).toMatch(/^node-/);
  expect(output.join('\n')).not.toContain(readNodeCredential(state).token);
});
it('additive upgrade preserves task history and live legacy leases across repeated opens', () => {
  const path = join(temp(), 'upgrade.db');
  let store = new SqliteStore(path);
  store.createTask({ id: 'old', title: 'history', type: 'docs' });
  const job = store.submitJob({ agent_id: 'a', type: 'test', command: 'true' });
  const lease = store.nextJob('legacy', 'minipc');
  store.close();
  const db = new Database(path); db.exec('DROP TABLE node_tokens; DROP TABLE node_enrollments; DROP TABLE nodes; DROP TABLE node_rate_limits;'); db.close();
  store = new SqliteStore(path); cleanups.push(() => store.close());
  expect(store.getTask('old').title).toBe('history');
  expect(store.getJob(job.id).lease_token).toBe(lease.lease_token);
  expect(store.getJob(job.id).status).toBe('running');
  expect(store.listNodes()).toEqual([]);
});
