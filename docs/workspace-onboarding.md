# Workspace onboarding: the agent entry-point convention

Issue: [#164](https://github.com/underwright/underwright/issues/164).

Repos tend to scatter agent-facing standards across `docs/dev/`, `.github/`,
`.claude/commands/`, `.cursor/` and similar places. Dispatched agents read
`AGENTS.md`, as the launch prompt tells them to, and many stop there. A
standard or review gate that `AGENTS.md` does not point to is one most
harnesses never see.

## The convention

Every repo the control plane dispatches into (every workspace in
`dispatch.workspaces`) must follow these rules:

1. **Keep `AGENTS.md` at the repo root as the single entry point.** Other
   harness files (`CLAUDE.md`, `.cursor/rules`, `.github/copilot-instructions.md`)
   may exist, but they point back to `AGENTS.md`. They do not hold separate rules.
2. **Give `AGENTS.md` a `## Required reading (before coding)` section.** It
   lists every agent-facing standards doc by repo-relative path, with one line
   each on why it matters.
3. **Name the pre-PR review gate in that section.** Point to the rubric,
   checklist, or review matrix an agent must satisfy before it opens a PR,
   such as a PR template or a `docs/dev/review-matrix.md`.
4. **Mirror the list in the control plane.** `dispatch.required_reading` in
   `underwright.policy.json` maps a workspace_id, or `"*"` for every
   workspace, to the same paths. The dispatcher puts them into the launch
   prompt. A harness that only skims `AGENTS.md` still gets the list named in
   its first instruction.

```json
"dispatch": {
  "workspaces": { "owner/repo": "repo" },
  "required_reading": {
    "*": [],
    "repo": ["CONTRIBUTING.md", "docs/dev/standards.md", "docs/dev/review-matrix.md"]
  }
}
```

The launch prompt (`LAUNCH_PROMPT` in `src/dispatcher.ts`) always tells the
agent: *"Before coding, read AGENTS.md at the worktree root and follow its
required-reading list … read those docs too, not just AGENTS.md."* The
`{{required_reading}}` slot then adds the policy paths for that workspace.
Entries under `"*"` come first, then the workspace's own entries, with
duplicates removed. If a workspace has no entry, the slot renders as empty
text, and the AGENTS.md router instruction still applies.

## Onboarding checklist for a new workspace or repo

- [ ] The repo is mapped in `dispatch.workspaces` (`owner/name` → workspace_id),
      and the node policy's `workspace_ids` includes that workspace_id.
- [ ] `AGENTS.md` exists at the repo root. `underwright init` scaffolds one.
- [ ] `AGENTS.md` has a `## Required reading (before coding)` section that
      lists the repo's standards docs.
- [ ] That section names the pre-PR review gate (rubric, matrix, or PR template).
- [ ] Each harness-specific file (`CLAUDE.md`, `.cursor/`, `.claude/commands/`,
      `.github/copilot-instructions.md`) either points back to `AGENTS.md` or
      holds no rules of its own.
- [ ] `dispatch.required_reading.<workspace_id>` mirrors the AGENTS.md list.
- [ ] Every listed path exists on the default branch.
- [ ] A dispatched job's prompt (`node_spec.payload.prompt`) shows the list.

## Workspace audit (2026-11-18)

| Workspace | Repo | Entry point | Required-reading list | Review gate named | Action |
|---|---|---|---|---|---|
| underwright | underwright/underwright | `AGENTS.md` | Added in #164 | Yes: `.github/PULL_REQUEST_TEMPLATE.md` + `dod` | Done in #164 |
| kraftina | alandennis1024/kraftina | `AGENTS.md` (a project guide, not a router) | Missing. It only says design docs are in `docs/design/` | No | File an issue: add a Required-reading section and name the review gate. The policy currently lists `docs/design/` |
| omnigent | (not in `dispatch.workspaces`) | Not checked: no local checkout on the audit host | — | — | File an issue: audit and onboard with this checklist |
| aura slice(s) | covasant/Aura | Not checked: no local checkout. Issue covasant/Aura#5870 is the origin of this convention | — | — | File an issue: add Required reading routing to `docs/dev/` standards and the review matrix |

The per-repo issues from this audit are listed in the #164 task artifacts.
