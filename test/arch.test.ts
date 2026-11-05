import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("..", import.meta.url));
const bin = join(root, "node_modules/dependency-cruiser/bin/dependency-cruiser.mjs");
const config = join(root, ".dependency-cruiser.cjs");
// Cruising TypeScript on a Windows mount is slow; ubuntu CI is much faster.
const CRUISE_TIMEOUT_MS = 120_000;

type Report = {
  modules: { source: string; dependencies: { resolved: string }[] }[];
  summary: { error: number; violations: { rule: { name: string }; from: string; to: string }[] };
};

function runCruise(cwd: string, outputType: string): { status: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync(process.execPath, [bin, "--config", config, "--output-type", outputType, "src"], {
      cwd,
      encoding: "utf8",
    });
    return { status: 0, stdout, stderr: "" };
  } catch (error: any) {
    return {
      status: error.status ?? 1,
      stdout: String(error.stdout ?? ""),
      stderr: String(error.stderr ?? error.message ?? ""),
    };
  }
}

function cruiseJson(cwd: string): Report {
  const { stdout, stderr } = runCruise(cwd, "json");
  try {
    return JSON.parse(stdout);
  } catch {
    throw new Error(`depcruise did not return JSON:\n${stdout}\n${stderr}`);
  }
}

function resolved(report: Report, source: string) {
  const mod = report.modules.find((m) => m.source === source);
  return (mod?.dependencies ?? []).map((d) => d.resolved);
}

function writeFixture(dir: string, storeSource: string) {
  mkdirSync(join(dir, "src"));
  writeFileSync(join(dir, "tsconfig.json"), JSON.stringify({
    compilerOptions: { target: "ES2022", module: "Node16", moduleResolution: "Node16", strict: true },
    include: ["src/**/*"],
  }));
  writeFileSync(join(dir, "src/cli.ts"), "export const cli = 1;\n");
  writeFileSync(join(dir, "src/server.ts"), "export const server = 1;\n");
  writeFileSync(join(dir, "src/schema.ts"), "export const schema = 1;\n");
  writeFileSync(join(dir, "src/github.ts"), "export const github = 1;\n");
  writeFileSync(join(dir, "src/store.ts"), storeSource);
}

describe("dependency-cruiser architecture", () => {
  it("allows cli → server → store → schema and keeps github.ts adapter-only", () => {
    const report = cruiseJson(root);
    expect(report.summary.violations, JSON.stringify(report.summary.violations, null, 2)).toEqual([]);
    expect(report.summary.error).toBe(0);

    const cli = resolved(report, "src/cli.ts");
    expect(cli).toContain("src/server.ts");
    expect(cli).toContain("src/github.ts");
    expect(cli).not.toContain("src/store.ts");
    expect(cli).not.toContain("src/schema.ts");

    const server = resolved(report, "src/server.ts");
    expect(server).toContain("src/store.ts");
    expect(server).not.toContain("src/schema.ts");
    expect(server).not.toContain("src/cli.ts");

    const store = resolved(report, "src/store.ts");
    expect(store).toContain("src/schema.ts");
    expect(store).not.toContain("src/github.ts");
    expect(store).not.toContain("src/server.ts");
    expect(store).not.toContain("src/cli.ts");

    const importers = report.modules
      .filter((m) => m.dependencies.some((d) => d.resolved === "src/github.ts"))
      .map((m) => m.source);
    expect(importers).toEqual(["src/cli.ts"]);
  }, CRUISE_TIMEOUT_MS);

  it("fails the err reporter when store.ts imports the github adapter", () => {
    const dir = mkdtempSync(join(tmpdir(), "uw-arch-"));
    try {
      writeFixture(dir, "import \"./github.js\";\nexport const store = 1;\n");
      // npm run depcruise uses the default err reporter, which is what CI runs.
      const err = runCruise(dir, "err");
      expect(err.status, err.stdout + err.stderr).not.toBe(0);
      expect(err.stderr + err.stdout).toContain("github-adapter-only");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, CRUISE_TIMEOUT_MS);

  it("runs from CI via npm run depcruise", () => {
    const ci = readFileSync(join(root, ".github/workflows/ci.yml"), "utf8");
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    expect(pkg.scripts.depcruise).toContain("depcruise");
    expect(pkg.scripts.depcruise).toContain(".dependency-cruiser.cjs");
    expect(pkg.scripts.depcruise).not.toContain("output-type");
    expect(ci).toContain("npm run depcruise");
  });
});
