# Underwright PR review rubric

Consistent, rubric-driven review of open PRs and linked board tasks — notes
always, approve only when the bar is met, minor issues filed to the PR owner.
Modeled on `covasant/Aura`'s `.claude/commands/review-prs.md`; the
control-plane wiring lives in `underwright.policy.json` → `rubrics`.

## 0. Scope & eligibility

- Given a PR number, review only that PR; otherwise review every **eligible**
  open PR, oldest first.
- **Eligible = open, not a draft, not authored by the reviewing agent**, and
  targeting `main` (or its declared base). List with:
  `gh pr list --state open --draft=false --json number,title,author,isDraft,headRefName`
  and the current user with `gh api user --jq .login`.
- A board review task reviews the task's `spec_ref` (issue/PR), claimed only
  by an agent that did **not** implement it — `claim_task` enforces this.
- State each PR's number, title, and author before reviewing it.

## 1. Gather context

- Fetch the diff (`gh pr diff <n>`) and the linked task's evidence/artifacts —
  the review is against *delivered* work, not the diff alone.
- Prefer structural tools over raw file reads where available; fall back to
  Read/Grep for what they don't cover.

## 2. Rubric — evaluate each criterion explicitly (PASS / FAIL / N/A + one-line evidence)

1. **Aligned with underwright's architecture.** Control-plane conventions hold:
   all state mutations flow through `Store` methods with audit logging; new MCP
   tools are zod schemas delegating thinly to `Store`; ESM `.js` imports;
   durable state lands in the store backend, not process memory (stateless
   HTTP mode). FAIL on a mutation path that skips the audit log, business
   logic embedded in the HTTP/transport layer, or anything contradicting an
   ADR in `docs/adr/` — cite the specific doc when you FAIL.
2. **No inappropriate hardcoded values.** FAIL on hardcoded tokens, agent
   credentials, node/hostnames, DB paths, or ports as literals where
   configuration exists (`underwright.policy.json`,
   `~/.config/underwright/`, env vars). Named module-level constants and test
   fixtures are fine — do not flag those.
3. **Tests present and passing — verified, not assumed.** Tests covering the
   change must exist. **Actually run them** (`npx vitest run <file>` for the
   touched area) and quote the observed result. If the suite needs a live
   fleet/DB that isn't reachable, mark **UNVERIFIED** and say exactly why —
   UNVERIFIED counts as fail for approval; never claim "tests pass" without
   observed output.
4. **No serious issues.** Serious = correctness bug, security hole, a
   breaking change to the MCP tool or CLI contract, schema/enum drift (code
   writing a value a `CHECK` constraint rejects, or reading a column that
   isn't in every supported schema), or a data-loss/exec-safety pattern
   (unbounded buffers, shell-injection paths, deletes without dependent-row
   handling). Everything else is **minor**.
5. **Actually delivered.** The work exists on a pushed branch with an open PR
   linked to its issue — a local commit or a `done` board task is not
   delivery. FAIL if the claimed change isn't visible on the remote. (This
   criterion exists because a completed task once held only local commits the
   author couldn't push — the evidence gate missed it.)

## 3. Actions

- **Always** post a review whose body is the filled-in rubric (five criteria +
  verdict + evidence lines) so the decision is auditable — `gh pr review`
  on the PR, plus a `report_evidence kind=review` artifact on the linked task.
- **Approve** (`gh pr review <n> --approve`) **only if all five PASS**
  (criterion 3 must be *verified* PASS). Otherwise `--comment` with a clear
  "Approve blocked by: …" summary, or `--request-changes` for serious issues.
- **Minor issues** → one GitHub issue per trackable item, assigned to the PR
  author (`gh issue create --assignee <author> --label tech-debt`), deduped
  against existing issues; link them in the review body. Style nits stay as
  inline comments — no issues.
- Post a `blocked` artifact and release the task rather than approve something
  you could not verify.

## 4. Idempotency & summary

- Don't double-post: if your prior rubric review exists and the head commit is
  unchanged, skip re-reviewing.
- End with a table: PR # | author | verdict (Approved / Blocked / Skipped) |
  issues filed | one-line reason.
