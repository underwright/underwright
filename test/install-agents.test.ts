import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// scripts/install-agents.sh is the provisioning playbook the node
// install-harness executor runs. Provisioning gates on its exit codes, so pin
// them here with fake harness binaries and an isolated HOME/PATH. Nothing here
// touches the network or a real vendor CLI.
const script = fileURLToPath(new URL('../scripts/install-agents.sh', import.meta.url));

function sandbox(bins: Record<string, string>) {
  const home = mkdtempSync(join(tmpdir(), 'uw-install-agents-'));
  const bin = join(home, 'bin');
  mkdirSync(bin);
  for (const [name, body] of Object.entries(bins)) {
    const p = join(bin, name);
    writeFileSync(p, `#!/bin/sh\n${body}\n`);
    chmodSync(p, 0o755);
  }
  const run = (...args: string[]) => {
    const r = spawnSync('bash', [script, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { HOME: home, PATH: `${bin}:/usr/bin:/bin`, TERM: 'dumb' },
    });
    return { code: r.status, out: r.stdout + r.stderr };
  };
  return { run, cleanup: () => rmSync(home, { recursive: true, force: true }) };
}

describe('install-agents.sh provisioning contract', () => {
  it('lists the nine install-agents harnesses plus copilot', () => {
    const s = sandbox({});
    try {
      const r = s.run('list');
      expect(r.code).toBe(0);
      for (const id of ['codex', 'claude', 'antigravity', 'kimi', 'opencode', 'command-code', 'cline', 'grok', 'cursor', 'copilot']) {
        expect(r.out).toMatch(new RegExp(`^${id}\\s`, 'm'));
      }
      expect(r.out).toContain('GitHub Copilot CLI');
    } finally { s.cleanup(); }
  });

  it('verify exits 1 when a selected harness is not installed', () => {
    const s = sandbox({});
    try {
      const r = s.run('verify', '--agents', 'copilot');
      expect(r.code).toBe(1);
      expect(r.out).toContain('GitHub Copilot CLI is not installed');
    } finally { s.cleanup(); }
  });

  it('verify exits 0 when the harness is installed and its check passes', () => {
    const s = sandbox({ copilot: 'echo "copilot 0.0.1"' });
    try {
      const r = s.run('verify', '--agents', 'copilot');
      expect(r.code).toBe(0);
      expect(r.out).toContain('copilot 0.0.1');
    } finally { s.cleanup(); }
  });

  it('verify exits 1 when an installed harness fails its auth check', () => {
    const s = sandbox({ codex: '[ "$1" = "--version" ] && { echo "codex 1.0"; exit 0; }; echo "Not logged in" >&2; exit 1' });
    try {
      const r = s.run('verify', '--agents', 'codex');
      expect(r.code).toBe(1);
      expect(r.out).toContain('authentication verification did not succeed');
    } finally { s.cleanup(); }
  });

  it('one failing harness fails a multi-harness verify', () => {
    const s = sandbox({ copilot: 'echo "copilot 0.0.1"' });
    try {
      const r = s.run('verify', '--agents', 'copilot,cursor');
      expect(r.code).toBe(1);
      expect(r.out).toContain('1 selected step(s) reported a failure');
    } finally { s.cleanup(); }
  });

  it('install of an already-installed harness without --force skips and exits 0', () => {
    const s = sandbox({ copilot: 'echo "copilot 0.0.1"' });
    try {
      const r = s.run('install', '--agents', 'copilot');
      expect(r.code).toBe(0);
      expect(r.out).toContain('Skipped GitHub Copilot CLI');
    } finally { s.cleanup(); }
  });

  it('usage errors exit 2', () => {
    const s = sandbox({});
    try {
      expect(s.run('verify', '--agents', 'nope').code).toBe(2);
      expect(s.run('bogus').code).toBe(2);
    } finally { s.cleanup(); }
  });
});
