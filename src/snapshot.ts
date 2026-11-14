// Workspace snapshot: `underwright export` / `underwright import` (ADR-0010 §4).
//
// Format (NDJSON, one JSON object per line):
//   {"type":"header","format":"underwright-snapshot","version":1,"backend":"sqlite","exported_at":"…"}
//   {"type":"row","table":"tasks","row":{…}}        ← every table, in schema order
//   {"type":"end","counts":{"tasks":12,…}}           ← lets import detect truncation
//
// Rows carry every column verbatim, so ids (task, claim, evidence, event,
// message) survive a round trip. Values are written as the source backend
// returns them. Postgres timestamps become ISO strings. Import coerces each
// value to the target column type, so SQLite → Postgres and back both work.
//
// The module talks to the database directly rather than through IStore:
// a snapshot is a table copy, not a sequence of domain operations.
import Database from "better-sqlite3";
import postgres from "postgres";
import { createReadStream, createWriteStream, existsSync } from "node:fs";
import { createInterface } from "node:readline";
import { once } from "node:events";
import type { Writable } from "node:stream";
import { SqliteStore } from "./store.js";
import { PgStore } from "./pstore.js";

export const SNAPSHOT_FORMAT = "underwright-snapshot";
export const SNAPSHOT_VERSION = 1;

/** Schema order: parents before children, so FK checks pass on import. */
export const SNAPSHOT_TABLES = [
  "tasks",
  "task_dependencies",
  "claims",
  "artifacts",
  "evidence",
  "helpers",
  "jobs",
  "locks",
  "messages",
  "watches",
  "code_files",
  "code_symbols",
  "code_refs",
  "events",
  "github_status",
  "agent_keys",
  "nodes",
  "node_enrollments",
  "node_tokens",
  "node_workers",
  "node_rate_limits",
] as const;

export type SnapshotTarget = { kind: "sqlite"; path: string } | { kind: "postgres"; url: string };

export interface SnapshotHeader {
  type: "header";
  format: string;
  version: number;
  backend: SnapshotTarget["kind"];
  exported_at: string;
}

export interface ImportResult {
  counts: Record<string, number>;
  /** Columns present in the snapshot but absent from the target schema. */
  dropped_columns: Record<string, string[]>;
}

/** DATABASE_URL selects Postgres, the same rule as openStore. */
export function snapshotTargetFromEnv(dbPath: string, env: NodeJS.ProcessEnv = process.env): SnapshotTarget {
  return env.DATABASE_URL ? { kind: "postgres", url: env.DATABASE_URL } : { kind: "sqlite", path: dbPath };
}

const qi = (name: string) => `"${name.replace(/"/g, '""')}"`;

/** Known tables first in schema order, then any others alphabetically. */
function orderTables(present: string[]): string[] {
  const known = SNAPSHOT_TABLES.filter(t => present.includes(t)) as string[];
  const extra = present.filter(t => !known.includes(t)).sort();
  return [...known, ...extra];
}

function exportValue(v: unknown): unknown {
  if (v instanceof Date) return v.toISOString();
  if (typeof v === "bigint") return v.toString();
  if (Buffer.isBuffer(v)) throw new Error("snapshot: binary column values are not supported");
  return v;
}

function exportRow(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) out[k] = exportValue(v);
  return out;
}

type Write = (line: string) => void | Promise<void>;

/**
 * Write a consistent snapshot of every table as NDJSON lines (each ends in "\n").
 * Returns row counts per table.
 */
export async function exportSnapshot(target: SnapshotTarget, write: Write): Promise<Record<string, number>> {
  const header: SnapshotHeader = {
    type: "header", format: SNAPSHOT_FORMAT, version: SNAPSHOT_VERSION,
    backend: target.kind, exported_at: new Date().toISOString(),
  };
  await write(JSON.stringify(header) + "\n");
  const counts = target.kind === "sqlite" ? await exportSqlite(target.path, write) : await exportPg(target.url, write);
  await write(JSON.stringify({ type: "end", counts }) + "\n");
  return counts;
}

function sqliteTables(db: Database.Database): string[] {
  // The FTS index (search_idx and its shadow tables) is derived. Import rebuilds it.
  const rows = db.prepare(
    `SELECT name FROM sqlite_master WHERE type='table'
       AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'search_idx%' ORDER BY rowid`,
  ).all() as { name: string }[];
  return orderTables(rows.map(r => r.name));
}

async function exportSqlite(path: string, write: Write): Promise<Record<string, number>> {
  const db = new Database(path, { readonly: true, fileMustExist: true });
  const counts: Record<string, number> = {};
  try {
    // One read transaction: WAL gives every SELECT the same snapshot.
    db.exec("BEGIN");
    for (const table of sqliteTables(db)) {
      let n = 0;
      for (const row of db.prepare(`SELECT * FROM ${qi(table)} ORDER BY rowid`).iterate() as Iterable<Record<string, unknown>>) {
        await write(JSON.stringify({ type: "row", table, row: exportRow(row) }) + "\n");
        n++;
      }
      counts[table] = n;
    }
    db.exec("COMMIT");
  } finally {
    db.close();
  }
  return counts;
}

async function pgTables(sql: postgres.Sql | postgres.TransactionSql): Promise<string[]> {
  const rows = await sql<{ table_name: string }[]>`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = current_schema() AND table_type = 'BASE TABLE'`;
  return orderTables(rows.map(r => r.table_name));
}

async function pgPrimaryKey(sql: postgres.TransactionSql, table: string): Promise<string[]> {
  const rows = await sql<{ attname: string }[]>`
    SELECT a.attname FROM pg_index i
    JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
    WHERE i.indrelid = ${qi(table)}::regclass AND i.indisprimary
    ORDER BY array_position(i.indkey, a.attnum)`;
  return rows.map(r => r.attname);
}

async function exportPg(url: string, write: Write): Promise<Record<string, number>> {
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  const counts: Record<string, number> = {};
  try {
    await sql.begin("isolation level repeatable read read only", async tx => {
      for (const table of await pgTables(tx)) {
        const pk = await pgPrimaryKey(tx, table);
        const order = pk.length ? ` ORDER BY ${pk.map(qi).join(",")}` : "";
        let n = 0;
        const cursor = tx.unsafe(`SELECT * FROM ${qi(table)}${order}`).cursor(500);
        for await (const batch of cursor) {
          for (const row of batch as Record<string, unknown>[]) {
            await write(JSON.stringify({ type: "row", table, row: exportRow(row) }) + "\n");
            n++;
          }
        }
        counts[table] = n;
      }
    });
  } finally {
    await sql.end();
  }
  return counts;
}

type Line =
  | SnapshotHeader
  | { type: "row"; table: string; row: Record<string, unknown> }
  | { type: "end"; counts: Record<string, number> };

/** Parse and validate the line stream: header first, rows, then a matching end line. */
async function* parseSnapshot(lines: AsyncIterable<string> | Iterable<string>): AsyncGenerator<Line> {
  let lineNo = 0;
  let header = false;
  let end: Record<string, number> | null = null;
  const seen: Record<string, number> = {};
  for await (const raw of lines) {
    lineNo++;
    const text = raw.trim();
    if (!text) continue;
    if (end) throw new Error(`snapshot: data after end line (line ${lineNo})`);
    let obj: any;
    try { obj = JSON.parse(text); } catch { throw new Error(`snapshot: invalid JSON on line ${lineNo}`); }
    if (!header) {
      if (obj?.type !== "header" || obj.format !== SNAPSHOT_FORMAT) throw new Error("snapshot: missing underwright-snapshot header");
      if (obj.version !== SNAPSHOT_VERSION) throw new Error(`snapshot: unsupported version ${obj.version}`);
      header = true;
      yield obj;
      continue;
    }
    if (obj?.type === "row" && typeof obj.table === "string" && obj.row && typeof obj.row === "object") {
      seen[obj.table] = (seen[obj.table] ?? 0) + 1;
      yield obj;
    } else if (obj?.type === "end" && obj.counts && typeof obj.counts === "object") {
      end = obj.counts;
    } else {
      throw new Error(`snapshot: unexpected record on line ${lineNo}`);
    }
  }
  if (!header) throw new Error("snapshot: empty input");
  if (!end) throw new Error("snapshot: no end line (truncated?)");
  for (const t of new Set([...Object.keys(end), ...Object.keys(seen)])) {
    if ((end[t] ?? 0) !== (seen[t] ?? 0)) {
      throw new Error(`snapshot: ${t} has ${seen[t] ?? 0} rows, end line says ${end[t] ?? 0}`);
    }
  }
  yield { type: "end", counts: end };
}

/**
 * Load a snapshot into a fresh store. Creates the schema, refuses a non-empty
 * target, and inserts every row with its original ids in one transaction.
 * Any validation failure (bad header, truncation, count mismatch, FK
 * violation) rolls back.
 */
export async function importSnapshot(
  target: SnapshotTarget,
  lines: AsyncIterable<string> | Iterable<string>,
): Promise<ImportResult> {
  // Apply SCHEMA and migrations exactly as a normal open would.
  if (target.kind === "sqlite") new SqliteStore(target.path).close();
  else await (await PgStore.connect(target.url)).close();
  return target.kind === "sqlite" ? importSqlite(target.path, lines) : importPg(target.url, lines);
}

function noteDropped(result: ImportResult, table: string, cols: string[]) {
  if (!cols.length) return;
  const list = (result.dropped_columns[table] ??= []);
  for (const c of cols) if (!list.includes(c)) list.push(c);
}

function sqliteValue(v: unknown): unknown {
  if (v === undefined) return null;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (v !== null && typeof v === "object") return JSON.stringify(v);
  return v;
}

async function importSqlite(path: string, lines: AsyncIterable<string> | Iterable<string>): Promise<ImportResult> {
  const db = new Database(path);
  const result: ImportResult = { counts: {}, dropped_columns: {} };
  try {
    db.pragma("busy_timeout = 5000");
    const tables = sqliteTables(db);
    for (const t of tables) {
      const { n } = db.prepare(`SELECT COUNT(*) AS n FROM ${qi(t)}`).get() as { n: number };
      if (n > 0) throw new Error(`snapshot: target is not empty (${t} has ${n} rows); import needs a fresh store`);
    }
    const columns = new Map<string, Set<string>>();
    const colsOf = (t: string) => {
      let c = columns.get(t);
      if (!c) {
        const info = db.prepare(`SELECT name FROM pragma_table_info(?)`).all(t) as { name: string }[];
        c = new Set(info.map(r => r.name));
        columns.set(t, c);
      }
      return c;
    };
    const stmts = new Map<string, Database.Statement>();

    // Snapshot order already satisfies FKs, but cross-backend snapshots may
    // differ, so check FKs once at the end instead of per row.
    db.pragma("foreign_keys = OFF");
    db.exec("BEGIN IMMEDIATE");
    try {
      for await (const line of parseSnapshot(lines)) {
        if (line.type !== "row") continue;
        const cols = colsOf(line.table);
        if (!cols.size) throw new Error(`snapshot: table ${line.table} does not exist in the target schema`);
        const keys = Object.keys(line.row).filter(k => cols.has(k));
        noteDropped(result, line.table, Object.keys(line.row).filter(k => !cols.has(k)));
        const sig = `${line.table}\0${keys.join("\0")}`;
        let stmt = stmts.get(sig);
        if (!stmt) {
          stmt = db.prepare(`INSERT INTO ${qi(line.table)} (${keys.map(qi).join(",")}) VALUES (${keys.map(() => "?").join(",")})`);
          stmts.set(sig, stmt);
        }
        stmt.run(...keys.map(k => sqliteValue(line.row[k])));
        result.counts[line.table] = (result.counts[line.table] ?? 0) + 1;
      }
      const violations = db.prepare("PRAGMA foreign_key_check").all() as { table: string }[];
      if (violations.length) {
        throw new Error(`snapshot: ${violations.length} foreign key violation(s), first in ${violations[0].table}`);
      }
      rebuildSqliteSearch(db);
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    } finally {
      db.pragma("foreign_keys = ON");
    }
  } finally {
    db.close();
  }
  return result;
}

/** `underwright export [--out FILE]`: NDJSON to FILE, or stdout when FILE is absent or "-". */
export async function exportToPath(target: SnapshotTarget, out?: string): Promise<Record<string, number>> {
  if (target.kind === "sqlite" && !existsSync(target.path)) throw new Error(`snapshot: no database at ${target.path}`);
  const toStdout = !out || out === "-";
  const stream: Writable = toStdout ? process.stdout : createWriteStream(out);
  const write = async (line: string) => {
    if (!stream.write(line)) await once(stream, "drain");
  };
  const counts = await exportSnapshot(target, write);
  if (!toStdout) {
    stream.end();
    await once(stream, "finish");
  }
  return counts;
}

/** `underwright import FILE`: reads NDJSON from FILE, or stdin when FILE is "-". */
export async function importFromPath(target: SnapshotTarget, file: string): Promise<ImportResult> {
  const input = file === "-" ? process.stdin : createReadStream(file, { encoding: "utf8" });
  const rl = createInterface({ input, crlfDelay: Infinity });
  try {
    return await importSnapshot(target, rl);
  } finally {
    rl.close();
  }
}

/** search_idx is derived from artifacts and helpers. Mirrors SqliteStore.index(). */
function rebuildSqliteSearch(db: Database.Database) {
  db.exec("DELETE FROM search_idx");
  db.exec(`INSERT INTO search_idx (entity_type, entity_id, title, content)
    SELECT 'artifact', id, COALESCE(NULLIF(title, ''), kind), content FROM artifacts ORDER BY rowid`);
  db.exec(`INSERT INTO search_idx (entity_type, entity_id, title, content)
    SELECT 'helper', id, COALESCE(NULLIF(symbol, ''), path), summary FROM helpers ORDER BY rowid`);
}

type PgColumn = { data_type: string; udt_name: string; identity: boolean };

/** Every value is sent as text and cast server-side, so driver type inference never applies. */
function pgText(v: unknown, col: PgColumn): string | null {
  if (v === null || v === undefined) return null;
  if (col.data_type === "boolean") {
    if (typeof v === "boolean") return v ? "true" : "false";
    if (typeof v === "number") return v ? "true" : "false";
    return String(v);
  }
  if (col.data_type === "json" || col.data_type === "jsonb") {
    // SQLite stores JSON as text. Postgres exports parse it to objects.
    return typeof v === "string" ? v : JSON.stringify(v);
  }
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

async function importPg(url: string, lines: AsyncIterable<string> | Iterable<string>): Promise<ImportResult> {
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  const result: ImportResult = { counts: {}, dropped_columns: {} };
  try {
    await sql.begin(async tx => {
      // SQLite timestamps ("YYYY-MM-DD HH:MM:SS") have no zone and are UTC.
      await tx`SET LOCAL TIME ZONE 'UTC'`;
      const tables = await pgTables(tx);
      for (const t of tables) {
        const [{ n }] = await tx.unsafe(`SELECT COUNT(*)::int AS n FROM ${qi(t)}`) as unknown as [{ n: number }];
        if (n > 0) throw new Error(`snapshot: target is not empty (${t} has ${n} rows); import needs a fresh store`);
      }
      const colRows = await tx<{ table_name: string; column_name: string; data_type: string; udt_name: string; is_identity: string }[]>`
        SELECT table_name, column_name, data_type, udt_name, is_identity FROM information_schema.columns
        WHERE table_schema = current_schema()`;
      const columns = new Map<string, Map<string, PgColumn>>();
      for (const r of colRows) {
        if (!columns.has(r.table_name)) columns.set(r.table_name, new Map());
        columns.get(r.table_name)!.set(r.column_name, { data_type: r.data_type, udt_name: r.udt_name, identity: r.is_identity === "YES" });
      }
      // Defer deferrable FKs. Non-deferrable ones rely on schema order.
      await tx`SET CONSTRAINTS ALL DEFERRED`;

      for await (const line of parseSnapshot(lines)) {
        if (line.type !== "row") continue;
        const cols = columns.get(line.table);
        if (!cols) throw new Error(`snapshot: table ${line.table} does not exist in the target schema`);
        const keys = Object.keys(line.row).filter(k => cols.has(k));
        noteDropped(result, line.table, Object.keys(line.row).filter(k => !cols.has(k)));
        const overriding = keys.some(k => cols.get(k)!.identity) ? " OVERRIDING SYSTEM VALUE" : "";
        const placeholders = keys.map((k, i) => `$${i + 1}::text::${qi(cols.get(k)!.udt_name)}`);
        await tx.unsafe(
          `INSERT INTO ${qi(line.table)} (${keys.map(qi).join(",")})${overriding} VALUES (${placeholders.join(",")})`,
          keys.map(k => pgText(line.row[k], cols.get(k)!)),
        );
        result.counts[line.table] = (result.counts[line.table] ?? 0) + 1;
      }

      // Move identity/serial sequences past the imported ids.
      const seqs = await tx<{ table_name: string; column_name: string }[]>`
        SELECT table_name, column_name FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND (is_identity = 'YES' OR column_default LIKE 'nextval(%')`;
      for (const s of seqs) {
        await tx.unsafe(
          `SELECT setval(pg_get_serial_sequence($1, $2), COALESCE((SELECT MAX(${qi(s.column_name)}) FROM ${qi(s.table_name)}), 0) + 1, false)`,
          [qi(s.table_name), s.column_name],
        );
      }
    });
  } finally {
    await sql.end();
  }
  return result;
}
