import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { attestHarnesses, initConfig, probeHarnesses, validateConfig, which } from "../src/node-config.js";

const tmp = () => mkdtempSync(join(tmpdir(), "uw-nodecfg-"));

/** Fake PATH dir with stub executables. */
function fakeBin(names: string[]) {
  const dir = tmp();
  for (const name of names) {
    const p = join(dir, name);
    writeFileSync(p, "#!/bin/sh\nexit 0\n");
    chmodSync(p, 0o755);
  }
  return dir;
}

describe("which", () => {
  it("finds executables on PATH and absolute paths", () => {
    const bin = fakeBin(["stub-cli"]);
    expect(which("stub-cli", bin)).toBe(join(bin, "stub-cli"));
    expect(which(join(bin, "stub-cli"), "")).toBe(join(bin, "stub-cli"));
    expect(which("missing-cli", bin)).toBeNull();
    expect(which("packaged-install-agents", "")).toBe("packaged-install-agents");
  });
});

describe("validateConfig", () => {
  it("rejects a non-object config and missing workspaces", () => {
    expect(validateConfig(null).ok).toBe(false);
    expect(validateConfig({ workspaces: {} }).issues.some((i) => i.level === "error" && i.section === "workspaces")).toBe(true);
  });

  it("flags missing workspace paths and unresolvable executables as errors", () => {
    const bin = fakeBin(["echo"]);
    const report = validateConfig({
      workspaces: { home: "/nonexistent/path/xyz", ok: tmp() },
      scripts: { smoke: { executable: "echo" }, bad: { executable: "no-such-binary" } },
      harnesses: { ghost: { executable: "/absent/cli" } },
    }, bin);
    const errors = report.issues.filter((i) => i.level === "error");
    expect(report.ok).toBe(false);
    expect(errors.some((i) => i.id === "home")).toBe(true);
    expect(errors.some((i) => i.id === "bad")).toBe(true);
    expect(errors.some((i) => i.id === "ghost")).toBe(true);
    expect(errors.some((i) => i.id === "ok")).toBe(false);
    expect(errors.some((i) => i.id === "smoke")).toBe(false);
  });

  it("warns on out-of-range concurrency, unknown keys, and attestation drift", () => {
    const bin = fakeBin(["codex", "echo"]);
    const report = validateConfig({
      workspaces: { home: tmp() },
      scripts: { smoke: { executable: "echo" } },
      harnesses: { codex: { executable: join(bin, "codex") } },
      inventory: { harnesses: [{ id: "codex", installed: true, auth_status: "ready" }, { id: "ghost" }] },
      concurrency: 99,
      typo_key: true,
    }, bin);
    const warnings = report.issues.filter((i) => i.level === "warning");
    expect(report.ok).toBe(true);
    expect(warnings.some((i) => i.section === "concurrency")).toBe(true);
    expect(warnings.some((i) => i.message.includes("typo_key"))).toBe(true);
    expect(warnings.some((i) => i.id === "ghost" && i.message.includes("not in harnesses"))).toBe(true);
  });

  it("warns when a configured harness is not attested", () => {
    const bin = fakeBin(["codex"]);
    const report = validateConfig({
      workspaces: { home: tmp() },
      harnesses: { codex: { executable: join(bin, "codex") } },
    }, bin);
    expect(report.issues.some((i) => i.id === "codex" && i.message.includes("not attested"))).toBe(true);
  });
});

describe("initConfig + probeHarnesses", () => {
  it("produces a config that passes validate on the host", () => {
    const bin = fakeBin(["echo", "grok"]);
    const config = initConfig({ workspaces: { home: tmp() }, pathEnv: bin });
    const report = validateConfig(config, bin);
    expect(report.issues.filter((i) => i.level === "error")).toEqual([]);
    expect(config.harnesses?.grok).toEqual({ executable: join(bin, "grok"), args: ["--single"] });
  });

  it("prefers omni for harnesses without a single-prompt native form", () => {
    const bin = fakeBin(["omni", "codex", "kimi"]);
    const found = probeHarnesses(bin);
    expect(found.codex).toEqual({ executable: join(bin, "omni"), args: ["run", "--harness", "codex", "-p"] });
    expect(found.kimi).toEqual({ executable: join(bin, "omni"), args: ["run", "--harness", "kimi", "-p"] });
  });

  it("keeps native CLIs for harnesses with a known single-prompt form", () => {
    const bin = fakeBin(["omni", "grok", "agent"]);
    const found = probeHarnesses(bin);
    expect(found.grok).toEqual({ executable: join(bin, "grok"), args: ["--single"] });
    expect(found.cursor).toEqual({ executable: join(bin, "agent"), args: ["-p"] });
  });
});

describe("attestHarnesses", () => {
  it("marks installed by executable resolution and preserves a still-valid ready", () => {
    const bin = fakeBin(["codex", "echo"]);
    const config = attestHarnesses({
      workspaces: { home: tmp() },
      harnesses: {
        codex: { executable: join(bin, "codex") },
        gone: { executable: "/absent/cli" },
      },
      inventory: { harnesses: [{ id: "codex", installed: true, auth_status: "ready", quota: { state: "unknown" } }] },
    }, bin);
    const hs = (config.inventory as any).harnesses;
    expect(hs.find((h: any) => h.id === "codex")).toMatchObject({ installed: true, auth_status: "ready" });
    expect(hs.find((h: any) => h.id === "gone")).toMatchObject({ installed: false, auth_status: "unknown" });
  });
});
