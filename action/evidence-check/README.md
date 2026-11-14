# underwright/evidence-check

GitHub Action that posts a CI result to an Underwright control plane as
`ci_check` or `smoke_test` evidence on the linked task. `complete_task` can then
cite real CI output for the task's acceptance criteria.

It has no dependencies (`node20`, raw JSON-RPC to the stateless `/mcp`
endpoint), so consumer repos need no `npm install`.

```yaml
- name: Report CI evidence
  if: always()                      # report failures too
  uses: underwright/underwright/action/evidence-check@v1
  with:
    url: ${{ secrets.UNDERWRIGHT_URL }}       # base URL or …/mcp
    token: ${{ secrets.UNDERWRIGHT_TOKEN }}
    kind: ci_check                            # or smoke_test
    ac-ids: build-green, tests-pass
    status: ${{ job.status }}
    output-file: test-output.txt              # optional
```

**Task resolution.** The action looks for the task in this order: the `task-id`
input, then `UNDERWRIGHT_TASK_ID`, then `uw:<task-id>` in the PR body, then a
branch name like `feat/task-1a2b` or `fix/gh-12`.

**Skipping.** If no URL or no task resolves, the step logs `skipped` and exits 0.
Forks and unconfigured repos stay green.

**Exit code.** `status: success` is recorded as exit 0 and anything else as 1.
`exit-code` overrides this.

**Output.** The recorded output starts with the run URL, workflow/job and sha.
It is clipped to the last 60k characters.

**Failures.** A failed post fails the step with an `::error` annotation. Set
`fail-on-error: "false"` to downgrade it to a warning. The token is masked in
messages.

**Step output.** `evidence-id` is the created evidence row id.
