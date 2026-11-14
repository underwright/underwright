# Board → GitHub status mirror

Humans can follow agent work on GitHub issues without opening the board
(issue #62, task-cfc5f333). There are two outputs:

- **Status comments.** When a linked task changes status, one comment goes on
  its issue, for example: `Board update: gh-57 moved open → claimed (by claude@minipc)`.
  When the task reaches **done**, the comment includes the evidence pack.
- **Digests.** A periodic summary on each open linked issue: the claim holder and
  lease, acceptance-criteria coverage, and the activity, evidence and artifacts
  since the last digest. Issues with no change since the last digest are skipped.

## Linking

A task mirrors an issue when one of these holds, checked in order:

1. `spec_ref` is a `https://github.com/<owner>/<repo>/issues/<n>` URL.
2. The task id is `gh-<n>` and a default repo is configured.
3. The title starts with `[#<n>]` and a default repo is configured.

## How it works

The `github_status` table stores the status last reported for each linked
task. Each pass compares that value with the live status and comments only on
a difference. Every mutation path is covered: claim, release, lease sweep,
complete and `setTaskStatus`. No store method calls GitHub.

- **First sighting.** The baseline is recorded and no comment is posted, so
  enabling the mirror does not flood old issues.
- **Echo suppression.** Changes made by `github-webhook`, `github-sync`,
  `github-pr-sync` or `github-adapter` already happened on GitHub. They update
  the baseline without a comment, so closing an issue does not echo back.
- **Failures.** The error and attempt count are recorded, and the baseline
  stays unchanged. The next pass retries with backoff of 1, 2, 4 … minutes,
  capped at one hour.
- **Rate cap.** A pass posts at most 20 comments. The rest wait for the next pass.
- **Audit.** Every mirror update is logged as `github_status/<task>` by `github-status`.

## Enabling

Add this to `underwright.policy.json` (it is off by default):

```json
"github": { "status_comments": true, "repo": "owner/name", "digest_hours": 24 }
```

- `serve --http` runs the mirror every minute when the GitHub App credentials
  (`UNDERWRIGHT_GITHUB_APP_ID` plus the private key, see `docs/webhook.md`) are
  exported. The poster looks up the installation per repo
  (`GET /repos/{repo}/installation`) and caches its token.
- From the CLI, a single pass uses the App when its credentials are set and the
  `gh` CLI otherwise:

```sh
underwright github status [--repo owner/name] [--dry-run]
underwright github digest [--repo owner/name] [--task ID] [--force] [--due] [--dry-run]
```

`digest` posts for every open linked task with activity. `--due` applies the
`digest_hours` cadence, and `--force` posts even when nothing changed.
`--dry-run` prints the comment bodies to stderr instead of posting them.
