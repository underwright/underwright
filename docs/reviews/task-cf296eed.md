# Review: gh-84 Groom phase (task-cf296eed)

Reviewer: claude@alandesktop (not the implementer, claude@covasant-laptop-wsl2)
Subject: https://github.com/underwright/underwright/issues/84
Base checked: origin/main @ 1885ea9 (2026-11-22)

**Verdict: FAIL. Changes requested, nothing to merge.** gh-84 sits at `in_review`,
but no implementation was delivered. No branch, PR, or commit references gh-84 or
#84. The issue's board digest shows 0/7 ACs with evidence.

## How I searched
- `gh pr list --state all --limit 300` filtered for `gh-84`, `#84`, or `groom`. The only
  hit is PR #232, a gh-64 review that itself notes "omits the groom ... actions".
- `git branch -r | grep -iE '84|groom'` finds only `origin/uw/task-9dfd4c84`, which is an unrelated gh-45 review.
- `git log --all -i --grep=groom` finds `f2108c4` (wip/dirty-main-salvage) and the PR #232 commit.
- `grep -rn -i groom src/` on main finds no matches. The only references are the
  `sdlc.grooming` block in `underwright.policy.json` and `docs/process-flow.md`,
  which marks groom (gh-84) as 📐 (designed, not built).
- The salvage commit f2108c4 holds a gh-56 `groomBacklog()`/`sweepSdlc()` stale-task
  sweep that writes a note artifact. That is the "side-channel job" model gh-84 sets out
  to replace. It is not on main and it is not gh-84 work.

## Underwright rubric
| # | Criterion | Result | Evidence |
|---|-----------|--------|----------|
| 1 | AGENTS.md conventions (claim, board, artifacts) | FAIL | gh-84 is unclaimed with no handoff or evidence artifacts (issue digest 0/7). |
| 2 | Build + typecheck actually run | FAIL | No implementer evidence. The reviewer's `npm run build` on main is clean, but that proves nothing about gh-84. |
| 3 | Store changes on both SQLite + PG | N/A (FAIL by absence) | The `subject-update` permission seam is not implemented in either store. |
| 4 | ESM/Node16 hygiene | N/A | No code to inspect. |
| 5 | Git hygiene (feat branch, PR linked) | FAIL | No feat/gh-84-* branch and no PR linked to #84. |
| 6 | Mutations via store + audit | N/A | No code to inspect. |

## Issue ACs
| AC | Status |
|----|--------|
| groom-phase (pipeline stage + `type: groom` + DoR exit gate) | Missing. `lifecycle.pipelines` is `{}` and there is no groom type. |
| groom-duties (runbook) | Missing |
| cadence-producer (gh-64 schedule enqueues groom tasks) | Missing. gh-64's `src/schedule.ts` is salvage-only and lacks a groom action (see PR #232). |
| subject-update (audited update of the subject task) | Missing |
| escalation (lettered-option mailbox) | Missing |
| tests | Missing |

## Required to pass
1. Move gh-84 from `in_review` back to `open`. Nothing implements it.
2. Land the gh-64 scheduler (salvage `src/schedule.ts`) on a real branch first, since the
   cadence producer depends on it.
3. Implement each AC on `feat/gh-84-*`, with tests on both stores and a PR linked to #84.
