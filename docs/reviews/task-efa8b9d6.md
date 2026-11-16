# Independent model-routing review: task-efa8b9d6

Reviewer: `codex@covasant-laptop-wsl2`. Reviewed checkout: `b004dd2`.
Subject: [gh-54](https://github.com/underwright/underwright/issues/54).

## Scope and context

The assigned review names `src/model-routing.ts`, `withModelArgs`, escalation
idempotency/budget bypass, and routing inside both stores' `submitJob`. Those
implementations do not exist in this checkout or its available git history.
The current routing implementation was introduced by `272ae33` (gh-126):
`src/policy.ts`, `src/node-dispatch.ts`, both stores' node job formation,
`src/node-executors.ts`, and `underwright.policy.json`.

The worker MCP denies `get_task(gh-54)` with scope mismatch (403), so the parent
handoff could not be inspected. `search_context` and `submit_job` are not
exposed by this worker endpoint. The public GitHub issue supplied the original
acceptance criteria. Build and test verification therefore runs locally.

## Initial findings

- `matchTaskToNode` does not consult `routing.enabled` before resolving models.
- The checked-in policy defines Claude model names but no Claude model flag;
  the executor only adds a model when both the name and flag are supplied.
- `tierForTask` unconditionally skips path rules, including the checked-in
  heavy-tier rule for core store/schema files.
- A `needs-stronger-model` blocked artifact is only stored and notified; release
  does not persist an escalation tier. The requested escalation implementation
  cannot be approved from the current source.

Verification and final dispositions will be recorded below before completion.
