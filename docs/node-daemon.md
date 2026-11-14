# Node enrollment

Configure `UNDERWRIGHT_TOKEN` on the control plane and expose it through HTTPS.
Keep that administrator credential off enrolled machines.

On the machine to enroll:

```
underwright node enroll --url https://control.example --name desktop
```

Compare the displayed enrollment ID and code on that machine. An authenticated
administrator calls `list_node_enrollments` and `approve_node_enrollment` with
`enrollment_id`, `code`, and an explicit policy, for example:

```json
{"allowed_task_types":["run-script"],"workspace_ids":["demo"],"repository_ids":[]}
```

The code expires after ten minutes and can be approved once. Only the device
holding the locally generated proof can exchange it. The returned node credential
is stored outside the repository in `~/.local/state/underwright/node/credential.json`
(directory mode 0700, file mode 0600, atomic replacement). The daemon never uses
the administrator token. `underwright node status` shows identity and expiry
without printing credentials. Credentials expire after thirty days.

Use `reject_node_enrollment` to reject a pending request and `revoke_node` with
its `node_id` to invalidate all its credentials and sessions. A lost successful
exchange response cannot be recovered: revoke the approved node and enroll again.
Revoke and reenroll also provides explicit credential rotation.

HTTP development on a local or trusted tailnet endpoint requires the explicit
`--allow-insecure` flag; that choice is recorded in enrollment metadata. Do not
use it across an untrusted network. The client refuses credential-bearing URLs,
URL query strings and redirects.

Node credentials authorize only the dedicated `/nodes/v1` surface. They are
rejected on the global MCP and dashboard surfaces, including the dashboard query
parameter. Enrollment and all node administration fail closed when administrator
authentication is unconfigured. Enrollment/exchange rate limits are durable and
shared across server instances.

Tests always exercise SQLite. To run the concurrent Postgres enrollment contract,
set `UNDERWRIGHT_TEST_DATABASE_URL` to a dedicated test database before `npm test`.

## Operator runbook

### Before enrolling: check what already exists

`underwright node status` prints the stored credential's node_id and expiry.
If it shows a live credential, do **not** re-enroll — `underwright node run`
is all that is needed. Re-enrolling with an existing credential creates a
duplicate node row on the board; if a stray enrollment is created anyway,
reject it (`reject_node_enrollment`) or let its code expire rather than
approving it.

### Bring a node up

```
underwright node enroll --url http://<tailnet-ip>:8741 --name <name> --allow-insecure
# compare code printed → administrator approves within 10 minutes
underwright node config init --force --workspace=home=$HOME --workspace=underwright=$HOME/code/underwright
underwright node config set concurrency <N>
underwright node config set-auth <harness> ready            # per harness
underwright node config set-auth <h> ready --quota exhausted --resets "<ISO>"  # quota-capped seats
underwright node config validate
underwright node run --config ~/.config/underwright/node-executors.json
```

Prefer **tailnet addresses over LAN IPs** for `--url`: tailnet reachability
survives subnet changes, WSL2 NAT quirks, and network moves; a LAN IP that
worked at setup can silently stop routing later. For always-on, install the
user unit once the manual run is healthy (`underwright service install`).

### Recovery

| Symptom | Cause | Action |
|---|---|---|
| `node daemon already running` | Daemon healthy | Nothing — it is working |
| Offline for a while, comes back | Session expired | Nothing — the daemon re-authenticates in place (gh-110); heartbeats resume |
| `state: revoked` on the board | Credential invalidated | Revocation is terminal — re-enroll from scratch |
| Inactive/dead systemd unit | Restart limit hit or stopped | `systemctl --user reset-failed underwright-node && systemctl --user restart underwright-node` |
| `fetch failed` on enroll | Wrong/unreachable URL | Use the tailnet IP of the board host |

### Verify on the board

Node row shows `approved`, a live `session_expires_at`, fresh
`capabilities_observed_at`, `current_slots` vs `max_concurrency`, and the
expected harness list with `auth_status`/`quota` per seat.
