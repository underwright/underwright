#!/usr/bin/env node
// gh-149 post-deploy validation: quota telemetry (usage sampling, provider pace).
//
//   UW_URL=https://host:8741 UW_ADMIN_TOKEN=... node scripts/validate-gh-149.mjs [--expect-harness grok]
//
// UW_URL          server base URL (no trailing /mcp)
// UW_ADMIN_TOKEN  the server's UNDERWRIGHT_TOKEN (admin MCP + dashboard). Worker
//                 tokens cannot see provider_usage. If unset, only the
//                 unauthenticated node-protocol cases run.
// --expect-harness H  also assert provider H has a usage sample in the last 24h
//                 (use once a node has `usage` sources configured).
//
// Not covered here (by design): posting a heartbeat as a real node. That needs
// a node session, and starting one would evict the running daemon's session.
// Heartbeat→usage_samples→routing is covered by test/node-dispatch.test.ts.
//
// Each case prints PASS/FAIL; exit code is the number of failures (0 = all pass).
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const base = (process.env.UW_URL ?? '').replace(/\/+$/, '');
const admin = process.env.UW_ADMIN_TOKEN ?? '';
const argi = process.argv.indexOf('--expect-harness');
const expectHarness = argi > 0 ? process.argv[argi + 1] : undefined;
if (!base) { console.error('UW_URL is required'); process.exit(2); }

let failures = 0;
const result = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
};
const skip = (name, why) => console.log(`SKIP  ${name} — ${why}`);
const post = (path, body, headers = {}) => fetch(`${base}${path}`, {
  method: 'POST', headers: { 'content-type': 'application/json', ...headers },
  body: JSON.stringify(body), signal: AbortSignal.timeout(10_000),
});
const now = new Date().toISOString();

// 1. Positive: the deployed heartbeat schema accepts a `usage` array. Without a
//    bearer, a schema-valid body reaches the auth check (401); a pre-gh-149
//    server's strict schema rejects the unknown key first (400).
try {
  const r = await post('/nodes/v1/heartbeat', { session_id: 'validate-gh-149', usage: [
    { harness: 'grok', tokens_in: 1, tokens_out: 1, window_used_pct: 10, window_kind: 'weekly', vendor_state: 'rate_limited', resets_at: now, sampled_at: now },
  ] });
  result('heartbeat schema accepts usage samples (expect 401, not 400)', r.status === 401, `status ${r.status}`);
} catch (e) { result('heartbeat schema accepts usage samples', false, String(e)); }

// 2. Negative: malformed usage (unknown window_kind) is still rejected by schema.
try {
  const r = await post('/nodes/v1/heartbeat', { session_id: 'validate-gh-149', usage: [
    { harness: 'grok', window_kind: 'fortnightly', sampled_at: now },
  ] });
  result('heartbeat rejects malformed usage (expect 400)', r.status === 400, `status ${r.status}`);
} catch (e) { result('heartbeat rejects malformed usage', false, String(e)); }

// 3. Negative: a bogus node token cannot write samples.
try {
  const r = await post('/nodes/v1/heartbeat', { session_id: 'validate-gh-149', usage: [{ harness: 'grok', sampled_at: now }] },
    { authorization: 'Bearer not-a-real-node-token' });
  result('heartbeat with bogus node token is denied (expect 401/403)', r.status === 401 || r.status === 403, `status ${r.status}`);
} catch (e) { result('heartbeat with bogus node token is denied', false, String(e)); }

if (!admin) {
  skip('provider_usage MCP tool', 'UW_ADMIN_TOKEN not set');
  skip('dashboard providers panel', 'UW_ADMIN_TOKEN not set');
} else {
  // 4. Positive: provider_usage answers pace per provider.
  const client = new Client({ name: 'validate-gh-149', version: '1.0.0' });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${admin}` } },
    }));
    const tools = (await client.listTools()).tools.map(t => t.name);
    result('provider_usage tool is registered', tools.includes('provider_usage'));
    const res = await client.callTool({ name: 'provider_usage', arguments: expectHarness ? { harness: expectHarness } : {} });
    const body = JSON.parse(res.content?.[0]?.text ?? '{}');
    const shapeOk = Array.isArray(body.providers) && typeof body.generated_at === 'string'
      && body.providers.every(p => 'projected_pct_at_reset' in p && 'pace_delta' in p && 'tokens_per_hr' in p);
    result('provider_usage returns {providers[], generated_at} with pace fields', shapeOk,
      body.providers?.map(p => `${p.harness}: ${p.window_used_pct ?? '?'}% ${p.window_kind ?? ''} → ${p.projected_pct_at_reset ?? '?'}% at reset`).join('; ') || 'no samples yet');
    if (expectHarness) {
      const p = body.providers?.find(x => x.harness === expectHarness);
      const fresh = p && Date.now() - Date.parse(p.sampled_at) < 24 * 3_600_000;
      result(`provider ${expectHarness} has a usage sample in the last 24h`, !!fresh, p ? `sampled_at ${p.sampled_at}` : 'no samples');
    }
    // Negative: harness filter does not leak other providers.
    const none = JSON.parse((await client.callTool({ name: 'provider_usage', arguments: { harness: '__no_such_harness__' } })).content?.[0]?.text ?? '{}');
    result('provider_usage filter for unknown harness returns empty', Array.isArray(none.providers) && none.providers.length === 0);
  } catch (e) { result('provider_usage MCP tool', false, String(e)); }
  finally { await client.close().catch(() => {}); }

  // 5. Positive: dashboard providers panel renders the new columns.
  try {
    const r = await fetch(`${base}/board`, { headers: { authorization: `Bearer ${admin}` }, signal: AbortSignal.timeout(10_000) });
    const html = await r.text();
    result('dashboard providers panel has Window/Burn/Projected at reset columns',
      r.status === 200 && html.includes('Projected at reset') && html.includes('>Burn<'), `status ${r.status}`);
  } catch (e) { result('dashboard providers panel', false, String(e)); }
  // Negative: dashboard without credentials is not served.
  try {
    const r = await fetch(`${base}/board`, { redirect: 'manual', signal: AbortSignal.timeout(10_000) });
    result('dashboard without token is denied', r.status !== 200, `status ${r.status}`);
  } catch (e) { result('dashboard without token is denied', false, String(e)); }
}

console.log(failures ? `\n${failures} check(s) FAILED` : '\nall checks passed');
process.exit(failures ? 1 : 0);
