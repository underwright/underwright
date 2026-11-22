# Review: gh-98 Glossary → UC Pages sync (task-dbccf1cf)

Reviewer: devin@alandesktop (not the implementer, claude@alandesktop)
Subject: https://github.com/underwright/underwright/issues/98
Base checked: origin/main @ 32f6610 (2026-11-22)

**Verdict: FAIL. Changes requested.** gh-98 sits at `in_review`, but nothing was
delivered. A real, good-quality implementation exists — it just lives only as
*uncommitted* edits in the local worktree `/home/alan/code/uw-gh-98` on branch
`feat/gh-98-glossary-sync` (HEAD `950d125`, 47 commits behind main). No commit,
no push, no PR, and the issue's board digest shows 0/6 ACs with evidence. Per
AGENTS.md, an unpushed commit is undelivered work — an uncommitted diff is
further still.

## What exists

| Item | Where | State |
|---|---|---|
| `docs/glossary.md` (~25 atomic terms) | `origin/main` @ 3840c72 | Landed 2026-11-13, direct commit to main, no PR (`gh api commits/3840c72/pulls` → `[]`) |
| `src/glossary.ts` (130 lines: `readGlossary`, `syncGlossary`, `databricksKnowledgeRequest`) | uw-gh-98 worktree | **uncommitted** (`??` in git status) |
| `test/glossary.test.ts` (153 lines, 10 tests) | uw-gh-98 worktree | **uncommitted** |
| `docs/glossary-sync.md` (86 lines: configure/preview/publish/add-term workflow) | uw-gh-98 worktree | **uncommitted** |
| `src/cli.ts` `glossary sync` subcommand (+18) | uw-gh-98 worktree | **uncommitted** (`M`) |
| `docs/glossary.md` stable `<!-- glossary-id: -->` markers (+92) | uw-gh-98 worktree | **uncommitted** (`M`) |
| `README.md` glossary pointer (+4) | uw-gh-98 worktree | **uncommitted** (`M`) |

No `feat/gh-98-*` or glossary-related branch exists on `origin`
(`git branch -r` after fetch, 81 refs), no PR is open or linked from the issue
timeline, and `gh search code --owner underwright glossary` finds nothing
outside this repo's doc. The board task artifacts (design + note by
codex@alandesktop) are the only delivery record; the scoped worker credential
(403 on `get_task gh-98`) prevented reading them directly.

## Verification performed by this reviewer

Run against the uncommitted worktree at `/home/alan/code/uw-gh-98` (Node
v22.23.4):

```
$ npm run build
> underwright@0.1.1 build
> tsc
$ npx vitest run test/glossary.test.ts
 Test Files  1 passed (1)
      Tests  10 passed (10)
```

Build clean, all 10 tests pass — including parsing the real
`docs/glossary.md` (≥20 terms with markers), create/unchanged/update
idempotency, same-title conflict refusal, dedicated-domain guard, subdomain
isolation, pagination, retried-create reconciliation, and CLI-adapter
injection/error handling.

## Underwright rubric

| # | Criterion | Result | Evidence |
|---|-----------|--------|----------|
| 1 | AGENTS.md conventions (claim, board, artifacts) | FAIL | Task was claimed and has design/note artifacts, but board digest shows 0/6 ACs evidenced and `in_review` was entered with nothing pushed |
| 2 | Build + typecheck actually run | FAIL | No implementer evidence; reviewer-verified clean only against the uncommitted worktree |
| 3 | Store changes on both SQLite + PG | N/A | No store/IStore changes |
| 4 | ESM/Node16 hygiene | PASS (on the worktree diff) | `import ... from "./glossary.js"` in cli.ts; node: builtins only; execFile used, no shell; errors drop argv/env |
| 5 | Git hygiene (feat branch, PR linked) | FAIL | Work is a dirty worktree on a stale base (47 behind main); nothing committed, pushed, or PR'd |
| 6 | Mutations via store + audit | N/A | No code path touches the store |

## Issue ACs

| AC | Status |
|----|--------|
| glossary-doc | Met on main (3840c72, 25 terms); marker IDs exist only in the uncommitted edit |
| sync-mechanism | Implemented (`syncGlossary`, `underwright glossary sync`) but undelivered |
| idempotent | Implemented + tested (unchanged rerun, stable `request_id` on create retry) but undelivered |
| term-workflow-docs | `docs/glossary-sync.md` written but undelivered |
| databricks-workspace | Unverified — never run against the gh-51 workspace; doc itself says "Capture real workspace output on gh-98 before claiming live verification" |
| tests + review | Tests exist and pass (reviewer-run); no evidence attached on the task |

## Implementation notes (for the follow-up, not blockers beyond delivery)

- Rebase needed: the diff is against `950d125` (2026-11-14); `docs/glossary.md`
  and `src/cli.ts` have both moved on main.
- `readGlossary` splits single-file mode on `^## ` — a level-2 heading inside a
  term body (e.g. fenced example) would misparse; acceptable but worth a
  comment or guard.
- `databricksKnowledgeRequest` surfaces `stderr` in errors — fine, but
  `console.error((error as Error).message)` in cli.ts prints `undefined` for
  non-Error throws; minor.
- Test uses a shebang'd fake `databricks` binary — Linux-only; fine for this
  repo's fleet.

## Required to pass

1. Rebase `feat/gh-98-glossary-sync` onto current main, commit the worktree
   diff, push, and open a PR linked to #98.
2. Attach `report_evidence` on gh-98 citing the build + `vitest run
   test/glossary.test.ts` output for every applicable ac_id.
3. Run `glossary sync --dry-run` and a real publish against the gh-51 target
   workspace (or document why that is infeasible) for the
   `databricks-workspace` AC.
