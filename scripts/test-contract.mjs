import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const agent = 'contract-A';
const other = 'contract-B';

async function matrix(token) {
  const dir = await mkdtemp(join(tmpdir(), 'uw-http-contract-'));
  const clients = [];
  let child;
  let exited;
  let logs = '';
  try {
    // Reserve a scratch port, then release it immediately before booting the CLI.
    const reservation = createServer();
    reservation.listen(0, '127.0.0.1');
    await once(reservation, 'listening');
    const port = reservation.address().port;
    await new Promise((resolve, reject) => reservation.close(e => e ? reject(e) : resolve()));
    const base = `http://127.0.0.1:${port}`;
    child = spawn(process.execPath, ['dist/cli.js', 'serve', '--http', `127.0.0.1:${port}`], {
      cwd: root,
      env: { ...process.env, DATABASE_URL: '', UNDERWRIGHT_DB: join(dir, 'scratch.db'),
        UNDERWRIGHT_POLICY: join(dir, 'no-policy.json'), UNDERWRIGHT_TOKEN: token ?? '' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    exited = new Promise(resolve => {
      child.once('exit', (code, signal) => resolve({ code, signal }));
      child.once('error', error => resolve({ error }));
    });
    child.stdout.on('data', chunk => { logs += chunk; });
    child.stderr.on('data', chunk => { logs += chunk; });
    const deadline = Date.now() + 120_000;
    while (!logs.includes('MCP over HTTP at')) {
      assert.equal(child.exitCode, null, `server exited: ${logs}`);
      assert.equal(child.signalCode, null, `server killed: ${logs}`);
      assert(Date.now() < deadline, `server startup timed out: ${logs}`);
      await delay(50);
    }
    const request = (path, options = {}) => fetch(`${base}${path}`, {
      ...options, signal: AbortSignal.timeout(10_000),
    });
    const health = await request('/health');
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { ok: true });
    assert.equal((await request('/missing')).status, 404);
    const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream',
      ...(token ? { authorization: `Bearer ${token}` } : {}) };
    if (token) {
      for (const authorization of [undefined, 'Bearer wrong-token']) {
        const denied = await request('/mcp', { method: 'POST',
          headers: { 'content-type': 'application/json', ...(authorization ? { authorization } : {}) }, body: '{}' });
        assert.equal(denied.status, 401);
        assert.equal(denied.headers.get('www-authenticate'), 'Bearer');
        assert.deepEqual(await denied.json(), { error: 'unauthorized' });
      }
    }
    assert.equal((await request('/mcp', { method: 'POST', headers, body: '{invalid' })).status, 400);
    assert.equal((await request('/mcp', { method: 'PUT', headers })).status, 405);

    async function connect(name) {
      const client = new Client({ name, version: '1.0.0' });
      clients.push(client);
      const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
        requestInit: { headers },
      });
      await client.connect(transport);
      assert.equal(transport.sessionId, undefined, 'HTTP must remain stateless');
      assert.equal(client.getServerVersion().name, 'underwright');
      return client;
    }
    const first = await connect(agent);
    const second = await connect(other);
    const listed = await first.listTools();
    assert(listed.tools.length > 0);
    const exercised = new Set();
    async function call(name, args = {}, client = first) {
      const result = await client.callTool({ name, arguments: args });
      assert(!result.isError, `${name}: ${JSON.stringify(result)}`);
      assert.equal(result.content[0].type, 'text');
      exercised.add(name);
      return JSON.parse(result.content[0].text);
    }
    const invalid = await first.callTool({ name: 'create_task', arguments: {} });
    assert.equal(invalid.isError, true);
    const unknown = await first.callTool({ name: 'does_not_exist', arguments: {} });
    assert.equal(unknown.isError, true);
    assert.deepEqual((await call('board')).tasks, []);
    const task = await call('create_task', { title: 'HTTP matrix', ac_ids: ['http-ac'],
      type: 'triage', estimate: 'S', created_by: agent });
    assert.match(task.id, /^task-/);
    const task_id = task.id;
    assert.equal((await call('get_task', { task_id }, second)).title, 'HTTP matrix');
    assert.equal((await call('update_task', { task_id, actor: agent, title: 'Updated HTTP matrix' })).title,
      'Updated HTTP matrix');
    assert((await call('list_tasks', { status: 'open' })).some(t => t.id === task_id));
    assert.equal((await call('claim_task', { task_id, agent_id: agent })).agent_id, agent);
    assert.match((await call('claim_task', { task_id, agent_id: other }, second)).error, /claimed by/);
    assert.equal((await call('get_task', { task_id }, second)).claim.agent_id, agent);
    const renewed = await call('renew_lease', { task_id, agent_id: agent, ttl_seconds: 3600 });
    assert(Date.parse(renewed.lease_expires) > Date.now());
    assert.match((await call('renew_lease', { task_id, agent_id: other })).error, /not claimed/);
    assert.match((await call('release_task', { task_id, agent_id: other })).error, /claimed by/);
    assert.equal((await call('release_task', { task_id, agent_id: agent })).released, task_id);
    assert.equal((await call('get_task', { task_id })).status, 'open');
    await call('claim_task', { task_id, agent_id: agent });

    const resources = ['contract/resource.ts'];
    assert.deepEqual(await call('check_locks', { resources }), []);
    assert.deepEqual((await call('claim_resources', { resources, agent_id: agent, task_id })).claimed, resources);
    assert.equal((await call('claim_resources', { resources, agent_id: other }, second)).error, 'locked');
    assert.equal((await call('check_locks', { resources }, second))[0].agent_id, agent);
    await call('release_resources', { resources, agent_id: agent });
    assert.deepEqual(await call('check_locks', { resources }), []);

    assert.match((await call('post_artifact', { task_id, agent_id: agent, kind: 'design',
      title: 'matrixartifact', content: 'HTTP contract design matrixartifact' })).id, /^art-/);
    assert((await call('search_context', { query: 'matrixartifact', kinds: ['artifact'] })).some(h => h.entity_type === 'artifact'));
    assert.match((await call('register_helper', { agent_id: agent, path: 'contract/helper.ts',
      symbol: 'matrixhelper', kind: 'fixture', summary: 'matrixhelper HTTP fixture' })).id, /^hlp-/);
    assert((await call('search_context', { query: 'matrixhelper', kinds: ['helper'] })).some(h => h.entity_type === 'helper'));

    assert.equal((await call('send_message', { to: other, from: agent, body: 'HTTP handoff', task_id })).sent, other);
    assert.equal((await call('inbox', { agent_id: other }, second))[0].body, 'HTTP handoff');
    assert.deepEqual(await call('inbox', { agent_id: other }, second), []);
    assert.equal((await call('inbox', { agent_id: other, unread_only: false })).length, 1);
    assert.equal((await call('watch_task', { agent_id: other, task_id })).watching, task_id);

    const job = await call('submit_job', { task_id, agent_id: agent, type: 'test', command: 'echo contract' });
    assert.equal(job.status, 'queued');
    const status = await call('job_status', { job_id: job.id }, second);
    assert.equal(status.status, 'queued');
    assert.equal(status.command, 'echo contract');
    assert.equal((await call('job_status', { job_id: 'missing' })).error, 'not found');
    assert.match((await call('complete_task', { task_id, agent_id: agent })).error, /http-ac/);
    assert.match((await call('report_evidence', { task_id, agent_id: agent, kind: 'contract_test',
      command: 'HTTP matrix', exit_code: 0, output: 'verified', ac_ids: ['http-ac'] })).id, /^ev-/);
    assert.match((await call('complete_task', { task_id, agent_id: other })).error, /claimed by/);
    assert.equal((await call('complete_task', { task_id, agent_id: agent })).completed, task_id);
    const completed = await call('get_task', { task_id }, second);
    assert.equal(completed.status, 'done');
    assert.equal(completed.claim, null);
    assert((await call('audit_log', { limit: 100 })).some(e => e.entity_id === task_id && e.action === 'completed'));
    const board = await call('board', {}, second);
    assert.equal(board.tasks.find(t => t.id === task_id).status, 'done');
    assert.equal(board.helpers_registered, 1);
    assert(board.job_counts.some(j => j.status === 'queued' && j.n === 1));
    assert.deepEqual([...exercised].sort(), listed.tools.map(t => t.name).sort(),
      'Every advertised tool must have a contract case');
    console.log(`PASS ${token ? 'bearer auth' : 'no auth'}: initialize, ${exercised.size} tools, shared state, rejection paths, HTTP checks`);
  } catch (error) {
    if (logs) console.error(`Server output:\n${logs}`);
    throw error;
  } finally {
    await Promise.allSettled(clients.map(client => client.close()));
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      await Promise.race([exited, delay(5_000)]);
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
        await exited;
      }
    }
    await rm(dir, { recursive: true, force: true });
  }
}

await matrix();
await matrix('contract-only-test-token');
console.log('HTTP contract matrix passed.');
