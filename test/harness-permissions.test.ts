import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareHarnessPermissions } from '../src/harness-permissions.js';

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach(d => rmSync(d, { recursive: true, force: true })));
function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'uw-permissions-')); dirs.push(home);
  const workspace = join(home, 'workspace'); mkdirSync(workspace);
  return { home, workspace, trust: join(home, '.claude.json'), settings: join(workspace, '.claude/settings.json') };
}
const read = (path: string) => JSON.parse(readFileSync(path, 'utf8'));

describe('harness permission preparation', () => {
  it('trusts the canonical workspace and allows required tools before first launch', async () => {
    const f = fixture();
    await prepareHarnessPermissions('claude', f.workspace, f.home);
    expect(read(f.trust).projects[f.workspace].hasTrustDialogAccepted).toBe(true);
    expect(read(f.settings).permissions.allow).toEqual(expect.arrayContaining([
      'mcp__underwright__*', 'Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep',
    ]));
  });
  it('preserves existing configuration and explicit denies and is idempotent', async () => {
    const f = fixture(); mkdirSync(join(f.workspace, '.claude'));
    writeFileSync(f.trust, JSON.stringify({ theme: 'dark', projects: { other: { x: 1 }, [f.workspace]: { allowedTools: ['x'] } } }));
    writeFileSync(f.settings, JSON.stringify({ env: { X: 'y' }, permissions: { allow: ['Read'], deny: ['Bash(rm *)'], ask: ['Write'] } }));
    await prepareHarnessPermissions('claude-sdk', f.workspace, f.home);
    const first = readFileSync(f.settings, 'utf8');
    await prepareHarnessPermissions('claude-sdk', f.workspace, f.home);
    expect(readFileSync(f.settings, 'utf8')).toBe(first);
    expect(read(f.trust)).toMatchObject({ theme: 'dark', projects: { other: { x: 1 }, [f.workspace]: { allowedTools: ['x'], hasTrustDialogAccepted: true } } });
    expect(read(f.settings)).toMatchObject({ env: { X: 'y' }, permissions: { deny: ['Bash(rm *)'], ask: ['Write'] } });
    expect(read(f.settings).permissions.allow.filter((s: string) => s === 'Read')).toHaveLength(1);
  });
  it('leaves unrelated harnesses untouched', async () => {
    const f = fixture();
    await prepareHarnessPermissions('codex', f.workspace, f.home);
    expect(() => read(f.trust)).toThrow();
    expect(() => read(f.settings)).toThrow();
  });
  it('refuses malformed configuration rather than replacing it', async () => {
    const f = fixture(); writeFileSync(f.trust, '{broken');
    await expect(prepareHarnessPermissions('claude', f.workspace, f.home)).rejects.toThrow();
    expect(readFileSync(f.trust, 'utf8')).toBe('{broken');
    writeFileSync(f.trust, JSON.stringify({ projects: [] }));
    await expect(prepareHarnessPermissions('claude', f.workspace, f.home)).rejects.toThrow(/object/);
    writeFileSync(f.trust, '{}'); mkdirSync(join(f.workspace, '.claude'));
    writeFileSync(f.settings, JSON.stringify({ permissions: { allow: 'bad' } }));
    await expect(prepareHarnessPermissions('claude', f.workspace, f.home)).rejects.toThrow(/array/);
    expect(read(f.trust)).toEqual({});
  });
  it('merges concurrent workspace launches into the same user config', async () => {
    const f = fixture(); const second = join(f.home, 'other'); mkdirSync(second);
    await Promise.all([prepareHarnessPermissions('claude', f.workspace, f.home), prepareHarnessPermissions('claude', second, f.home)]);
    expect(Object.keys(read(f.trust).projects).sort()).toEqual([f.workspace, second].sort());
  });
});
