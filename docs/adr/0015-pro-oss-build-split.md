# ADR-0015: Pro vs OSS build split — separate repo, feature-level gating, declared public surface

Status: accepted · 2026-11-21 · gh-198

## Context

gh-197 (control-plane HA/failover) is Pro-tier scope per
[ADR-0005](0005-open-core-apache.md), but no pro artifact existed to put it
in. [COMMERCIAL.md](../../COMMERCIAL.md) already names a private
`underwright-pro` repository consuming this package as a dependency; the
repo, its build, and the enforceable module boundary did not exist. Three
questions were open: repo shape (separate repo vs monorepo), where the
code-level boundary runs (PgStore already ships in the OSS package), and
how the two artifacts stay in sync.

## Decision

**Repo shape: separate private repo `underwright/underwright-pro`.** It
consumes the published npm package `underwright` (Apache-2.0) as a
dependency and layers pro modules on top. No monorepo. This follows
ADR-0005 ("repo private until announcement") and keeps the licenses,
release cadences, and CI secrets cleanly separated. Revisit only if shared
churn between the repos becomes the dominant cost — measured as pro PRs
that must land OSS-side first exceeding half of pro PRs for two
consecutive months.

**Split granularity: feature-level (license/config gating), not
code-location-level.** `PgStore` (`src/pstore.ts`) stays in the OSS
package. ADR-0002 made Postgres the hosted backend of the OSS `IStore`
port, ADR-0014 makes multi-database portability an OSS goal, and the
whitepaper names the PgStore→Lakebase path as the OSS abstraction's hosted
story. A single store class is not the premium value; extracting it would
break those decisions and self-hosted Postgres users, to gate nothing an
organization actually pays for. The OSS repo contains no license-gating
code at all; gating lives entirely in the pro repo.

**Tier roster.**

- OSS (this repo, Apache-2.0): task registry, claims/leases, DoD engine,
  MCP surface (stdio + HTTP), SQLite store, `PgStore`, code index,
  dashboard, GitHub adapter, nodes/executors, policy/dispatch.
- Pro (`underwright-pro`, private): HA/failover (gh-197), hosted
  multi-repo control plane, org-wide agent coordination, SSO/RBAC,
  managed fleet runners, fleet analytics, compliance/audit reporting.

**Module boundary, enforced in CI.** The OSS package's public surface is
declared in `package.json` `exports`: `.` (server factory + runtime:
`createServer`, `openStore`, `serve`, `serveHttp`), `./istore` (the store
port and its types), `./schema` (shared schema/types). The pro repo may
import only those entrypoints — never deep `underwright/dist/...` paths —
and its CI runs dependency-cruiser with a forbidden rule for any
`underwright` import outside the declared exports. This repo's CI keeps
running dependency-cruiser (layering) and the contract test; the boundary
doc is this ADR plus [COMMERCIAL.md](../../COMMERCIAL.md). If pro work
genuinely needs a new hook, the change lands OSS-side first as a public
export, with an amendment note here — never as a deep-import workaround.

**Build/CI and version skew.** Pro build = `npm ci` on the pinned OSS
package + pro modules (`tsc`). The pro repo pins an exact `underwright`
version and bumps it at least weekly; its CI builds against both the
pinned version and latest OSS release. An OSS breaking change requires a
major version bump and a green pro CI run against it before the OSS
release is published. Pro releases are tagged independently (`vX.Y.Z`);
a pro release never ships against an unpinned OSS version.

## Consequences

- gh-197 unblocks: its implementation target is the pro artifact, and its
  Postgres/HA substrate (PgStore, IStore) is already OSS-public.
- OSS consumers gain a stable, declared API surface (`exports` map);
  deep imports into `dist/` were never supported and are now blocked at
  resolution time.
- Two repos can drift: the weekly pin bump plus the min/max CI matrix is
  the ratchet; the revisit trigger above is the escape hatch.
- Anything that smells like license-gating in this repo should fail review:
  it belongs in `underwright-pro`.
