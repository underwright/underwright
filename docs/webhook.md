# GitHub webhook receiver

`underwright serve --http` accepts GitHub deliveries at `POST /github/webhook`
and applies them to the board. Stdio `underwright serve` does not expose this
path. The receiver replaces polling for the events below: a delivery updates
the linked task or appends evidence as soon as GitHub sends it.

## Secret

Set the HMAC secret in the server process environment:

| Variable | Role |
|---|---|
| `UNDERWRIGHT_GITHUB_WEBHOOK_SECRET` | Primary secret. Checked first. |
| `GITHUB_WEBHOOK_SECRET` | Fallback when the primary variable is unset or blank. |

The value is read on each request. Restart `underwright serve` after changing
it when the process manager only injects environment variables at start.
Use the same string in the GitHub webhook's **Secret** field.

When neither variable is set, the endpoint responds `503` and does not accept
the body. A missing or mismatched `X-Hub-Signature-256` responds `401`.
The signature is `sha256=` plus the hex HMAC-SHA256 of the **raw** request
body. This path authenticates with that HMAC secret. `/mcp` still requires
the bearer token when `UNDERWRIGHT_TOKEN` is set.

Bodies larger than 2 MB are rejected with `413`.

## GitHub App (recommended)

A GitHub App delivers the same events as a repository webhook. It covers every
repository you install it on, uses scoped permissions, and lets Underwright
post evidence packs back on pull requests.

Permissions requested by the manifest:

| Permission | Access | Why |
|---|---|---|
| Metadata | read | Required by GitHub for every app |
| Issues | write | Comment evidence packs (PR comments use the issues API) |
| Pull requests | write | Comment on pull requests |
| Checks | read | Receive `check_run` / `check_suite` |

Subscribed events: `issues`, `check_run`, `check_suite`, `pull_request_review`.

### One-click install

1. Run `underwright serve --http` behind HTTPS as described below. Set
   `UNDERWRIGHT_PUBLIC_URL=https://<your-host>` so the manifest points GitHub
   at the right URL. Without it, the request `Host` header and
   `X-Forwarded-Proto` are used.
2. Open `https://<your-host>/github/app/install` in a browser. For an
   organization-owned app, use `/github/app/install?org=<org>`. The page
   submits the app manifest to GitHub. Confirm the name and create the app.
3. GitHub redirects to `/github/app/callback`. That page shows the three
   lines to export. Nothing is stored on the server:

   ```bash
   export UNDERWRIGHT_GITHUB_APP_ID=123456
   export UNDERWRIGHT_GITHUB_WEBHOOK_SECRET='…'
   export UNDERWRIGHT_GITHUB_APP_PRIVATE_KEY='-----BEGIN RSA PRIVATE KEY-----\n…'
   ```

   You can save the PEM to a file and set
   `UNDERWRIGHT_GITHUB_APP_PRIVATE_KEY_FILE=/path/key.pem` instead.
   The callback page shows the private key once, so copy it before you close the page.
4. Restart `underwright serve --http` with those variables. Then follow the
   install link on the callback page to install the app on your repositories.

To create the app by hand, print the manifest with
`underwright github app-manifest --url https://<your-host>`.

### Evidence packs on pull requests

When app credentials are set, a `check_suite` delivery with action
`completed` that carries `installation.id` does two things. First it appends
`ci_check` evidence as usual. Then it comments the evidence pack of each
linked task on every pull request in the suite. Each comment adds a `posted`
effect to the response. A failed comment adds a `skipped` effect with the
GitHub error and does not fail the delivery. `installation` and
`installation_repositories` deliveries are acknowledged and ignored.

## Repository webhook setup

1. Run the control plane where GitHub can reach it, over HTTPS. See
   [tls-reverse-proxy.md](tls-reverse-proxy.md). Bind Underwright to loopback
   and forward `POST /github/webhook` through the proxy. Do not put the MCP
   bearer check in front of this path.
2. In the GitHub repository, open **Settings → Webhooks → Add webhook**.
3. **Payload URL**: `https://<your-host>/github/webhook`
4. **Content type**: `application/json`
5. **Secret**: the same value as `UNDERWRIGHT_GITHUB_WEBHOOK_SECRET`
6. Enable SSL verification when the proxy presents a certificate GitHub trusts.
7. Choose **Let me select individual events** and enable:
   - **Issues** (`issues`)
   - **Pull request reviews** (`pull_request_review`)
   - **Check runs** (`check_run`)
   - **Check suites** (`check_suite`)
8. Leave the webhook **Active** and save.

GitHub sends a `ping` when the webhook is created. A signed ping returns
`200` with `{"ok":true,"event":"ping"}`. Events outside the map return `200`
with `"ignored"` so GitHub does not retry them.

## What each event does

| GitHub event | Board effect |
|---|---|
| `check_run`, `check_suite` | Append `ci_check` evidence on every linked task. `success`, `neutral`, and `skipped` record exit code 0 and cite the task AC `checks-gate` when that task lists it. Failure-like conclusions (`failure`, `cancelled`, `timed_out`, `action_required`, `startup_failure`, `stale`) record exit code 1 and cite no acceptance criteria. A check with no linked task is ignored. No task is created. |
| `issues` (`opened`, `edited`, `closed`, `reopened`, `labeled`, `unlabeled`, and other edits) | Sync the linked task's title (`[#n] …`), description, and `spec_ref`. An open issue with no task creates `gh-<n>` (label `p0`–`p4` sets priority). A closed issue with no task is skipped. Closing an issue sets the task to `done`. `reopened` moves a `done` task back to `open`. |
| `pull_request_review` | Append `review` evidence. `agent_id` is `github:<login>`. `approved` and `commented` record exit code 0. `approved` cites the task AC `review` when that task lists it. `changes_requested` records exit code 1 and cites nothing. |

A task is linked, in order, by:

1. a `uw:<task-id>` marker in the issue or pull request body, when the payload includes the body
2. a task id in the head branch (`task-<hex>`, `gh-<n>`, or `pr-<n>`)
3. the conventional id `pr-<n>` for a pull request or `gh-<n>` for an issue
4. a task whose `spec_ref` is that issue or pull URL (`/issues/<n>` or `/pull/<n>`)

Issue sync stops at the first match (marker, then `gh-<n>`, then `spec_ref`).
Check and review deliveries attach evidence to every match.

Each delivery appends a new evidence row. The `X-GitHub-Delivery` id is stored
on the evidence command so retries are visible in the audit trail.

## Local check

```bash
export UNDERWRIGHT_GITHUB_WEBHOOK_SECRET="choose-a-long-secret"
underwright serve --http 127.0.0.1:8741
```

In another shell:

```bash
BODY='{"zen":"test"}'
SIG=$(node --input-type=module -e '
import { createHmac } from "node:crypto";
const body = process.argv[1];
process.stdout.write("sha256=" + createHmac("sha256", process.env.UNDERWRIGHT_GITHUB_WEBHOOK_SECRET).update(body).digest("hex"));
' "$BODY")
curl -sS -X POST "http://127.0.0.1:8741/github/webhook" \
  -H "Content-Type: application/json" \
  -H "X-GitHub-Event: ping" \
  -H "X-GitHub-Delivery: local-ping" \
  -H "X-Hub-Signature-256: $SIG" \
  --data-binary "$BODY"
```

A correct secret prints `{"ok":true,"event":"ping","zen":"test"}`.
