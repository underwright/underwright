#!/usr/bin/env node
/** sqlite→postgres one-shot migration for the underwright store (gh-200).
 *
 *  Copies every table that exists in the PgStore DDL from a SQLite database
 *  into Postgres. Skips SQLite-only tables (search_idx* FTS, github_status,
 *  cp_leader, code_*, sprints, agent_keys, sqlite_sequence) — either
 *  rebuildable indexes or features not yet ported.
 *
 *  Idempotent: every insert uses ON CONFLICT DO NOTHING, so it can be rerun
 *  or used for incremental catch-up before a cutover.
 *
 *  Usage:
 *    UNDERWRIGHT_DB=./underwright.db DATABASE_URL=postgres://... \
 *      node scripts/sqlite-to-pg.mjs [--dry-run] [--events-since <iso>]
 */
import Database from "better-sqlite3";
import postgres from "postgres";

const args = process.argv.slice(2);
const DRY = args.includes("--dry-run");
const UPSERT = args.includes("--upsert");
const eventsSinceIdx = args.indexOf("--events-since");
const EVENTS_SINCE = eventsSinceIdx >= 0 ? args[eventsSinceIdx + 1] : null;

const dbPath = process.env.UNDERWRIGHT_DB || "underwright.db";
const url = process.env.DATABASE_URL;
if (!url) { console.error("DATABASE_URL is required"); process.exit(2); }

/** Insert order respects FK direction (parents first). */
const ORDER = [
  "tasks", "task_dependencies", "claims", "artifacts", "evidence",
  "task_ledger", "jobs", "helpers", "messages", "watches", "locks",
  "nodes", "node_enrollments", "node_tokens", "node_workers",
  "node_rate_limits", "provider_quota", "harness_health", "events",
];

const sqlite = new Database(dbPath, { readonly: true, timeout: 30000 });
const sql = postgres(url, { max: 3, idle_timeout: 20 });

const pgTables = new Set(
  (await sql`SELECT table_name FROM information_schema.tables WHERE table_schema='public'`)
    .map((r) => r.table_name),
);
const colRows = await sql`SELECT table_name, column_name, udt_name, is_identity FROM information_schema.columns WHERE table_schema='public' ORDER BY ordinal_position`;
const colMap = {};
const identityCols = {};
for (const r of colRows) {
  (colMap[r.table_name] ??= []).push(r);
  if (r.is_identity === "YES") (identityCols[r.table_name] ??= []).push(r.column_name);
}

const pkRows = await sql`
  SELECT kcu.table_name, kcu.column_name
  FROM information_schema.table_constraints tc
  JOIN information_schema.key_column_usage kcu
    ON tc.constraint_name = kcu.constraint_name AND tc.table_name = kcu.table_name
  WHERE tc.constraint_type = 'PRIMARY KEY' AND tc.table_schema = 'public'
  ORDER BY kcu.ordinal_position`;
const pkMap = {};
for (const r of pkRows) (pkMap[r.table_name] ??= []).push(r.column_name);

const sqliteTables = new Set(
  sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name),
);

let totalRows = 0;
for (const table of ORDER) {
  if (!pgTables.has(table)) { console.log(`skip ${table}: no PG table`); continue; }
  if (!sqliteTables.has(table)) { console.log(`skip ${table}: no SQLite table`); continue; }
  const liteCols = new Set(sqlite.prepare(`PRAGMA table_info(${q(table)})`).all().map((c) => c.name));
  const missing = colMap[table].map((c) => c.column_name).filter((c) => !liteCols.has(c));
  if (missing.length) console.log(`  warn ${table}: PG-only columns get defaults: ${missing.join(",")}`);
  const cols = colMap[table].map((c) => c.column_name).filter((c) => liteCols.has(c));
  const colInfo = Object.fromEntries(colMap[table].map((c) => [c.column_name, c.udt_name]));
  let where = "";
  const params = [];
  if (table === "events" && EVENTS_SINCE) { where = " WHERE created_at >= ?"; params.push(EVENTS_SINCE); }
  const count = sqlite.prepare(`SELECT COUNT(*) c FROM ${q(table)}${where}`).get(...params).c;
  console.log(`${table}: ${count} rows`);

  const CHUNK = table === "events" ? 1000 : 400;
  const select = sqlite.prepare(`SELECT ${cols.map(q).join(",")} FROM ${q(table)}${where}`);
  let done = 0;
  const iter = select.iterate(...params);
  let batch = [];
  const flush = async () => {
    if (!batch.length) return;
    const ph = batch.map((_, i) => `(${cols.map((_, j) => `$${i * cols.length + j + 1}`).join(",")})`).join(",");
    const flat = batch.flatMap((row) => cols.map((c) => coerce(row[c], colInfo[c])));
    const overriding = identityCols[table] ? " OVERRIDING SYSTEM VALUE" : "";
    // Upsert converges mutable tables on rerun; events stay append-only.
    const pk = pkMap[table];
    const upsertable = UPSERT && pk && table !== "events";
    const onConflict = upsertable
      ? `ON CONFLICT (${pk.map(q).join(",")}) DO UPDATE SET ${cols.filter((c) => !pk.includes(c)).map((c) => `${q(c)}=excluded.${q(c)}`).join(",") || `${q(pk[0])}=excluded.${q(pk[0])}`}`
      : "ON CONFLICT DO NOTHING";
    if (!DRY) await sql.unsafe(`INSERT INTO ${q(table)} (${cols.map(q).join(",")})${overriding} VALUES ${ph} ${onConflict}`, flat);
    done += batch.length; totalRows += batch.length; batch = [];
    if (done % 10000 < CHUNK) process.stdout.write(`\r  ${done}/${count}`);
  };
  for (const row of iter) { batch.push(row); if (batch.length >= CHUNK) await flush(); }
  await flush();
  process.stdout.write(`\r  ${table}: ${done} copied\n`);
}
// Advance identity sequences past the migrated ids so future inserts don't collide.
if (!DRY) for (const [table, cols] of Object.entries(identityCols)) {
  for (const col of cols) {
    const seq = await sql`SELECT pg_get_serial_sequence(${table}, ${col}) AS s`;
    if (seq[0]?.s) await sql.unsafe(`SELECT setval('${seq[0].s}', COALESCE((SELECT MAX(${q(col)}) FROM ${q(table)}), 1))`);
    console.log(`sequence ${table}.${col} advanced`);
  }
}
console.log(`total: ${totalRows} rows ${DRY ? "(dry-run, nothing written)" : "copied"}`);
await sql.end();

function q(name) { return `"${name.replace(/"/g, '""')}"`; }
function coerce(v, udt) {
  if (v === null || v === undefined) return null;
  if (udt === "bool") return !!v;
  return v;
}
