# Independent code review: task-a6a60ecc (task-7c4338ee — pluggable `authenticate(req)` hook + read-only scope on `serveHttp`, ADR-0010 seams)

**Disposition: FAIL — no implementation was delivered to review.**
Reviewer: `devin@alandesktop` (independence OK — implementer was
`claude@alandesktop`). Subject spec:
`docs/adr/0010-hosted-control-plane.md` requires three OSS seams (ADR-0010
lines 166–168): a pluggable auth hook
`authenticate(req) → {principal, scope}` on `serveHttp`, a store-scoped
policy source, and read-only scope enforcement in tool dispatch ("the
`read` scope rejects mutations", line 222). task-7c4338ee covers the auth
hook + read-only scope. None of it exists on any ref.

## Method and scope

- `git log --oneline main..uw/task-7c4338ee` → **empty**; merge-base equals
  the branch tip `b004dd2`, so the subject branch is a strict ancestor of
  `main` (~50 commits behind, "node: attest worktree-mcp feature"). 0
  commits delivered.
- `git ls-remote origin | grep 7c4338ee` → **nothing**; the branch was
  never pushed. `gh pr list --state all --search 7c4338ee|authenticate|
  ADR-0010|serveHttp|auth` → no PR of any state for this work.
- `git log --all -S "authenticate(req"` → only `f2108c4`
  ("wip: salvage uncommitted multi-feature work from main checkout"),
  which is the ADR-0010 spec text mentioning the hook — not an
  implementation, and itself unpushed salvage.
- `git show origin/main:src/server.ts` → `serveHttp(dbPath, host, port,
  token?)` at line 318: no `authenticate` hook parameter, no `read` scope.
  The `401 "scoped credential cannot access admin surface"` check (~line
  349) is pre-existing node-token logic, not a read scope.
- `git log origin/main --oneline -15 -- src/server.ts` → no auth-hook or
  scope work landed on `main` under any other task.
- Subject worktree `.uw/wt/job-e3639a22` is checked out at `b004dd2` and
  is clean — only harness noise (`M .mcp.json`, `?? .cursor/`, identical
  to every other worker worktree).
- The spec document itself, `docs/adr/0010-hosted-control-plane.md`, is
  absent from `origin/main`; it exists only inside salvage commit
  `f2108c4`. The closest thing in that commit is `serveHttp(..., authRule:
  Required<AuthRule>)` — a policy-object seam, not the specified
  `authenticate(req) → {principal, scope}` hook.
- `get_task`/`board` for `task-7c4338ee` are refused on this worker
  endpoint (`403 worker scope mismatch`), so the implementer's own
  artifacts/evidence could not be inspected; git and GitHub are the
  authoritative record and they show nothing delivered.
- Note: `claim_task` on this review succeeded only because `b07d9cf`
  ("Satisfy review blockers at in_review, not only done") now lets an
  `in_review` subject unblock reviews — the subject presumably reached
  `in_review` via lease-expiry/sweep with zero code, same gap documented
  in `docs/reviews/task-616d1b77.md` (F2).

## Rubric criteria (underwright/underwright, `underwright.policy.json`)

| # | Criterion | Result | Evidence (one line) |
|---|-----------|--------|---------------------|
| 1 | AGENTS.md conventions — claimed before work, board updated, artifacts not side channels | FAIL | Subject task inaccessible (403 scope) but no commits, no pushed branch, no PR, and no handoff artifact anywhere visible — the task reached `in_review` with nothing delivered. |
| 2 | build+typecheck actually run — UNVERIFIED counts as fail | FAIL | No code exists, so no build/test could have run; no `test_run` evidence is visible. |
| 3 | Store-layer changes verified on both SQLite and PG | N/A | Feature is server-layer; no store change exists or was required. |
| 4 | ESM/Node16 hygiene — .js suffixes, no undeclared deps/secrets | N/A | No code delivered. |
| 5 | Git hygiene — feat branch off main, PR open and linked, no orphans | FAIL | `uw/task-7c4338ee` has 0 commits beyond merge-base, is not pushed to `origin`, and no PR exists. |
| 6 | Mutations through store methods with audit events | N/A | No code delivered. |

## Findings

### F1 — Blocking: task-7c4338ee was never implemented

Every element of the spec is absent on every ref: no `authenticate(req)`
parameter on `serveHttp`, no `{principal, scope}` return contract, no
`read` scope, no read-scope rejection in tool dispatch, no tests. The
subject task appears to have been parked into `in_review` by a sweep
without delivery. This is not a reviewable PR — the work needs to be
implemented and re-dispatched.

### F2 — Process gap (repeat of task-616d1b77 F2): `in_review` satisfies `blocked_by` without evidence

This is the second review spawned against empty work for the same reason
(`b07d9cf` / gh-179). `in_review` reached by lease-expiry/sweep is
indistinguishable from `in_review` after a real submission. Recommend
gating blocker-satisfaction on `in_review` **with ≥1 evidence row or a
pushed branch**, or emitting a distinct status for sweep-parked tasks.

## Verdict and actions

**FAIL.** There is no implementation to approve. task-7c4338ee should
return to `open` for implementation: add
`authenticate?: (req) => {principal, scope} | Promise<...>` to
`serveHttp` options (default = current token check), thread `scope`
through tool dispatch, reject mutations for `read` scope, and cover it
with tests — on a pushed branch with a PR linked to the tracking issue.
