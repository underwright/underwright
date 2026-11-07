# Executable helpers and playbooks

Agents should spend tokens on judgment, not re-deriving routine procedures.
`register_helper` used to store metadata only — every agent re-derived "how to
sync / merge / attach evidence / index" from scratch each session. Executable
helpers close that gap: a routine is registered once with a command template,
then any agent invokes it with `run_helper`.

## run_helper

```
run_helper(name, agent_id, task_id?, args?, sync?, timeout_ms?)
```

Resolution order:

1. **Built-in playbook** — the catalog below, shipped in code and seeded into
   the helpers table so `search_context` finds them.
2. **Registered executable helper** — a `helpers` row with
   `kind = 'executable'` and an `entry_point` command template, looked up by
   `symbol` then `path`. Register with `register_helper(..., kind: "executable",
   entry_point: "npm test -- {{filter}}")`.

The command template fills `{{placeholders}}` from `args` (plus `task_id` and
`agent_id`, always available). A leftover placeholder is an error naming the
missing argument — the template never half-renders.

Execution modes:

- **Job queue (default)** — renders the command and `submit_job`s it. Returns
  `{ mode: "job", status: "queued", job_id }`; a runner (`underwright run`)
  picks it up. Right mode for builds, tests, merges.
- **Sync (`sync: true`)** — executes in the server process with a hard timeout
  (per-playbook default, `timeout_ms` override, 600s max), returns
  `{ mode: "sync", status, exit_code, output, duration_ms }`. Right mode for
  fast, read-only routines. Only invoke helpers you trust: the command runs
  with the server's privileges.

Every invocation lands in `helper_runs` (helper, task, agent, mode, status,
command, result, duration) and the audit log — the raw data for
`helper_metrics` and gh-35 cost tracking.

## Built-in playbooks

Each replaces a procedure agents previously re-invented per prompt:

| Playbook | Command template | Required args |
|---|---|---|
| `github-sync` | `node dist/cli.js github sync --repo {{repo}} --prs` | `repo` |
| `merge-and-verify` | `git merge --no-edit {{branch}} && npm run build && npm test` | `branch` |
| `evidence-attach` | `node dist/cli.js evidence --task {{task_id}} --kind {{kind}} --file {{file}} --by {{agent_id}}` | `kind`, `file` |
| `index-refresh` | `node dist/cli.js index --root {{root}}` | `root` |
| `branch-worktree-setup` | `git worktree add {{path}} {{branch}}` | `path`, `branch` |

Example — attach a test log as evidence without re-deriving the CLI:

```json
run_helper("evidence-attach", "kimi@host", "gh-36",
           { kind: "test_run", file: "test-output.log" })
```

## helper_metrics

`helper_metrics(task_id?)` reports, per task and in aggregate:

- `helper_runs` — invocations recorded in `helper_runs`
- `agent_prompts` — agent-actor control-plane events on the task (human, CLI,
  and system actors excluded), the observable proxy for "an agent had to think
  through this routine"
- `tools_over_inference` — the ratio; as routines become executable it shifts
  toward `helper_runs`

This is the metric that proves the thesis: routine work moves out of prompts
and into tools. It feeds gh-35 cost tracking (tokens per routine before vs
after).

## The minimal launch prompt (prompt-shrink)

Once routines are executable, an agent needs no procedure in its prompt — only
identity, claim, and judgment. The minimal launch prompt:

> You are {{agent_id}} on {{host}}. Claim {{task_id}} and work it to done:
> search_context first, run_helper for routine work (github-sync,
> merge-and-verify, evidence-attach, index-refresh, branch-worktree-setup),
> report_evidence citing every ac_id, complete_task. Escalate only on genuine
> ambiguity: post_artifact kind=blocked, send_message the human, release_task,
> then read inbox.

Everything else — sync, merge, evidence, indexing, worktrees — is a tool call,
not prompt prose. Fleet launch prompts shrink from a page of procedure to a
claim plus judgment; `helper_metrics` measures the difference.
