# ADR-0003: Evidence-gated completion + per-type Definition of Done

Status: accepted · 2026-11-04

## Decision

`complete_task` refuses unless (a) every declared `ac_id` has cited evidence
and (b) the task-type DoD ruleset passes: required evidence kinds, required
artifact kinds, TDD ordering (a failing `test_run` before the green), and
reviewer independence (reviewer ≠ claim holder). Enforcement ratchets
observe → warn → block via `underwright.policy.json`.

## Why

- Self-grading is measurably unreliable for agents; verification must be
  independent and deterministic.
- Per-type DoD encodes "world class" as mechanism, not documentation.
- Progressive enforcement avoids gate fatigue during adoption.

## Consequences

- Agents must instrument their own work honestly — mitigated by the audit
  log (evidence claims are attributable) and CI-reported evidence later.
- Task creators must declare ac_ids or the task can't be done.
