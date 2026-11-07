import { expect, it } from 'vitest';
import { PgStore } from '../src/pstore.js';
import { nodeHash, nodeSecret } from '../src/node-protocol.js';

// A dedicated test database is required: never point fixtures at a production store.
it.skipIf(!process.env.UNDERWRIGHT_TEST_DATABASE_URL)('Postgres enrollment parity: concurrent approval/exchange, audit redaction, fencing and revocation', async () => {
  const url = process.env.UNDERWRIGHT_TEST_DATABASE_URL!;
  const first = await PgStore.connect(url); const second = await PgStore.connect(url);
  let node: string | undefined;
  try {
    const secret = nodeSecret();
    const e: any = await first.createNodeEnrollment({ version: 1, name: 'parity', platform: 'test', arch: 'test', device_secret_hash: nodeHash(secret) });
    const policy = { allowed_task_types: [] as [], workspace_ids: [] };
    const approvals = await Promise.all([first.approveNodeEnrollment(e.id, e.code, policy, 'test'), second.approveNodeEnrollment(e.id, e.code, policy, 'test')]);
    expect(approvals.filter(a => a.node_id)).toHaveLength(1); node = approvals.find(a => a.node_id).node_id;
    const exchanges = await Promise.all([first.exchangeNodeEnrollment(e.id, secret), second.exchangeNodeEnrollment(e.id, secret)]);
    expect(exchanges.filter(e => e.token)).toHaveLength(1);
    const issued = exchanges.find(e => e.token);
    const a = await first.startNodeSession(issued.token); const b = await second.startNodeSession(issued.token);
    expect((await first.authenticateNode(issued.token, a.session_id) as any).error).toBeTruthy();
    expect((await second.authenticateNode(issued.token, b.session_id) as any).node_id).toBe(node);
    await first.revokeNode(node!, 'test');
    expect((await second.authenticateNode(issued.token) as any).error).toBeTruthy();
    const audit = JSON.stringify(await first.auditLog(1000));
    for (const value of [issued.token, secret, e.code, nodeHash(secret)]) expect(audit).not.toContain(value);
    const scriptPolicy = { allowed_task_types: ['run-script'] as const, workspace_ids: [] };
    const secretB = nodeSecret();
    const e2: any = await first.createNodeEnrollment({ version: 1, name: 'queue', platform: 'test', arch: 'test', device_secret_hash: nodeHash(secretB) });
    const approvedB = await first.approveNodeEnrollment(e2.id, e2.code, scriptPolicy, 'test');
    const issuedB = await first.exchangeNodeEnrollment(e2.id, secretB);
    const sessionB = await first.startNodeSession(issuedB.token);
    const submitted = await first.submitNodeTask({
      target_node_id: approvedB.node_id,
      node_spec: { version: 1, kind: 'run-script', payload: { argv: ['true'] } },
    });
    await first.submitJob({ agent_id: 'legacy', type: 'test', command: 'echo hi' });
    expect((await first.nextJob('legacy', 'host')).type).toBe('test');
    const polls = await Promise.all([
      first.pollNodeJob(issuedB.token, sessionB.session_id, 0),
      second.pollNodeJob(issuedB.token, sessionB.session_id, 0),
    ]);
    expect(polls.filter(p => p.id === submitted.id)).toHaveLength(1);
    expect(polls.filter(p => p.empty)).toHaveLength(1);
    const leased = polls.find(p => p.id);
    const finished = await first.finishNodeJob(issuedB.token, sessionB.session_id, leased.id, leased.lease_token, 'done', 'ok');
    expect(finished.status).toBe('done');
    const replay = await second.finishNodeJob(issuedB.token, sessionB.session_id, leased.id, leased.lease_token, 'done', 'ok');
    expect(replay.idempotent).toBe(true);
    await first.revokeNode(approvedB.node_id, 'test-cleanup');
  } finally { if (node) await first.revokeNode(node, 'test-cleanup'); await first.close(); await second.close(); }
}, 30000);
