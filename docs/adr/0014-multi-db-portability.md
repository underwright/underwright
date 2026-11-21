# ADR-0014: Multi-database portability — shared SQL + dialect shims

Status: proposed · 2026-11-21 · gh-200

## Context

ADR-0002 established `IStore` with `SqliteStore` and `PgStore`, each ~90K of
handwritten SQL. gh-200 sets the goal: run on most modern SQL databases —
whatever managed engine a team already operates. Per-backend handwritten
stores cost N×90K; that strategy does not scale past two engines.

## Dialect inventory (PgStore)

Audited `src/pstore.ts`. The divergence surface is small and concentrated —
the store was written mostly portable already: app-side `randomUUID()` keys,
JSON kept in TEXT columns and parsed in JS, `?` placeholders translated by a
shim (`nodeQuery` → `$n`), no advisory locks, no `ILIKE`, no `jsonb` ops.

| Construct | Count | MySQL/MariaDB | SQL Server | pg-wire engines (CRDB/YB/Neon/Aurora/Lakebase) |
|---|---|---|---|---|
| `FOR UPDATE` / `FOR UPDATE SKIP LOCKED` (job lease, dequeue) | 8 | 8.0+ supports `SKIP LOCKED`/`NOWAIT` | `UPDLOCK`/`READPAST` hints, different syntax | CRDB yes; YB partial |
| `RETURNING` | 14 | none (MariaDB 10.5+ only); re-select needed | `OUTPUT INSERTED.*` | yes |
| `ON CONFLICT … DO UPDATE/NOTHING` | 7 | `ON DUPLICATE KEY UPDATE` / `INSERT IGNORE` | `MERGE` | yes (YB restrictions) |
| `::` casts (`::int`, `::timestamptz`, `::interval`, `::text`) | 11 | `CAST(x AS t)` | `CAST`/`CONVERT` | yes |
| Interval math (`now() - interval '6 hours'`, `make_interval`) | ~6 | `DATE_SUB/NOW() - INTERVAL n MINUTE` | `DATEADD` | yes |
| DDL types (`TIMESTAMPTZ DEFAULT now()`, `BOOLEAN`) | schema | `DATETIME/CURRENT_TIMESTAMP`, `TINYINT(1)` | `DATETIME2`, `BIT` | yes |
| Boolean literals in predicates (`read=false`) | few | `=0` | `=0` | yes |

## Decision

**Shared statement layer + dialect shims.** Introduce a `Dialect` interface
covering exactly the divergence points above — `lockRows()`, `upsert()`,
`insertReturning()`, `cast()`, `interval()`, `boolLit()`, `ddl()` — and keep
one authored statement set. `PgStore` becomes `SqlStore` driven by the
Postgres dialect; each new engine is a dialect module + thin driver adapter,
not a 90K port.

Rejected:

- *Query builder (Kysely/Drizzle)*: rewrites all ~180K of both stores; the
  semantic gap (lease claims, SKIP LOCKED queues, re-own semantics) still
  lands per-engine anyway; payoff doesn't clear the rewrite cost.
- *More handwritten stores*: the exact N×90K failure the issue calls out.

## Backend tiers

- **Tier 1** — verify pg-wire engines through the existing `postgres` driver:
  CockroachDB or YugabyteDB runs the gh-83 contract suite green in the gh-28
  CI matrix. That makes "Postgres-compatible" a real claim.
- **Tier 2** — MySQL/MariaDB: first non-pg-wire dialect; exercises every shim
  (upsert, RETURNING-free paths, FOR UPDATE SKIP LOCKED, boolean literals).
- **Tier 3** — SQL Server and others by demand (`MERGE`, `OUTPUT`, `TOP`/`OFFSET FETCH`).

"Supported" = the gh-83 contract suite green in CI for that engine, per gh-200.

## Consequences

- The dialect seam must be cut before backend #3 lands, or it rots into
  copy-paste. `Dialect` interface + extraction is the first PR.
- Both existing backends keep working unchanged; `SqliteStore` stays the OSS
  default (gh-198 boundary).
- Driver adapters stay thin: `postgres` (pg-wire), `mysql2`, `mssql` —
  connection + `?`-placeholder conventions already in place.
- Contract suite coverage is the release gate for every engine claim; the CI
  matrix (gh-28) gains one job per tier-1 engine.
