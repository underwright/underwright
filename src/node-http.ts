import type { IncomingMessage, ServerResponse } from 'node:http';
import { z } from 'zod';
import type { IStore } from './istore.js';
import { nodeEnrollmentSchema } from './node-protocol.js';

/** Only parsing/auth here: durable limits and state transitions belong to IStore. */
export async function handleNodeHttp(store: IStore, req: IncomingMessage, res: ServerResponse, adminConfigured: boolean) {
  const reply = (status: number, value: unknown) => {
    if (res.destroyed) return;
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...(status === 429 ? { 'retry-after': '3' } : {}) }).end(JSON.stringify(value));
  };
  if (!adminConfigured) { reply(503, { error: 'Configure UNDERWRIGHT_TOKEN before enrolling nodes or approving enrollment' }); return; }
  if (req.method !== 'POST') { reply(405, { error: 'POST required' }); return; }
  if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] ?? '')) { reply(415, { error: 'JSON required' }); return; }
  const timeout = setTimeout(() => { reply(408, { error: 'request timeout' }); req.destroy(); }, 10000);
  try {
    let size = 0;
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      const buf = Buffer.from(chunk); size += buf.length;
      if (size > 8192) { reply(413, { error: 'body too large' }); return; }
      chunks.push(buf);
    }
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    let result: any;
    if (req.url === '/nodes/v1/enrollments') {
      result = await store.createNodeEnrollment(nodeEnrollmentSchema.parse(body));
    } else if (/^\/nodes\/v1\/enrollments\/enroll-[a-f0-9-]{36}\/exchange$/.test(req.url ?? '')) {
      const a = z.object({ device_secret: z.string().regex(/^[a-f0-9]{64}$/) }).strict().parse(body);
      result = await store.exchangeNodeEnrollment(req.url!.split('/')[4], a.device_secret);
    } else if (req.url === '/nodes/v1/session') {
      z.object({ version: z.literal(1) }).strict().parse(body);
      const token = req.headers.authorization?.match(/^Bearer (uw_node_[a-f0-9]{64})$/)?.[1];
      result = token ? await store.startNodeSession(token) : { error: 'unauthorized', status_code: 401 };
    } else { reply(404, { error: 'unknown node endpoint' }); return; }
    reply(result.error ? result.status_code ?? 400 : 200, result);
  } catch (error) {
    // Never echo schema inputs, JSON bodies, credentials or internal SQL errors.
    reply(error instanceof z.ZodError || error instanceof SyntaxError ? 400 : 500, { error: 'node request failed' });
  } finally { clearTimeout(timeout); }
}
