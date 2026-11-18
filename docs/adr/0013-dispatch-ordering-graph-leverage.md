# ADR-0013: Dependency-graph leverage in dispatch ordering

Status: proposed · 2026-11-18 · tracks gh-175

## Context

A control plane's core economic function is *choosing what runs next*. The
fleet's ordering today is `priority ASC, updated_at ASC` — an issue's
declared importance plus first-in-first-out. Both inputs are static: neither
reflects the *system* value of finishing a task now, namely the work it
unblocks.

Two observations motivated this:

- **Fan-out is ignored.** `task_dependencies` edges exist, eligibility
  already gates on them (`blocked_deps`), and the reverse lookup (`blocks`)
  is implemented — but the count of tasks waiting on a blocker never
  influences where the blocker sits in the queue.
- **The real choke point wasn't per-task at all.** In Nov 2026 the board
  held ~150 completed tasks parked in `in_review` with no review task
  attached, plus a backlog of unmerged PRs. Work was *done* but not
  *delivered*: every merge gate, follow-on feature, and downstream deploy
  waited behind an unscheduled review queue. The highest-leverage item on
  the board was not any single task — it was a class.

## Decision

Order eligible tasks by a dispatch score:

```
score = priority_base + w1·direct_dependents + w2·transitive_dependents + age_boost
```

- `direct_dependents` — COUNT of `task_dependencies` rows this task blocks.
  A cheap join on the existing eligibility query; v1 ships with this alone.
- `transitive_dependents` — recursive CTE over the same table (SQLite and
  Postgres both support it; a few hundred tasks is trivial). Deferred until
  edge density justifies it.
- `age_boost` — retain `updated_at` aging so leaf tasks cannot starve under
  pure fan-out greed.
- **`type:review` boost** — a configurable score bonus. A review task
  unblocks delivery of its subject (via `review_of`) and everything
  downstream of the merge; the backlog evidence says the class gates the
  pipeline. The boost approximates that leverage without inventing edges.

All weights come from policy config, never literals.

## Edge population — the actual gating problem

Scoring only differentiates where edges exist, and most tasks have none.
The durable lever is *densifying the graph*:

- `review_of` already auto-sets `blocked_by` for code reviews.
- `cluster:` labels (Aura) encode intentional sequencing — the label→field
  sync mapping (gh-171) can infer edges.
- Issue cross-references ("depends on #N") and issue templates can seed
  edges at sync time.
- Meta-blockers (e.g. gh-172's MCP argument bug) block entire *classes* of
  tasks — not expressible as per-task edges; handled by priority or
  epic-level dependency edges later.

## Why

- **Leverage, not just importance.** An S-sized task blocking twenty others
  delivers more throughput per token than an L-sized leaf. Fan-out scoring
  is the scheduler's version of "finish what unblocks the most."
- **The graph is a knowledge asset.** Every `blocked_by` edge is a claim
  about the work's structure that outlives any single agent's context.
  Dispatch consumes it; triage and sync produce it.
- **Composes with the economics work.** Once gh-168 attributes cost per
  issue and gh-149 tracks quota windows, cost-fit becomes another score
  term: prefer the cheapest sufficient unlock when headroom is tight.
- **Review as delivery.** Treating reviews as high-leverage by default
  encodes the lesson that done ≠ delivered — the gate that failed silently
  in gh-167.

## Consequences

- v1 adds one join and policy weights to the eligibility query — no schema
  change; `blocked_by` semantics untouched.
- Ordering becomes score-dependent; ops need the score visible on the board
  (fold into gh-170's tabbed dashboard) or dispatch becomes opaque.
- Metric to collect for the case study: review-queue depth and
  "unlock count" distribution over time — the before/after evidence for
  whether leverage ordering measurably raises delivered throughput.
- Transitive scoring, critical-path length, and class-level edges are
  explicit follow-ons, gated on observed edge density.

## Alternatives considered

- **Pure priority + FIFO (status quo)** — simple and starvation-free, but
  blind to leverage; the review backlog demonstrates the failure mode.
- **Full critical-path scheduling** — computes the longest dependency chain
  per task; overkill while the graph is sparse, and unstable when edges
  are added mid-flight.
- **Human curation only** — triage-by-hand doesn't scale past ~30 open
  tasks and cannot react to the graph changing as work lands.
