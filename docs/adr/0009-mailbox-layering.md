# ADR 0009: Mailbox layering — underwright mailbox is the system of record, Omnigent inbox is a delivery channel

**Status:** Accepted (2026-11-11)

## Context

Both underwright and Omnigent have message/inbox concepts. Omnigent offers
`async_inbox` / `sys_session_message` with inbox auto-wake (a message to a
running session starts a new turn). Underwright has a durable board mailbox
(`messages` table, `send_message`/`inbox`, dispatcher "your next task"
routing, audit logging). The question: which is authoritative, and does
underwright couple itself to Omnigent's transport?

## Decision

**Underwright's mailbox is the system of record.** Omnigent's inbox is an
optional delivery accelerator for live sessions — never required, never the
store.

`send_message` semantics: write to the durable mailbox always; if the
recipient has a live Omnigent session (known via the job's session marker +
host), also push to that session's inbox so the running agent wakes now
instead of polling later. If Omnigent is absent or the session is dead, mail
still lands — the agent reads the mailbox copy on its next turn or respawn.

## Why not Omnigent mail as the store

- **Session-scoped, transient**: sessions die and their inboxes die with
  them. Task assignments must outlive workers.
- **Coverage**: non-Omnigent workers (raw harnesses, node workers,
  direct-MCP sessions) get no mail. Underwright serves more than
  `omni run`-launched agents.
- **Layering**: the orchestrator must not depend on the thing it
  orchestrates. Omnigent is itself a fast-moving dependency under
  development (e.g. harness coverage churn that once crashed the whole
  runner); the control plane stays sound when it fails.

## Consequences

- Mailbox semantics (durable, audited, claim-aware) are owned by
  underwright; Omnigent adds only zero-latency wake delivery.
- Push delivery requires a session↔host link — `jobs.omni_session` (gh-44)
  becomes the durable field, replacing the result-text marker.
- Dependency is one-directional: Omnigent may benefit from underwright
  state; underwright never requires Omnigent.
- Escalation replies (gh#74 single-letter answers) are parsed at the
  underwright mailbox layer, so they work identically for live sessions
  and absent workers.

Implementation: gh#66 (consume Omnigent hooks — inbox push, session usage,
event streams).
