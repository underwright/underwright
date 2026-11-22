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

  const admin = () => postgres(url!, { max: 1, onnotice: () => {} });
  let a: HaController, b: HaController, a2: HaController | null = null;
  let preId = '';

  it('failover-drill: active dies, standby promotes within bound, board state intact', async () => {
    await migrateHa(url!, { domainId: domain, instanceIds: ['a', 'b'], rolePassword: 'drillpw' });
    a = new HaController(cfg('a')); b = new HaController(cfg('b'));
    await a.start(); await until(() => a.state === 'active');
    await b.start();
    expect(b.state).toBe('standby');
    preId = 'pre-' + Date.now();
    const asA = postgres(roleUrl(url!, 'a', 'drillpw'), { max: 1, onnotice: () => {} });
    await asA`INSERT INTO tasks (id, title, status, priority, created_by) VALUES (${preId}, 'pre-failover', 'open', 2, 'a')`;
    // paused leader: A keeps a live session open across the failover
    await asA`SELECT 1`;
    // kill active without release: lease must expire, standby promotes
    const killedAt = Date.now();
    await a.stop(false);
    await until(() => b.state === 'active');
    const window = Date.now() - killedAt;
    expect(window).toBeLessThan(2000 /* ttl */ + 2 * 300 /* heartbeat */ + 1000 /* slack */);
    expect(b.generation).toBeGreaterThan(1);
    // the paused leader's session was terminated in the promotion tx; nothing it sends can commit
    const paused = await asA`INSERT INTO tasks (id, title, status, priority, created_by) VALUES (${'late-' + Date.now()}, 'x', 'open', 2, 'a')`
      .then(() => 'ok', (e: any) => String(e.message));
    expect(paused).not.toBe('ok');
    await asA.end({ timeout: 1 }).catch(() => {});
    const sql = admin();
    try {
      const rows = await sql`SELECT title FROM tasks WHERE id = ${preId}`;
      expect(rows[0]?.title).toBe('pre-failover');
    } finally { await sql.end(); }
    expect(await writeAs('b')).toBe('ok');
  }, 60000);

  it('rejoin-drill: former leader rejoins, demotes, is fenced; single audit stream', async () => {
    const before = Date.now();
    a2 = new HaController(cfg('a')); await a2.start();
    expect(a2.state).toBe('standby');
    expect(a2.readiness().ready).toBe(false);
    expect(() => a2!.assertWritable()).toThrow();
    expect(await writeAs('a')).toMatch(/fenced/);
    // a few heartbeats: a2 must not contend while b's lease is live
    await sleep(1000);
    expect(a2.state).toBe('standby');
    expect(b.state).toBe('active');
    expect(await writeAs('b')).toBe('ok');
    const sql = admin();
    try {
      const mine = await sql`SELECT id FROM tasks WHERE id LIKE 't-a-%'`;
      expect(mine.filter(r => Number(String(r.id).slice(4)) >= before)).toEqual([]);
      const ev = await sql`SELECT kind, instance_id, generation FROM uw_ha_events WHERE domain_id = ${domain} AND kind = 'acquire' ORDER BY id`;
      const gens = ev.map(e => Number(e.generation));
      // strictly increasing generations, exactly one holder per generation
      expect(gens).toEqual([...new Set(gens)].sort((x, y) => x - y));
      const leader = await sql`SELECT holder_id, generation FROM uw_cp_leader WHERE domain_id = ${domain}`;
      expect(leader[0].holder_id).toBe('b');
      expect(Number(leader[0].generation)).toBe(gens[gens.length - 1]);
      expect(ev[ev.length - 1].instance_id).toBe('b');
    } finally { await sql.end(); }
    await a2.stop(); await b.stop();
  }, 60000);
});
