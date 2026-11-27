import { expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { BUILD_INFO } from "../src/build-info.js";
import { nodeInventorySchema, projectNode } from "../src/node-protocol.js";
import { defaultInventoryProbe } from "../src/node-run.js";

it("stamps a fixed UTC build time into the artifact", () => {
  const dir = mkdtempSync(join(tmpdir(), "uw-build-stamp-"));
  try {
    const before = Date.now();
    execFileSync(process.execPath, [new URL("../scripts/stamp-build.mjs", import.meta.url).pathname, dir]);
    const path = join(dir, "build-info.json");
    const stamp = JSON.parse(readFileSync(path, "utf8"));
    expect(stamp.build_time).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);
    expect(Date.parse(stamp.build_time)).toBeGreaterThanOrEqual(before);
    expect(Date.parse(stamp.build_time)).toBeLessThanOrEqual(Date.now());
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(stamp);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it("reports unstamped source execution as unknown, not startup time", () => {
  expect(BUILD_INFO.version).toBe("0.1.2");
  expect(BUILD_INFO.build_time).toBeNull();
});

it("accepts and projects build time while retaining legacy inventory compatibility", () => {
  const build_time = "2026-11-27T17:00:00.000Z";
  expect(nodeInventorySchema.parse({}).build_time).toBeUndefined();
  expect(nodeInventorySchema.safeParse({ build_time: "not-a-date" }).success).toBe(false);
  const inventory = nodeInventorySchema.parse({ daemon_version: "0.1.1", build_time });
  expect(projectNode({ capabilities_json: JSON.stringify(inventory) })).toMatchObject({ daemon_version: "0.1.1", build_time });
  expect(projectNode({})).toMatchObject({ daemon_version: "unknown", build_time: null });
  expect(defaultInventoryProbe()).toMatchObject({ daemon_version: BUILD_INFO.version, build_time: BUILD_INFO.build_time });
});
