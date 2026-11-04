# ADR-0002: Pluggable store via IStore; SQLite default, Postgres hosted

Status: accepted · 2026-11-04

## Decision

All persistence goes through `IStore` (awaitable signatures). `openStore()`
picks the backend by config only: `DATABASE_URL` → `PgStore`, else
`SqliteStore`. Databricks Lakebase (managed Postgres) works unchanged.

## Why

- SQLite keeps OSS adoption zero-dependency.
- Postgres is required for multi-server/HA and SaaS; needed before it's urgent.
- Awaitable signatures let sync (SQLite) and async (pg) impls share call sites.

## Consequences

- Behavior must be implemented twice; contract tests (env-gated on
  DATABASE_URL) keep parity verifiable.
- New backends (e.g. hosted multi-tenant) = one more class, no refactor.
