# ADR-0013: Interface-first integrations — an adapter at every external seam

Status: proposed · 2026-11-21

## Context

Three integration surfaces converged on the same shape in one day of design
discussion, which is the sign that a pattern wants to be a rule:

- **Store** — `IStore` already exists (ADR-0002): `SqliteStore` + `PgStore`
  behind `openStore(DATABASE_URL)`, conformance suite pending (gh-83),
  multi-engine portability under gh-200.
- **Tracker** — issue write-back and Azure DevOps support (gh-203) need the
  same seam: an `ITracker` interface with GitHub as the reference impl.
- **Harness backends** — `ug` (Unity Gateway) joins `omnigent` as a second
  `backend` flavor for the same harnesses (gh-202), and `genie` joins the
  harness registry as another executable+args entry.

The 2026-11-21 outage supplied the counter-example: the places where a
concrete choice was baked in — the control-plane URL inside node
credentials, GitHub-specific write-back end to end — are exactly where a
dead host or a second provider causes pain. Interfaces are not premature
abstraction here; they are how the system stays portable between the OSS
and Pro topologies.

## Decision

**Any integration with an external system — or any subsystem that could
plausibly gain a second implementation — is introduced behind an interface,
with the seam named and a reference implementation.** This is the default,
not a per-case judgment call.

Rules of the pattern:

1. **The contract speaks domain terms, not vendor terms.** `IStore` speaks
   tasks/claims/evidence, not SQL; `ITracker` speaks issues/transitions,
   not the GitHub API. Vendor concepts never leak past the adapter.
2. **Supported means contract-tested.** One contract suite runs against
   every implementation (the gh-83 pattern for stores, the same for
   trackers). Per-impl skips are allowed only where a feature is genuinely
   backend-specific, and each is documented.
3. **Design for two.** The second implementation is what validates the
   seam. An interface with one impl forever is suspect — either widen the
   contract or collapse it.
4. **Selection is configuration, not call-site logic.** `openStore()` on
   `DATABASE_URL` is the precedent: callers hold the interface, config
   picks the impl.
5. **Thin seam.** The interface surface is as small as honesty allows
   (ADR-0012's thin-coupling rule for omnigent is the same instinct):
   what crosses the boundary is the minimum the coordination logic needs.
6. **No speculative abstraction.** The trigger is "external system
   boundary" or "a plausible second implementation under the product
   roadmap" — not "might be nice someday." Single-purpose internal helpers
   stay concrete.

## Consequences

- New backends/adapters = one implementation + a contract-suite run. No
  refactoring call sites.
- Cost: behavior is written and maintained per implementation; parity is
  enforced by the suite rather than by optimism.
- Existing seams under this rule: store (done — ADR-0002), tracker
  (gh-203), harness backends (registry exists in node-executors config;
  formalize `backend` flavors), store-engine portability (gh-200).
- Candidate future seams the rule now covers by default: credential/secret
  providers, notification channels, deployment targets.

## References

- ADR-0002 — pluggable store (the precedent this generalizes)
- ADR-0012 — thin coupling across a deployment boundary (same instinct)
- gh-83 — IStore contract suite · gh-200 — multi-database store support
- gh-203 — tracker abstraction + issue write-back · gh-202 — genie/ug harness paths
