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
