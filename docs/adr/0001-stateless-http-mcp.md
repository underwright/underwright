# ADR-0001: Stateless MCP over HTTP for shared control plane

Status: accepted · 2026-11-04

## Decision

`serve --http` uses stateless Streamable HTTP: a fresh transport+McpServer
per request. No session state; all shared state lives in the store.

## Why

- Agents on any machine/harness connect with just a URL + bearer token.
- Stateful sessions create ownership questions across crashes/restarts and
  complicate load-balancing to multiple server processes later.
- The store is the shared brain; transport stays dumb.

## Consequences

- No server-push notifications; job completion is polled via `job_status`
  (acceptable — agents check between other work; A2A callbacks later).
- Each request pays Store-open cost; SQLite makes this trivial, Postgres
  pool caps at 5.
