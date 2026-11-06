# Engineering standards — what "world class" means here, and how it's enforced

Principle: **every standard is a mechanism, not a document.** Each item below
lists (a) the standard, (b) how the control plane encodes it, (c) how this repo
applies it. Enforcement is progressive: `observe → warn → block`.

## 1. Clean architecture

- **Standard**: dependency direction inward (domain ← application ← adapters);
  no layer skipping; module boundaries explicit; decisions recorded as ADRs.
- **Control plane**: `ownership` on tasks already declares file/symbol scopes —
  extend it to *forbidden* paths ("this task may not touch src/db/"). Architecture
  decisions are `post_artifact(kind:"design")` — required before tasks of
  type `architecture` complete. Machine check: dependency-cruiser/archunit-style
  rules run as a `report_evidence(kind:"ci_check")` step.
- **This repo**: add `dependency-cruiser` config — `cli.js → server.ts → store.ts → schema.ts`,
  `github.ts` is an adapter (may not be imported by `store.ts`).

## 2. TDD

- **Standard**: failing test observed before implementation; minimal code to
  green; refactor on green; no test-file edits during GREEN phase.
- **Control plane**: task field `tdd: true` → `report_evidence` must include a
  `test_run` with `exit_code != 0` timestamped *before* the passing one
  (the store already records timestamps — the gate is cheap to verify).
  Optional hard mode: phase-locked file writes (tdd-enforcer pattern) via a
  git pre-commit / watcher hook.
- **This repo**: vitest; all new Store methods get a failing test first.
  Evidence: red run + green run attached to the task.

## 3. Unit testing & coverage

- **Standard**: unit tests for domain logic; coverage floor on changed code
  (diff coverage ≥80%), not global vanity percentages; mutation testing on
  the policy/store core.
- **Control plane**: `report_evidence(kind:"coverage", output:"<pct-or-vitest-output>")`
  parses into structured lines/statements/branches/functions; DoD policy
  `min_coverage` sets numeric floors per task type (number = lines, or an
  object of per-metric thresholds).
- **This repo**: `npm run test:coverage` on PR uploads the `coverage` artifact;
  `npm run report:coverage` posts it to the task linked by `uw:<task-id>` in the
  PR body or the branch name. Stryker later for `store.ts`.

## 4. Integration & contract tests

- **Standard**: adapters tested against contracts; MCP tool surface tested
  end-to-end (initialize → tools/call); DB migrations tested.
- **Control plane**: `kind:"contract_test"` evidence; the tool surface is
  itself contract-testable via the HTTP endpoint.
- **This repo**: a script that boots `serve --http` on a scratch port and
  runs the full tool matrix — already proven manually, formalize it.

## 5. Automated CI

- **Standard**: every PR runs build + lint + typecheck + tests; required
  checks gate merge; no merge-to-main without green.
- **Control plane**: git adapter maps check-runs → `ci_check` evidence; PR
  task can't complete while required checks are red.
- **This repo**: `.github/workflows/ci.yml` (npm ci, build, test); branch
  protection: require checks on main.

## 6. Post-deploy validation

- **Standard**: deploy ≠ done. Smoke tests and synthetic checks after every
  deploy; rollback criteria defined in advance; canary where feasible.
- **Control plane**: `kind:"deploy"` + `kind:"smoke_test"` evidence kinds;
  DoD for `deploy` task type requires both, ordered after the deploy event.
  `complete_task` already enforces ordering via timestamps.
- **This repo**: for the HTTP server — `/health` + a smoke script that calls
  `board` after restart. Same pattern scales to real deploys.

## 7. Independent review

- **Standard**: reviewer ≠ author. For agent work, the reviewing agent must
  not share the worker's context (information barrier) — self-grading is
  proven to degrade quality.
- **Control plane**: schema: `evidence.agent_id` must differ from
  `claims.agent_id` for `kind:"review"` — enforce in `complete_task` when
  DoD requires review.
- **This repo**: PRs reviewed by a different harness than the author where
  possible; human sign-off on what matters.

## 8. Security

- **Standard**: secrets never in repo/logs; dependency scanning; least-privilege
  tool grants; SAST on PRs.
- **Control plane**: `kind:"security_scan"` evidence; pre-commit hook blocks
  writes containing secret patterns; JIT credential brokering is a roadmap item.
- **This repo**: `npm audit` in CI; Dependabot on; gh secret scanning
  (free on public repos) enabled.

## 9. Definition of Done — the keystone

- **Standard**: "done" is declared per task type, checked mechanically.
- **Control plane**: `underwright.policy.json` per workspace:
  ```json
  {
    "dod": {
      "feature":     { "evidence": ["test_run", "coverage", "review"], "tdd": true },
      "bug":         { "evidence": ["test_run", "review"], "tdd": true },
      "deploy":      { "evidence": ["deploy", "smoke_test"] },
      "architecture":{ "artifacts": ["design"], "evidence": ["review"] },
      "docs":        { "evidence": ["review"] }
    },
    "enforcement": "warn"
  }
  ```
  `complete_task` evaluates the task-type ruleset. This is the single most
  important feature to build next — it turns every other standard on.
- **This repo**: ship the policy file; start at `warn`, ratchet to `block`
  once agents adapt.

## 10. Evidence & traceability (already the spine)

- Every task links spec → ACs → evidence → PR → audit events. Extend the
  evidence enum: `contract_test`, `security_scan`, `smoke_test`, `coverage`,
  `mutation`. The pack is the audit artifact.

## 11. Agent-specific additions

- **Trajectory evals**: spot-check how agents reached results (tool selection,
  dedupe rate, evidence quality) — the audit log already captures it.
- **Drift guards**: periodic `search_context` pre-flight compliance check —
  did the agent consult the helper index? Track reuse-vs-duplicate as a metric.
- **Cost**: job-queue stats give inference-vs-wait ratio for free.
