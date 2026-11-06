# Security policy

## Reporting a vulnerability

Do not open a public GitHub issue for a suspected vulnerability, and do
not paste live tokens, database files, or exploit output into an issue,
pull request, commit, or Underwright artifact.

Report it privately through GitHub Security Advisories:

<https://github.com/underwright/underwright/security/advisories/new>

Include:

- What is affected (version, commit, or deployment shape)
- Impact (what an attacker gains, and what they must already have)
- Reproduction steps or a proof of concept, with secrets redacted
- Whether you have already published the details anywhere

This project is in early development. We will acknowledge the report,
confirm or reject it, and agree a fix and a disclosure window before
anything is made public. There is no paid bounty program.

If you are unsure whether something is a vulnerability, use the advisory
form anyway. A public issue is the wrong place to find out.

## Supported versions

| Version | Supported |
|---|---|
| `0.1.x` on the default branch | yes |
| Older commits and unpublished branches | no, unless a maintainer says otherwise |

Security fixes land on the default branch. There are no stable release
branches yet.

## `UNDERWRIGHT_TOKEN` and other secrets

The HTTP control plane treats `UNDERWRIGHT_TOKEN` as a bearer secret.
When it is set, `/mcp` requires `Authorization: Bearer <token>`. Anyone
who has the token can claim tasks, post artifacts, and attach evidence
on that board.

- Generate it with a CSPRNG (`openssl rand -hex 24` or better). Do not
  use a password or a short string.
- Pass it through the server environment and through each client's
  environment or a secret store. The committed `.mcp.json` is the local
  stdio config and must not contain a bearer token.
- Do not commit the token, echo it in logs, or copy it into issues,
  pull requests, artifacts, or evidence output. Redact it if a command
  trace would include the `Authorization` header.
- `/health` is unauthenticated on purpose so probes do not need the
  secret. It returns `{"ok":true}` and nothing else — no task data, no
  paths, no version. Do not "fix" a health check by attaching the bearer
  token to a world-readable monitor config.
- Bind the server to loopback or a private network (for example a
  Tailscale address). Do not publish `0.0.0.0:8741` on an untrusted
  network. TLS and reverse-proxy setup, including token rotation, is
  in [`docs/tls-reverse-proxy.md`](docs/tls-reverse-proxy.md). How
  harnesses should send the header is in
  [`docs/multi-harness.md`](docs/multi-harness.md).

Rotation does not drop board state. HTTP mode is stateless
([ADR-0001](docs/adr/0001-stateless-http-mcp.md)): replace
`UNDERWRIGHT_TOKEN`, restart the server, and update clients. Claims,
artifacts, evidence, and queued jobs stay in the store. After restart,
confirm the old token receives `401` and the new token can call `board`.

The same rules apply to GitHub tokens, database URLs, and anything else
that grants access. `underwright.db` is workspace state, not source.
Do not commit it.

## What we consider in scope

- Authentication and authorization on `/mcp`, including token leakage,
  token comparison, and missing checks
- Information disclosure from `/health`, errors, logs, or artifacts
- Store access across workspaces or across agents that should not see
  each other's claims
- Injection into shell-backed job execution (`submit_job` / `underwright run`)
- A dependency vulnerability that is exploitable through this project

Out of scope:

- A deployment that publishes the server contrary to
  [`docs/tls-reverse-proxy.md`](docs/tls-reverse-proxy.md)
- Issues that require a stolen token and add no further flaw
- Social engineering of maintainers

`npm audit --audit-level=high` runs in CI. Dependency advisories that
do not meet the bar above can be a normal issue.
