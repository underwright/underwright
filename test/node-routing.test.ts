import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { SqliteStore } from "../src/store.js";
import { selectNode, nodeSpecAllowed, type NodeCandidate } from "../src/node-protocol.js";

// Fleet resilience: submit_node_task can omit target_node_id and the store
// routes to the best eligible node; board surfaces unread mail and agent
// activity; lease_lost node jobs optionally requeue under dispatcher.node_retry.

const cleanup: (() => void)[] = [];
afterEach(() => { cleanup.splice(0).reverse().forEach(f => f()); });
const hash = (s: string) => createHash('sha256').update(s).digest('hex');

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'uw-routing-'));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const store: any = new SqliteStore(join(dir, 'store.db'));
  cleanup.push(() => store.close());
  return store;
}

async function approvedNode(store: any, opts: { kinds?: string[]; workspaces?: string[]; caps?: object; name?: string } = {}) {
  const secret = randomBytes(32).toString('hex');
  const e = await store.createNodeEnrollment({ version: 1, name: opts.name ?? 'n', device_secret_hash: hash(secret), platform: 'linux', arch: 'x64', insecure_transport: true });
  const approved = await store.approveNodeEnrollment(e.id, e.code, {
    allowed_task_types: opts.kinds ?? ['run-script'],
    workspace_ids: opts.workspaces ?? ['underwright'],
    repository_ids: [],
  }, 'admin');
  if (opts.caps) store.db.prepare("UPDATE nodes SET capabilities_json=?, capabilities_observed_at=? WHERE id=?")
    .run(JSON.stringify(opts.caps), new Date().toISOString(), approved.node_id);
  return approved.node_id;
}

const runScript = (workspace_id = 'underwright') => ({
  version: 1 as const, kind: 'run-script' as const, workspace_id,
  payload: { workspace_id, script: 'smoke' },
});

describe('nodeSpecAllowed / selectNode', () => {
  const cand = (id: string, policy: object, caps = {}, last_seen?: string): NodeCandidate => ({
    id, policy_json: JSON.stringify(policy), capabilities_json: JSON.stringify(caps), capabilities_observed_at: null, last_seen_at: last_seen ?? null,
  });
  const policy = (kinds: string[], workspaces: string[]) => ({ allowed_task_types: kinds, workspace_ids: workspaces, repository_ids: [] });
  const now = Date.now();

  it('gates on allowed kinds and workspaces', () => {
    expect(nodeSpecAllowed(policy(['run-script'], ['w1']) as any, runScript('w1'), '{}')).toBe(true);
    expect(nodeSpecAllowed(policy(['provision'], ['w1']) as any, runScript('w1'), '{}')).toBe(false);
    expect(nodeSpecAllowed(policy(['run-script'], ['other']) as any, runScript('w1'), '{}')).toBe(false);
    expect(nodeSpecAllowed(policy(['run-script'], ['w1']) as any, runScript('w1'), JSON.stringify({ supported_operation_kinds: ['provision'] }))).toBe(false);
  });

  it('returns null when nothing is eligible and picks the only fit', () => {
    expect(selectNode([cand('n1', policy(['provision'], ['w1']))], runScript('w1'), now)).toBeNull();
    expect(selectNode([
      cand('n1', policy(['provision'], ['w1'])),
      cand('n2', policy(['run-script'], ['w1'])),
    ], runScript('w1'), now)).toBe('n2');
  });

  it('prefers online+free nodes, deterministic on ties', () => {
    const online = new Date(now - 10_000).toISOString();
    const eligible = [
      cand('a', policy(['run-script'], ['w1']), { supported_operation_kinds: ['run-script'], max_concurrency: 1, current_slots: 0 }),
      cand('b', policy(['run-script'], ['w1']), { supported_operation_kinds: ['run-script'], max_concurrency: 1, current_slots: 0 }, online),
      cand('c', policy(['run-script'], ['w1']), { supported_operation_kinds: ['run-script'], max_concurrency: 1, current_slots: 1 }, online),
    ];
    expect(selectNode(eligible, runScript('w1'), now)).toBe('b'); // online + free beats online-busy and offline-free
    expect(selectNode([eligible[0], eligible[2]], runScript('w1'), now)).toBe('c'); // online-busy outranks offline-free
    const tied = [
      cand('a2', policy(['run-script'], ['w1']), { supported_operation_kinds: ['run-script'], max_concurrency: 1, current_slots: 0 }, online),
      cand('a1', policy(['run-script'], ['w1']), { supported_operation_kinds: ['run-script'], max_concurrency: 1, current_slots: 0 }, online),
    ];
    expect(selectNode(tied, runScript('w1'), now)).toBe('a1'); // deterministic id order when equally ranked
  });
});

describe('submitNodeTask routing', () => {
  it('routes to the only eligible approved node when target is omitted', async () => {
    const store = fixture();
    const wrong = await approvedNode(store, { kinds: ['provision'], name: 'wrong' });
    const right = await approvedNode(store, { name: 'right' });
    const job = await store.submitNodeTask({ node_spec: runScript(), agent_id: 'admin' });
    expect(job.status).toBe('queued');
    expect(job.target_node_id).toBe(right);
    expect(job.target_node_id).not.toBe(wrong);
  });

  it('fails cleanly when no node can take the spec', async () => {
    const store = fixture();
    await approvedNode(store, { kinds: ['provision'] });
    const res = await store.submitNodeTask({ node_spec: runScript(), agent_id: 'admin' });
    expect(res.error).toMatch(/no capable node/);
  });

  it('explicit target still works and still enforces policy', async () => {
    const store = fixture();
    const node = await approvedNode(store);
    const denied = await approvedNode(store, { workspaces: ['other'], name: 'denied' });
    const ok = await store.submitNodeTask({ target_node_id: node, node_spec: runScript(), agent_id: 'admin' });
    expect(ok.status).toBe('queued');
    const bad = await store.submitNodeTask({ target_node_id: denied, node_spec: runScript(), agent_id: 'admin' });
    expect(bad.error).toBeTruthy();
  });
});

describe('board visibility', () => {
  it('exposes unread mail counts and agent activity', async () => {
    const store = fixture();
    await store.sendMessage('agent-b', 'agent-a', 'hello');
    await store.sendMessage('agent-b', 'agent-a', 'again');
    const board = await store.board();
    expect(board.unread_messages['agent-b']).toBe(2);
    expect(board.agent_activity['agent-a']).toBeTruthy();
  });
});

describe('node job retry policy', () => {
  const expire = async (store: any, nodeId: string) => {
    const job = await store.submitNodeTask({ target_node_id: nodeId, node_spec: runScript(), agent_id: 'admin' });
    store.db.prepare("UPDATE jobs SET status='running', lease_expires=? WHERE id=?")
      .run(new Date(Date.now() - 60_000).toISOString(), job.id);
    return job.id;
  };
  const policyFile = (retry?: object) => {
    const dir = mkdtempSync(join(tmpdir(), 'uw-policy-'));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const path = join(dir, 'policy.json');
    writeFileSync(path, JSON.stringify({ dispatcher: { enabled: false, ...(retry ? { node_retry: retry } : {}) } }));
    return path;
  };

  it('defaults to deliberate failure, no requeue', async () => {
    const store = fixture();
    const node = await approvedNode(store);
    const old = process.env.UNDERWRIGHT_POLICY;
    process.env.UNDERWRIGHT_POLICY = policyFile(); // no node_retry
    try {
      const jobId = await expire(store, node);
      const res = await store.sweepExpiredNodeJobs();
      expect(res.retried).toEqual([]);
      expect(store.db.prepare("SELECT outcome_reason FROM jobs WHERE id=?").get(jobId).outcome_reason).toBe('lease_lost/outcome_unknown');
    } finally { old === undefined ? delete process.env.UNDERWRIGHT_POLICY : process.env.UNDERWRIGHT_POLICY = old; }
  });

  it('requeues retryable kinds up to max_attempts, then stops', async () => {
    const store = fixture();
    const node = await approvedNode(store);
    const old = process.env.UNDERWRIGHT_POLICY;
    process.env.UNDERWRIGHT_POLICY = policyFile({ kinds: ['run-script'], max_attempts: 2 });
    try {
      const first = await expire(store, node);
      const res1 = await store.sweepExpiredNodeJobs();
      expect(res1.retried).toHaveLength(1);
      const second = res1.retried[0];
      expect(store.db.prepare("SELECT status,retry_of FROM jobs WHERE id=?").get(second)).toMatchObject({ status: 'queued', retry_of: first });
      expect(store.db.prepare("SELECT outcome_reason FROM jobs WHERE id=?").get(first).outcome_reason).toBe('lease_lost/requeued');
      // Second expiry: depth 1 + 1 = max_attempts reached, deliberate again.
      store.db.prepare("UPDATE jobs SET status='running', lease_expires=? WHERE id=?").run(new Date(Date.now() - 60_000).toISOString(), second);
      const res2 = await store.sweepExpiredNodeJobs();
      expect(res2.retried).toEqual([]);
      expect(store.db.prepare("SELECT outcome_reason FROM jobs WHERE id=?").get(second).outcome_reason).toBe('lease_lost/outcome_unknown');
    } finally { old === undefined ? delete process.env.UNDERWRIGHT_POLICY : process.env.UNDERWRIGHT_POLICY = old; }
  });

  it('does not requeue kinds outside the policy allowlist', async () => {
    const store = fixture();
    const node = await approvedNode(store, { kinds: ['run-script', 'provision'] });
    const old = process.env.UNDERWRIGHT_POLICY;
    process.env.UNDERWRIGHT_POLICY = policyFile({ kinds: ['provision'], max_attempts: 3 });
    try {
      await expire(store, node); // run-script not in retry.kinds
      const res = await store.sweepExpiredNodeJobs();
      expect(res.retried).toEqual([]);
    } finally { old === undefined ? delete process.env.UNDERWRIGHT_POLICY : process.env.UNDERWRIGHT_POLICY = old; }
  });
});

describe('quota gating', () => {
  const launchSpec = {
    kind: 'launch-agent', workspace_id: 'w1',
    payload: { workspace_id: 'w1', harness: 'codex', prompt: 'x' },
  } as any;
  const launchPolicy = { allowed_task_types: ['launch-agent'], workspace_ids: ['w1'], repository_ids: [] } as any;
  const capsWithQuota = (quota: object) => JSON.stringify({
    harnesses: [{ id: 'codex', installed: true, auth_status: 'ready', quota }],
  });
  const fresh = new Date().toISOString();

  it('blocks exhausted quota, allows past resets_at to recover, and passes available/unknown', () => {
    expect(nodeSpecAllowed(launchPolicy, launchSpec, capsWithQuota({ state: 'exhausted' }), fresh)).toBe(false);
    expect(nodeSpecAllowed(launchPolicy, launchSpec, capsWithQuota({ state: 'exhausted', resets_at: new Date(Date.now() + 3600_000).toISOString() }), fresh)).toBe(false);
    expect(nodeSpecAllowed(launchPolicy, launchSpec, capsWithQuota({ state: 'exhausted', resets_at: new Date(Date.now() - 60_000).toISOString() }), fresh)).toBe(true);
    expect(nodeSpecAllowed(launchPolicy, launchSpec, capsWithQuota({ state: 'available' }), fresh)).toBe(true);
    expect(nodeSpecAllowed(launchPolicy, launchSpec, capsWithQuota({ state: 'unknown' }), fresh)).toBe(true);
    expect(nodeSpecAllowed(launchPolicy, launchSpec, capsWithQuota({ state: 'stale' }), fresh)).toBe(false);
  });
});
