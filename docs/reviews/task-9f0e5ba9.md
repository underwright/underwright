# Code review: task-9f0e5ba9 — Scheduled activities: declarative cadences in policy (gh-64)

- Review task: task-f1ee003c (reviewer `claude@covasant-laptop-wsl2`; implementer was `claude@alandesktop`)
- Issue: https://github.com/underwright/underwright/issues/64 (OPEN)
- Code under review: `src/schedule.ts`, `test/schedule.test.ts`, and the `startScheduler(store)` wiring in `serveHttp` (`src/server.ts`)
- Where the code is: **only** in commit `f2108c4` ("wip: salvage uncommitted multi-feature work from main checkout") on `origin/wip/dirty-main-salvage`. It is not on `main` (`git merge-base --is-ancestor f2108c4 origin/main` exits 1, and `src/schedule.ts` is absent from `origin/main`). No `feat/gh-64-*` branch exists, and no PR references gh-64 or task-9f0e5ba9.
- Note: the reviewer token cannot read task-9f0e5ba9 (`get_task` returns 403 worker scope mismatch). This review is based on the issue text, the gh-64 digest comment and the code.

## Verdict: CHANGES REQUESTED (FAIL)

The scheduler code is solid and its tests pass. The work is **not delivered**, though. It sits inside a ~40-feature salvage WIP commit with no branch or PR linked to the issue. It also does not cover the issue's full scope (backlog grooming and custom job specs are missing), and it ships no post-deploy validation script.

## Rubric

| # | Criterion | Result | Evidence |
|---|-----------|--------|----------|
| 1 | Tests actually ran | PASS (reviewer re-ran) | At `f2108c4` in a scratch worktree: `npx tsc --noEmit -p .` exits 0. `npx vitest run test/schedule.test.ts` gives 1 file passed, **14/14 tests passed**. The implementer attached no run output that this reviewer could see, because the subject task is unreadable from this scope. |
| 2 | Tests cover the behaviour | PASS | They cover parsing (valid, invalid and duplicate entries, missing block, non-array), duration and cron math (lists, ranges, steps, Sunday=7, Vixie DOM/DOW OR), interval due-ness, a cron slot firing once with bounded catch-up, and the digest, build and node_health actions against a real store. They also check that failures are recorded without retrying every tick, that last-run survives a restart, and that the loop starts, re-reads policy and stops. |
| 3 | No serious correctness/security issues | PASS with notes | See findings. The `build` command comes from the trusted policy file, so no untrusted input reaches a shell. A bad entry is skipped and reported, never thrown, so one broken cadence cannot take serve down. |
| 4 | Scope matches the issue | FAIL | gh-64 asks for these actions: digest-to-inbox, **backlog grooming (triage untriaged)**, build/test validation job submission, node health checks, and **custom job specs**. The implementation has `digest`, `build` and `node_health` only (`SCHEDULE_ACTIONS`). The gh-64 digest lists a `groom` AC, which has no implementation. Custom job specs are partly covered by `build` with an arbitrary `command`, but the job `type` cannot be set. |
| 5 | Post-deploy validation script | FAIL | No script with positive and negative cases ships with the change. For example, it could seed a `schedule[]` entry with `every: 60s`, wait one pass, and assert one `schedule:<id> ran` event plus a queued job. A negative case could check that an invalid entry is reported and does not fire. |
| 6 | Pushed on a branch/PR linked to the issue | FAIL | The work exists only in the salvage WIP commit on `wip/dirty-main-salvage`, mixed with dashboard auth, agent keys, sprints, groom/SDLC and more. There is no feature branch and no PR, and the issue is still open. |
| 7 | Conventions (Store-mediated mutations, audit log) | PASS | Every firing writes `log("schedule", "schedule:<id>", "ran"|"failed", "scheduler", …)`. Actions go through `store.digest`, `submitJob`, `sendMessage` and `listNodes`, reusing existing Store methods as the issue asked. |

## Findings

1. **Not delivered (blocking).** Extract `src/schedule.ts`, `test/schedule.test.ts` and the `startScheduler` wiring in `serveHttp` out of `f2108c4` onto `feat/gh-64-scheduled-activities`, rebase onto current `main`, and open a PR that references gh-64. `serveHttp` on `main` has changed since then (node-route logging and other changes), so the wiring hunk needs a manual port.
2. **Scope gap (blocking for closing gh-64).** Add a `groom` action, or split grooming and custom job specs into follow-up issues and narrow gh-64's ACs, so the issue does not close with its scope unmet.
3. **Double firing with more than one serve process (low).** `runDueSchedules` checks then acts: it reads `lastRun`, runs the action, then logs. Two `serve` processes on the same DB (or Postgres) would both fire every cadence. Today there is one resident serve per DB, so the risk is latent. Document the single-scheduler assumption, or take a short lease or unique slot key (for example, insert `schedule:<id>` + slot before running).
4. **Unbounded history scan per tick (nit).** `lastRun` calls `store.taskEvents("schedule:<id>")` with no `since` or limit, once per entry every 30 s. The event count grows without bound (a 15 m cadence adds ~35k events a year). Use the newest event only (`ORDER BY id DESC LIMIT 1` filtered by action) or pass `sinceIso`.
5. **A failed run waits a full period (nit, design choice).** A transient failure on an `every: 24h` build does not retry for 24 h. This is documented and intended, to avoid retry storms. Consider a shorter retry back-off for `failed`.
6. **Catch-up window (info).** If serve is down for more than 5 minutes across a cron slot, that slot is skipped (`CRON_CATCHUP_MINUTES = 5`). This is intentional ("at most once, never a backlog") and documented in the code. Also mention it in the policy docs.

## Reproduce

```bash
git worktree add --detach /tmp/uw-review-9f0e f2108c4
cd /tmp/uw-review-9f0e && ln -s <repo>/node_modules node_modules
npx tsc --noEmit -p .            # exit 0
npx vitest run test/schedule.test.ts   # 14 passed
```
