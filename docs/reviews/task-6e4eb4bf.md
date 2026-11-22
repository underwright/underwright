# Review: gh-116 Omnigent session ids + fork-aware retry (task-6e4eb4bf)

Reviewer: devin@alandesktop (not the implementer, claude@covasant-laptop-wsl2)
Subject: https://github.com/underwright/underwright/issues/116
Base checked: origin/main @ 1885ea9 (2026-11-22)

**Verdict: FAIL. Changes requested, nothing to merge.** gh-116 sits at `in_review`,
but no implementation was delivered. No branch, PR, or commit references gh-116 or
#116 anywhere in underwright/underwright or underwright/underwright-pro. The issue's
board digest shows 0/4 ACs with evidence. A prior reviewer (codex@alandesktop,
art-0d693713) reached the same finding on 2026-11-20; nothing has been pushed since.

## How I searched
- `gh pr list --state all --limit 40` + searches for `116`, `omnigent session`, `fork`:
  no PR implements gh-116. Closest is open PR #178 (`uw/gh-168`), which captures
  `jobs.omni_session_id` + cost via uw-runner telemetry heartbeats — a different
  issue, a different mechanism (dedicated column, local-runner path only), and no
  node path, no get_task surfacing, and no fork retry.
- `git grep -l 'fork_session|omnigent_session'` across every remote branch (~78):
  zero hits. `git grep 'omni_session'` hits only `feat/gh-66-omnigent-hooks` (gh-66,
  unmerged, week-old) and `uw/gh-168` (PR #178).
- `git log --all --grep=116` / `--grep=omnigent`: no gh-116 commits.
- `gh api repos/underwright/underwright/issues/116/timeline`: no cross-referenced or
  linked PRs/commits; issue remains OPEN.
- `underwright-pro`: `main` only, no branches or PRs.
- `origin/wip/dirty-main-salvage`: no gh-116 content.
- On main, `src/runner.ts:72,167-168` only normalizes the `omnigent session: X`
  marker into the result *text*; nothing extracts it into `result_metadata`, and
  `src/node-protocol.ts` launch-agent payloads carry no `fork_session` field.

## Underwright rubric
| # | Criterion | Result | Evidence |
|---|-----------|--------|----------|
| 1 | AGENTS.md conventions (claim, board, artifacts) | FAIL | gh-116 shows `in_review` with 0/4 evidenced ACs and no published handoff or implementation ref. |
| 2 | Build + typecheck actually run | FAIL | No implementer evidence. Reviewer's `npm run build` on main @ 1885ea9 is clean, but proves nothing about gh-116. |
| 3 | Store changes on both SQLite + PG | N/A (FAIL by absence) | `finishJob`/`finishNodeJob` `result_metadata.omnigent_session` extraction is absent from both `src/store.ts` and `src/pstore.ts` on every ref. |
| 4 | ESM/Node16 hygiene | N/A | No code to inspect. |
| 5 | Git hygiene (feat branch, PR linked) | FAIL | No `feat/gh-116-*`/`uw/gh-116` branch and no PR linked to #116. |
| 6 | Mutations via store + audit | N/A | No code to inspect. |

## Issue ACs
| AC | Status |
|----|--------|
| capture: finishJob/finishNodeJob stores result_metadata.omnigent_session | Missing. Marker stays embedded in `jobs.result` text only. |
| get_task surfaces task->job->omnigent session chain | Missing. No session chain in `get_task` output on any ref. |
| retry_of launch-agent payload supports fork_session; executor appends --fork when harness is omni | Missing. `fork_session` appears nowhere; node-protocol payload schema has no such field. |
| test: extraction + fork wiring covered | Missing. |

## Required to pass
1. Move gh-116 from `in_review` back to `open`. Nothing implements it.
2. Implement on `feat/gh-116-*`: extract `omnigent session: <id>` into
   `result_metadata.omnigent_session` in `finishJob`/`finishNodeJob` (both stores),
   surface the job->session chain in `get_task`, add `fork_session` to the
   launch-agent payload + re-dispatch lookup, append `--fork <id>` for omni
   harnesses in the node executor, and cover extraction + fork wiring with tests.
3. Reconcile with PR #178 (gh-168): if `jobs.omni_session_id` lands first, gh-116's
   capture AC should reuse it rather than adding a second session field.
4. Push and open a PR linked to #116; quote real build/test output in evidence.
