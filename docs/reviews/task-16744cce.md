# Review: task-16744cce — gh-45 per-harness-proof (kimi, opencode, cline, cursor, copilot)

- Review task: `task-9dfd4c84` (kind `code`, ac `review`)
- Subject: `task-16744cce`, implementer `claude@alandesktop`
- Issue: https://github.com/underwright/underwright/issues/45 (AC `per-harness-proof`)
- Reviewer: `claude@covasant-laptop-wsl2` (not the implementer)
- Date: 2026-11-22
- Rubric: `underwright.policy.json` → `rubrics["underwright/underwright"].review.checklist`
  (landed in 9207594, PR #230). `docs/review-rubric.md` does not exist.

## What the subject was meant to deliver

Issue #45, AC `per-harness-proof`: each harness completes one real board task
end to end. codex, claude, grok, agy and cmdc were already done. This subject
covers the other five: **kimi, opencode, cline, cursor, copilot**.

## Access limitation

The reviewer's credential is scoped to `task-9dfd4c84`. These calls were refused:
`get_task task-16744cce` → 403 `worker scope mismatch`;
`board task-16744cce` → 403; `GET /board` → 401 `scoped credential cannot
access admin surface`. So I could not read the subject's own artifacts or
evidence. Everything below comes from git and GitHub, which any reviewer can
check. If the subject's board evidence names task ids that kimi, opencode,
cline, cursor and copilot completed, a reviewer with board access should check
them. Without that, this review cannot accept the proof.

## Evidence gathered

| Check | Result |
|---|---|
| Branch for the subject (`git branch -a \| grep 16744`) | none |
| PR mentioning `16744cce` / `per-harness` (`gh pr list --state all --search`) | none relevant |
| Commits citing `16744cce` / `per-harness-proof` (`git log --all --grep`) | none |
| Issue #45 state | OPEN. Last digest (2026-11-17) shows 0/3 ACs evidenced, blocked by task-16744cce |
| Harness registry (`docs/harness-registry.md`) | Only on `origin/wip/dirty-main-salvage` (aa9215d, 2026-11-19), not on `main`. Its "Board proof" column lists **all five** harnesses as `⏳ task-16744cce`, not as completed |
| Git commits authored by each harness identity (`git log --all --author`) | see below |

Commits by harness identity, across all refs:

| Harness | Commits | Notes |
|---|---|---|
| kimi | 1: `e0ee67b` kimi@alandesktop, 2026-11-07, on `main` | Real work (harness_matrix parsing + tests). Predates the subject and is not linked to a board task id here |
| cline | 2: `12ca447`, `5614f64` cline@yoga, 2026-11-21 | gh-200 ADR/docs on `uw/gh-200` → PR #215, **still OPEN** (not merged) |
| opencode | 0 | none |
| cursor | 0 | none |
| copilot | 0 | none |

Commits are a proxy. The AC asks for a board completion, which may not involve
a commit. Still, for opencode, cursor and copilot, nothing in git or GitHub
shows an end-to-end run.

## Rubric

| # | Criterion | Verdict | Evidence |
|---|---|---|---|
| 1 | AGENTS.md conventions: claimed, board updated, artifacts not side channels | UNVERIFIED → FAIL | Could not read the subject's artifacts (403). The issue digest records 50+ repeated `blocked` re-check artifacts on the parent `gh-45` while the subject was operator-only. That is the re-dispatch loop already filed as #69, not progress |
| 2 | Build + typecheck actually run, output quoted | N/A | The subject has no code diff. It is an operational proof task |
| 3 | Store changes valid on both SQLite and PG | N/A | No store changes |
| 4 | ESM/Node16 hygiene, no secrets or host values | N/A | No code changes |
| 5 | Git hygiene: feat branch, PR open and linked to the issue | FAIL | No branch, no PR, no commit references task-16744cce. The only per-harness proof table sits on an unmerged WIP salvage branch and shows all five as pending |
| 6 | Mutations through store methods with audit events | N/A | No code changes |
| — | Task-specific: does the AC hold (each of the five harnesses completed one real board task)? | FAIL | No proof found for opencode, cursor or copilot. kimi has one pre-existing commit and cline has an unmerged PR, but neither is tied to a recorded board completion |
| — | Post-deploy validation script (global rule) | N/A | No deployable change. The proof is the board completion record itself |

## Verdict: **CHANGES REQUESTED**

The `per-harness-proof` AC is not shown to be met. Before gh-45 can close:

1. For each of kimi, opencode, cline, cursor and copilot, record the board task
   id that harness completed (agent_id such as `opencode@<host>`) and its
   `report_evidence`. Put these on the subject task and in the registry's
   "Board proof" column.
2. Land `docs/harness-registry.md` on `main` through a PR linked to #45. Today
   it exists only on `wip/dirty-main-salvage`, and `docs/glossary.md` on main
   already links to it, so that link is broken.
3. For harnesses that cannot complete a task yet (the registry marks
   kimi/cline/cursor install or auth as `unknown`), post a `blocked` artifact
   on the subject saying why, rather than completing it. Or split them into
   their own tasks so the other harnesses can be accepted.
4. Re-run this review with a credential that can read task-16744cce's evidence.
