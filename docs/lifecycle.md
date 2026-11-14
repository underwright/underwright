# Task lifecycle state machine

`src/lifecycle.ts` turns `task.status` into an enforced state machine (gh-56).
It is on when `underwright.policy.json` has a `lifecycle` block. Without one,
the store keeps its old permissive behaviour.

## Phases and statuses

| SDLC phase | Stored status | Gate on the way out |
|---|---|---|
| backlog, triage, design, ready | `open` | DoR (`dor` policy) on `claim_task` |
| claimed, implementing | `claimed` | design artifact if the pipeline needs one |
| reviewing | `in_review` | — |
| verifying | (gate on `complete_task`) | passing verification evidence, reproduction for bugs, DoD |
| done | `done` | — |

Legal edges (`TRANSITIONS`):

```
open      → claimed | blocked | done(sync only)
claimed   → claimed | in_review | open(release_task) | blocked | done
in_review → claimed | open | blocked | done
blocked   → open | done(sync only)
done      → open
```

Rules that apply even on legal edges:

- `claimed` can only be entered through `claim_task`, so the DoR gate always runs.
- `complete_task` refuses to run from `open` or `blocked`. Claim the task first.
- `set_task_status open` on a claimed task is refused. Use `release_task`.
- `setTaskStatus(done|open)` from GitHub sync is allowed. An external system of
  record is reconciling the board, and the change is logged as `status:<s>`.
  The `set_task_status` MCP tool cannot set `done`.

## Per-type pipelines

| type | design | review | verify | reproduction |
|---|---|---|---|---|
| default / feature / tdd / deploy | – | – | ✓ | – |
| bug | – | – | ✓ | ✓ |
| architecture | ✓ | – | – | – |
| docs / review / triage | – | – | – | – |

- **design**: a `design` or `spec` artifact must exist before `in_review` or `done`.
  Tasks with an estimate listed in `design_estimates` (default `["L"]`) also need one.
- **review**: `done` must come from `in_review`. Move there with `set_task_status`.
- **verify**: there must be passing `test_run`, `ci_check`, `smoke_test`,
  `contract_test` or `deploy` evidence (exit 0 or unset).
- **reproduction**: a failing `test_run` must be on record.

Override any of these per type in the policy file:

```json
"lifecycle": {
  "enabled": true,
  "design_estimates": ["L"],
  "pipelines": { "feature": { "review": true }, "docs": { "verify": false } }
}
```

DoD (`dod` + `enforcement`) still runs after the lifecycle gate. The lifecycle
gate always blocks. It does not follow `enforcement`.

## Ceremonies: retro, grooming, sprints

`src/sdlc.ts` holds the logic as pure functions. Both stores only fetch rows.
The lease sweeper calls `sweepSdlc()` every minute. Retro and grooming run only
when the policy `sdlc` block turns them on and they are due. The last run is
the newest `sdlc/retro_created` or `sdlc/groomed` audit event.

```json
"sdlc": {
  "retro": { "enabled": true, "every_days": 7 },
  "grooming": { "enabled": true, "every_minutes": 60, "stale_open_days": 14,
                "stale_claim_minutes": 120, "reset_estimates": false }
}
```

### Retro (`run_retro`)

Creates task `retro-<YYYY-MM-DD>`, one per window end day. It has type `retro`,
estimate `S` and AC `actions`. The `retro` pipeline skips verifying. The task
description and a `Retro stats` note artifact hold:

- **review failures**: `review` evidence with a non-zero `exit_code`
- **rework rate**: share of touched tasks that were reopened after done, claimed
  more than once, or failed review
- **blocker stats**: `blocked` escalations, tasks set to `blocked`, expired leases
- **DoR/DoD tuning**: suggestions fired by thresholds (review failure > 25%,
  rework > 20%, 3+ blocked tasks, 3+ expired leases)

### Grooming (`groom_backlog`)

- **Stale open tasks**: no task activity for `stale_open_days`. A `groom_stale`
  event is logged. With `reset_estimates`, the estimate is cleared, so a DoR
  that requires an estimate forces re-estimation before the next claim.
- **Stale claims**: the lease is live, but the holder has done nothing on the
  task for `stale_claim_minutes`. Renewing a lease does not count as activity.
  The holder gets a mailbox message and a `stale_claim` event is logged.
- **Dependency edges**: a task done before its blocker, a task claimed or in
  review while its blocker is unfinished, or a task in `blocked` status whose
  blockers are all done. Each is logged as `dependency_issue`.

When anything is found, a `Backlog grooming` note artifact summarises it.

### Sprints (`create_sprint`, `assign_sprint`, `sprint_report`, `list_sprints`)

Sprints are optional. A task belongs to at most one sprint (`tasks.sprint`).
Closed sprints refuse new commitments. When unfinished work moves from one
sprint to another, it is logged as `sprint_assigned` with `carry_over: true`.
`board()` includes `sprint`, the active sprint's report:

- committed, done and remaining counts
- a daily `burndown` against the ideal line
- `carry_over`: unfinished tasks once the sprint is closed
- `carried_in`: tasks that came from an earlier sprint

A date-only `ends_at` includes that whole day.
