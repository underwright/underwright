# Fleet-ops session in the Omnigent UI (gh-163)

Routine fleet operations (health checks, board status, log pulls, routine
maintenance) run as a session in the Omnigent UI at
<http://100.119.119.34:8000>, not only over SSH from a terminal. The session
runs the `fleet-ops` agent on an always-on omnigent host on minipc.

| Piece | File |
|---|---|
| Agent spec (prompt embeds the runbook) | `ops/fleet-ops/config.yaml` |
| Fleet runbook (source of truth) | `docs/ops/fleet-runbook.md` |
| Always-on host installer | `ops/install-ops-host.sh` |
| Restart policy drop-in | `ops/systemd/omnigent-host.service.d/10-always-on.conf` |
| Post-deploy validator | `scripts/validate-ops-session.py` |

## Install (on minipc, once)

```sh
cd ~/code/underwright
OMNIGENT_SERVER=http://100.119.119.34:8000 ops/install-ops-host.sh   # host daemon as a systemd user unit
omnigent agent add ops/fleet-ops/config.yaml                          # register / update the fleet-ops agent
```

`install-ops-host.sh` is safe to re-run. It turns on user lingering, so the unit
runs with no login session. It runs `omnigent host enable`, which writes
`~/.config/systemd/user/omnigent-host.service`. Then it installs the
`10-always-on.conf` drop-in. The generated unit uses `Restart=on-failure` with
`RestartPreventExitStatus=78 143`, so a clean exit or a stray SIGTERM would
leave the host down. The drop-in sets `Restart=always`, `RestartSec=10s` and
`StartLimitIntervalSec=0`. Only exit 78 (EX_CONFIG) stops the restarts, so a
broken config does not loop. An explicit `systemctl --user stop` still stops
the unit.

After you edit the spec or the runbook, run `omnigent agent add` again. The
validator's `spec-sync` case fails if the prompt's Hosts and Services tables
drift from the runbook.

## Using it

In the UI, start a new session, pick agent **fleet-ops** and host **minipc**,
and ask, for example: "fleet health check".

## Permissions

The ops session must run ssh, docker, systemctl, journalctl and git with no
per-call prompts. Three settings in `ops/fleet-ops/config.yaml` control this:

| Setting | Value | Effect |
|---|---|---|
| `os_env.type` | `caller_process` | Registers `sys_os_shell`, `sys_os_read`, `sys_os_write` and `sys_os_edit`. They run as the host user in the host's working directory. |
| `os_env.sandbox.type` | `none` | No sandbox, so real `ssh`, `docker`, `systemctl --user` and `journalctl` work. |
| `guardrails.policies.blast_radius` | `gate_pushes: true`, `risky_action: ASK` | The built-in blast-radius policy runs on every `tool_call` and returns ALLOW for everything except the commands below. |

Verdicts from that policy:

| Verdict | Commands |
|---|---|
| ALLOW (no prompt) | ssh, docker, systemctl, journalctl, curl, `git fetch/status/log/pull`, `underwright ...`, and everything else not listed below |
| ASK (approval card in the UI) | `git push`, `gh pr merge`, `gh release`, `gh repo delete`, `rm -rf <path>`, and kubectl, helm, terraform or databricks apply/deploy/destroy/delete |
| DENY | force-push, `rm -rf /`, `git reset --hard <remote>/<ref>` |

This is the omnigent counterpart of the grok `--yolo` plus MCP-permission work:
routine commands are pre-approved and outward-facing ones are not.
`gate_pushes` stays `true` because a human is watching an ops session and can
answer the rare ASK. Unattended workers use `gate_pushes: false` instead.

## Guardrails

- **Owner-only transcripts.** Ops transcripts expose infrastructure details.
  Omnigent sessions belong to their creator, and the UI sidebar and
  `GET /v1/sessions?visibility=mine` show them only to that creator. Do not
  share an ops session. The validator's `live-guardrails` case fails if the
  session has more than the owner's grant or is marked `shared_with_others`.
- **Named identity.** The agent is `fleet-ops`, which is distinct from the
  task-agent definitions, and it identifies itself as `ops@minipc`. Every reply
  that runs commands starts with an `ops@minipc:` line. Sessions created by
  the validator also carry the labels `underwright.agent_id=ops@minipc` and
  `underwright.role=ops`. The prompt forbids claiming, completing or reporting
  evidence on board tasks, so the identity never appears in the board's task
  ledger as a worker.
- **Secrets.** The prompt forbids printing tokens or the contents of
  `auth_tokens.json`.

## Not covered: plane-down recovery

When the omnigent server on alandesktop or the host on minipc is down, the ops
session is down too. Recover from a terminal. See the runbook.

## Post-deploy validation

Run this from any machine that has omnigent installed and is logged in to the
server (`omnigent login http://100.119.119.34:8000`):

```sh
~/.local/share/uv/tools/omnigent/bin/python -I scripts/validate-ops-session.py --live
```

Each case prints PASS or FAIL, and the script exits non-zero if any case fails.
Positive cases: spec-sync, agent-registered, policy-allow, host-online,
live-host-unit, live-cross-host and live-guardrails. Negative cases:
spec-drift-neg (a changed runbook row is caught), policy-gate-neg (push asks,
force-push and `rm -rf /` are denied) and auth-neg (no bearer token gets 401).
`--live` creates one session titled "fleet-ops: validation" through the same
`POST /v1/sessions` request the UI uses, and keeps it as the audit record.
Add `--cleanup` to delete it afterwards. Without `--live`, the script runs only
the offline and server checks and creates nothing.
