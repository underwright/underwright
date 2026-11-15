# Model catalog refresh

Run `underwright models refresh` from the policy checkout. Use `--harness codex`
(or claude, kimi, grok, cursor, cmdc, devin) to limit discovery and `--policy FILE`
to choose another policy. Output contains added, removed and unassigned model IDs.
Devin is explicitly excluded because it delegates to `adaptive`.

Codex uses its authenticated CLI app-server `model/list` endpoint, including
pagination. Grok uses `grok models`, Cursor uses `agent --list-models`, and Command
Code uses its noninteractive `cmdc --list-models` flag. Claude uses Anthropic's
model API with `ANTHROPIC_API_KEY` (including pagination and Claude Code's
haiku/sonnet/opus family selectors); Kimi uses Moonshot's model API with
`KIMI_API_KEY`. API inventory reflects that API account's access, which can differ
from a subscription CLI account. Missing credentials, unsupported CLI formats and
partial catalogs are reported as failures, never as empty catalogs or removals.
Probes have a 20 second timeout. Credentials and CLI stderr are not published.

`--publish` posts a proposed routing review artifact through the shared HTTP MCP
server, then mails `human` when models need placement, configured models disappear,
or discovery fails. Set `UNDERWRIGHT_MCP_URL` and `UNDERWRIGHT_TOKEN`; optionally
use `--task gh-100`, `--agent-id model-catalog@HOST`, and `--recipient TRIAGE_ID`.
Each unassigned model gets a proposal with `tier: null`. A reviewer must choose its
tier. Before deleting any removed name, check queued and running jobs that refer
to it. The command never edits policy. Exit status 1 signals incomplete discovery;
the artifact is still posted when publishing was requested.

For a weekly scheduled pass, install `deploy/underwright-model-catalog.service`
and `.timer` in `~/.config/systemd/user/`. Adjust WorkingDirectory and ExecStart
with `systemctl --user edit underwright-model-catalog.service` for your checkout
and Node installation. Create a mode-600
`~/.config/underwright/model-catalog.env` containing the MCP URL, bearer token and
API keys. Include a PATH that finds Node and your harness executables. Then run
`systemctl --user daemon-reload` and
`systemctl --user enable --now underwright-model-catalog.timer`.
The persistent weekly timer catches up after downtime. Use
`systemctl --user start underwright-model-catalog.service` for an immediate pass
and `journalctl --user -u underwright-model-catalog.service` for failures.
The timer is opt-in; installing this code does not activate a host service.

The Anthropic pagination fields follow its [Models API reference](https://platform.claude.com/docs/en/api/typescript/models/list).
