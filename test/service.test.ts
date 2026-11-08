import { describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  defaultServiceName,
  installService,
  renderEnvFile,
  renderUnit,
  serviceStatus,
  systemdQuote,
  uninstallService,
  validateServiceName,
} from "../src/service.js";

// `underwright service install` renders a systemd unit so the control plane,
// node daemon, or job runner comes back after a reboot. Rendering is pure;
// install runs systemctl through an injectable exec.

const dir = mkdtempSync(join(tmpdir(), "uw-service-"));
process.on("exit", () => rmSync(dir, { recursive: true, force: true }));

const base = { target: "serve" as const, cwd: "/srv/uw" };

describe("renderUnit", () => {
  it("renders a user serve unit pointing at the CLI with an env DB path", () => {
    const unit = renderUnit({ ...base, http: "0.0.0.0:8741", environment: { UNDERWRIGHT_DB: "/srv/uw/underwright.db" } });
    expect(unit).toContain("Description=Underwright MCP control plane (underwright)");
    expect(unit).toContain("After=network-online.target");
    expect(unit).toContain("WorkingDirectory=/srv/uw");
    expect(unit).toContain("Environment=UNDERWRIGHT_DB=/srv/uw/underwright.db");
    expect(unit).toMatch(/ExecStart=.+cli\.js serve --http 0\.0\.0\.0:8741/);
    expect(unit).toContain("Restart=on-failure");
    expect(unit).toContain("WantedBy=default.target");
    expect(unit).not.toContain("ProtectSystem");
  });

  it("renders a hardened system unit with a dedicated user", () => {
    const unit = renderUnit({ ...base, system: true, runAs: "underwright", environment: { UNDERWRIGHT_DB: "/var/lib/uw/underwright.db" } });
    expect(unit).toContain("User=underwright");
    expect(unit).toContain("ProtectSystem=strict");
    expect(unit).toContain("ReadWritePaths=/srv/uw /var/lib/uw");
    expect(unit).toContain("WantedBy=multi-user.target");
  });

  it("renders node and run targets with per-target restart policy", () => {
    const node = renderUnit({ target: "node", config: "/etc/uw/node.json", cwd: "/srv/uw" });
    expect(node).toMatch(/node run --config \/etc\/uw\/node\.json/);
    expect(node).toContain("KillMode=control-group");
    expect(defaultServiceName("node")).toBe("underwright-node");
    const run = renderUnit({ target: "run", cwd: "/srv/uw" });
    expect(run).toContain("Restart=always");
    expect(run).toMatch(/cli\.js run$/m);
  });

  it("renders the fleet runner with url/host/agent-id and always restart", () => {
    const unit = renderUnit({ target: "runner", url: "http://ctrl:8741/mcp", host: "minipc", agentId: "codex-2@minipc", cwd: "/srv/uw" });
    expect(unit).toContain("Description=Underwright fleet job runner (underwright-runner)");
    expect(unit).toMatch(/uw-runner\.js --url http:\/\/ctrl:8741\/mcp --host minipc --agent-id codex-2@minipc/);
    expect(unit).toContain("Restart=always");
    vi.stubEnv("UNDERWRIGHT_URL", "");
    expect(() => renderUnit({ target: "runner", cwd: "/srv/uw" })).toThrow(/--url/);
    vi.unstubAllEnvs();
  });

  it("requires --config for the node target and rejects bad names/vars", () => {
    expect(() => renderUnit({ target: "node" })).toThrow(/config/);
    expect(() => validateServiceName("uw;rm -rf")).toThrow(/invalid/);
    expect(() => renderUnit({ ...base, environment: { "BAD NAME": "x" } })).toThrow(/invalid environment/);
  });

  it("quotes paths and values containing spaces", () => {
    expect(systemdQuote("/a/b c/d")).toBe('"/a/b c/d"');
    expect(systemdQuote('say "hi"')).toBe('"say \\"hi\\""');
    expect(systemdQuote("/plain/path")).toBe("/plain/path");
    const unit = renderUnit({ ...base, environment: { FOO: "a b" } });
    expect(unit).toContain('Environment=FOO="a b"');
  });
});

describe("renderEnvFile", () => {
  it("quotes only values that need it", () => {
    expect(renderEnvFile({ A: "x", B: "a b", C: 'q"v', D: "has#hash" })).toBe('A=x\nB="a b"\nC="q\\"v"\nD="has#hash"\n');
  });
});

describe("installService", () => {
  const calls: string[] = [];
  const exec = (cmd: string, args: string[]) => { calls.push([cmd, ...args].join(" ")); return ""; };
  const deps = () => ({ exec, unitDir: join(dir, "units"), configDir: join(dir, "cfg"), env: {} as NodeJS.ProcessEnv });

  it("writes the unit, reloads, enables, starts, and enables linger", () => {
    calls.length = 0;
    const r = installService(base, deps());
    expect(r.ok).toBe(true);
    expect(readFileSync(r.unitPath!, "utf8")).toContain("ExecStart=");
    expect(calls).toEqual([
      "systemctl --user daemon-reload",
      "systemctl --user enable underwright.service",
      "systemctl --user start underwright.service",
      "loginctl enable-linger",
    ]);
    expect(r.warnings).toEqual([]);
  });

  it("skips start with start:false and uses system scope", () => {
    calls.length = 0;
    const r = installService({ ...base, system: true, start: false }, deps());
    expect(r.ok).toBe(true);
    expect(calls).toEqual(["systemctl daemon-reload", "systemctl enable underwright.service"]);
    expect(calls.some(c => c.startsWith("loginctl"))).toBe(false);
  });

  it("writes secrets to a 0600 env file and references it", () => {
    calls.length = 0;
    const r = installService(base, { ...deps(), env: { UNDERWRIGHT_TOKEN: "tok 123" } });
    expect(r.ok).toBe(true);
    expect(statSync(r.envFile!).mode & 0o777).toBe(0o600);
    expect(readFileSync(r.envFile!, "utf8")).toBe('UNDERWRIGHT_TOKEN="tok 123"\n');
    expect(readFileSync(r.unitPath!, "utf8")).toContain(`EnvironmentFile=${r.envFile}`);
    expect(readFileSync(r.unitPath!, "utf8")).not.toContain("tok 123");
  });

  it("warns with guidance when the user manager is unreachable", () => {
    const fail = () => { throw new Error("Failed to connect to bus: No such file or directory"); };
    const r = installService(base, { exec: fail, unitDir: join(dir, "units2"), env: {} });
    expect(r.ok).toBe(false);
    expect(r.warnings.join(" ")).toMatch(/user manager unavailable/);
    expect(existsSync(r.unitPath!)).toBe(true);
  });

  it("renders the unit without installing on non-Linux", () => {
    const r = installService(base, { platform: "darwin", env: {} });
    expect(r.ok).toBe(false);
    expect(r.unit).toContain("[Service]");
    expect(r.unitPath).toBeUndefined();
  });
});

describe("uninstallService", () => {
  it("stops, disables, removes the unit, reloads", () => {
    const unitDir = join(dir, "units-rm");
    const seeded = installService({ target: "run" }, { exec: () => "", unitDir, env: {} });
    expect(existsSync(seeded.unitPath!)).toBe(true);
    const calls: string[] = [];
    const r = uninstallService({ target: "run" }, { exec: (c, a) => { calls.push([c, ...a].join(" ")); return ""; }, unitDir });
    expect(r.ok).toBe(true);
    expect(existsSync(unitDir + "/underwright-run.service")).toBe(false);
    expect(calls).toEqual([
      "systemctl --user stop underwright-run.service",
      "systemctl --user disable underwright-run.service",
      "systemctl --user daemon-reload",
    ]);
  });
});

describe("serviceStatus", () => {
  it("maps is-enabled/is-active/linger probes", () => {
    const s = serviceStatus(base, {
      exec: (cmd, args) => args.includes("is-enabled") ? "enabled\n" : args.includes("Linger") || args.includes("--value") ? "yes\n" : "active\n",
    });
    expect(s).toMatchObject({ name: "underwright", scope: "user", enabled: "enabled", active: "active", linger: "yes" });
  });
});
