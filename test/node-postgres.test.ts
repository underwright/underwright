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
  } finally { if (node) await first.revokeNode(node, 'test-cleanup'); await first.close(); await second.close(); }
}, 30000);
