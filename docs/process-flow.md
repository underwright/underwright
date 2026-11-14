# Process flow — the default pipeline and how to change it

Audience: humans running or extending the system. This doc describes the
**default pipeline**: the stages every work item moves through, the gate at
the exit of each stage, and the policy knobs that change the behavior. When
reality and this doc disagree, reality wins — update the doc.

Stage status legend: ✅ built · 🟡 partial · 📐 designed/tracked, not built

## The pipeline at a glance

```
issue → sync → triage → [design] → ready → dispatch → work → verify
       │                                                              │
       └────────── DoR gate ──────┘              DoD gate              ▼
                                                          review → PR → PR-eval → merge → close
                                                          (indep. harness)  (CI+rubrics) (automerge)
```

Groom (hygiene sweep) and watch (failure recovery) run *alongside* the
pipeline, not inside it — see "Alongside loops" below.

## Stage by stage

### 1. Issue intake — GitHub is the source of truth ✅

Work begins as a GitHub issue. `underwright github sync --repo owner/name`
(or the repo webhook) mirrors it onto the board as a `gh-<n>` task.
`create_task` is reserved for board-internal bookkeeping (reviews, probes).
An agent that discovers unfiled work files an issue first — the board is
coordination state, never a second backlog.

*Customize:* which repos feed a board (one board per repo today;
multi-board federation is gh-22/task-b7dac0d3). Webhook wiring:
`docs/webhook.md`.

### 2. Triage — DoR gate 🟡

Before a task can be claimed it must carry `type`, `estimate`, and
`ac_ids` — enforced at `claim_task` (policy `dor`: `require_type`,
`require_ac_ids`, `require_estimate`, `require_description`). Triage is
manual today (`update_task`); auto-triage on import plus a groom phase that
owns backlog hygiene is gh-84.

*Customize:* `policy.dor` toggles which fields the gate requires.

### 3. Design — pipeline-required for heavy work ✅

The lifecycle state machine (`policy.lifecycle`, `src/lifecycle.ts`) maps
SDLC phases onto task statuses with per-type `pipelines`. By default,
`architecture` requires a design artifact and any task estimated `L`
forces the design phase (`design_estimates`). Bugs require reproduction
evidence; docs skip verification entirely.

*Customize:* `policy.lifecycle.pipelines` per task type — add/remove
`design`, `review`, `verify`, `reproduction` requirements;
`design_estimates` controls which sizes force design.

### 4. Dispatch — who gets the work ✅

`policy.dispatcher` (`enabled`, `max_tasks_per_agent`, `idle_minutes`,
review rules) assigns tasks to agents on completion/release. Model-complexity
routing (`policy.model_routing`) maps task signals → light/standard/heavy
tier → concrete model per harness, passed via `omni --model` or harness
flags. `policy.watch` gates the budget (`max_inflight`,
`max_agent_jobs_per_day`, `budget_usd_per_day`) and fails seats over on
quota signatures (`codex_seats`).

*Customize:* `dispatcher`, `model_routing.rules/models`, `watch` budget +
seat fields, `harness_matrix` (which agent runs which backend; omnigent
coverage table decides `omni run` vs raw CLI).

#### Node execution — pull-through dispatch 📐 (gh-126)

Nodes are pullers, not push targets. The daemon's lifecycle on every host:

```
connect/re-auth session → attest capabilities (vendors, slots, quota state)
   → per-slot long-poll  POST /nodes/v1/poll { held_job_ids, wait:25s }
   → execute matched job → finish/renew → repeat
```

The poll handler runs the match — there is no separate producer daemon:

```
/nodes/v1/poll → 1. pre-queued job for this node? → return it
                 2. else eligible_tasks × node capability → form job → return
                 3. else long-poll wait, re-evaluate on wake
```

Eligibility is maintained by synchronous hooks (task→open, last blocker
done, quota transitions); the **match** runs at pull time against the
polling node's live state — attested vendors, free slot, per-harness quota,
node policy allowlist. The job spec emitted carries **task + vendor +
concrete model + prompt**, which is both the dispatch decision and the
usage-attribution key (gh-61). Match metadata explains starvation
("3 eligible, 2 need cline, 1 quota-exhausted") instead of returning empty.

Today only stages 1 and 3 exist — `submit_node_task`/`submit_job` are the
sole producers, so an empty queue stays empty (observed: reconnected node
with 8 slots pulling nothing while the board held 89 open tasks).

### 5. Work — claim, context, build ✅

The agent claims (lease, not flag — renews, expires, gets reclaimed),
calls `search_context` before building, coordinates through task artifacts,
and implements on a `feat/*` branch or worktree (AGENTS.md git hygiene).

*Customize:* lease lengths, `ownership.paths` scoping, node policies for
remote execution (workspaces/repositories/op kinds per node).

### 6. Verify — DoD evidence gate ✅

`complete_task` refuses without `report_evidence` citing every `ac_id`.
Policy `dod` defines required evidence kinds per type (`enforcement` mode
controls warn vs refuse).

*Customize:* `policy.dod` per-type evidence lists, `enforcement` level.

### 7. Review — independent harness 🟡

Completed work gets reviewed by a *different* harness family
(`policy.dispatcher.review`: `require_different_harness`,
`prefer_stronger`). Review tasks exist and the family-separation bug is
fixed (gh-68) — but spawning them on completion is manual today.
Auto-spawn as a pipeline stage: gh-90.

### 8. PR — agent raises the pull request ✅

The worker opens a PR on its feature branch (`gh pr create`), links it via
`pr-link` evidence, and the PR ⇄ review gate wires status back to the
task (gh-2). Clustering (one PR for N related tasks, one CI run) is gh-85.

### 9. PR evaluation — CI + rubrics 🟡

CI status rolls up onto the task via check suites (GitHub App evidence
packs). Rubric evaluation — per-type quality criteria scored against the
diff before merge — is designed but blocked today: gh-89 (supersedes
task-3507c835).

*Customize (when built):* `policy.rubrics` per type, same override pattern
as `lifecycle.pipelines`.

### 10. Merge — auto-merge gate ✅

`autoMergePR` merges a green PR when the repo opts in via
`policy.automerge` (per-repo bool/list/rule map), posting `automerge`
evidence. Conflict → `automerge_conflict` event, task stays open.
Target branch today is `main` (trunk-based flow — no `develop`).

*Customize:* `policy.automerge` per repo; rubric gate adds a second
condition when gh-89 lands.

### 11. Close & retro ✅

`github sync`/`github status` close the linked issue on done (with
evidence-gate comment), post status comments + digests
(`policy.github_status`: `status_comments`, `digest_hours`, `repo`).
`sdlc.retro`/`sdlc.grooming` run the ceremonies (`policy.sdlc`).

## Alongside loops (not pipeline stages)

| Loop | Cadence | Job |
|---|---|---|
| watch (`uw-watch.mjs`) | 10 min | failure classification → budget gate → produce agent jobs → GitHub mirror |
| sweeper (in `serve`) | 60 s | reclaim dead leases, reassign idle dispatch messages |
| daily (`uw-daily.mjs`) | 09:00 | inbox digest to human + build/validation jobs |
| groom (gh-84 📐) | cadence | triage, dedupe, stale reclamation, cluster proposals |
| monitor (task-b39fd401 📐) | cadence | blockage detection + graduated intervention |

## Runtime units

| Unit | Role |
|---|---|
| `underwright` | control plane: MCP `:8741/mcp`, board `:8741/board`, webhook, in-process sweeper, GitHub status loop |
| `underwright-runner` | pulls queued agent jobs, spawns `omni run`/raw CLI, renews lease, posts result |
| `underwright-node` | session → capability attest (60s) → heartbeat (15s) → per-slot long-poll `/nodes/v1/poll`; executes matched jobs |
| `underwright-watch.timer` / `underwright-daily.timer` | the alongside loops above |

## Customization reference — the whole policy surface

| Stage | Policy key | What it controls |
|---|---|---|
| Triage/DoR | `dor` | required fields before claimable |
| Design/verify | `lifecycle` | enabled, `design_estimates`, per-type `pipelines` |
| Completion/DoD | `dod` + `enforcement` | evidence kinds per type; warn vs refuse |
| Dispatch | `dispatcher` | enabled, agent caps, idle timeout, review independence |
| Model pick | `model_routing` | tier rules, tier→model per harness, flag per CLI |
| Harness pick | `harness_matrix` | agent→backend, omnigent coverage |
| Budget | `watch` | inflight cap, daily job cap, USD cap, codex seats, unblock rules |
| Merge | `automerge` | per-repo opt-in |
| Status mirror | `github_status` | issue comments, digest cadence |
| Ceremonies | `sdlc` | retro days, grooming interval/staleness |
| Rubrics 📐 | `rubrics` (gh-89) | per-type quality criteria at PR stage |
| Groom 📐 | `schedule[]` (gh-64/84) | declarative cadences |
| Nodes | node policy per device | op kinds, workspace_ids, repository_ids |

## Anti-patterns this flow assumes

- Never silently stop: blocked → `blocked` artifact + human message + release.
- No duplicate dispatch: producer checks live job per task; sweeper reclaims
  dead leases only.
- Human intervention clears skips: watch skip-list releases on `update_task` only.
- LLM only on judgment: classification/failover/dispatch are deterministic
  SQL+regex.

## Multi-repo convention

One board per repo (project), not per checkout. Multiple clones of the same
repo are fine for epic-level work segregation — each gets its own branch,
`workspace_id` in node-executors, and `cwd` in agent jobs — but they share
the project's single board and GH issue stream.
