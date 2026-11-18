#!/usr/bin/env -S python3 -I
"""Post-deploy validation for gh-163: fleet-ops session in the Omnigent UI.

Run it with omnigent's own interpreter, which provides omnigent_client and
the stored login token:

    ~/.local/share/uv/tools/omnigent/bin/python -I scripts/validate-ops-session.py          # offline + server checks
    ~/.local/share/uv/tools/omnigent/bin/python -I scripts/validate-ops-session.py --live   # + a real cross-host ops session on minipc

Each case prints PASS/FAIL. The exit code is non-zero if any case fails.
--live creates one session titled "fleet-ops: validation" on the ops host. It
is the same POST /v1/sessions request the UI's new-session button makes. The
session is kept as the audit record. Pass --cleanup to delete it afterwards.

Cases (ac_id in brackets):
  spec-sync          [ops-spec]     the prompt's Hosts/Services tables match docs/ops/fleet-runbook.md
  spec-drift-neg     [ops-spec]     a changed runbook row is flagged as drift (negative)
  agent-registered   [ops-spec]     fleet-ops is installed on the server with the claude-sdk harness
  policy-allow       [permissions]  ssh/docker/systemctl/journalctl/git status pass with no prompt
  policy-gate-neg    [permissions]  git push asks, force-push and rm -rf / are denied (negative)
  auth-neg           [guardrails]   session listing without a bearer token is rejected (negative)
  host-online        [host-daemon]  the ops host is registered and online
  live-host-unit     [host-daemon]  omnigent-host.service is active and enabled, Restart=always, linger on (--live)
  live-cross-host    [verified]     the session reaches minipc, alandesktop and yoga with no approval prompts (--live)
  live-guardrails    [guardrails]   the session is owner-only and not shared, and carries the ops@minipc identity (--live)
"""
from __future__ import annotations

import argparse
import asyncio
import json
import re
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
SPEC = REPO / "ops" / "fleet-ops" / "config.yaml"
RUNBOOK = REPO / "docs" / "ops" / "fleet-runbook.md"
OPS_IDENTITY = "ops@minipc"
FLEET = ("minipc", "alandesktop", "yoga")

results: list[tuple[str, bool, str]] = []


def case(name: str, ok: bool, detail: str = "") -> None:
    results.append((name, ok, detail))
    print(f"{'PASS' if ok else 'FAIL'}  {name}" + (f"  — {detail}" if detail else ""), flush=True)


# ---------------------------------------------------------------- spec checks
def table_rows(text: str, heading: str) -> list[str]:
    """Rows of the markdown table under a heading that starts with `heading`."""
    lines = [ln.strip() for ln in text.splitlines()]
    try:
        start = next(i for i, ln in enumerate(lines) if ln.lstrip("# ").startswith(heading) and ln.startswith("#"))
    except StopIteration:
        return []
    rows: list[str] = []
    for ln in lines[start + 1:]:
        if ln.startswith("|"):
            rows.append(ln)
        elif rows:
            break
    return rows


def spec_drift(runbook: str, prompt: str) -> list[str]:
    drift = []
    for heading in ("Hosts", "Services"):
        a, b = table_rows(runbook, heading), table_rows(prompt, heading)
        if not a:
            drift.append(f"runbook has no {heading} table")
        elif a != b:
            drift.append(f"{heading} table differs ({len(a)} vs {len(b)} rows)")
    return drift


def check_spec() -> dict:
    import yaml  # bundled with omnigent

    spec = yaml.safe_load(SPEC.read_text())
    runbook = RUNBOOK.read_text()
    drift = spec_drift(runbook, spec["prompt"])
    case("spec-sync", not drift, "; ".join(drift) or "Hosts + Services tables identical")
    mutated = runbook.replace("100.93.76.98", "100.93.76.99", 1)
    case("spec-drift-neg", bool(spec_drift(mutated, spec["prompt"])), "edited runbook IP detected as drift")
    return spec


def check_policy(spec: dict) -> None:
    import importlib

    fn = spec["guardrails"]["policies"]["blast_radius"]["function"]
    module, _, attr = fn["path"].rpartition(".")
    # Load the exact factory the spec names, with the spec's arguments.
    evaluate = getattr(importlib.import_module(module), attr)(**fn["arguments"])

    def verdict(cmd: str) -> str:
        event = {"type": "tool_call", "data": {"name": "sys_os_shell", "arguments": {"command": cmd}}}
        d = evaluate(event, {})
        return str(d.get("decision") or d.get("action") or d.get("result") or d).upper()

    allow = ["ssh yoga systemctl --user is-active underwright-node.service", "docker ps",
             "systemctl --user restart underwright-node", "journalctl --user -u omnigent-host -n 50",
             "git -C ~/code/underwright status"]
    got = {c: verdict(c) for c in allow}
    bad = {c: v for c, v in got.items() if "ALLOW" not in v}
    case("policy-allow", not bad, f"{len(allow)} ops commands ALLOW" if not bad else f"not allowed: {bad}")
    gated = {"git push origin main": "ASK", "git push --force origin main": "DENY", "rm -rf /": "DENY"}
    got = {c: verdict(c) for c in gated}
    bad = {c: got[c] for c, want in gated.items() if want not in got[c]}
    case("policy-gate-neg", not bad, "push→ASK, force-push/rm -rf /→DENY" if not bad else f"wrong verdicts: {bad}")


# -------------------------------------------------------------- server checks
def http_json(url: str, token: str | None) -> tuple[int, dict]:
    req = urllib.request.Request(url, headers={"Authorization": f"Bearer {token}"} if token else {})
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            return r.status, json.load(r)
    except urllib.error.HTTPError as e:
        return e.code, {}


def check_server(server: str, token: str, host_name: str) -> dict | None:
    code, _ = http_json(f"{server}/v1/sessions?visibility=mine&limit=1", None)
    case("auth-neg", code in (401, 403), f"unauthenticated GET /v1/sessions → {code}")
    _, agents = http_json(f"{server}/v1/agents?scope=user&limit=100", token)
    ops = [a for a in agents.get("data", []) if a.get("name") == "fleet-ops"]
    case("agent-registered", bool(ops) and ops[0].get("harness") == "claude-sdk",
         f"id={ops[0]['id']} harness={ops[0].get('harness')}" if ops else "fleet-ops not installed: omnigent agent add ops/fleet-ops/config.yaml")
    _, hosts = http_json(f"{server}/v1/hosts", token)
    host = next((h for h in hosts.get("hosts", []) if h.get("name") == host_name), None)
    case("host-online", bool(host) and host.get("status") == "online",
         f"{host_name} {host.get('status') if host else 'not registered'}")
    return host


# ---------------------------------------------------------------- live checks
LIVE_PROMPT = f"""Fleet health check (validation run). Use sys_os_shell for everything.
1. On minipc (local): hostname; systemctl --user is-active omnigent-host.service;
   systemctl --user show omnigent-host.service -p Restart -p UnitFileState;
   loginctl show-user $USER -p Linger; systemctl --user is-active underwright-node.service;
   curl -s http://100.120.201.70:8741/health
2. For alandesktop and yoga, via ssh -o BatchMode=yes -o ConnectTimeout=8 <host>:
   hostname; systemctl --user is-active underwright-node.service; uptime
3. Node heartbeats: on each host also run `underwright node status` and note the last heartbeat.
End your reply with exactly one line per host, in this format and nothing after it:
OPS-CHECK host=<minipc|alandesktop|yoga> reachable=<yes|no> node=<is-active output> heartbeat=<value or none>"""


async def live(server: str, token: str, host: dict, cleanup: bool, timeout_s: int) -> None:
    from omnigent_client import OmnigentClient

    async with OmnigentClient(server, headers={"Authorization": f"Bearer {token}"}, timeout=60) as c:
        agent = await c.sessions.resolve_agent("fleet-ops")
        s = await c.sessions.create_from_agent_id(
            agent.id, title="fleet-ops: validation", workspace="/home/alan", host_id=host["host_id"],
            labels={"underwright.agent_id": OPS_IDENTITY, "underwright.role": "ops"})
        print(f"      session {s.id}  ({server}/sessions/{s.id})", flush=True)
        await c.sessions.post_event(s.id, {"type": "message", "data": {"role": "user", "content": [{"type": "input_text", "text": LIVE_PROMPT}]}})
        deadline, prompts_seen, status = time.time() + timeout_s, 0, "?"
        await asyncio.sleep(15)
        while time.time() < deadline:
            snap = await c.sessions.get(s.id)
            raw = await c.sessions.list_items(s.id, limit=100)
            status = snap.status
            if status in ("idle", "completed", "failed", "error"):
                break
            await asyncio.sleep(10)
        _, row = http_json(f"{server}/v1/sessions/{s.id}", token)
        prompts_seen = int(row.get("pending_elicitations_count") or 0)
        items = [i if isinstance(i, dict) else getattr(i, "__dict__", {}) for i in (await c.sessions.list_items(s.id, limit=200)).data]
        tool_out = "\n".join(str(i.get("output", "")) for i in items if i.get("type") == "function_call_output")
        final = "\n".join(p.get("text", "") for i in items if i.get("type") == "message" and i.get("role") == "assistant" for p in i.get("content", []))
        checks = {m.group(1): m.group(0) for m in re.finditer(r"OPS-CHECK host=(\w+) reachable=yes\b.*", final)}

        unit_ok = all(x in tool_out for x in ("Restart=always", "UnitFileState=enabled", "Linger=yes")) and re.search(r"\bactive\b", tool_out)
        case("live-host-unit", bool(unit_ok), "omnigent-host.service active+enabled, Restart=always, Linger=yes" if unit_ok else "see session transcript")
        missing = [h for h in FLEET if h not in checks]
        # The shell output proves the commands ran; the agent's summary line alone is not enough.
        proof = all(re.search(h, tool_out, re.I) for h in FLEET)
        ok = status == "idle" and not missing and proof and prompts_seen == 0
        case("live-cross-host", ok, f"status={status} reached={sorted(checks)} missing={missing} shell-proof={proof} pending_prompts={prompts_seen}")
        if ok:
            for h in FLEET:
                print(f"      {checks[h]}")

        _, perms = http_json(f"{server}/v1/sessions/{s.id}/permissions", token)
        _, mine = http_json(f"{server}/v1/sessions?visibility=mine&limit=50", token)
        in_mine = any(x["id"] == s.id for x in mine.get("data", []))
        mine_row = next((x for x in mine.get("data", []) if x["id"] == s.id), {})
        grants = perms.get("data", perms.get("permissions", []))
        shared = bool(mine_row.get("shared_with_others")) or len(grants) > 1
        labelled = (mine_row.get("labels") or {}).get("underwright.agent_id") == OPS_IDENTITY and mine_row.get("agent_name") == "fleet-ops"
        ok = in_mine and not shared and labelled
        case("live-guardrails", ok, f"in visibility=mine={in_mine} shared={shared} grants={len(grants)} identity={OPS_IDENTITY if labelled else 'missing'}")
        if cleanup:
            await c.sessions.delete(s.id)
            print(f"      deleted {s.id}")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--server", default="http://100.119.119.34:8000")
    ap.add_argument("--host", default="minipc", help="omnigent host name that serves ops sessions")
    ap.add_argument("--live", action="store_true", help="run a real ops session on the host")
    ap.add_argument("--cleanup", action="store_true", help="delete the live session afterwards")
    ap.add_argument("--timeout", type=int, default=600)
    a = ap.parse_args()

    spec = check_spec()
    check_policy(spec)
    from omnigent.cli_auth import load_token

    token = load_token(a.server)
    if not token:
        case("server-auth", False, f"no stored token for {a.server}: run `omnigent login {a.server}`")
    else:
        host = check_server(a.server, token, a.host)
        if a.live:
            if host and host.get("status") == "online":
                asyncio.run(live(a.server, token, host, a.cleanup, a.timeout))
            else:
                case("live-cross-host", False, f"host {a.host} not online")

    failed = [n for n, ok, _ in results if not ok]
    print(f"\n{len(results) - len(failed)}/{len(results)} passed" + (f"; FAILED: {', '.join(failed)}" if failed else ""))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
