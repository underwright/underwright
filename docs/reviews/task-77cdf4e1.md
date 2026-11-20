# Independent code review: task-77cdf4e1 (gh-70)

**Disposition: Blocked — subject work is not delivered; do not approve.**
Reviewer: `opencode@alandesktop` (not the implementer, `claude@alandesktop`).
Reviewed checkout: `32f66105394d4549cbc0218b7ca795bfc9fc5ef1` (`uw/task-77cdf4e1`).
Subject: [gh-70](https://github.com/underwright/underwright/issues/70) —
"Dashboard: pending node enrollments with approve/reject UI".
Rubric: `docs/review-rubric.md` from `origin/feat/review-rubrics` @ `0855d4a`.
The rubric file named by the task is not on `main`; this is the repo's PR review
rubric commit (`rubrics: PR review rubric for underwright + kraftina wiring`).
This branch delivers the review only — no runtime code was changed.

## Method and scope

- Read the subject issue (#70) and its acceptance criteria via `gh issue view 70`.
  The issue is **OPEN** and declares all three AC boxes unchecked:
  dashboard lists pending enrollments with expiry countdown; approve + reject
  form actions under admin-scope auth; compare-code input surfaced for pasting.
- Searched for delivered work: `gh pr list`/`gh api pulls` found no PR referencing
  `#70` (open or closed); issue #70's timeline has no cross-reference to a PR
  (only issue #170, "Board UI: tabbed ops console", which is an issue, not a PR).
  `git branch -a` (189 branches) has no `gh-70`/`70`/`enroll` branch, and
  `git log --all -S 'enrollments/:id/approve' -S 'pendingEnrollments'` finds none.
- Inspected the shipped dashboard (`src/dashboard.ts`, 609 lines): its only
  routes are `/`, `/board`, `/tasks`, `/task/:id/*`, `/messages`, `/inbox/*`,
  `/chat*`. There is no `/nodes` page, no enrollment listing, no
  `POST /nodes/enrollments/:id/approve` / `:id/reject` form action, no compare-code
  field and no expiry countdown. `grep -i 'enroll\|approve\|reject\|compare'`
  against that file returns nothing.
- Confirmed what *does* exist on `main`: the enrollment **backend** from `8beeb3d`
  (`feat(node): add enrollment and scoped node credentials`) — MCP admin tools
  `list_node_enrollments`, `approve_node_enrollment`, `reject_node_enrollment`
  in `src/server.ts:47-53`, `Store` methods in `src/store.ts:216-280` and
  `src/pstore.ts:163-227`, the `node_enrollments` table in `src/schema.ts:275`,
  and the `underwright node approve` CLI. That is the "related" work the issue
  calls out, not the dashboard UI the issue asks for.
- Worker-MCP limits: `get_task(gh-70)` → `403 worker scope mismatch`;
  `claim_task(task-77cdf4e1)` → `task ... is blocked by unfinished tasks: gh-70`
  (task status `blocked`, `unfinished_blockers: ["gh-70"]`). `search_context`,
  `submit_job` and `send_message` are not exposed by this worker endpoint, so
  the GitHub issue plus the local checkout were used as the source of truth.

## Rubric criteria

| # | Criterion | Result | Evidence (one line) |
|---|-----------|--------|---------------------|
| 1 | Aligned with underwright's architecture | N/A | No gh-70 change exists to evaluate; the existing enrollment backend on `main` does route mutations through `Store` (`src/store.ts:216-280`) with the P-store mirror. |
| 2 | No inappropriate hardcoded values | N/A | No gh-70 change exists to evaluate. |
| 3 | Tests present and passing — verified | FAIL | No test covers the requested UI because no UI exists; `test/dashboard.test.ts` exercises only the existing board routes (15 focused tests pass), and the full suite has 5 failures unrelated to enrollment (below). |
| 4 | No serious issues | N/A | No subject code to inspect; cannot certify absence of correctness/security/contract defects in work that was never written. |
| 5 | Actually delivered on a pushed branch with an open PR linked to the issue | **FAIL** | Issue #70 is open with no linked PR, no `gh-70` branch exists anywhere in `git branch -a`, and the dashboard contains none of the three AC features. |

## Finding

The three gh-70 acceptance criteria are unimplemented and undelivered. The
review cannot approve: there is no diff, no PR, and no pushed branch to review,
and the shipped dashboard does not list enrollments or offer approve/reject
actions. The existing MCP-only approval flow is exactly the gap the issue was
raised to close ("Node enrollment approval is MCP-admin only … There's no UI
path; admins can't self-serve approvals and 10-minute windows keep expiring").

Signals checked and found absent:

- dashboard listing of pending/recent enrollments with id, device name,
  requested-at and expiry countdown;
- `POST /nodes/enrollments/:id/approve` and reject form actions, gated to
  admin-scope bearer auth like the MCP admin tools (`adminConfigured` gate in
  `src/server.ts`);
- compare-code input on the form (the backend hashes the code in
  `approveNodeEnrollment`, so the UI must collect it from device output).

Everything else reported here is N/A precisely because there is no subject
implementation — that is the finding, not a gap in review effort.

## Validation

Run on `uw/task-77cdf4e1` at `32f6610`, Node `v22.23.4`, npm `10.9.9`:

- `npm run build`: **exit 0** (`tsc`).
- `npm test -- test/node-enrollment.test.ts test/dashboard.test.ts`:
  **exit 0**; 2 files passed, 15 tests passed. These cover the pre-existing
  enrollment backend and board UI, not gh-70's missing UI.
- `npm test`: **exit 1**; 35 files: 3 failed, 31 passed, 1 skipped;
  356 tests: 5 failed, 318 passed, 33 skipped. The 5 failures are outside the
  subject area: `test/arch.test.ts` (2 failures — `depcruise` cannot resolve its
  module: `node:internal/modules/cjs/loader` in this worktree),
  `test/packaging.test.ts` (1 — extracted-package installer plan assertion),
  `test/runner.test.ts` (2 — omnigent `--server` argument injected into the
  expected `omni run` argv). None involves enrollment or the dashboard.

No test run is represented as passing for gh-70; the feature has no tests.

## Verdict and actions

**Blocked / request changes — do not approve this subject.** Criterion 5 fails
outright (nothing delivered), criterion 3 fails (no tests for a nonexistent
change), and criteria 1, 2 and 4 are N/A for the same reason. Per the rubric's
approval rule ("Approve only if all five PASS"), approval is withheld.

Before an approvable review is possible, gh-70 needs a pushed branch with an
open PR linked to issue #70 implementing the three ACs, including admin-scope
authentication on the form actions, plus tests that are actually run. Completing
this **review** task records the negative verdict; it does not approve or close
gh-70, which remains open and unfinished.
