# Database support matrix

Underwright's control-plane state lives behind `IStore` (`src/istore.ts`).
`openStore()` picks the backend: `DATABASE_URL` set → `PgStore` (pg-wire,
`postgres` driver), otherwise `SqliteStore` (`UNDERWRIGHT_DB`, the OSS default).
The portability strategy, shared SQL plus dialect shims, is recorded in
[ADR-0014](adr/0014-multi-db-portability.md). Tracking issue: gh-200.

## What "supported" means

An engine is **supported** only if the gh-83 contract suite passes against it
in CI (the gh-28 matrix). Anything less is listed below as *implemented*,
*expected* or *planned*. These are not support claims.

| Status | Meaning |
|---|---|
| **supported** | Contract suite green in CI for this engine |
| **implemented** | Backend exists and passes `test/store.test.ts` when pointed at it locally; not yet in the CI matrix |
| **expected** | Should run through an existing backend (pg-wire), but has not been verified |
| **planned** | Needs a new dialect module behind the ADR-0014 seam |
| **by demand** | No work scheduled |

## Matrix

| Engine | Tier | Backend | Status | Tracking | Known divergences |
|---|---|---|---|---|---|
| SQLite (better-sqlite3) | OSS default | `SqliteStore` | **supported**: `npm test` and `npm run test:contract` in CI | — | Single-writer and single-host, so it can't provide control-plane failover (gh-197) |
| PostgreSQL 14+ (community) | 1 (reference) | `PgStore` | **implemented**: `DATABASE_URL=… npm test` runs the `pg backend` suite; not yet a CI job | gh-28 | Reference dialect: all ADR-0014 constructs are native |
| Databricks Lakebase | 1 | `PgStore` | **expected** | gh-76 | Managed PG; auth and token-refresh handling are in the driver path, not the SQL |
| Neon / RDS / Aurora PostgreSQL | 1 | `PgStore` | **expected** | gh-207 | Treated as community PG; pooler (PgBouncer transaction mode) may break session-scoped settings |
| CockroachDB | 1 (proving case) | `PgStore` | **expected**, unverified | gh-207 | `FOR UPDATE SKIP LOCKED` supported (v23.1+); `::interval` and `make_interval` coverage differs; serializable-only isolation means retries on contention (40001); `ON CONFLICT` OK |
| YugabyteDB (YSQL) | 1 | `PgStore` | **expected**, unverified | gh-207 | `SKIP LOCKED` support partial and version-dependent; some `ON CONFLICT` restrictions; DDL in transactions limited |
| MySQL 8.0+ / MariaDB 10.6+ | 2 | dialect on ADR-0014 seam | **planned** | gh-206 → gh-208 | No `RETURNING` (MariaDB 10.5+ has it for `INSERT`/`DELETE` only); `ON DUPLICATE KEY UPDATE` / `INSERT IGNORE` instead of `ON CONFLICT`; `CAST()` instead of `::`; `NOW() - INTERVAL n MINUTE`; `TINYINT(1)` booleans; `DATETIME` instead of `TIMESTAMPTZ` |
| SQL Server | 3 | dialect | **by demand** | — | `OUTPUT INSERTED.*` instead of `RETURNING`; `MERGE` upserts; `UPDLOCK, READPAST` hints instead of `SKIP LOCKED`; `TOP` / `OFFSET FETCH`; `BIT`, `DATETIME2` |

## PgStore dialect surface

Counted in `src/pstore.ts`. Each row is a seam in the ADR-0014 `Dialect` interface:

| Construct | Occurrences | Dialect hook |
|---|---|---|
| `RETURNING` | 14 | `insertReturning()` |
| `ON CONFLICT … DO UPDATE/NOTHING` | 7 | `upsert()` |
| `FOR UPDATE` (lease/dequeue paths; 3 with `SKIP LOCKED`) | 5 | `lockRows()` |
| `::` casts (`::int` ×8, `::timestamptz` ×3, `::interval`, `::text`) | 13 | `cast()` / `interval()` |
| `TIMESTAMPTZ DEFAULT now()`, `BOOLEAN` DDL | schema | `ddl()` |
| Boolean literals in predicates | few | `boolLit()` |

Already portable: app-side `randomUUID()` keys, JSON stored as TEXT and parsed
in JS, `?` placeholders translated by the driver shim, no advisory locks, no
`jsonb` operators, no `ILIKE`.

## Running the store tests against another engine

```sh
DATABASE_URL=postgres://user:pass@host:5432/db npm test -- test/store.test.ts
```

Before you change an engine's status in this table, add it to the gh-28 CI
matrix and get `npm run test:contract` green against it.
