import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareHarnessPermissions } from '../src/harness-permissions.js';
import { createExecutorRegistry } from '../src/node-executors.js';
import { executeLeasedJob } from '../src/runner.js';
vi.mock('../src/harness-permissions.js', () => ({ prepareHarnessPermissions: vi.fn().mockResolvedValue(undefined) }));
const dirs: string[] = [];
afterEach(() => { vi.mocked(prepareHarnessPermissions).mockReset().mockResolvedValue(undefined); dirs.splice(0).forEach(d => rmSync(d, { recursive: true, force: true })); });
function nodeFixture() {
  const ws = mkdtempSync(join(tmpdir(), 'uw-launch-permissions-')); dirs.push(ws);
  const registry = createExecutorRegistry({ allowed_task_types: ['launch-agent'], workspace_ids: ['w'] }, {
    workspaces: { w: ws }, harnesses: { claude: { executable: process.execPath, args: ['-e', 'console.log("launched")', '--'] } },
  });
  return { ws, registry };
}
const nodeTask = { id: 'test', type: 'launch-agent' as const, params: { workspace_id: 'w', harness: 'claude', prompt: 'hello' } };
const job = () => ({ id: 'job-test', type: 'agent', lease_token: 'lease', lease_expires: new Date(Date.now() + 60000).toISOString(), agent_spec: { executable: process.execPath, args: ['-e', 'console.log("launched")', '--'], prompt: 'hi', harness: 'claude-sdk', backend: 'raw' } });
describe('launch permission preparation', () => {
  it('prepares the approved node workspace before spawning', async () => {
    const f = nodeFixture();
    const result = await f.registry.execute(nodeTask);
    expect(result.status).toBe('done');
    expect(result.result).toContain('launched');
    expect(prepareHarnessPermissions).toHaveBeenCalledWith('claude', f.ws);
  });
  it('does not prepare an unauthorized node launch', async () => {
    const f = nodeFixture();
    expect((await f.registry.execute({ ...nodeTask, params: { ...nodeTask.params, workspace_id: 'other' } })).status).toBe('failed');
    expect(prepareHarnessPermissions).not.toHaveBeenCalled();
  });
  it('fails the node job without spawning if config preparation fails', async () => {
    const f = nodeFixture(); vi.mocked(prepareHarnessPermissions).mockRejectedValue(new Error('bad config'));
    const result = await f.registry.execute(nodeTask);
    expect(result.status).toBe('failed'); expect(result.result).toContain('bad config'); expect(result.result).not.toContain('launched');
  });
  it('prepares the legacy runner workspace before spawning', async () => {
    const call = vi.fn(async (_name, args) => args);
    const result = await executeLeasedJob(job(), call, { agentId: 'test', host: 'local' });
    expect(prepareHarnessPermissions).toHaveBeenCalledWith('claude-sdk', process.cwd());
    expect(result.status).toBe('done'); expect(result.result).toContain('launched');
  });
  it('reports legacy preparation failure and never spawns', async () => {
    vi.mocked(prepareHarnessPermissions).mockRejectedValue(new Error('bad config'));
    const call = vi.fn(async (_name, args) => args);
    const result = await executeLeasedJob(job(), call, { agentId: 'test', host: 'local' });
    expect(result.status).toBe('failed'); expect(result.result).toContain('bad config'); expect(result.result).not.toContain('launched');
    expect(call).toHaveBeenCalledTimes(1);
  });
});
