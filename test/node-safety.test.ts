import { afterEach, expect, it, vi } from 'vitest';
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteStore } from '../src/store.js';
import { serveHttp } from '../src/server.js';
import { saveNodeCredential } from '../src/node-client.js';
import { runNode } from '../src/node-run.js';
import { AttemptJournal, processStart } from '../src/node-journal.js';
import { nodeHash, nodeSecret } from '../src/node-protocol.js';
const cleanup: (() => unknown)[] = [];
afterEach(async () => { for (const f of cleanup.splice(0).reverse()) await f(); });
async function until(check: () => boolean, ms = 6000) {
  const deadline = Date.now() + ms;
  while (!check()) { if (Date.now() > deadline) throw new Error('fixture timed out'); await new Promise(r => setTimeout(r, 20)); }
}
async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'uw-safety-')); cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'db'); const store = new SqliteStore(path); cleanup.push(() => store.close());
  const http = await serveHttp(path, '127.0.0.1', 0, 'admin');
  cleanup.push(() => new Promise<void>(resolve => { http.close(() => resolve()); http.closeAllConnections(); }));
  const secret = nodeSecret(); const e = store.createNodeEnrollment({ version: 1, name: 'fixture', device_secret_hash: nodeHash(secret), platform: 'linux', arch: 'x64' });
  store.approveNodeEnrollment(e.id, e.code, { allowed_task_types: ['run-script', 'launch-agent', 'install-harness', 'provision'], workspace_ids: ['w'], repository_ids: ['r'] }, 'admin');
  const node = store.exchangeNodeEnrollment(e.id, secret);
  saveNodeCredential({ version: 1, url: `http://127.0.0.1:${(http.address() as any).port}`, node_id: node.node_id, token: node.token, expires_at: node.expires_at, insecure_transport: true }, dir);
  const shutdown = new AbortController();
  const config: any = { workspaces: { w: dir }, scripts: { fixture: { executable: process.execPath, args: ['-e', 'console.log("ok")'] } } };
  const submit = (kind: any = 'run-script', payload: any = { workspace_id: 'w', script: 'fixture' }, extra = {}) => store.submitNodeTask({ target_node_id: node.node_id, node_spec: { version: 1, kind, workspace_id: 'w', payload }, ...extra });
  const start = (extra = {}) => {
    const running = runNode({ dir, config, signal: shutdown.signal, heartbeatMs: 50, capabilitiesMs: 100, renewMs: 40, ...extra });
    cleanup.push(async () => { shutdown.abort(); await running.catch(() => undefined); }); return running;
  };
  return { dir, store, node, shutdown, config, submit, start };
}
it.each(['shutdown', 'lease'])('stops a TERM-resistant real child on %s and journals the attempt', async why => {
  const f = await fixture(); const pidPath = join(f.dir, 'pid');
  f.config.scripts.fixture.args = ['-e', `require('fs').writeFileSync(${JSON.stringify(pidPath)},String(process.pid));process.on('SIGTERM',()=>{});setInterval(()=>{},1000)`];
  const job = f.submit(); const running = f.start();
  await until(() => existsSync(pidPath)); const pid = Number(readFileSync(pidPath, 'utf8'));
  if (why === 'shutdown') { f.shutdown.abort(); await running; }
  else (f.store as any).nodeQuery('UPDATE jobs SET lease_expires=? WHERE id=?', ['2000-01-01T00:00:00Z', job.id]);
  await until(() => { try { process.kill(pid, 0); return false; } catch { return true; } });
  expect(() => process.kill(pid, 0)).toThrow();
  const leased = f.store.getJob(job.id);
  await until(() => new AttemptJournal(join(f.dir, 'attempts')).read(job.id, leased.attempt_id)?.phase === 'finished');
  const record = new AttemptJournal(join(f.dir, 'attempts')).read(job.id, leased.attempt_id)!;
  expect(record.phase).toBe('finished'); expect(record.outcome?.status).toBe('failed');
}, 12000);
it('executes all four typed operations through real HTTP daemon leases with literal argv and worker-only credentials', async () => {
  const f = await fixture();
  f.store.createTask({ id: 'launch-task', title: 'launch task' });
  const inventory = { harnesses: [{ id: 'fixture', installed: true, auth_status: 'ready', quota: { state: 'available' } }] };
  f.config.inventory = inventory;
  f.config.harnesses = { fixture: { executable: process.execPath, args: ['-e', 'console.log(process.env.UNDERWRIGHT_MCP_URL, process.env.UNDERWRIGHT_TASK_ID, process.env.UNDERWRIGHT_TOKEN, process.argv[1])', '--'] } };
  f.config.installers = { fixture: { executable: process.execPath, args: ['-e', 'console.log("installed fixture")'] } };
  const source = join(f.dir, 'source'); execFileSync('git', ['init', '-q', source]);
  execFileSync('git', ['-C', source, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'fixture']);
  f.config.repositories = { r: source };
  f.start();
  await until(() => f.store.listNodes()[0].capabilities_freshness === 'fresh');
  const prompt = '$(touch injected); `echo bad`';
  const jobs = [f.submit(), f.submit('install-harness', { harness: 'fixture' }), f.submit('provision', { workspace_id: 'w', repository_id: 'r', dest: 'clone' }), f.submit('launch-agent', { workspace_id: 'w', harness: 'fixture', prompt }, { task_id: 'launch-task', agent_id: 'fixture-worker' })];
  for (const job of jobs) expect(job.error).toBeUndefined();
  await until(() => jobs.every(j => f.store.getJob(j.id).status === 'done'));
  const result = f.store.getJob(jobs[3].id).result;
  expect(result).toContain('/worker/mcp launch-task [redacted]');
  expect(result).toContain(prompt); expect(result).not.toContain(f.node.token);
  expect(existsSync(join(f.dir, 'injected'))).toBe(false);
  expect(existsSync(join(f.dir, 'clone', '.git'))).toBe(true);
  f.shutdown.abort();
});
it('reconciles interrupted local process identity and preserves uncertain and finished receipts across reopen', async () => {
  const f = await fixture();
  const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { detached: true, stdio: 'ignore' });
  cleanup.push(() => { try { process.kill(-child.pid!, 'SIGKILL'); } catch {} });
  await until(() => Boolean(child.pid && processStart(child.pid)));
  const journal = new AttemptJournal(join(f.dir, 'attempts'));
  journal.write({ job_id: 'lost', attempt_id: 'old', phase: 'started', pid: child.pid, process_start: processStart(child.pid!) });
  journal.write({ job_id: 'done', attempt_id: 'saved', phase: 'finished', outcome: { status: 'done', result: 'saved receipt' } });
  const closed = new Promise(resolve => child.once('close', resolve));
  f.start(); await closed;
  expect(new AttemptJournal(join(f.dir, 'attempts')).read('lost', 'old')?.phase).toBe('uncertain');
  expect(journal.read('done', 'saved')?.outcome?.result).toBe('saved receipt');
  f.shutdown.abort();
});
it('does not execute duplicate delivery when a durable receipt exists', async () => {
  const f = await fixture(); const job = f.submit(); let calls = 0;
  f.start({ executor: async (leased: any) => { calls++; return { status: 'done', result: 'receipt' }; } });
  await until(() => f.store.getJob(job.id).status === 'done');
  expect(calls).toBe(1);
  const done = f.store.getJob(job.id);
  const session = done.session_id;
  expect(f.store.finishNodeJob(f.node.token, session, job.id, done.lease_token, 'done', 'receipt').idempotent).toBe(true);
  expect(calls).toBe(1);
  f.shutdown.abort();
});

it('reuses journaled outcomes when finish upload fails before acknowledgment', async () => {
  const f = await fixture(); let executions = 0; let finishes = 0;
  const original = globalThis.fetch;
  const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    if (String(input).endsWith('/finish') && finishes++ === 0) return new Response(JSON.stringify({ error: 'temporary' }), { status: 503, headers: { 'content-type': 'application/json', 'retry-after': '1' } });
    return original(input, init);
  });
  cleanup.push(() => spy.mockRestore());
  const job = f.submit();
  f.start({ executor: async () => { executions++; return { status: 'done', result: 'saved once' }; } });
  await until(() => f.store.getJob(job.id).status === 'done');
  expect(executions).toBe(1); expect(finishes).toBeGreaterThanOrEqual(2);
  f.shutdown.abort();
});
it('refuses automatic execution of a previously interrupted attempt delivered again', async () => {
  const f = await fixture(); let executions = 0;
  const original = globalThis.fetch;
  const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const response = await original(input, init);
    if (String(input).endsWith('/poll') && response.status === 200) {
      const job = await response.clone().json() as any;
      new AttemptJournal(join(f.dir, 'attempts')).write({ job_id: job.id, attempt_id: job.attempt_id, phase: 'uncertain' });
    }
    return response;
  });
  cleanup.push(() => spy.mockRestore());
  const job = f.submit();
  f.start({ executor: async () => { executions++; return { status: 'done', result: 'should never run' }; } });
  await until(() => f.store.getJob(job.id).status === 'failed');
  expect(executions).toBe(0); expect(f.store.getJob(job.id).result).toContain('automatic replay refused');
  f.shutdown.abort();
});
