import { createHash } from 'node:crypto';
import { z } from 'zod';
import { setTimeout as delay } from 'node:timers/promises';

const count = z.number().int().nonnegative();
export const omniUsageSchema = z.object({
  input_tokens: count.optional(), output_tokens: count.optional(),
  cache_read_input_tokens: count.optional(), cache_creation_input_tokens: count.optional(),
  total_tokens: count.optional(), total_cost_usd: z.number().nonnegative().optional(),
}).strict();
const eventTypes = ['subagent.started', 'subagent.completed', 'subagent.tool_call',
  'session.child_session.updated', 'session.interrupted', 'response.elicitation_request',
  'response.elicitation_resolved', 'response.policy_denied', 'session.background_tasks', 'comment.relay'] as const;
export const omniUpdateSchema = z.object({
  session_id: z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/),
  usage: omniUsageSchema.optional(),
  events: z.array(z.object({ id: z.string().min(1).max(128), type: z.enum(eventTypes),
    data: z.record(z.string(), z.unknown()).optional().refine(v => JSON.stringify(v ?? {}).length <= 8000, 'event too large'),
  }).strict()).max(25).optional(),
}).strict();
export type OmniUpdate = z.infer<typeof omniUpdateSchema>;
export type OmniUsage = z.infer<typeof omniUsageSchema>;

/** Only explicitly configured service endpoints receive credentials, never transcript URLs. */
export class OmniClient {
  constructor(readonly base: string, private token?: string, private source?: string,
    private fetcher: typeof fetch = fetch) {
    const u = new URL(base);
    if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password || u.search || u.hash) throw new Error('invalid Omnigent endpoint');
  }
  static configured(): OmniClient | undefined {
    const base = process.env.UNDERWRIGHT_OMNI_URL;
    return base ? new OmniClient(base, process.env.UNDERWRIGHT_OMNI_TOKEN, process.env.UNDERWRIGHT_OMNI_SOURCE_SESSION) : undefined;
  }
  private url(session: string, suffix = '') {
    if (!omniUpdateSchema.shape.session_id.safeParse(session).success) throw new Error('invalid Omnigent session id');
    return new URL(`${this.base.replace(/\/$/, '')}/v1/sessions/${encodeURIComponent(session)}${suffix}`);
  }
  private headers(): Record<string, string> {
    return { 'Content-Type': 'application/json', ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}) };
  }
  async send(session: string, message: string) {
    if (!this.token || !this.source) throw new Error('Omnigent push requires runner credentials and source session');
    // An uncertain acknowledgement must not cause a retry: durable board mail remains available.
    const response = await this.fetcher(this.url(session, '/events'), {
      method: 'POST', headers: { ...this.headers(), 'X-Omnigent-Orchestration-Source': this.source },
      body: JSON.stringify({ type: 'session_message', data: { message: message.slice(0, 8000) } }),
      signal: AbortSignal.timeout(5000), redirect: 'error',
    });
    if (!response.ok) throw new Error(`Omnigent push refused (${response.status})`);
    const ack = await response.json() as any;
    if (typeof ack.queued !== 'boolean' || ack.denied === true) throw new Error('Omnigent push not acknowledged');
  }
  async usage(session: string): Promise<OmniUsage> {
    const url = this.url(session);
    url.searchParams.set('include_items', 'false');
    url.searchParams.set('include_live_status', 'false');
    const response = await this.fetcher(url, { headers: this.headers(), signal: AbortSignal.timeout(5000), redirect: 'error' });
    if (!response.ok) throw new Error(`Omnigent usage unavailable (${response.status})`);
    return usageFromSnapshot(await response.json());
  }
  /** Live-tail frames are bounded before JSON parsing. Snapshot usage recovers after reconnects. */
  async stream(session: string, signal: AbortSignal, onEvent: (event: Record<string, any>) => void) {
    const response = await this.fetcher(this.url(session, '/stream'), { headers: this.headers(), signal, redirect: 'error' });
    if (!response.ok || !response.body) throw new Error('Omnigent stream unavailable');
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      while (!signal.aborted) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer = (buffer + decoder.decode(value, { stream: true })).replace(/\r\n/g, '\n');
        if (buffer.length > 256000) throw new Error('Omnigent event frame too large');
        let boundary;
        while ((boundary = buffer.indexOf('\n\n')) >= 0) {
          const frame = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
          const data = frame.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).trimStart()).join('\n');
          if (data && data !== '[DONE]') {
            try { const event = JSON.parse(data); if (event && typeof event === 'object') onEvent(event); } catch { /* ignore malformed frames */ }
          }
        }
      }
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  }
}

export function usageFromSnapshot(snapshot: any): OmniUsage {
  const usage: Record<string, number> = {};
  if (typeof snapshot?.total_cost_usd === 'number') usage.total_cost_usd = snapshot.total_cost_usd;
  for (const model of Object.values(snapshot?.usage_by_model ?? {}) as any[]) {
    for (const key of ['input_tokens', 'output_tokens', 'total_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens']) {
      if (typeof model?.[key] === 'number') usage[key] = (usage[key] ?? 0) + model[key];
    }
  }
  return omniUsageSchema.parse(usage);
}

/** A process-local observer; SQLite/Postgres and the job lease remain the durable authority. */
export class OmniObserver {
  private controller = new AbortController();
  private events: NonNullable<OmniUpdate['events']> = [];
  private usage: OmniUsage = {};
  private pending?: Promise<void>;
  private streaming?: Promise<void>;
  private stopped?: Promise<void>;
  constructor(readonly session: string, private client?: OmniClient) {
    if (client) this.streaming = this.observe(client);
  }
  private async observe(client: OmniClient) {
    while (!this.controller.signal.aborted) {
      try { await client.stream(this.session, this.controller.signal, event => {
      if (event.type === 'session.usage') {
        try { this.usage = { ...this.usage, ...usageFromSnapshot(event) }; } catch { /* retain valid usage */ }
      } else if ((eventTypes as readonly string[]).includes(event.type)) {
        const data = JSON.stringify(event);
        const parsed = omniUpdateSchema.shape.events.safeParse([{ id: String(event.id ?? createHash('sha256').update(data).digest('hex')), type: event.type, data: event }]);
        if (parsed.success) this.events = [...this.events, ...parsed.data!].slice(-25);
      }
      }); } catch { /* retry read-only streams while the job remains alive */ }
      await delay(1000, undefined, { signal: this.controller.signal }).catch(() => {});
    }
  }
  refresh() {
    if (this.stopped || !this.client || this.pending) return;
    this.pending = this.client.usage(this.session).then(usage => { this.usage = { ...this.usage, ...usage }; }).catch(() => {}).finally(() => { this.pending = undefined; });
  }
  snapshot(): OmniUpdate { return { session_id: this.session, usage: { ...this.usage }, events: [...this.events] }; }
  stop(): Promise<void> {
    return this.stopped ??= (async () => {
      this.controller.abort();
      await this.streaming;
      await this.pending;
      try { if (this.client) this.usage = { ...this.usage, ...await this.client.usage(this.session) }; } catch { /* retain last usage */ }
    })();
  }
}

export function pushBoardMail(session: string, from: string, body: string, durable: () => boolean | Promise<boolean> = () => true) {
  queueMicrotask(() => {
    void (async () => {
      const client = OmniClient.configured();
      if (client && await durable()) await client.send(session, `[Underwright mail from ${from}]\n${body}`);
    })().catch(() => {}); // Mailbox commit/availability never depends on the optional accelerator.
  });
}

/** Normalize a captured locator without trusting its origin for API requests. */
export function omniSessionId(locator: string): string | undefined {
  let id = locator;
  try { id = new URL(locator).pathname.split('/').filter(Boolean).pop() ?? ''; } catch { /* bare id */ }
  return omniUpdateSchema.shape.session_id.safeParse(id).success ? id : undefined;
}
