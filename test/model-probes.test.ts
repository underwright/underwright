import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { probeCatalog } from "../src/model-catalog.js";
const dirs: string[] = [];
afterEach(() => { vi.unstubAllEnvs(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
it("runs each CLI with the noninteractive catalog arguments", async () => {
  const dir = mkdtempSync(join(tmpdir(), "uw-model-probe-")); dirs.push(dir);
  for (const [name, args, model] of [["grok", "models", "grok-4"], ["agent", "--list-models", "composer-2"], ["cmdc", "--list-models", "gpt-5"]]) {
    writeFileSync(join(dir, name), `#!/bin/sh\n[ "$*" = "${args}" ] || exit 2\nprintf '${model}  Model label\\n'\n`, { mode: 0o755 });
  }
  vi.stubEnv("PATH", dir);
  expect(await probeCatalog("grok")).toEqual({ harness: "grok", models: ["grok-4"] });
  expect(await probeCatalog("cursor")).toEqual({ harness: "cursor", models: ["composer-2"] });
  expect(await probeCatalog("cmdc")).toEqual({ harness: "cmdc", models: ["gpt-5"] });
});
it("initializes Codex app-server and collects all model/list pages", async () => {
  const dir = mkdtempSync(join(tmpdir(), "uw-model-probe-")); dirs.push(dir);
  writeFileSync(join(dir, "package.json"), '{"type":"module"}');
  writeFileSync(join(dir, "codex"), `#!${process.execPath}
import readline from 'node:readline';
if (process.argv[2] !== 'app-server') process.exit(2);
readline.createInterface({input:process.stdin}).on('line', line => {
  const request = JSON.parse(line);
  if (request.method === 'initialize') console.log(JSON.stringify({id:1,result:{}}));
  if (request.method === 'model/list') {
    const page = request.params.cursor;
    console.log(JSON.stringify({id:2,result:{data:[{id:page?'gpt-b':'gpt-a'}],nextCursor:page?null:'page-2'}}));
  }
});
`, { mode: 0o755 });
  vi.stubEnv("PATH", dir);
  expect(await probeCatalog("codex")).toEqual({ harness: "codex", models: ["gpt-a", "gpt-b"] });
});
