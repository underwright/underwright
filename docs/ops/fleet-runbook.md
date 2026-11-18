# Fleet runbook

Setup, permissions and guardrails for the ops session: `docs/ops/ops-session.md`.

The source of truth for the hosts, services and paths the fleet-ops agent
(`ops/fleet-ops/config.yaml`) works across. The agent prompt embeds a copy of
the **Hosts** and **Services** tables. Edit both together. The
`scripts/validate-ops-session.py --check-spec` run fails if they drift apart.

## Hosts

| Host | Tailscale IP | Role | Reach it via |
|---|---|---|---|
| minipc | 100.120.201.70 | Underwright control plane (`underwright serve`, :8741). Persistent omnigent host for ops sessions. | local (the ops session runs here) |
| alandesktop | 100.119.119.34 | Omnigent server (UI + API, :8000). Agent node (grok, agy). | `ssh alandesktop` (needs minipc's key in `authorized_keys`) |
| yoga | 100.93.76.98 | Agent node | `ssh yoga` |
| alandennis (covasant-laptop-wsl2) | 100.100.250.70 | Agent node (WSL2, laptop, often offline) | `ssh alandennis` |

All fleet traffic stays on the tailnet (`tailb707d5.ts.net`). Nothing is exposed
publicly.

## Services

| Host | Unit / process | Scope | Health check |
|---|---|---|---|
| minipc | `underwright.service` (`underwright serve`, :8741) | user | `curl -s http://100.120.201.70:8741/health` → `{"ok":true}` |
| minipc | `omnigent.service` (omnigent host daemon, `_daemon_entry --local`) | user | `systemctl --user is-active omnigent.service` |
| every node | `underwright-node.service` | user | `systemctl --user is-active underwright-node.service` |
| alandesktop | omnigent server (:8000) | — | `curl -s http://100.119.119.34:8000/health` |

Node heartbeats: `underwright board` (or the `board` MCP tool) lists nodes and
their last heartbeat. A node that hasn't been seen for more than 2× the poll
interval is down. Check its `underwright-node.service` with
`journalctl --user -u underwright-node -n 100`.

## Paths

| What | Path |
|---|---|
| Underwright repo (minipc) | `~/code/underwright` |
| Node executor config | `~/.config/underwright/node-executors.json` |
| Node unit + drop-ins | `~/.config/systemd/user/underwright-node.service{,.d/}` |
| Omnigent state | `~/.omnigent/` (`config.yaml`, `auth_tokens.json`, `logs/host/`) |
| Omnigent host unit | `~/.config/systemd/user/omnigent.service` + `omnigent.service.d/10-always-on.conf` (`ops/install-ops-host.sh`). Do not also run `omnigent host enable` on minipc: it would add a second host daemon (`omnigent-host.service`). |

## Routine ops

- **Fleet health:** for each host, check its node unit, run `df -h /`, and
  check uptime. Then check plane `/health`, omnigent `/health` and node
  heartbeats on the board.
- **Logs:** `journalctl --user -u <unit> --since -1h --no-pager`.
  Omnigent host logs are in `~/.omnigent/logs/host/`.
- **Restart a node daemon:** `systemctl --user restart underwright-node`.
  Check it with `is-active` and the board heartbeat.
- **Update a repo checkout:** `git -C <path> fetch && git -C <path> status`.
  Pull only fast-forward (`git pull --ff-only`) and never force-push.

## Out of scope: plane-down recovery

When the omnigent server (alandesktop:8000) or the minipc host is down, the ops
session is down too: a session inside the plane dies with what it is
repairing. Recover from a terminal with SSH or the console on the affected
machine. Ops sessions are for routine work only, not self-surgery.
