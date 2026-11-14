# Remote node executors

Enroll using `underwright node enroll --url https://control.example --name desktop`.
Approve the code and a minimal operation/workspace/repository policy on the admin
board. Vendor login stays on the machine; enrollment never transfers vendor keys.

Run `underwright node run --config /absolute/path/node-executors.json` with a
user-owned local configuration. It names the only commands the node may execute:

```json
{
  "workspaces": {"project": "/home/user/code/project"},
  "repositories": {"project-origin": "https://example.org/team/project.git"},
  "harnesses": {"codex": {"executable": "codex", "args": ["exec"]}},
  "installers": {"codex": {"executable": "packaged-install-agents"}},
  "scripts": {"check": {"executable": "npm", "args": ["test"]}},
  "concurrency": 4,
  "timeoutMs": 600000
}
```

`concurrency` (gh-91) sets this node's worker slots: how many node jobs run in
parallel. It is clamped to the protocol maximum of 8 (a warning is logged when
clamped). The daemon attests it as `max_concurrency` and reports live
`current_slots` each capabilities tick; the server leases up to that many
running jobs per node and prefers nodes with free slots when routing. Each
slot polls with its own lease and journal — a running job is a child process,
so a crashed job kills only its own slot. Omit it (or use an operator
`inventory` object) and the node stays single-slot.

The packaged installer resolves relative to the installed module and runs the
reviewed `scripts/install-agents.sh install --agents ID --yes --no-open` resource.
It never runs an authentication action. `bash .../scripts/install-agents.sh list`
lists supported harness IDs without installing anything. Network installers are
only run when the administrator submits an explicitly approved install operation.

Launch payloads use `{workspace_id, harness, prompt, cwd?}`; script payloads use
`{workspace_id, script, args?, cwd?}`; provision uses
`{workspace_id, repository_id, dest}`; install uses `{harness}`.
The outer node spec's workspace must match the launch payload. Launches require
an explicit task and agent plus a fresh installed/auth-ready harness inventory.
Publish inventory with an operator-supplied probe when embedding `runNode`;
the default probe conservatively reports unknown readiness. For the CLI, an
operator can add an `inventory` object to the local config, for example
`{"harnesses":[{"id":"codex","installed":true,"auth_status":"ready","quota":{"state":"unknown"}}]}`.
Only attest readiness after local vendor verification; embedding callers should
use a live probe to observe changes. The daemon does not
infer vendor authentication by reading vendor credential files.

A launch reserves its task/agent while queued or running, even if the caller
changes idempotency keys or targets another node. Scripts and provisioning use
the existing explicit idempotency keys. Retries of uncertain side effects must
be deliberate administrator submissions with `retry_of`.

Children receive a small environment allowlist and, for agent launches only,
`UNDERWRIGHT_TOKEN` (a worker token), `UNDERWRIGHT_MCP_URL` (`/worker/mcp`),
and task/agent/job/attempt IDs. Configure the harness's HTTP MCP connection to
use that URL and bearer from its environment. Parent control-plane credentials
are excluded even if listed in `envAllow`. Local vendor auth remains available
through HOME or explicitly allowed vendor environment names.

The worker surface supports only task-local board/get_task/artifacts/evidence,
claim/renew/release/complete, and artifact/evidence writes. Other tasks, agents,
admin tools, global search, mail, jobs, and dispatcher assignment are unavailable.
Each invocation checks the durable node session and job attempt lease; completion
and release never assign another task to a worker.

Attempt receipts live under the private node state directory in `attempts/`.
They are fsynced before execution and before finish upload. Duplicate delivery
reuses a saved outcome. Interrupted attempts become uncertain and never replay;
Linux restart reconciliation kills a recorded process group only after checking
its kernel process start identity. Lease rejection, renewal failure, timeout,
and shutdown abort the group with TERM followed by KILL. Server leases mark
unacknowledged work `lease_lost/outcome_unknown`; this is not exactly-once
execution of arbitrary external side effects.

For a Linux user service, `underwright service install node --config
/absolute/path/node-executors.json` writes and enables the unit below (user
manager, lingering enabled). To install by hand instead, create
`~/.config/systemd/user/underwright-node.service`:

```ini
[Unit]
Description=Underwright node
After=network-online.target
[Service]
ExecStart=/absolute/path/to/underwright node run --config /absolute/path/node-executors.json
Restart=on-failure
RestartSec=5
KillMode=control-group
TimeoutStopSec=10
[Install]
WantedBy=default.target
```

Run `systemctl --user daemon-reload` then
`systemctl --user enable --now underwright-node`. Keep the config and node state
private. On other platforms use a supervisor that kills the whole process tree.
The fixture tests exercise harmless local children; they do not claim desktop
or production repository validation.
