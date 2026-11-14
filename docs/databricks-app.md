# Underwright as a Databricks App

Underwright can run as a [Databricks App](https://docs.databricks.com/aws/en/dev-tools/databricks-apps/):
the App hosts `serve --http` (MCP at `/mcp` plus the dashboard), workspace
login replaces the shared dashboard token for people, and Lakebase Postgres is
the store. Tracking issue: gh-51.

## Files

| File | Purpose |
|---|---|
| `databricks.yml` | Asset bundle. Declares the `underwright` app, a `lakebase-url` secret resource, and a `lakebase` database resource. |
| `app.yaml` | App runtime. Runs `node dist/cli.js serve --http 0.0.0.0` with `UNDERWRIGHT_AUTH_MODE=databricks` and `DATABASE_URL` from `lakebase-url`. |

The Apps runtime runs `npm install` and `npm run build` before the command. A
bare host in `--http` listens on `DATABRICKS_APP_PORT`.

## Deploy

1. Create a Lakebase instance and a Postgres role for the app.
2. Store the connection string in a secret:
   ```sh
   databricks secrets create-scope underwright
   databricks secrets put-secret underwright database-url \
     --string-value 'postgres://ROLE:PASSWORD@INSTANCE_HOST:5432/databricks_postgres?sslmode=require'
   ```
3. Deploy and start the app:
   ```sh
   databricks bundle deploy -t dev --var lakebase_instance=<instance>
   databricks bundle run underwright -t dev
   ```

Short-lived OAuth credentials with connection rotation, instead of a static
role password, are tracked in task-a8a2eb41 (`lakebase-store`).

## Platform auth (`auth.mode = "databricks"`)

The Apps proxy authenticates every request against the workspace and passes
the user to the app as `X-Forwarded-Email`, `X-Forwarded-Preferred-Username`,
and `X-Forwarded-User`. In `databricks` mode:

- `/mcp` and dashboard routes (`/`, `/board`, `/task/*`, `/inbox/*`, `/chat/*`,
  ...) need a forwarded identity. With no identity they return 401. A user
  outside `auth.allowed_users` gets 403.
- A `Bearer $UNDERWRIGHT_TOKEN` header is still accepted as the machine path.
  `?token=` and the session cookie are not used.
- Node administration tools (`list_nodes`, `approve_node_enrollment`, ...)
  need the bearer token. A workspace user is not a node admin.
- `/health`, `/nodes/*`, `/worker/mcp`, and the GitHub webhook keep their own
  auth.

Turn the mode on with policy or env. The env value wins.

```json
{ "auth": { "mode": "databricks", "allowed_users": ["ada@example.com", "@example.com"] } }
```

```sh
UNDERWRIGHT_AUTH_MODE=databricks
```

`allowed_users` entries are exact emails or `@domain` suffixes, matched without
regard to case. An empty list lets in any authenticated workspace user. The
App's own permissions (`CAN_USE`) are the first gate.

**Only use this mode behind the Databricks Apps proxy.** The forwarded headers
are trusted as-is. On a server anyone can reach, a client can send any
`X-Forwarded-Email` it wants.

## Identity in the audit log

- **Dashboard.** The forwarded user is the actor for every action: task
  `created_by`, claims, artifacts, evidence, and message/chat `from`. Form fields
  cannot set another identity. The board shows "signed in as …".
- **MCP.** Tools keep the `agent_id` the agent passes, such as `claude@app`,
  because claims and leases depend on it. Each audit event written during the
  request also gets `data.principal = <forwarded user>`. Every agent action can
  then be traced to a workspace user.

The `X-Forwarded-Access-Token` header is never read or stored.
