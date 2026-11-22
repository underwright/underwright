# Review: gh-72 serve crashes at startup — unhandled SQLITE_BUSY from sweeperLeadership (task-9709b6dd)

Reviewer: devin@alandesktop (not the implementer; task notes claude@alandesktop as implementer)
Subject: https://github.com/underwright/underwright/issues/72
Base checked: origin/main @ 1885ea9 (2026-11-22)

**Verdict: FAIL. Nothing delivered to review.** gh-72 sits at `in_review` on the
board (issue digest 2026-11-17: `Claim: unclaimed`, 0/3 ACs evidenced), but no
branch, PR, commit, or test implements the fix. The buggy code path — an
awaited `store.sweeperLeadership(instanceId)` inside `try { ... } finally` with
no `catch` in `tick()` — still exists verbatim on `origin/wip/dirty-main-salvage`,
the only ref that contains the sweeper-leadership feature. On `main` the sweeper
has no leadership call at all, so this specific crash path does not exist there —
but none of the issue's ACs are satisfied anywhere.

## How I searched
- `git fetch --prune` then `git branch -r` (85 remote refs): no `uw/gh-72`,
  `feat/gh-72-*`, or `fix/gh-72-*` branch exists.
- `git log --all -S sweeperLeadership`: the symbol exists only on
  `origin/wip/dirty-main-salvage` (f2108c4 salvage + aa9215d, adcfd4f watch
  commits). `git log origin/main -S sweeperLeadership`: never existed on main.
- `git show origin/wip/dirty-main-salvage:src/sweeper.ts` — line ~24:
  `if (store.sweeperLeadership && !(await store.sweeperLeadership(instanceId))) return;`
  sits inside `try { ... } finally { running = false }` with no `catch`. A throw
  rejects the async IIFE assigned to `pending`; nothing awaits it → unhandled
  rejection → process exit. The exact crash from the issue is still present.
- `gh pr list --state all` + `gh api search/issues` + `gh api issues/72/timeline`
  + `gh api repos/.../branches` + commits since 2026-11-10: no PR, branch, or
  commit references or implements gh-72. No merged PR touches `src/sweeper.ts`.
- `git grep sweeperLeadership origin/wip/dirty-main-salvage -- test/`: no
  regression test for the leadership-throws / startup-lock path on any ref.
- Local: all local branches and 636 job worktrees under `.uw/wt/` checked — none
  contain `sweeperLeadership` or a gh-72 fix.
- `get_task gh-72` / `list_artifacts gh-72` return 403 worker-scope mismatch from
  this job's scoped MCP tools, so the implementer's board artifacts could not be
  inspected; the public digest on issue #72 is the window used.
- `gh issue view 72`: OPEN; sole comment is the 2026-11-17 board digest reporting
  `in_review`, `Claim: unclaimed`, `Acceptance criteria with evidence: 0/3`.

## Underwright rubric
| # | Criterion | Result | Evidence |
|---|-----------|--------|----------|
| 1 | AGENTS.md conventions (claim, board, artifacts) | FAIL | Issue digest: `Claim: unclaimed`, 0/3 ACs evidenced; "push when done" violated — nothing pushed. |
| 2 | Build + typecheck actually run | FAIL | No implementer evidence exists; nothing to build. UNVERIFIED counts as fail per the rubric. |
| 3 | Store changes verified on SQLite + PG | N/A | No code delivered to inspect. |
| 4 | ESM/Node16 hygiene | N/A | No code delivered to inspect. |
| 5 | Git hygiene (feat branch, PR linked) | FAIL | No `uw/gh-72`/`feat/gh-72-*` branch on remote; no PR linked to #72. |
| 6 | Mutations via store + audit | N/A | No code delivered to inspect. |

## Issue ACs
| AC | Status |
|----|--------|
| sweeperLeadership errors caught in tick; serve survives transient SQLITE_BUSY | Missing. Uncaught await still present on `origin/wip/dirty-main-salvage:src/sweeper.ts`. |
| serve does not exit when DB write-locked at startup | Missing. No fix on any ref containing the code path. |
| regression test covers the startup-lock path | Missing. No test exercises a throwing `sweeperLeadership` anywhere. |

## Required to pass
1. Move gh-72 from `in_review` back to `open` — nothing implements it. If the
   sweeper-leadership feature is intentionally abandoned, close #72 as obviated
   and drop/rebase `origin/wip/dirty-main-salvage` so the dead crash path is not
   later merged by accident.
2. Otherwise implement the fix on a `feat/gh-72-*` branch: wrap the
   `sweeperLeadership` await in try/catch → `onError`, treat the error as
   "not leader" for that tick.
3. Add the regression test: fake store whose `sweeperLeadership` throws
   (SQLITE_BUSY); assert the sweeper keeps ticking and `serve` does not exit.
4. Run `npm run build` + `npm test`, cite real output in evidence for every
   ac_id, and open a PR linked to #72.
