import { expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";

const root = new URL("../", import.meta.url);
const pkg = JSON.parse(readFileSync(new URL("package.json", root), "utf8"));

it("declares only the reviewed OSS public entrypoints", () => {
  expect(pkg.exports).toEqual({
    ".": { types: "./dist/server.d.ts", import: "./dist/server.js" },
    "./istore": { types: "./dist/istore.d.ts", import: "./dist/istore.js" },
    "./schema": { types: "./dist/schema.d.ts", import: "./dist/schema.js" },
  });
});

it("does not bundle Pro packages or premium implementation modules", () => {
  expect(pkg.license).toBe("Apache-2.0");
  expect(Object.keys(pkg.dependencies)).not.toContain("underwright-pro");
  const files = readdirSync(new URL("src/", root));
  expect(files.filter(name => /^(?:ha|serve-ha|license|entitlement|sso|rbac|tenant|org-analytics)(?:[.-]|$)/i.test(name))).toEqual([]);
  for (const file of files.filter(name => name.endsWith(".ts"))) {
    const source = readFileSync(new URL(`src/${file}`, root), "utf8");
    expect(source, file).not.toMatch(/(?:from\s*|import\s*\(|require\s*\()\s*["']underwright-pro(?:[/'"])/);
  }
});
