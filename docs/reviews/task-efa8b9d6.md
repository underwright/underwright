# Independent model-routing review: task-efa8b9d6

**Disposition: request changes.** Four reproducible functional gaps remain.
Reviewer: `codex@covasant-laptop-wsl2`. Reviewed runtime checkout: `b004dd2`.
Subject: [gh-54](https://github.com/underwright/underwright/issues/54).
Follow-up implementation work: [issue 152](https://github.com/underwright/underwright/issues/152).
This branch delivers the review and diagnostics; it does not change runtime behavior.

## Findings

### P2: Honor the model-routing disable switch

Location: `src/node-dispatch.ts:144-150`.

`getModelRouting` preserves `enabled: false`, but `matchTaskToNode` always
calls `tierForTask` and `modelForHarness`. Keeping the configured model table
while disabling routing still ships `haiku` and `--model` to a capable Claude
node. An operator cannot turn off model overrides using the advertised switch.
Gate model resolution/emission on `routing.enabled` and cover disabled routing
through dispatch integration tests.

### P2: Supply the Claude model flag in the checked-in policy

Location: `underwright.policy.json:248-251`; consumer: `src/node-executors.ts:157`.

The policy maps a small Claude task to Haiku but defines flags only for Grok
and Cursor. Dispatch emits `model: "haiku"` with no `model_flag`; the executor
constructs model arguments only when both fields exist. Claude therefore runs
its locally configured/default model while dispatch records Haiku. This breaks
the intended cheap-model routing and makes model telemetry misleading. Add the
supported Claude flag and an integration test using the checked-in policy.
Codex has the same flag omission and should be audited in that change.

### P2: Evaluate the advertised core-file heavy-tier rule

Location: `src/policy.ts:511-516`.

Every rule with `paths` is unconditionally skipped, and dispatch does not pass
ownership paths to the resolver. The checked-in heavy rule for `src/store.ts`,
`src/pstore.ts`, and `src/schema.ts` can never match. A feature estimated S
with one AC still resolves light even when its supplied path is `src/store.ts`.
This violates gh-54's repo-area criterion and the documented core-store
routing promise. Carry ownership paths into resolution and evaluate the rule,
or replace the advertised policy with an equivalent supported signal.

### P2: Persist escalation state before redispatching a blocked task

Locations: `src/store.ts:1059-1062`, `src/pstore.ts:989-992`; release paths:
`src/store.ts:992-1003`, `src/pstore.ts:925-937`.

A `needs-stronger-model` blocked artifact only records an event and notifies
watchers. Releasing the task reopens it without changing a routing tier;
node dispatch uses only type, estimate, AC count, and review kind. The SQLite
probe posts that marker and releases a small task: it remains open and resolves
light on its next routing evaluation. Both stores lack the promised escalation
state, so no stronger-tier retry, escalation idempotency, budget bypass, or
heavy-tier human fallback can be approved. Implement a persisted, bounded,
idempotent escalation consumed by both dispatch paths.

## Scope and positive checks

The assigned review names `src/model-routing.ts`, `withModelArgs`, escalation
idempotency/budget bypass, and routing inside both stores' `submitJob`. Those
implementations do not exist in this checkout or its available git history.
The current routing implementation was introduced by `272ae33` (gh-126):
`src/policy.ts`, `src/node-dispatch.ts`, both stores' node job formation,
`src/node-executors.ts`, and `underwright.policy.json`.

The worker MCP denies `get_task(gh-54)` with scope mismatch (403), so the parent
handoff could not be inspected. `search_context` and `submit_job` are not
exposed by this worker endpoint. The public GitHub issue supplied the original
acceptance criteria. Verification ran locally. Issue 152 needs normal webhook
or administrator sync; running the local CLI sync would create a separate
board database, and this worker cannot sync the shared board.

Current matching correctly uses first-match precedence for architecture,
design review, large estimates, and AC counts, with standard as the default.
Harnesses without an applicable model entry retain their model defaults.
Older daemons without `launch-model-flag` do not receive unsupported payload
keys. Both stores delegate current node routing to the same matching helper.
Legacy `submitJob` persists the agent spec unchanged in both stores; it has no
model-routing hook. The diagnostic script verifies that behavior in SQLite;
PostgreSQL was inspected statically, without a live PostgreSQL instance.

The current executor inserts model flags before configured arguments, preserving
adjacent argument/value pairs such as Grok's `--single <prompt>`; the dedicated
executor regression test covers this. Original `withModelArgs` cannot be
reviewed because it is absent. Model-tier token economics were not validated;
the assigned review focuses on routing/execution/escalation.

## Reproduction

After `npm ci` and `npm run build`, run:

```sh
node docs/reviews/task-efa8b9d6-probes.mjs
```

The diagnostic assertions confirm observed defects, not desired behavior.
It creates and removes its own temporary SQLite database and launches no agents.
Output (exit 0):

```text
CONFIRMED disabled routing still emits model: {"tier":"light","model":"haiku","model_flag":"--model"}
CONFIRMED live Claude selection lacks required executor flag: {"tier":"light","model":"haiku","model_flag":null}
CONFIRMED core-store path rule ignored: light
CONFIRMED escalation marker plus release leaves next routing tier unchanged: {"status":"open","tier":"light","artifacts":1}
CONFIRMED legacy submitJob stores unmodified agent spec: {"executable":"claude","args":["-p"],"prompt":"task"}
```

## Validation

- `npm ci`: exit 0; 222 packages installed, native SQLite compiled locally.
- `npm run build`: exit 0 (`tsc`).
- `node docs/reviews/task-efa8b9d6-probes.mjs`: exit 0, all five diagnostic
  assertions confirmed the behavior printed above.
- `npm test -- test/node-dispatch.test.ts test/node-executors.test.ts test/runner.test.ts test/dispatcher.test.ts`:
  exit 0; 4 files passed, 68 tests passed, 14 skipped.
- `npm test`: exit 1; 29 files passed, 2 failed, 1 skipped; 286 tests passed,
  3 failed, 33 skipped. The three failures are outside the review files:
  `test/escalation.test.ts` expects the current launch prompt verbatim in
  README/docs (and older recovery wording in the prompt), and two
  `test/packaging.test.ts` cases assume `npm pack --json` returns an array.
  With npm 12.0.2 it returns an object keyed by `underwright`, confirmed by a
  direct dry-run. No production source changed on this review branch.

The first full run preceded local dependency installation and additionally
failed two architecture tests because they require worktree-local
`node_modules/dependency-cruiser`. Those passed after `npm ci`.
The 33 skipped tests and absence of a PostgreSQL service limit runtime coverage;
this review does not claim all tests pass.

The pre-existing worker configuration changes (`.mcp.json`, `.claude/`, and
`.cursor/`) were excluded from commits; they contain task-scoped access config.
