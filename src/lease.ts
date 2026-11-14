// Lease bookkeeping shared by both stores.

/**
 * Should a job renewal write an audit event? Runners heartbeat every second
 * (to stream live output), so logging every renewal floods the audit log.
 * Log only once at least a third of the lease has been consumed since the
 * previous renewal, i.e. the prior lease had ≤ 2/3 of the new TTL left.
 */
export function renewalWorthLogging(priorExpires: unknown, ttlMs: number, now = Date.now()): boolean {
  if (priorExpires == null || priorExpires === "") return true;
  const prior = priorExpires instanceof Date ? priorExpires.getTime() : Date.parse(String(priorExpires));
  if (!Number.isFinite(prior)) return true;
  return prior - now <= (ttlMs * 2) / 3;
}
