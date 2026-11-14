import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from 'node:os';
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("..", import.meta.url));

describe("npm packaging, release CI, and install docs (gh-25)", () => {
  it("packaging: verifies package.json metadata, bin entrypoints, prepack/version flow, and npm pack contents", () => {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

    expect(pkg.name).toBe("underwright");
    expect(pkg.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(pkg.type).toBe("module");
    expect(pkg.main).toBe("./dist/server.js");
    expect(pkg.types).toBe("./dist/server.d.ts");
    expect(pkg.bin).toEqual({
      underwright: "./dist/cli.js",
      "uw-runner": "./dist/uw-runner.js",
    });
    expect(pkg.files).toEqual(expect.arrayContaining(["dist/", "README.md", "LICENSE"]));
    expect(pkg.repository?.url).toContain("github.com/underwright/underwright");
    expect(pkg.publishConfig).toEqual({
      access: "public",
      provenance: true,
    });
    expect(pkg.scripts?.prepack).toContain("npm run build");
    expect(pkg.scripts?.preversion).toContain("npm test");

    for (const rel of Object.values(pkg.bin) as string[]) {
      const full = join(root, rel);
      expect(existsSync(full), `missing bin file ${rel}`).toBe(true);
      const head = readFileSync(full, "utf8").split("\n")[0];
      expect(head).toBe("#!/usr/bin/env node");
    }

    const cliVersion = execFileSync(process.execPath, [join(root, "dist/cli.js"), "--version"], {
      cwd: root,
      encoding: "utf8",
    }).trim();
    expect(cliVersion).toBe(pkg.version);

    const packJson = execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
      cwd: root,
      encoding: "utf8",
    });
    const [packInfo] = JSON.parse(packJson);
    const packedPaths = (packInfo.files as { path: string }[]).map((f) => f.path);
    expect(packedPaths).toContain("package.json");
    expect(packedPaths).toContain("README.md");
    expect(packedPaths).toContain("LICENSE");
    expect(packedPaths).toContain("dist/cli.js");
    expect(packedPaths).toContain("dist/uw-runner.js");
    expect(packedPaths).toContain("dist/server.js");
    expect(packedPaths).toContain("scripts/install-agents.sh");
    expect(packedPaths.some((p) => p.startsWith("src/"))).toBe(false);
    expect(packedPaths.some((p) => p.startsWith("test/"))).toBe(false);
    expect(packedPaths).not.toContain(".mcp.json");
  }, 60000);

  it("release-ci: configures tag -> build -> test -> npm publish workflow with provenance", () => {
    const workflowPath = join(root, ".github/workflows/release.yml");
    expect(existsSync(workflowPath)).toBe(true);
    const workflow = readFileSync(workflowPath, "utf8");

    expect(workflow).toContain('tags: ["v*"]');
    expect(workflow).toContain("id-token: write");
    expect(workflow).toContain("contents: read");
    expect(workflow).toContain("registry-url: https://registry.npmjs.org");
    expect(workflow).toContain("npm ci");
    expect(workflow).toContain("npm run build");
    expect(workflow).toContain("npm test");
    expect(workflow).toContain("npm run test:contract");
    expect(workflow).toContain("npm publish --provenance --access public");
    expect(workflow).toContain("NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}");
  });

  it("install-doc: documents global install, npx usage, and release version bump in README", () => {
    const readme = readFileSync(join(root, "README.md"), "utf8");

    expect(readme).not.toContain("<<<<<<<");
    expect(readme).not.toContain(">>>>>>>");
    expect(readme).toContain("npm i -g underwright");
    expect(readme).toContain("npx");
    expect(readme).toContain("npm version");
  });
});

it("runs the reviewed installer resource from an extracted npm package", () => {
  const dir = mkdtempSync(join(tmpdir(), 'uw-installed-'));
  try {
    const packed = JSON.parse(execFileSync('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', dir], { cwd: root, encoding: 'utf8' }))[0];
    execFileSync('tar', ['-xzf', join(dir, packed.filename), '-C', dir]);
    symlinkSync(join(root, 'node_modules'), join(dir, 'package', 'node_modules'), 'dir');
    const script = join(dir, 'package', 'scripts', 'install-agents.sh');
    expect(execFileSync('bash', [script, 'list'], { encoding: 'utf8' })).toContain('codex');
    const result = execFileSync(process.execPath, ['--input-type=module', '-e', `
      import { planTask } from ${JSON.stringify('file://' + join(dir, 'package', 'dist', 'node-executors.js'))};
      const plan = planTask({id:'fixture',type:'install-harness',params:{harness:'codex'}},
        {allowed_task_types:['install-harness'],workspace_ids:[]},
        {workspaces:{},installers:{codex:{executable:'packaged-install-agents'}}});
      console.log(JSON.stringify(plan));
    `], { cwd: dir, encoding: 'utf8' });
    const plan = JSON.parse(result);
    expect(plan.executable).toBe('bash');
    expect(plan.args).toEqual([script, 'install', '--agents', 'codex', '--yes', '--no-open']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}, 60000);
