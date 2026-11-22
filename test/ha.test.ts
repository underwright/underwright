import { describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { HaController, isFenced, epochOf, roleName, roleUrl, migrateHa } from '../src/ha.js';

describe('ha fencing helpers', () => {
  it('fences missing or mismatched epochs', () => {
    expect(isFenced(null, 1)).toBe(true);
    expect(isFenced(1, 2)).toBe(true);
    expect(isFenced(2, 2)).toBe(false);
    expect(epochOf('7')).toBe(7);
    expect(epochOf('x')).toBeNull();
  });
  it('derives safe role names and urls', () => {
    expect(roleName('A-1')).toBe('uw_cp_a_1');
    expect(() => roleName("a'; drop")).toThrow();
    expect(roleUrl('postgres://admin:x@h:5432/db', 'a', 'pw')).toContain('uw_cp_a:pw@');
  });
});

// Drills need an admin-capable dedicated test database.
const url = process.env.UNDERWRIGHT_TEST_DATABASE_URL;
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
async function until(fn: () => boolean, ms = 15000) { const t = Date.now(); while (!fn()) { if (Date.now() - t > ms) throw new Error('timeout'); await sleep(100); } }

describe.skipIf(!url)('ha drills (postgres)', () => {
  const domain = 'drill';
  const cfg = (id: string) => ({ domainId: domain, instanceId: id, adminUrl: url!, ttlMs: 2000, heartbeatMs: 300, admissionMarginMs: 300 });
  async function writeAs(id: string) {
    const sql = postgres(roleUrl(url!, id, 'drillpw'), { max: 1, onnotice: () => {} });
    try { await sql`INSERT INTO tasks (id, title, status, priority, created_by) VALUES (${'t-' + id + '-' + Date.now()}, 'x', 'open', 2, ${id})`; return 'ok'; }
    catch (e: any) { return String(e.message); } finally { await sql.end(); }
  }

  it('failover-drill and rejoin-drill', async () => {
    await migrateHa(url!, { domainId: domain, instanceIds: ['a', 'b'], rolePassword: 'drillpw' });
    const a = new HaController(cfg('a')); const b = new HaController(cfg('b'));
    await a.start(); await until(() => a.state === 'active');
    await b.start();
    expect(b.state).toBe('standby');
    expect(await writeAs('a')).toBe('ok');
    // kill active without release: lease must expire, standby promotes
    await a.stop(false);
    await until(() => b.state === 'active');
    expect(b.generation).toBeGreaterThan(1);
    expect(await writeAs('b')).toBe('ok');
    // rejoin: former leader returns, demotes to standby, writes are fenced
    const a2 = new HaController(cfg('a')); await a2.start();
    expect(a2.state).toBe('standby');
    expect(await writeAs('a')).toMatch(/fenced/);
    expect(await writeAs('b')).toBe('ok');
    await a2.stop(); await b.stop();
  }, 60000);
});
