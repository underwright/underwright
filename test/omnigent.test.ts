import { afterEach, describe, expect, it, vi } from 'vitest';
import { SqliteStore } from '../src/store.js';
import { OmniClient, OmniObserver, omniUpdateSchema } from '../src/omnigent.js';

const stores: SqliteStore[] = [];
afterEach(() => { for (const s of stores.splice(0)) s.close(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });
function fixture() {
  const store = new SqliteStore(':memory:'); stores.push(store);
  const submitted = store.submitJob({ agent_id: 'human', type: 'agent', target_agent_id: 'codex@host', agent: { executable: 'codex', args: [], prompt: 'work' } });
  const job = store.nextJob('codex@host', 'host');
  return { store, job, submitted };
}
describe('Omnigent hooks', () => {
  it('persists session, usage and audit events only for the current lease', () => {
    const { store, job } = fixture();
    const update = { session_id: 'session-123', usage: { input_tokens: 100, output_tokens: 20, total_cost_usd: 0.5 }, events: [{ id: 'event-1', type: 'session.interrupted', data: { reason: 'human' } }] };
    expect(store.recordOmnigent(job.id, 'other', job.lease_token, update)).toHaveProperty('error');
    expect(store.getJob(job.id)).toHaveProperty('omni_session', null);
    expect(store.recordOmnigent(job.id, 'codex@host', job.lease_token, update)).toEqual({ id: job.id });
    expect(store.getJob(job.id)).toHaveProperty('omni_session', 'session-123');
    expect(JSON.parse((store.getJob(job.id) as any).omni_usage)).toEqual(update.usage);
    store.recordOmnigent(job.id, 'codex@host', job.lease_token, update);
    expect(store.auditLog(100).filter((e: any) => e.action === 'omni_event')).toHaveLength(1);
    expect((store.board() as any).omni_events).toHaveLength(1);
    store.finishJob(job.id, 'done', 'ok', 'codex@host', job.lease_token);
    expect(store.recordOmnigent(job.id, 'codex@host', job.lease_token, update)).toHaveProperty('error');
  });
  it('validates bounded telemetry and nonnegative usage', () => {
    expect(omniUpdateSchema.safeParse({ session_id: '../escape' }).success).toBe(false);
    expect(omniUpdateSchema.safeParse({ session_id: 's', usage: { input_tokens: -1 } }).success).toBe(false);
    expect(omniUpdateSchema.safeParse({ session_id: 's', events: Array(101).fill({ id: 'x', type: 'subagent.started' }) }).success).toBe(false);
  });
  it('keeps durable mail when push fails, and targets only a live owned session', async () => {
    const { store, job } = fixture();
    const push = vi.spyOn(OmniClient.prototype, 'send').mockRejectedValue(new Error('offline'));
    vi.stubEnv('UNDERWRIGHT_OMNI_URL', 'http://localhost:6767');
    store.recordOmnigent(job.id, 'codex@host', job.lease_token, { session_id: 'session-123' });
    expect(store.sendMessage('codex@host', 'human', 'continue')).toEqual({ sent: 'codex@host' });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(push).toHaveBeenCalledTimes(1);
    expect(store.inbox('codex@host')).toHaveLength(1);
    store.finishJob(job.id, 'done', 'ok', 'codex@host', job.lease_token);
    store.sendMessage('codex@host', 'human', 'after');
    expect(push).toHaveBeenCalledTimes(1);
  });
  it('uses the peer-session API contract with explicit source and credentials', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ queued: true }), { status: 200 }));
    const client = new OmniClient('http://localhost:6767', 'runner-token', 'source-session', fetcher);
    await client.send('destination', 'hello');
    const [url, init] = fetcher.mock.calls[0];
    expect(url.toString()).toBe('http://localhost:6767/v1/sessions/destination/events');
    expect(JSON.parse(init.body)).toEqual({ type: 'session_message', data: { message: 'hello' } });
    expect(init.headers.Authorization).toBe('Bearer runner-token');
    expect(init.headers['X-Omnigent-Orchestration-Source']).toBe('source-session');
  });
  it('reads usage snapshots without downloading transcript items', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ total_cost_usd: 1.25, usage_by_model: { model: { input_tokens: 10, output_tokens: 5 } } })));
    const client = new OmniClient('http://localhost:6767', undefined, undefined, fetcher);
    expect(await client.usage('session')).toEqual({ input_tokens: 10, output_tokens: 5, total_cost_usd: 1.25 });
    expect(fetcher.mock.calls[0][0].toString()).toContain('include_items=false');
  });
});

describe('Omnigent observation', () => {
  it('parses split SSE frames and captures usage and interventions', async () => {
    const encoder = new TextEncoder();
    const frames = ['data: {"type":"response.elicitation_request","elicitation_id":"q"}\r', '\n\r\n',
      'data: {"type":"session.usage","total_cost_usd":0.75}\n\n'];
    const fetcher = vi.fn().mockResolvedValue(new Response(new ReadableStream({ start(controller) {
      for (const frame of frames) controller.enqueue(encoder.encode(frame)); controller.close();
    } })));
    const events: any[] = [];
    await new OmniClient('http://localhost:6767', undefined, undefined, fetcher).stream('s', new AbortController().signal, event => events.push(event));
    expect(events.map(e => e.type)).toEqual(['response.elicitation_request', 'session.usage']);
  });
  it('retains bounded events and final cumulative usage, and stops the stream', async () => {
    const client = new OmniClient('http://localhost:6767');
    vi.spyOn(client, 'usage').mockResolvedValue({ input_tokens: 50, total_cost_usd: 1 });
    vi.spyOn(client, 'stream').mockImplementation(async (_session, signal, onEvent) => {
      onEvent({ type: 'session.child_session.updated', child_session_id: 'child', child: { status: 'running' } });
      onEvent({ type: 'response.policy_denied', reason: 'human review needed' });
      await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
    });
    const observer = new OmniObserver('s', client);
    observer.refresh();
    await observer.stop();
    expect(observer.snapshot().usage).toEqual({ input_tokens: 50, total_cost_usd: 1 });
    expect(observer.snapshot().events).toHaveLength(2);
    expect(observer.snapshot().events?.[1].type).toBe('response.policy_denied');
  });
});

describe('Omnigent delivery failures', () => {
  it('refuses missing runner identity, denied requests, and ambiguous acknowledgements', async () => {
    const fetcher = vi.fn();
    await expect(new OmniClient('http://localhost:6767', undefined, undefined, fetcher).send('s', 'hello')).rejects.toThrow(/runner credentials/);
    expect(fetcher).not.toHaveBeenCalled();
    fetcher.mockResolvedValueOnce(new Response('', { status: 403 }));
    await expect(new OmniClient('http://localhost:6767', 'token', 'source', fetcher).send('s', 'hello')).rejects.toThrow(/403/);
    fetcher.mockResolvedValueOnce(new Response('{}'));
    await expect(new OmniClient('http://localhost:6767', 'token', 'source', fetcher).send('s', 'hello')).rejects.toThrow(/not acknowledged/);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('rejects embedded URL credentials and retains usage when stream updates omit fields', async () => {
    expect(() => new OmniClient('https://user:password@example.com')).toThrow(/invalid/);
    const client = new OmniClient('http://localhost:6767');
    vi.spyOn(client, 'usage').mockRejectedValue(new Error('offline'));
    vi.spyOn(client, 'stream').mockImplementation(async (_s, signal, onEvent) => {
      onEvent({ type: 'session.usage', total_cost_usd: 0.5, usage_by_model: { m: { input_tokens: 10 } } });
      onEvent({ type: 'session.usage', context_window: 200000 });
      await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
    });
    const observer = new OmniObserver('s', client);
    await observer.stop();
    expect(observer.snapshot().usage).toEqual({ input_tokens: 10, total_cost_usd: 0.5 });
  });
  it('does not accelerate mail rolled back by an enclosing transaction', async () => {
    const { store, job } = fixture();
    vi.stubEnv('UNDERWRIGHT_OMNI_URL', 'http://localhost:6767');
    const push = vi.spyOn(OmniClient.prototype, 'send').mockResolvedValue(undefined);
    store.recordOmnigent(job.id, 'codex@host', job.lease_token, { session_id: 's' });
    const db = (store as any).db;
    expect(() => db.transaction(() => { store.sendMessage('codex@host', 'human', 'rollback'); throw new Error('rollback'); })()).toThrow('rollback');
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(store.inbox('codex@host')).toHaveLength(0);
    expect(push).not.toHaveBeenCalled();
  });
});
