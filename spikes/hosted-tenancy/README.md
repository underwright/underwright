# Spike: hosted tenancy (gh-30)

This is throwaway reference code for [ADR-0010](../../docs/adr/0010-hosted-control-plane.md).
It is **not** part of the product:

- It is not compiled (`tsconfig.json` includes only `src/`) and not
  published (`package.json` `files` is `dist/`).
- Nothing in `src/` may import it.
- It is deleted once `underwright-pro` exists. The production version of
  everything here is paid-tier code and lives in that private repo (see
  [gtm.md](../../docs/gtm.md) and [COMMERCIAL.md](../../COMMERCIAL.md)).

What it proves:

- `tenancy.ts` contains the control DB schema (tenants, workspaces,
  workspace_tokens). It issues, verifies, and revokes `uwws_` tokens, keeps
  a bounded pool of unmodified `SqliteStore` instances (one per workspace),
  and has a router that runs each call as the token principal. It also
  derives usage metering from each workspace's `claimed` audit events.
- `tenancy.spike.test.ts` checks isolation, token rejection paths, read and
  agent scopes, metering, and adopting a self-hosted DB unchanged. `npm test`
  runs it through vitest's default include.
