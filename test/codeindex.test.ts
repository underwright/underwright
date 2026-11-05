import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { SqliteStore } from "../src/store.js";
import { extractFile, indexWorkspace } from "../src/codeindex.js";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let dir: string;
let store: SqliteStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "uw-code-"));
  process.env.UNDERWRIGHT_POLICY = "/tmp/uw-no-policy.json";
  store = new SqliteStore(join(dir, "test.db"));
  mkdirSync(join(dir, "src"));
});
afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });

const put = (p: string, c: string) => writeFileSync(join(dir, "src", p), c);
const index = () => indexWorkspace(store, join(dir, "src"), "test");

describe("ast-index", () => {
  it("extracts definitions and references from TypeScript", async () => {
    const r = await extractFile(
      `export function foo(a: number) { return bar(a); }
function bar(x: number) { return x; }
export class Svc { run(): Foo { return new Foo(); } }
export interface Foo { id: string }
export const arrow = () => foo(1);
type T = Foo;`, "a.ts");
    const defs = Object.fromEntries(r.symbols.map((s) => [s.name, s]));
    expect(defs.foo).toMatchObject({ kind: "function", exported: true, line: 1 });
    expect(defs.bar).toMatchObject({ kind: "function", exported: false });
    expect(defs.Svc.kind).toBe("class");
    expect(defs.run.kind).toBe("method");
    expect(defs.Foo.kind).toBe("interface");
    expect(defs.arrow).toMatchObject({ kind: "function", exported: true });
    expect(defs.T.kind).toBe("type");
    expect(r.refs).toContainEqual({ name: "bar", line: 1, container: "foo" });
    expect(r.refs).toContainEqual({ name: "foo", line: 5, container: "arrow" });
    expect(r.refs.some((x) => x.name === "Foo" && x.container === "run")).toBe(true);
  });

  it("parses TSX and JS files", async () => {
    const tsx = await extractFile(`export const C = () => <div>{helper()}</div>;`, "c.tsx");
    expect(tsx.refs.map((r) => r.name)).toContain("helper");
    const js = await extractFile(`function j() {}`, "j.js");
    expect(js.symbols[0].name).toBe("j");
  });
});

describe("symbol-search", () => {
  beforeEach(async () => {
    put("a.ts", `export function parseConfig() { return load(); }\nfunction load() {}`);
    put("b.ts", `import { parseConfig } from "./a.js";\nexport function main() { parseConfig(); }\nexport function boot() { main(); }`);
    await index();
  });

  it("finds definitions by name, exact before substring", () => {
    const r = store.searchSymbols("load");
    expect(r[0]).toMatchObject({ name: "load", path: "a.ts", kind: "function" });
    expect(store.searchSymbols("config").map((s: any) => s.name)).toContain("parseConfig");
    expect(store.searchSymbols("parse", "class")).toEqual([]);
  });

  it("treats LIKE wildcards in queries literally", () => {
    expect(store.searchSymbols("%")).toEqual([]);
  });

  it("lists references", () => {
    const refs = store.findReferences("parseConfig");
    expect(refs.map((r: any) => r.path).sort()).toEqual(["b.ts", "b.ts"]); // import + call
    expect(refs.some((r: any) => r.container === "main")).toBe(true);
  });

  it("computes transitive blast radius", () => {
    const r = store.blastRadius("load");
    expect(r.impacted.map((i) => [i.depth, i.symbol])).toEqual([
      [1, "parseConfig"], [2, "<top-level>"], [2, "main"], [3, "boot"], // top-level = b.ts's import
    ]);
    expect(r.files).toEqual(["a.ts", "b.ts"]);
    expect(store.blastRadius("load", 1).impacted).toHaveLength(1);
  });

  it("feeds search_context with symbol results", () => {
    const r = store.searchContext("parseConfig");
    expect(r.some((x: any) => x.entity_type === "symbol" && x.title === "parseConfig")).toBe(true);
    expect(store.searchContext("parseConfig", ["helper"]).some((x: any) => x.entity_type === "symbol")).toBe(false);
    expect(store.searchContext("parseConfig", ["symbol"]).length).toBeGreaterThan(0);
  });
});

describe("incremental-update", () => {
  it("skips unchanged files, reparses changed, drops deleted", async () => {
    put("a.ts", `export function one() {}`);
    put("b.ts", `export function two() {}`);
    expect(await index()).toMatchObject({ indexed: 2, unchanged: 0, removed: 0 });

    expect(await index()).toMatchObject({ indexed: 0, unchanged: 2, removed: 0 });

    put("a.ts", `export function uno() {}`);
    expect(await index()).toMatchObject({ indexed: 1, unchanged: 1 });
    expect(store.searchSymbols("one")).toEqual([]);
    expect(store.searchSymbols("uno")).toHaveLength(1);

    rmSync(join(dir, "src", "b.ts"));
    expect(await index()).toMatchObject({ indexed: 0, unchanged: 1, removed: 1 });
    expect(store.searchSymbols("two")).toEqual([]);
    expect(store.findReferences("two")).toEqual([]);
  });

  it("ignores node_modules, dist and .d.ts", async () => {
    mkdirSync(join(dir, "src", "node_modules"));
    put("node_modules/x.ts", `export function hidden() {}`);
    put("t.d.ts", `export declare function decl(): void;`);
    put("ok.ts", `export function shown() {}`);
    const r = await index();
    expect(r.files).toBe(1);
    expect(store.searchSymbols("hidden")).toEqual([]);
  });

  it("audits index mutations", async () => {
    put("a.ts", `export function one() {}`);
    await index();
    expect(store.auditLog(10).some((e: any) => e.entity_type === "code_file" && e.action === "indexed")).toBe(true);
  });
});
