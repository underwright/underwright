# Go-to-market: open-core packaging

Status: draft · 2026-11-09 · tracks [#27](https://github.com/underwright/underwright/issues/27)

This document records the open-core split. The decision itself is
[ADR-0005](adr/0005-open-core-apache.md), and [COMMERCIAL.md](../COMMERCIAL.md)
gives the repo-level rule. This doc covers what ships where, the packaging
tiers, and the order we bring them to market.

## Principle

What a single agent or a small team needs to **adopt and trust** the system is
free. What an organization needs to **run it at scale or prove governance** is
paid. The value of coordination grows with the number of agents, so the paid
tier charges the buyer (engineering leadership), not the individual developer.

Rule for contributors: a feature that one workspace needs to work correctly
goes in the OSS core. Do not cripple the core to create upsell pressure.

## Feature matrix

| Capability | OSS core (free) | Paid |
|---|:-:|:-:|
| Task registry, ownership globs, templates, DoR/DoD | ✅ | ✅ |
| Claim/lease semantics, resource locks | ✅ | ✅ |
| Evidence-gated completion, review tasks | ✅ | ✅ |
| Artifacts, mailbox, helper index, `search_context` | ✅ | ✅ |
| Code index (symbols, references, blast radius) | ✅ | ✅ |
| Job queue, remote fleet runner, node daemon (self-managed) | ✅ | ✅ |
| Dispatcher, sweeper, digest, webhook notifications | ✅ | ✅ |
| GitHub issue sync and commit status | ✅ | ✅ |
| Audit log (per workspace) | ✅ | ✅ |
| Basic dashboard (single-workspace board, task detail, inbox) | ✅ | ✅ |
| Self-hosted, single workspace (stdio or stateless HTTP, SQLite) | ✅ | ✅ |
| **Hosted control plane**, multi-repo / multi-workspace | — | ✅ |
| **Org dashboard and analytics** (cross-repo throughput, agent/harness efficiency, evidence coverage trends) | — | ✅ |
| **Compliance and audit reporting** (exportable evidence packs, retention, traceability reports) | — | ✅ |
| **SSO / RBAC** (SAML/OIDC, org roles, per-workspace permissions) | — | ✅ |
| **Fleet management** (managed runners, central node policy, capacity, cost controls) | — | ✅ |
| **Support** (SLA, onboarding, private channel) | Community | ✅ |

## Packaging tiers

| Tier | Who it's for | What's included | Delivery |
|---|---|---|---|
| **Community** (free, Apache-2.0) | Individual developers, small teams, evaluators | Everything in the OSS column: one workspace, self-hosted, basic dashboard | `npm i -g underwright`, Docker image |
| **Team** (hosted, per-seat or per-active-agent) | Teams running several agents across a few repos | Hosted control plane, multi-repo, org dashboard and analytics, managed runners, email support | SaaS |
| **Enterprise** (annual contract) | Orgs with governance, security, or scale needs | Team plus SSO/RBAC, compliance reporting, audit retention, fleet policy, self-hosted or VPC option, SLA support | SaaS, VPC, or on-prem |

Pricing is not set yet. Leading candidate: a usage metric that tracks value,
either active agents or claimed tasks per month, rather than human seats.

## Sequencing

1. **OSS traction** (now). Public launch of the Apache-2.0 core. Success
   signals: installs, active workspaces, external contributors, harness
   integrations (Claude Code, Codex, Copilot, Spec Kit/Omnigent interop).
   Position the evidence/traceability format as a de-facto standard.
2. **Hosted beta.** Invite-only Team tier for design partners pulled from
   active OSS users running multiple repos or agents. Validate the pricing
   metric and the org dashboard. Exit criterion: paying design partners.
3. **Enterprise.** Add SSO/RBAC, compliance reporting, fleet management, and
   contracted support. Driven by design-partner demand and security reviews.

Do not build paid components before the step that needs them.

## Licensing

- The OSS core in this repository is **Apache-2.0** (see [LICENSE](../LICENSE),
  `package.json` `license`). This is confirmed and unchanged.
- **Premium components go in a separate private repository**
  (`underwright-pro`) once they are built. They consume this package as a
  dependency. No proprietary code or license-gated feature flags go in
  this repo.
- Contributions to this repo are Apache-2.0 (see [CONTRIBUTING.md](../CONTRIBUTING.md)).
