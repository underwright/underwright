import { spawnSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteStore } from '../src/store.js';
import { raiseIssue, syncIssues } from '../src/github-issues.js';

let store: SqliteStore;
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'uw-raise-'));
  process.env.UNDERWRIGHT_POLICY = join(dir, 'no-policy.json');
  store = new SqliteStore(join(dir, 'store.db'));
});
afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });

const issue = { number: 412, title: 'Fix `quotes` $(touch /tmp/nope)', body: 'Details\nwith "quotes"', html_url: 'https://github.com/org/repo/issues/412', state: 'open', labels: [] };
describe('GitHub raise', () => {
  it('creates one claimable task, preserves literal text through stdin, and re-syncs idempotently', async () => {
    const runner = vi.fn(() => issue);
    const result = await raiseIssue(store, { repo: 'org/repo', title: issue.title, body: issue.body, agent_id: 'codex@test', task_extras: { estimate: 'M', ac_ids: ['fixed'] } }, { runner });
    expect(result).toEqual({ issue: { ...issue, url: issue.html_url, state: 'OPEN' }, task_id: 'gh-412' });
    expect(runner).toHaveBeenCalledTimes(1);
    expect(runner.mock.calls[0]).toEqual(['api repos/org/repo/issues --method POST --input -', JSON.stringify({ title: issue.title, body: issue.body })]);
    const task = store.getTask('gh-412');
    expect(task).toMatchObject({ title: `[#412] ${issue.title}`, spec_ref: issue.html_url, estimate: 'M', type: 'feature', created_by: 'codex@test', ac_ids: ['fixed'] });
    expect(store.claimTask('gh-412', 'codex@test')).not.toHaveProperty('error');
    await syncIssues(store, 'org/repo', 'sync', { runner: () => [{ ...issue, url: issue.html_url, state: 'OPEN' }] });
    expect(store.listTasks()).toHaveLength(1);
    expect(store.getTask('gh-412').ac_ids).toEqual(['fixed']);
  });
  it.each([{ repo: 'org/repo; touch /tmp/nope', title: 'x' }, { repo: 'org/repo', title: ' ' }, { repo: 'org/repo', title: 'x', task_extras: { id: 'override' } }])('validates before creating an issue: %j', async args => {
    const runner = vi.fn();
    await expect(raiseIssue(store, args as any, { runner })).rejects.toThrow();
    expect(runner).not.toHaveBeenCalled();
  });
  it('does not create a board task when GitHub fails', async () => {
    await expect(raiseIssue(store, { repo: 'org/repo', title: 'x' }, { runner: () => { throw new Error('unauthorized'); } })).rejects.toThrow('unauthorized');
    expect(store.listTasks()).toHaveLength(0);
  });
  it('returns the created issue and recovery guidance if the board import fails', async () => {
    vi.spyOn(store, 'createTask').mockImplementation(() => { throw new Error('database unavailable'); });
    const result = await raiseIssue(store, { repo: 'org/repo', title: 'x' }, { runner: () => issue });
    expect(result).toMatchObject({ issue: { url: issue.html_url }, task_id: null, error: expect.stringContaining('database unavailable'), recovery: expect.stringContaining('github sync') });
  });
  it('does not let a body marker redirect the raised task', async () => {
    store.createTask({ id: 'other', title: 'Existing' });
    const result = await raiseIssue(store, { repo: 'org/repo', title: 'x' }, { runner: () => ({ ...issue, body: 'uw:other' }) });
    expect(result.task_id).toBe('gh-412');
    await syncIssues(store, 'org/repo', 'sync', { runner: () => [{ ...issue, url: issue.html_url, state: 'OPEN', body: 'uw:other' }] });
    expect(store.getTask('other').spec_ref).toBeNull();
    expect(store.listTasks()).toHaveLength(2);
  });
  it('reports a cross-repository task number collision without modifying the old task', async () => {
    store.createTask({ id: 'gh-412', title: 'Other repo', spec_ref: 'https://github.com/other/repo/issues/412' });
    const result = await raiseIssue(store, { repo: 'org/repo', title: 'x' }, { runner: () => issue });
    expect(result).toMatchObject({ task_id: null, error: expect.stringContaining('collision') });
    expect(store.getTask('gh-412').title).toBe('Other repo');
  });
});

describe('Store and MCP entry points', () => {
  it('exposes github_raise with schema validation and delegates to Store', async () => {
    const { createServer } = await import('../src/server.js');
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
    const { server } = createServer(store);
    const client = new Client({ name: 'raise-test', version: '1' });
    const [a, b] = InMemoryTransport.createLinkedPair();
    const raised = vi.spyOn(store, 'raiseGithubIssue').mockResolvedValue({ task_id: 'gh-412', issue });
    await Promise.all([server.connect(a), client.connect(b)]);
    try {
      expect((await client.listTools()).tools.some(t => t.name === 'github_raise')).toBe(true);
      const result = await client.callTool({ name: 'github_raise', arguments: { repo: 'org/repo', title: 'Title', task_extras: { estimate: 'M' } } });
      expect(result.isError).not.toBe(true);
      expect(raised).toHaveBeenCalledWith({ repo: 'org/repo', title: 'Title', task_extras: { estimate: 'M' } });
      const invalid = await client.callTool({ name: 'github_raise', arguments: { repo: 'org/repo;bad', title: 'Title' } });
      expect(invalid.isError).toBe(true);
      expect(raised).toHaveBeenCalledTimes(1);
    } finally { await client.close(); await server.close(); }
  });
});

describe('CLI and real Store delegation', () => {
  it('raises through gh argv/stdin and leaves one task after CLI re-sync', () => {
    const gh = join(dir, 'gh');
    writeFileSync(gh, `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args[0] === 'api') {
 const input = JSON.parse(fs.readFileSync(0, 'utf8'));
 fs.writeFileSync(process.env.RAISE_CAPTURE, JSON.stringify({args, input}));
 console.log(JSON.stringify({number: 412, title: input.title, body: input.body, html_url: 'https://github.com/org/repo/issues/412', state: 'open', labels: []}));
} else { console.log(JSON.stringify([{number:412,title:'Raised',body:'',url:'https://github.com/org/repo/issues/412',state:'OPEN',labels:[]}])); }
`, { mode: 0o700 });
    const env = { ...process.env, PATH: dir + ':' + process.env.PATH, UNDERWRIGHT_DB: join(dir, 'store.db'), RAISE_CAPTURE: join(dir, 'capture') };
    const run = (...args: string[]) => spawnSync(process.execPath, ['dist/cli.js', 'github', ...args], { env, encoding: 'utf8' });
    const raised = run('raise', issue.title, '--repo', 'org/repo', '--body', issue.body, '--task-extras', '{"estimate":"M","priority":1}');
    expect(raised.status, raised.stderr).toBe(0);
    expect(JSON.parse(raised.stdout).task_id).toBe('gh-412');
    expect(JSON.parse(readFileSync(join(dir, 'capture'), 'utf8'))).toEqual({ args: ['api', 'repos/org/repo/issues', '--method', 'POST', '--input', '-'], input: { title: issue.title, body: issue.body } });
    expect(store.getTask('gh-412')).toMatchObject({ estimate: 'M', priority: 1 });
    expect(run('sync', '--repo', 'org/repo').status).toBe(0);
    expect(store.listTasks()).toHaveLength(1);
    expect(store.claimTask('gh-412', 'codex@test')).not.toHaveProperty('error');
    expect(run('raise', 'bad', '--repo', 'org/repo', '--task-extras', '{bad').status).toBe(1);
    expect(run('raise', 'bad').status).toBe(1);
  });
});

describe('issue reconciliation and partial failure', () => {
  it('reconciles closed issues and closes completed linked tasks, including markers', async () => {
    store.createTask({ id: 'gh-1', title: 'Closing' });
    store.createTask({ id: 'gh-2', title: 'Complete' });
    store.setTaskStatus('gh-2', 'done', 'test');
    store.createTask({ id: 'marked-closed', title: 'Marker close' });
    store.createTask({ id: 'marked-done', title: 'Marker done' });
    store.setTaskStatus('marked-done', 'done', 'test');
    const runner = vi.fn((cmd: string) => cmd.startsWith('issue list') ? [
      { ...issue, number: 1, url: 'url-1', state: 'CLOSED' },
      { ...issue, number: 2, url: 'url-2', state: 'OPEN' },
      { ...issue, number: 3, url: 'url-3', state: 'CLOSED', body: 'uw:marked-closed' },
      { ...issue, number: 4, url: 'url-4', state: 'OPEN', body: 'uw:marked-done' },
      { ...issue, number: 5, url: 'url-5', state: 'CLOSED' },
      { ...issue, number: 6, url: 'url-6', state: 'OPEN', labels: [{ name: 'p1' }], body: 'uw:absent' },
    ] : '');
    const result = await syncIssues(store, 'org/repo', 'sync', { runner });
    expect(result).toEqual({ imported: 1, skipped: 3, closed_tasks: ['gh-1', 'marked-closed'], closed_issues: [2, 4] });
    expect(store.getTask('gh-6').priority).toBe(1);
    expect(store.getTask('marked-closed')).toMatchObject({ status: 'done', spec_ref: 'url-3' });
    expect(runner).toHaveBeenCalledTimes(3);
  });
  it('reports a Store refusal without claiming success', async () => {
    vi.spyOn(store, 'createTask').mockReturnValue({ error: 'dependency absent' });
    const result = await raiseIssue(store, { repo: 'org/repo', title: 'x' }, { runner: () => JSON.stringify(issue) });
    expect(result).toMatchObject({ task_id: null, error: 'dependency absent' });
  });
  it('rejects malformed GitHub responses', async () => {
    await expect(raiseIssue(store, { repo: 'org/repo', title: 'x' }, { runner: () => ({ number: 'wrong' }) })).rejects.toThrow('invalid issue response');
    expect(store.listTasks()).toHaveLength(0);
  });
  it('reports when a Store write does not actually import the issue', async () => {
    vi.spyOn(store, 'createTask').mockReturnValue({ id: 'ignored' });
    const result = await raiseIssue(store, { repo: 'org/repo', title: 'x' }, { runner: () => issue });
    expect(result).toMatchObject({ task_id: null, error: expect.stringContaining('not imported') });
  });
  it('Store entry point uses authenticated gh with stdin and the default claimable fields', async () => {
    const fakeGh = join(dir, 'gh');
    writeFileSync(fakeGh, `#!${process.execPath}\nprocess.stdin.resume(); process.stdin.on('end', () => console.log(${JSON.stringify(JSON.stringify(issue))}));\n`, { mode: 0o700 });
    const oldPath = process.env.PATH;
    process.env.PATH = dir + ':' + oldPath;
    try {
      expect(await store.raiseGithubIssue({ repo: 'org/repo', title: 'x' })).toMatchObject({ task_id: 'gh-412' });
      expect(store.getTask('gh-412')).toMatchObject({ estimate: 'S', type: 'feature', ac_ids: ['impl', 'tests', 'review'] });
      expect(store.claimTask('gh-412', 'codex@test')).not.toHaveProperty('error');
    } finally { process.env.PATH = oldPath; }
  });
});
