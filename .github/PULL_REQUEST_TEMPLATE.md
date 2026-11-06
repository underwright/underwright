## Task

Board id and GitHub issue (for example `gh-26`, closes #26):

## Summary

## Acceptance criteria

Which `ac_id`s this pull request proves:

-

## Test plan

- [ ] `npm run build`
- [ ] `npm test`
- [ ] `npm run depcruise` (if imports or layering changed)
- [ ] `npm run test:contract` (if the MCP surface, store, or CLI changed)

Docs-only pull requests still say how the text was checked (links, paths,
commands).

## Agent checklist

Delete this section if a person opened the pull request.

- [ ] Read `AGENTS.md` and called `board` before editing
- [ ] Claimed the task as `<harness>@<host>` and held the lease
- [ ] Called `search_context` before adding a shared helper or config
- [ ] Posted the design or handoff with `post_artifact`
- [ ] `report_evidence` cites every `ac_id` on the task
- [ ] No token, database file, or other secret is in the diff
