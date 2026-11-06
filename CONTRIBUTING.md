# Contributing to underwright

Underwright is the control plane that agents and humans use to build this
repo. Both kinds of contributor follow the same engineering rules. Agents
have an extra coordination protocol, and that protocol is normative.

By contributing you agree that your work is licensed under the Apache
License 2.0 (`LICENSE`).

## Read this first

| Who | Start here |
|---|---|
| Anyone changing code or docs | This file, then `README.md` |
| Agents (any harness) | [`AGENTS.md`](AGENTS.md) — those rules are not suggestions |
| Someone connecting a harness to the shared board | [`docs/multi-harness.md`](docs/multi-harness.md) |
| Someone deploying the HTTP server | [`docs/tls-reverse-proxy.md`](docs/tls-reverse-proxy.md) |
| Someone reporting a vulnerability | [`SECURITY.md`](SECURITY.md) — not a public issue |

## People

1. Look for an existing issue, or open one with the templates in
   `.github/ISSUE_TEMPLATE/`. Name acceptance criteria with stable ids
   (`repro`, `fix`, …). Those ids are what the evidence gate checks.
2. Branch off `main`. Do not commit to `main`.
3. Keep the change scoped to the issue. Match the surrounding code.
4. Run the checks below before you open a pull request. Fill in
   `.github/PULL_REQUEST_TEMPLATE.md` and link the issue.
5. CI (`.github/workflows/ci.yml`) runs `npm ci`, build, dependency-cruiser,
   unit tests, the HTTP contract test, and `npm audit --audit-level=high`.
   A red check is not ready to merge.

## Agents

Read [`AGENTS.md`](AGENTS.md) and follow it on every session. The short
version, which does not replace that file:

1. Call `board` before editing. Pick up an open task or create one.
2. Triage until the task is claimable (type, acceptance-criterion ids,
   estimate), then `claim_task` with a stable `agent_id` of the form
   `<harness>@<host>` (for example `grok@alandesktop`). Renew the lease on
   long work. Release it if you stop.
3. Call `search_context` before adding a shared utility, pattern, or
   config. Reuse a helper that already exists. `register_helper` when you
   create one.
4. Coordinate through `post_artifact` on the task. Do not use a side channel
   as the record.
5. `complete_task` refuses until `report_evidence` cites every `ac_id`.
   Attach real command output. Then read `inbox` and work the board until idle:
   claim the task named in `your next task: <id>` and repeat until none arrives.
6. Put slow builds and test suites on `submit_job` instead of blocking the
   session on them.

Connect to the shared HTTP server. Do not start a second server against a
private `underwright.db`. The trap, the URL, and per-harness config are in
[`docs/multi-harness.md`](docs/multi-harness.md).

Never put `UNDERWRIGHT_TOKEN` or any other credential in a committed file,
an issue, a pull request, an artifact, or evidence output. See
[`SECURITY.md`](SECURITY.md).

## Development

Requirements: Node.js 18 or newer, npm, and a C toolchain for
`better-sqlite3`.

```bash
npm ci
npm run build          # tsc → dist/
npm test               # vitest
npm run test:contract  # MCP HTTP matrix against the compiled CLI
npm run depcruise      # cli → server → store → schema
```

`npm run test:contract` boots a scratch server. It does not use the shared
board database.

### Stack conventions

- TypeScript, ESM, `"module": "Node16"`. Relative imports use a `.js`
  extension.
- Schema lives in `src/schema.ts`. There is no parallel `.sql` source.
- Mutations go through `Store` methods, which write the audit log.
- A new MCP tool is a zod schema and `server.tool()` in `src/server.ts`
  that delegates to a `Store` method. HTTP mode is stateless: durable
  state goes in the store, not on the request.
- Task-type completion rules live in `underwright.policy.json`.

## Pull requests

- One issue (or one board task) per branch when the work is tracked.
- Say what changed, which acceptance criteria it covers, and how you
  tested it.
- Do not force-push `main`, and do not merge your own branch to `main`
  unless the repository's review gate says you may.
- Docs-only changes still go through a pull request so the security and
  contributing text stays reviewable.
