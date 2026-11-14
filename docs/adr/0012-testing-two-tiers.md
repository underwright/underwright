# ADR 0012: Two-tier testing — unit tests + deployed-environment validation (UAT)

**Status:** Accepted (2026-11-11)

## Context

ADR-0011 makes deterministic tools the backbone. But "it compiles and unit
tests pass" has repeatedly proven insufficient here: the omni runner's
alembic version-skew crash, dispatch churn that only surfaced under live
claim load, `spec.cwd` that worked in tests but failed under real `omni run`
— each passed CI-shaped checks and broke in the real environment.

A system that orchestrates agents, daemons, nodes, and systemd units has
failure modes that only exist at deployment time — service restarts, lock
contention under real event load, quota exhaustion, tailnet routing, cross-
process transactions. Unit tests can't see them.

## Decision

Every capability ships with **two tiers**:

1. **Unit/integration tests** — `vitest` (and `pytest` for omnigent),
   per-tool contracts, CI-runnable, hermetic. Proves the logic.
2. **Validation tests (UAT)** — scripted exercises run against the *real
   deployed system*: the actual `underwright.service`, real node enrollment,
   real `omni run`, real jobs queueing and completing on real boards, real
   tailnet paths. Proves the wiring.

Rules:

- A feature isn't "done" on unit tests alone — evidence for `complete_task`
  should include a deployed-path check when the change touches services,
  dispatch, nodes, or agents.
- Validation scripts live under `scripts/` (e.g. `scripts/validate-*.mjs`)
  — cheap, repeatable, run against the live control plane or a known
  tailnet node, and named for the user-visible behavior they prove.
- UAT answers "does it work for a user," not "does the function work":
  enroll a node, submit a job, watch it complete; launch an omni agent and
  see the session marker land.
- UAT failures are first-class bugs — "unit tests pass" never excuses a
  broken deployed path.

## Consequences

- Release/deploy confidence comes from the second tier, not the first.
- Dogfooding IS the UAT substrate: minipc+desktop+laptop fleet, multiple
  boards, real quota limits — the system tests itself the way users hit it.
- Evidence requirements (`report_evidence`) can cite validation output as
  the acceptance signal for service-level changes.
