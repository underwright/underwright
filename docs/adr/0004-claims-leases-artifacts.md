# ADR-0004: Coordination via claims, leases, and artifacts — not chat

Status: accepted · 2026-11-04

## Decision

- Tasks claimed atomically with an expiring lease; stale claims reclaimable.
- File/symbol ownership scopes attach to tasks and claims.
- Inter-agent communication only via `post_artifact` on tasks.
- `search_context` + `register_helper` is the mandatory pre-flight before
  writing shared code.

## Why

- Chat-based coordination degrades past ~3 agents; artifacts scale.
- Claim/lease gives exclusive work without a central scheduler.
- The helper index kills the "three agents write three loggers" failure.

## Consequences

- Lease sweeper still needed (seeded) for dead-agent reclaim.
- Ownership is advisory today; enforcement via write-gates is roadmap.
