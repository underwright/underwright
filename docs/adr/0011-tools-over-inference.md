# ADR 0011: Tools over inference — deterministic behavior first, LLM on judgment only

**Status:** Accepted (2026-11-11)

## Context

Underwright orchestrates agents that can invoke LLM reasoning at any step.
The temptation: let the model "figure out" scheduling, routing, quota
failover, unblock decisions, health checks. The cost: every inference is a
paid, non-deterministic, harder-to-test decision — and the failure mode of
LLM-driven bookkeeping is silent wrongness (claims churn, quota loops,
repeated dispatches).

The system's existing patterns already embody this: ADR-0007's watchdog is
"cheap resident loop + LLM on judgment"; the classifier signatures are regex
rules, not model calls; quota failover is env-var seat rotation, not a
reasoned retry.

## Decision

**Do deterministically everything that can be done deterministically.** LLM
invocation is reserved for the cases that genuinely require judgment —
classification the rules can't handle, code/authorship work, design choices,
ambiguous human escalations.

Rules:

- **Rules before models.** If a behavior has a testable contract, it gets a
  code path, not a prompt. Block-unblock classification, dependency filters,
  quota-signature matching, liveness windows — all rules.
- **Judgment is the exception.** Invoke an agent only at the point a rule
  demonstrably can't decide; the LLM answers *the judgment question*, not
  the bookkeeping around it.
- **TDD drives tool quality.** Every deterministic tool ships with tests —
  the unit is small and provable, which is precisely why it's a tool and not
  a model call. A tool that can't be tested isn't a tool; it's latent
  inference and belongs behind a prompt or not at all.
- **Cost and predictability follow.** Deterministic paths are free at the
  margin, reproducible under test, and safe to run in loops. LLM paths are
  metered and bounded.

## Consequences

- Watch/classifier/monitor agents stay rule-driven until they reach a rule
  boundary, then escalate — matching gh#74's block-remover design
  (auto-clear transient, single-letter human escalation, LLM only for
  ambiguous).
- New autonomous behavior should ask first: "can a query/signature/rule
  decide this?" — and only reach for the model when the honest answer is no.
- Test coverage becomes the gate on tools: untested deterministic code is
  treated as unfinished, because the whole point of the tool was that it
  could be proven.
