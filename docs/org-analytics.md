# Org dashboard and agent analytics (premium design)

Status: design · 2026-11-09 · tracks [#31](https://github.com/underwright/underwright/issues/31)

This is a paid-tier feature (see [gtm.md](gtm.md): "Org dashboard and
analytics"). This document is the design only. Per the licensing rule in
gtm.md, the implementation goes in the private `underwright-pro` repository and
consumes this package. **Nothing in this repo changes to support it.**

The design covers three acceptance criteria:

| AC | Section |
|---|---|
| `metrics-model` | [Metrics model](#metrics-model) |
| `wireframe` | [Wireframe and key queries](#wireframe) |
| `boundary-check` | [Boundary check](#boundary-check) |

Every query below runs as-is against the OSS SQLite schema
([`src/schema.ts`](../src/schema.ts)). `test/org-analytics.test.ts` extracts
each `-- metric:` block from this file, seeds a workspace through the public
`Store` API, and executes the block over a **read-only** connection. If the
schema drifts away from this design, that test fails.

## Sources

The premium layer reads only things the OSS core already writes:

| Source | What it gives | Written by |
|---|---|---|
| `events` (audit log) | Every mutation as `entity_type, entity_id, action, actor, data, created_at`. `id` is monotonic per workspace. | `Store.log()` on every mutation |
| `tasks` | Current state, `type`, `estimate`, `ac_ids`, `review_of` | task tools |
| `evidence` | `kind`, `exit_code`, `ac_ids`, `output` per proof | `report_evidence` |
| `artifacts` | `kind` (`blocked`, `review`, `handoff`, …) | `post_artifact` |
| `jobs` | `started_at`, `finished_at`, `status`, `result_metadata` | job queue and node daemon |

The task-event actions the model uses are `created`, `claimed`, `released`,
`lease_expired` (actor `lease-sweeper`; the agent is in `data.agent_id`),
`completed`, `blocked`, `dispatched` (actor `dispatcher`; the agent is in
`data.agent_id`), `status:<status>`, `unblocked`, and `updated`. Artifact,
evidence, and job events add `artifact/*`, `evidence/reported`, and
`job/{submitted,started,done,failed}`.

**Timestamps.** `events.created_at` holds ISO-8601 strings, but older rows hold
SQLite `datetime('now')` text. Every query compares through `julianday()`,
which parses both formats.

**Agent identity.** Agent ids follow `harness@host` (AGENTS.md). The harness
rollup splits on the first `@`, so per-harness efficiency comes at no extra
cost.

## Metrics model

All metrics are computed per workspace and then tagged with a `workspace_id`
that the premium ingester assigns. They can then be summed across repos.
Every metric has a `:since` window parameter.

| Metric | Definition | Grain |
|---|---|---|
| `claims` | `claimed` events in which the agent took a task it did not already hold (a holder calling `claim_task` again re-logs `claimed`; those repeats are deduplicated. `renew_lease` logs nothing) | agent |
| `completed` | `completed` events by the agent | agent |
| `released` | voluntary `released` events | agent |
| `lease_expired` | `lease_expired` events with `data.agent_id` = agent | agent |
| `blocked` | `blocked` events (escalations recorded via a `blocked` artifact) | agent |
| `completion_rate` | `completed / (completed + released + lease_expired)` | agent, harness |
| `wall_clock_s` | from the agent's **first** claim after the task's previous terminal event (`completed` / `released` / `lease_expired`) to its `completed` | task × agent |
| `rework_rate` | completions followed by a later `status:open`, `status:claimed`, `status:in_review`, or `status:blocked` on the same task, divided by completions | agent |
| `evidence_pass_ratio` | share of the agent's evidence rows with `exit_code = 0` (rows with NULL exit codes are excluded) | agent |
| `ac_cited_ratio` | share of evidence rows that cite at least one `ac_id` | agent |
| `evidence_kinds` | distinct evidence kinds the agent used (diversity of proof) | agent |
| `coverage_reports` | evidence rows of kind `coverage` | agent |
| `evidence_per_completion` | evidence rows on tasks the agent completed, divided by those completions | agent |
| `job_runtime_s` | `finished_at − started_at` for `jobs` the agent submitted, accurate to ±1 s because the SQLite store writes `finished_at` at second precision | job |
| `inference_ms` | `jobs.result_metadata.inference_ms` **when a node executor reports it**, otherwise NULL | job |

### Wall-clock vs inference time

Wall-clock time is fully derivable from the audit log (`wall_clock_s`).
**Inference time is not.** The control plane never sees model calls. The
model handles this as follows:

- `jobs.result_metadata` is an existing public column: a free-form JSON object
  of at most 4 KB, accepted from node daemons by `node-protocol.ts`. If an
  executor reports `inference_ms` or token counts there, the premium layer
  reads them. If no executor does, the dashboard shows "n/a". It does not
  estimate a value.
- Harness-native telemetry (for example, session transcripts) can be ingested
  by the premium layer directly from the harness. That path is outside the
  OSS core and needs no hook in it.

No new instrumentation goes into the OSS core for this feature.

## Wireframe

```
┌ Org: acme ───────────── window: [7d ▾]  workspaces: [all ▾]  harness: [all ▾] ┐
│ ┌ Throughput ──────────┐ ┌ Completion ───────┐ ┌ Rework ─────┐ ┌ Evidence ───┐ │
│ │ 142 done  ▁▃▅▇▆▅▇    │ │ 81%  (done/claims)│ │ 6.3%        │ │ 92% pass    │ │
│ └──────────────────────┘ └───────────────────┘ └─────────────┘ └─────────────┘ │
│ Cross-repo board                                                               │
│ ┌ workspace ─┬ open ┬ claimed ┬ in_review ┬ blocked ┬ done(7d) ┬ oldest open ┐ │
│ │ api        │  12  │    4    │     2     │    1    │    38    │  3d         │ │
│ │ web        │   7  │    3    │     0     │    0    │    51    │  1d         │ │
│ └────────────┴──────┴─────────┴───────────┴─────────┴──────────┴─────────────┘ │
│ Agents                                         (click row → agent drill-down)  │
│ ┌ agent ─────────┬ harness ┬ done ┬ compl% ┬ rework ┬ p50 wall ┬ pass ┬ AC% ─┐ │
│ │ claude@minipc  │ claude  │  31  │  94%   │  3%    │  41m     │ 96%  │ 100% │ │
│ │ codex@laptop-2 │ codex   │  22  │  79%   │  9%    │  58m     │ 88%  │  91% │ │
│ └────────────────┴─────────┴──────┴────────┴────────┴──────────┴──────┴──────┘ │
│ Audit browser                                                                  │
│ [entity ▾] [actor ____] [action ▾] [from ─ to]                    [export CSV] │
│ #8812 14:02 task gh-31 completed   claude@minipc  {"dod":[]}                   │
│ #8811 14:01 evidence ev-… reported claude@minipc  {"kind":"test_run",…}        │
│                                                          [◀ newer] [older ▶]   │
└────────────────────────────────────────────────────────────────────────────────┘
```

Agent drill-down: a timeline of the agent's tasks showing claim→complete bars
(`wall_clock_s`), evidence rows with their exit codes, `blocked` artifacts, and
the agent's audit trail. The OSS `agentEvents()` query already produces this
trail.

Ingest: each workspace is read incrementally by `events.id > :cursor`, so the
ingester never rescans the log. The cross-repo board is the OSS `board`
result, or `SELECT status, COUNT(*) FROM tasks GROUP BY status`, per workspace.

### Key queries

These are written in SQLite dialect. The Postgres store (`pstore.ts`) has the
same tables; on Postgres, use `data->>'agent_id'` in place of `json_extract`
and epoch arithmetic in place of `julianday`.

```sql
-- metric: agent_activity
WITH ev AS (
  SELECT e.*,
         CASE WHEN e.action IN ('lease_expired','dispatched')
              THEN json_extract(e.data, '$.agent_id') ELSE e.actor END AS agent_id
  FROM events e
  WHERE e.entity_type = 'task' AND julianday(e.created_at) >= julianday(:since)
),
fresh_claims AS (
  -- a claim is fresh unless the same agent already held the task (lease renewal)
  SELECT c.* FROM ev c
  WHERE c.action = 'claimed' AND NOT EXISTS (
    SELECT 1 FROM ev p
    WHERE p.id = (SELECT MAX(q.id) FROM ev q
                  WHERE q.entity_id = c.entity_id AND q.id < c.id
                    AND q.action IN ('claimed','completed','released','lease_expired'))
      AND p.action = 'claimed' AND p.agent_id = c.agent_id)
)
SELECT a.agent_id,
       substr(a.agent_id, 1, instr(a.agent_id || '@', '@') - 1) AS harness,
       (SELECT COUNT(*) FROM fresh_claims f WHERE f.agent_id = a.agent_id) AS claims,
       SUM(a.action = 'completed')     AS completed,
       SUM(a.action = 'released')      AS released,
       SUM(a.action = 'lease_expired') AS lease_expired,
       SUM(a.action = 'blocked')       AS blocked,
       ROUND(1.0 * SUM(a.action = 'completed')
             / NULLIF(SUM(a.action IN ('completed','released','lease_expired')), 0), 3) AS completion_rate
FROM ev a
WHERE a.agent_id NOT IN ('dispatcher','lease-sweeper','sync','github-sync')
GROUP BY a.agent_id
ORDER BY completed DESC;
```

```sql
-- metric: task_wall_clock
SELECT c.entity_id AS task_id, c.actor AS agent_id,
       ROUND((julianday(c.created_at) - julianday((
         SELECT k.created_at FROM events k
         WHERE k.entity_type = 'task' AND k.entity_id = c.entity_id
           AND k.action = 'claimed' AND k.actor = c.actor AND k.id < c.id
           AND k.id > COALESCE((
             SELECT MAX(p.id) FROM events p
             WHERE p.entity_type = 'task' AND p.entity_id = c.entity_id AND p.id < c.id
               AND p.action IN ('completed','released','lease_expired')), 0)
         ORDER BY k.id ASC LIMIT 1))) * 86400, 1) AS wall_clock_s
FROM events c
WHERE c.entity_type = 'task' AND c.action = 'completed'
  AND julianday(c.created_at) >= julianday(:since)
ORDER BY c.id;
```

```sql
-- metric: agent_rework
SELECT c.actor AS agent_id,
       COUNT(*) AS completed,
       SUM(EXISTS (
         SELECT 1 FROM events r
         WHERE r.entity_type = 'task' AND r.entity_id = c.entity_id AND r.id > c.id
           AND r.action IN ('status:open','status:claimed','status:in_review','status:blocked')
       )) AS reworked,
       ROUND(1.0 * SUM(EXISTS (
         SELECT 1 FROM events r
         WHERE r.entity_type = 'task' AND r.entity_id = c.entity_id AND r.id > c.id
           AND r.action IN ('status:open','status:claimed','status:in_review','status:blocked')
       )) / COUNT(*), 3) AS rework_rate
FROM events c
WHERE c.entity_type = 'task' AND c.action = 'completed'
  AND julianday(c.created_at) >= julianday(:since)
GROUP BY c.actor;
```

```sql
-- metric: agent_evidence_quality
SELECT e.agent_id,
       COUNT(*)                                AS evidence_rows,
       ROUND(AVG(e.exit_code = 0), 3)          AS evidence_pass_ratio,
       ROUND(AVG(e.ac_ids <> '[]'), 3)         AS ac_cited_ratio,
       COUNT(DISTINCT e.kind)                  AS evidence_kinds,
       SUM(e.kind = 'coverage')                AS coverage_reports,
       ROUND(1.0 * SUM(e.task_id IN (
         SELECT c.entity_id FROM events c
         WHERE c.entity_type = 'task' AND c.action = 'completed' AND c.actor = e.agent_id))
         / NULLIF((SELECT COUNT(DISTINCT c.entity_id) FROM events c
                   WHERE c.entity_type = 'task' AND c.action = 'completed' AND c.actor = e.agent_id), 0), 2)
                                               AS evidence_per_completion
FROM evidence e
WHERE julianday(e.created_at) >= julianday(:since)
GROUP BY e.agent_id;
```

```sql
-- metric: job_runtime
SELECT j.agent_id, j.type, j.status,
       -- SqliteStore writes finished_at at 1 s precision (datetime('now')) but started_at
       -- as ISO with ms, so clamp: runtime is accurate to ±1 s.
       MAX(0, ROUND((julianday(j.finished_at) - julianday(j.started_at)) * 86400, 1)) AS job_runtime_s,
       json_extract(j.result_metadata, '$.inference_ms')                    AS inference_ms
FROM jobs j
WHERE j.finished_at IS NOT NULL AND julianday(j.created_at) >= julianday(:since);
```

```sql
-- metric: board_by_status
SELECT status, COUNT(*) AS n FROM tasks GROUP BY status;
```

```sql
-- metric: audit_page
SELECT id, created_at, entity_type, entity_id, action, actor, data
FROM events
WHERE (:entity_type IS NULL OR entity_type = :entity_type)
  AND (:actor IS NULL OR actor = :actor)
  AND (:action IS NULL OR action = :action)
  AND julianday(created_at) >= julianday(:since)
  AND id < :before_id
ORDER BY id DESC
LIMIT 100;
```

Paging with `id < :before_id` (keyset) stays fast on large logs, where
`OFFSET` paging slows down. Ingest uses the same pattern with `id > :cursor`.

## Boundary check

Result: **nothing in this design needs a private hook in OSS code.**

| Need | How the premium layer meets it | OSS change? |
|---|---|---|
| Event stream | Reads the `events` table (schema is public, append-only, id-ordered) | none |
| Evidence quality | Reads the `evidence` table | none |
| Wall-clock time | Derived from `claimed`/`completed` event timestamps | none |
| Inference time | `jobs.result_metadata` (existing column) or harness-side ingest | none |
| Cross-repo | One read connection (or MCP client) per workspace, plus a `workspace_id` assigned at ingest | none |
| Harness rollup | `harness@host` agent id convention | none |
| Hosted Team tier | The hosted plane owns each workspace DB, so it reads directly | none |
| Self-hosted Enterprise | Read-only DB credentials (`?mode=ro` on SQLite, a read-only role on Postgres) | none |

The test enforces the read-only claim: it opens the database with
`readonly: true` and runs every query. A query that wrote anything would fail.

API-only consumers: the MCP `audit_log` tool takes `after_id` (oldest first,
for an incremental ingest cursor) and `before_id` (for browsing older events).
An API-only ingester can therefore follow the log without database access.
This is a generic OSS feature, useful for scripts and digest tooling, and was
added on its own merits (task-c090a10c). It is not a premium hook.
