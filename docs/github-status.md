# GitHub status reporting

Board reporting comments on linked issues when task status, claimant, or evidence
changes. Comments show the current claim, acceptance criteria still missing proof,
and the latest evidence summaries. Raw evidence output is not published.

The reporter uses the authenticated `gh` CLI on the control-plane host. Explicit
GitHub issue URLs take precedence; otherwise `gh-N` IDs or `[#N]` titles use the
configured repository. Cross-repository links and pull request links are skipped.

Enable one publisher per board in `underwright.policy.json`:

```json
{
  "github": {
    "repo": "owner/name",
    "status_comments": true,
    "digest_hours": 168
  }
}
```

The HTTP server checks every minute. Reporting is disabled by default. Digests
are independently enabled with positive `digest_hours`; zero disables digests.
Run only one configured reporting server/CLI publisher against a given board.
The server waits for active reporting work before closing its store.

Manual commands (use the authoritative board database, not a client-side copy):

```sh
underwright github status --repo owner/name --dry-run
underwright github status --repo owner/name
underwright github digest --repo owner/name --hours 168 --dry-run
underwright github digest --repo owner/name --force
```

The first pass silently records a baseline to avoid commenting on every old
issue. A forced digest can publish an initial summary immediately. Digests cover
unfinished tasks, including quiet issues, on the requested cadence. State and
cadence persist in SQLite/Postgres through audited Store methods. Dry runs do
not advance that state.

GitHub webhook/sync actors advance the baseline silently to avoid echoing an
issue change back into the same issue. Failures leave delivery pending and back
off from one minute to one hour. Each pass attempts at most 20 comments. Remote
comment markers prevent sequential retries from duplicating a comment when
GitHub accepted it before the local checkpoint was written.

Polling summarizes the latest state; transitions that begin and end between
passes may be coalesced. GitHub App credentials are not required: the reporter
uses the same `gh` authentication as the existing issue/PR adapters.
