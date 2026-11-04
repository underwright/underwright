# ADR-0005: Open-core under Apache 2.0; premium = coordination + compliance

Status: accepted · 2026-11-04

## Decision

The control-plane core (registry, claims, DoD, adapters, indexes) is
Apache 2.0. Premium layer: hosted multi-repo control plane, compliance/
audit reporting, fleet analytics. Repo private until announcement.

## Why

- The OSS harness landscape is crowded; open source is table stakes and
  the distribution channel. Competing on a closed core loses to Spec Kit +
  platform-native agents.
- Value scales with agent count — gating coordination/compliance charges
  the buyer (eng leadership), not the individual dev.
- Apache 2.0 maximizes enterprise comfort and ecosystem integrations
  (Omnigent bundles, Spec Kit interop).

## Consequences

- Name/brand matters early — `underwright` org + npm/PyPI names claimed.
- Evidence/traceability format should be positioned as a de-facto standard.
