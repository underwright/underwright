import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createExecutorRegistry, containedPath, redact, sanitizedEnv, type NodeTask, type NodeTransport } from '../src/node-executors.js';

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach(d => rmSync(d, { recursive: true, force: true })));
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'uw-exec-')); dirs.push(d); return d; };
const node = process.execPath;

function setup(over: any = {}) {
  const ws = tmp();
  const cfg = {
    workspaces: { w1: ws },
    harnesses: { echo: { executable: node, args: ['-e', 'console.log(JSON.stringify(process.argv.slice(1)))', '--'] } },
    installers: { h: { executable: node, args: ['-e', 'console.log("installed")'] } },
    scripts: { env: { executable: node, args: ['-e', 'console.log(JSON.stringify(Object.keys(process.env)), process.cwd())', '--'] } },
    ...over,
  };
  const policy = { allowed_task_types: ['launch-agent', 'provision', 'install-harness', 'run-script'] as any, workspace_ids: ['w1'], repository_ids: [] as string[] };
  return { ws, cfg, policy, reg: (p = policy) => createExecutorRegistry(p, cfg) };
}
const task = (type: any, params: any): NodeTask => ({ id: 't1', type, params });

describe('node executors', () => {
  it('launch-agent passes prompt as literal argv', async () => {
    const { reg } = setup();
    const prompt = '$(touch pwned); `x` && echo hi';
    const r = await reg().execute(task('launch-agent', { workspace_id: 'w1', harness: 'echo', prompt }));
    expect(r.status).toBe('done');
    expect(JSON.parse(r.result.trim().split('\n')[0])).toEqual(['--', prompt].slice(1).length ? expect.arrayContaining([prompt]) : []);
  });
  it('install-harness runs approved installer only', async () => {
    const { reg } = setup();
    expect((await reg().execute(task('install-harness', { harness: 'h' }))).result).toContain('installed');
    const bad = await reg().execute(task('install-harness', { harness: 'evil' }));
    expect(bad.status).toBe('failed'); expect(bad.result).toMatch(/not approved/);
  });
  it('run-script uses sanitized env and contained cwd', async () => {
    const { reg, ws } = setup();
    mkdirSync(join(ws, 'sub'));
    process.env.SECRET_THING = 'leak';
    const r = await reg().execute(task('run-script', { workspace_id: 'w1', script: 'env', cwd: 'sub' }));
    delete process.env.SECRET_THING;
    expect(r.status).toBe('done');
    expect(r.result).not.toContain('SECRET_THING');
    expect(r.result).toContain('sub');
  });
  it('provision clones an approved repository (real git subprocess)', async () => {
    const src = tmp();
    const { execFileSync } = await import('node:child_process');
    execFileSync('git', ['init', '-q', src]);
    execFileSync('git', ['-C', src, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'i']);
    const { reg, ws, cfg, policy } = setup();
    cfg.repositories = { r1: src };
    const p = { ...policy, repository_ids: ['r1'] };
    const r = await createExecutorRegistry(p, cfg).execute(task('provision', { workspace_id: 'w1', repository_id: 'r1', dest: 'clone' }));
    expect(r.status).toBe('done');
    expect(existsSync(join(ws, 'clone', '.git'))).toBe(true);
    const denied = await reg(policy).execute(task('provision', { workspace_id: 'w1', repository_id: 'r1', dest: 'x' }));
    expect(denied.result).toMatch(/denied/);
  });
  it('enforces policy: type, workspace, traversal, symlink', async () => {
    const { reg, ws, policy } = setup();
    const only = reg({ ...policy, allowed_task_types: ['install-harness'] });
    expect((await only.execute(task('run-script', { workspace_id: 'w1', script: 'env' }))).result).toMatch(/not allowed/);
    expect((await reg().execute(task('run-script', { workspace_id: 'w2', script: 'env' }))).result).toMatch(/not approved/);
    expect((await reg().execute(task('run-script', { workspace_id: 'w1', script: 'env', cwd: '../..' }))).result).toMatch(/escapes/);
    const outside = tmp(); symlinkSync(outside, join(ws, 'link'));
    expect(() => containedPath(ws, 'link/x')).toThrow(/symlink/);
    expect((await reg().execute(task('run-script', { workspace_id: 'w1', script: 'env', cwd: 'link' }))).status).toBe('failed');
  });
  it('rejects unknown params without shell fallback', async () => {
    const { reg } = setup();
    const r = await reg().execute(task('run-script', { workspace_id: 'w1', script: 'env', command: 'rm -rf /' }));
    expect(r.result).toBe('invalid task parameters');
  });
  it('timeout and abort kill the process group', async () => {
    const { reg, cfg } = setup({ timeoutMs: 300 });
    cfg.scripts = { sleep: { executable: node, args: ['-e', 'setTimeout(()=>{},60000)'] } } as any;
    const t0 = Date.now();
    const r = await reg().execute(task('run-script', { workspace_id: 'w1', script: 'sleep' }));
    expect(r.status).toBe('failed'); expect(r.result).toMatch(/timed out/); expect(Date.now() - t0).toBeLessThan(5000);
    const ac = new AbortController(); setTimeout(() => ac.abort(), 100);
    cfg.timeoutMs = 60000;
    expect((await reg().execute(task('run-script', { workspace_id: 'w1', script: 'sleep' }), ac.signal)).result).toMatch(/aborted/);
  });
  it('runOnce drives a stub transport', async () => {
    const { reg } = setup();
    const finished: any[] = [];
    const queue: NodeTask[] = [task('install-harness', { harness: 'h' })];
    const transport: NodeTransport = {
      poll: async () => queue.shift() ?? null,
      renew: async () => ({ lease_expires: new Date().toISOString() }),
      finish: async (id, o) => { finished.push([id, o.status]); },
    };
    expect(await reg().runOnce(transport)).toBe(true);
    expect(await reg().runOnce(transport)).toBe(false);
    expect(finished).toEqual([['t1', 'done']]);
  });
  it('redacts credentials and filters env', () => {
    expect(redact('Bearer abcdefghijkl token=xyz uw_node_' + 'a'.repeat(64))).not.toMatch(/abcdefghijkl|xyz|aaaaaaaa/);
    expect(Object.keys(sanitizedEnv([], { PATH: '/x', FOO: 'y' }))).toEqual(['PATH']);
  });
});

it('redacts split scoped credentials before output truncation', async () => {
  const secret = 'uw_worker_' + 'a'.repeat(64);
  const cfg = { workspaces: {}, maxOutput: 12, installers: { fixture: { executable: process.execPath, args: ['-e', `process.stdout.write(${JSON.stringify(secret.slice(0, 35))});setTimeout(()=>process.stdout.write(${JSON.stringify(secret.slice(35))}),30)`] } } };
  const reg = createExecutorRegistry({ allowed_task_types: ['install-harness'], workspace_ids: [] }, cfg);
  const result = await reg.execute(task('install-harness', { harness: 'fixture' }));
  expect(result.result).toBe('[redacted]');
});

it('runOnce aborts its process and refuses stale finish when transport renewal is rejected', async () => {
  const cfg = { workspaces: {}, installers: { fixture: { executable: node, args: ['-e', 'setInterval(()=>{},1000)'] } } };
  const reg = createExecutorRegistry({ allowed_task_types: ['install-harness'], workspace_ids: [] }, cfg);
  let finishes = 0;
  const transport: NodeTransport = {
    poll: async () => ({ ...task('install-harness', { harness: 'fixture' }), lease_expires: new Date(Date.now() + 10000).toISOString() }),
    renew: async () => ({ error: 'lease lost' }),
    finish: async () => { finishes++; },
  };
  await expect(reg.runOnce(transport)).rejects.toThrow('lease lost');
  expect(finishes).toBe(0);
});
