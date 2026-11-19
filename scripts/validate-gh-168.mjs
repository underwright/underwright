#!/usr/bin/env node
// Post-deploy validation for gh-168: omni session id + cost telemetry on jobs.
//
//   node scripts/validate-gh-168.mjs            # against $UNDERWRIGHT_URL (bearer $UNDERWRIGHT_TOKEN)
//   node scripts/validate-gh-168.mjs --local    # boots dist/cli.js on a scratch DB first (needs npm run build)
//
// Optional: TASK_ID=gh-168 also checks task_usage + board cost_usd for a real task (read-only).
//           OMNIGENT_SERVER_URL + OMNI_SESSION_ID also read a live session snapshot (read-only).
//
// Side effects on a deployed server: one `test` job pinned to a unique host
// (`gh168-validate-<rand>`) so no real runner can lease it; it ends `done`.
// Prints PASS/FAIL per case and exits non-zero on any failure.
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const root = fileURLToPath(new URL('../', import.meta.url));
let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
};

async function bootLocal() {
  const dir = await mkdtemp(join(tmpdir(), 'uw-gh168-'));
  const reservation = createServer();
  reservation.listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  const port = reservation.address().port;
  await new Promise((resolve, reject) => reservation.close(e => e ? reject(e) : resolve()));
  const child = spawn(process.execPath, ['dist/cli.js', 'serve', '--http', `127.0.0.1:${port}`], {
    cwd: root,
    env: { ...process.env, DATABASE_URL: '', UNDERWRIGHT_DB: join(dir, 'scratch.db'), UNDERWRIGHT_POLICY: join(dir, 'none.json'), UNDERWRIGHT_TOKEN: '' },
    stdio: 'ignore',
  });
  for (let i = 0; i < 100; i++) {
    try { await fetch(`http://127.0.0.1:${port}/healthz`); break; } catch { await delay(100); }
  }
  return { url: `http://127.0.0.1:${port}/mcp`, token: '', stop: async () => { child.kill(); await rm(dir, { recursive: true, force: true }); } };
}

const local = process.argv.includes('--local') ? await bootLocal() : null;
const url = local?.url ?? process.env.UNDERWRIGHT_URL;
const token = local ? '' : process.env.UNDERWRIGHT_TOKEN;
if (!url) { console.error('set UNDERWRIGHT_URL (or pass --local)'); process.exit(2); }

const client = new Client({ name: 'validate-gh-168', version: '0.1.0' });
await client.connect(new StreamableHTTPClientTransport(new URL(url), {
  requestInit: { headers: token ? { Authorization: `Bearer ${token}` } : {} },
}));
const call = async (name, args) => {
  const r = await client.callTool({ name, arguments: args });
  const text = r.content?.find(c => c.type === 'text')?.text ?? 'null';
  let body; try { body = JSON.parse(text); } catch { body = text; }
  return { isError: !!r.isError, body };
};

try {
  const tools = (await client.listTools()).tools.map(t => t.name);
  check('task_usage tool is exposed', tools.includes('task_usage'));
  const renewSchema = (await client.listTools()).tools.find(t => t.name === 'renew_job')?.inputSchema;
  check('renew_job accepts telemetry', !!renewSchema?.properties?.telemetry);

  const host = `gh168-validate-${randomBytes(4).toString('hex')}`;
  const runner = `validate@${host}`;
  const submitted = await call('submit_job', { agent_id: runner, type: 'test', command: 'true', host });
  const lease = (await call('next_job', { agent_id: runner, host, ttl_seconds: 60 })).body;
  check('leased the pinned validation job', lease?.id === submitted.body?.id, `job ${submitted.body?.id}`);
  const owner = { job_id: lease.id, agent_id: runner, lease_token: lease.lease_token };

  // Positive: heartbeat telemetry is persisted on the job record.
  const renewed = await call('renew_job', { ...owner, ttl_seconds: 60, telemetry: { omni_session_id: 'sess-validate', cost_usd: 0.125 } });
  let job = (await call('job_status', { job_id: lease.id })).body;
  check('renew_job persists session id + cost', !renewed.body?.error && job.omni_session_id === 'sess-validate' && job.cost_usd === 0.125,
    `omni_session_id=${job.omni_session_id} cost_usd=${job.cost_usd}`);

  // Negative: a foreign lease token cannot write telemetry.
  const foreign = await call('renew_job', { ...owner, lease_token: 'not-the-token', telemetry: { omni_session_id: 'evil', cost_usd: 99 } });
  job = (await call('job_status', { job_id: lease.id })).body;
  check('foreign lease token is rejected and values unchanged', !!foreign.body?.error && job.omni_session_id === 'sess-validate' && job.cost_usd === 0.125,
    JSON.stringify(foreign.body));

  // Negative: invalid cost is rejected by the schema.
  const bad = await call('renew_job', { ...owner, telemetry: { cost_usd: -1 } });
  check('negative cost_usd is rejected', bad.isError || !!bad.body?.error);

  // Positive: finish_job records end-of-job usage; absent fields keep heartbeat values.
  await call('finish_job', { ...owner, status: 'done', result: 'validated', telemetry: { cost_usd: 0.25, usage_by_model: { 'model-x': { input_tokens: 10 } } } });
  job = (await call('job_status', { job_id: lease.id })).body;
  check('finish_job records exit usage', job.status === 'done' && job.omni_session_id === 'sess-validate' && job.cost_usd === 0.25
    && JSON.parse(job.usage_json ?? 'null')?.['model-x']?.input_tokens === 10, `cost_usd=${job.cost_usd} usage_json=${job.usage_json}`);

  if (process.env.TASK_ID) {
    const usage = (await call('task_usage', { task_id: process.env.TASK_ID })).body;
    check(`task_usage(${process.env.TASK_ID}) returns an aggregate`, typeof usage?.total_cost_usd === 'number' && Array.isArray(usage.jobs),
      `total=${usage?.total_cost_usd} sessions=${usage?.jobs?.map(j => j.omni_session_id).join(',')}`);
    const board = (await call('board', {})).body;
    const row = board?.tasks?.find(t => t.id === process.env.TASK_ID);
    check('board row carries cost_usd', row && 'cost_usd' in row, `cost_usd=${row?.cost_usd}`);
  }

  if (process.env.OMNIGENT_SERVER_URL && process.env.OMNI_SESSION_ID) {
    const { fetchSessionSnapshot } = await import(new URL('../dist/runner.js', import.meta.url));
    const { parseSessionSnapshot } = await import(new URL('../dist/usage.js', import.meta.url));
    const snap = parseSessionSnapshot(await fetchSessionSnapshot(process.env.OMNIGENT_SERVER_URL, process.env.OMNI_SESSION_ID));
    check('live omni session snapshot yields cost_usd', typeof snap.cost_usd === 'number', JSON.stringify(snap));
  }
} catch (error) {
  check('validation run', false, String(error?.stack ?? error));
} finally {
  await client.close().catch(() => {});
  await local?.stop();
}
console.log(failures ? `\n${failures} check(s) FAILED` : '\nall checks PASSED');
process.exit(failures ? 1 : 0);
