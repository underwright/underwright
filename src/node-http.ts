import type { IncomingMessage, ServerResponse } from 'node:http';
import { z } from 'zod';
import type { IStore } from './istore.js';
import { nodeEnrollmentSchema, nodePollSchema, nodeRenewSchema, nodeFinishSchema, nodeHeartbeatSchema, nodeCapabilitiesSchema } from './node-protocol.js';

function nodeBearer(req: IncomingMessage) {
  return req.headers.authorization?.match(/^Bearer (uw_node_[a-f0-9]{64})$/)?.[1];
}

/** Only parsing/auth here: durable limits and state transitions belong to IStore. */
export async function handleNodeHttp(store: IStore, req: IncomingMessage, res: ServerResponse, adminConfigured: boolean) {
  const reply = (status: number, value?: unknown) => {
    if (res.destroyed || res.headersSent) return;
    const headers: Record<string, string> = { 'content-type': 'application/json', 'cache-control': 'no-store' };
    if (status === 429) headers['retry-after'] = '3';
    if (value === undefined) { res.writeHead(status, headers).end(); return; }
    res.writeHead(status, headers).end(JSON.stringify(value));
  };
  if (!adminConfigured) { reply(503, { error: 'Configure UNDERWRIGHT_TOKEN before enrolling nodes or approving enrollment' }); return; }
  const allowPut = req.url === '/nodes/v1/capabilities' && req.method === 'PUT';
  if (!allowPut && req.method !== 'POST') { reply(405, { error: 'POST required' }); return; }
  if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] ?? '')) { reply(415, { error: 'JSON required' }); return; }
  const jobRoute = /^\/nodes\/v1\/jobs\//.test(req.url ?? '');
  const limit = jobRoute ? 400000 : 8192;
  const timeout = setTimeout(() => { reply(408, { error: 'request timeout' }); req.destroy(); }, 10000);
  const abort = new AbortController();
  const onClose = () => { if (!res.headersSent && !res.writableEnded) abort.abort(); };
  res.once('close', onClose);
  try {
    let size = 0;
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      const buf = Buffer.from(chunk); size += buf.length;
      if (size > limit) { reply(413, { error: 'body too large' }); return; }
      chunks.push(buf);
    }
    clearTimeout(timeout);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    let result: any;
    if (req.url === '/nodes/v1/enrollments') {
      result = await store.createNodeEnrollment(nodeEnrollmentSchema.parse(body));
    } else if (/^\/nodes\/v1\/enrollments\/enroll-[a-f0-9-]{36}\/exchange$/.test(req.url ?? '')) {
      const a = z.object({ device_secret: z.string().regex(/^[a-f0-9]{64}$/) }).strict().parse(body);
      result = await store.exchangeNodeEnrollment(req.url!.split('/')[4], a.device_secret);
    } else if (req.url === '/nodes/v1/session') {
      z.object({ version: z.literal(1) }).strict().parse(body);
      const token = nodeBearer(req);
      result = token ? await store.startNodeSession(token) : { error: 'unauthorized', status_code: 401 };
    } else if (req.url === '/nodes/v1/heartbeat') {
      const a = nodeHeartbeatSchema.parse(body);
      const token = nodeBearer(req);
      result = token ? await store.nodeHeartbeat(token, a.session_id, a) : { error: 'unauthorized', status_code: 401 };
    } else if (req.url === '/nodes/v1/capabilities') {
      const a = nodeCapabilitiesSchema.parse(body);
      const token = nodeBearer(req);
      result = token ? await store.putNodeCapabilities(token, a.session_id, a.version, a.inventory) : { error: 'unauthorized', status_code: 401 };
    } else if (req.url === '/nodes/v1/poll') {
      const a = nodePollSchema.parse(body);
      const token = nodeBearer(req);
      result = token ? await store.pollNodeJob(token, a.session_id, a.wait_seconds, abort.signal, a.held_job_ids) : { error: 'unauthorized', status_code: 401 };
    } else if (/^\/nodes\/v1\/jobs\/job-[a-f0-9]{8}\/(renew|finish|worker)$/.test(req.url ?? '')) {
      const jobId = req.url!.split('/')[4];
      const action = req.url!.split('/')[5];
      const token = nodeBearer(req);
      if (!token) { reply(401, { error: 'unauthorized' }); return; }
      if (action === 'renew') {
        const a = nodeRenewSchema.parse(body);
        result = await store.renewNodeJob(token, a.session_id, jobId, a.lease_token, a.result);
      } else if (action === 'worker') {
        const a = nodeRenewSchema.parse(body);
        result = await store.issueNodeWorker(token, a.session_id, jobId, a.lease_token);
      } else {
        const a = nodeFinishSchema.parse(body);
        result = await store.finishNodeJob(token, a.session_id, jobId, a.lease_token, a.status, a.result, a.result_metadata);
      }
    } else { reply(404, { error: 'unknown node endpoint' }); return; }
    if (result?.empty || result?.status_code === 204) { reply(204); return; }
    reply(result.error ? result.status_code ?? 400 : 200, result);
  } catch (error) {
    // Never echo schema inputs, JSON bodies, credentials or internal SQL errors.
    reply(error instanceof z.ZodError || error instanceof SyntaxError ? 400 : 500, { error: 'node request failed' });
  } finally {
    clearTimeout(timeout);
    res.off('close', onClose);
  }
}
