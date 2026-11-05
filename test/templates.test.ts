import { describe, it, expect, beforeEach, afterEach, beforeAll } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { SqliteStore } from "../src/store.js";

// Task templates: builtin + policy-defined seeds for AC scaffold, type, and a
// DoR checklist. cli.ts is exercised through the compiled binary.

const DB = "/tmp/uw-test-templates.db";
const root = fileURLToPath(new URL("..", import.meta.url));
const cli = join(root, "dist/cli.js");
let store: SqliteStore;

const rmDb = (path: string) => {
  for (const suffix of ["", "-wal", "-shm"]) rmSync(`${path}${suffix}`, { force: true });
};

beforeEach(() => {
  rmDb(DB);
  process.env.UNDERWRIGHT_POLICY = "/tmp/uw-no-policy.json";
  store = new SqliteStore(DB);
});
afterEach(() => {
  store.close();
  delete process.env.UNDERWRIGHT_POLICY;
});

describe("templates", () => {
  it("ships the builtin feature/bug/architecture/tdd set", () => {
    const ids = store.listTemplates().map((t: any) => t.id);
    expect(ids).toEqual(expect.arrayContaining(["feature", "bug", "architecture", "tdd"]));
  });

  it("expands the AC scaffold and type when create_task names a template", () => {
    const t = store.createTask({ title: "add search", template: "feature" } as any);
    expect(t.type).toBe("feature");
    expect(t.ac_ids.length).toBeGreaterThan(0);
    expect(t.ac_ids).toEqual(expect.arrayContaining(["scope"]));
  });

  it("lets explicit ac_ids override the template scaffold", () => {
    const t = store.createTask({ title: "x", template: "bug", ac_ids: ["custom-ac"] } as any);
    expect(t.ac_ids).toEqual(["custom-ac"]);
  });

  it("rejects an unknown template", () => {
    const r: any = store.createTask({ title: "x", template: "does-not-exist" } as any);
    expect(r.error).toContain("unknown template");
  });

  it("reads user-defined templates from the policy file", () => {
    const dir = mkdtempSync(join(tmpdir(), "uw-tpl-"));
    writeFileSync(join(dir, "pol.json"), JSON.stringify({
      templates: [{
        id: "spike",
        type: "feature",
        description: "## Spike",
        ac_ids: ["spike-goal"],
        dor_checklist: ["Timebox set"],
      }],
    }));
    process.env.UNDERWRIGHT_POLICY = join(dir, "pol.json");

    expect(store.listTemplates().map((t: any) => t.id)).toContain("spike");
    const t = store.createTask({ title: "investigate", template: "spike" } as any);
    expect(t.type).toBe("feature");
    expect(t.ac_ids).toEqual(["spike-goal"]);
  });
});

describe("dor-checklist", () => {
  it("injects checklist items into the description", () => {
    const t = store.createTask({ title: "add search", template: "feature" } as any);
    expect(t.description).toContain("Definition of Ready");
    expect(t.description).toMatch(/- \[ \] /);
  });

  it("seeds the DoR fields the triager must still complete", () => {
    process.env.UNDERWRIGHT_POLICY = new URL("../underwright.policy.json", import.meta.url).pathname;
    const t = store.createTask({ title: "fix crash", template: "bug" } as any);
    // Template filled type + ac_ids; the triager must still estimate effort.
    expect(store.claimTask(t.id, "agent-A")).toHaveProperty("error");
    store.updateTask(t.id, { estimate: "S" }, "triager");
    expect(store.claimTask(t.id, "agent-A")).not.toHaveProperty("error");
  });
});

describe("cli", () => {
  beforeAll(() => {
    if (!existsSync(cli)) execFileSync("npm", ["run", "build"], { cwd: root, stdio: "ignore" });
  });

  it("creates a task from a template: underwright create --template feature --title ...", () => {
    const db = join(mkdtempSync(join(tmpdir(), "uw-cli-")), "uw.db");
    const out = execFileSync(process.execPath, [cli, "create", "--template", "feature", "--title", "cli feature"], {
      encoding: "utf8",
      env: { ...process.env, UNDERWRIGHT_DB: db, UNDERWRIGHT_POLICY: "/tmp/uw-no-policy.json" },
    });
    const task = JSON.parse(out);
    expect(task.title).toBe("cli feature");
    expect(task.type).toBe("feature");
    expect(task.ac_ids).toEqual(expect.arrayContaining(["scope"]));
    expect(task.description).toContain("Definition of Ready");
    rmDb(db);
  });

  it("lists templates: underwright templates", () => {
    const db = join(mkdtempSync(join(tmpdir(), "uw-cli-")), "uw.db");
    const out = execFileSync(process.execPath, [cli, "templates"], {
      encoding: "utf8",
      env: { ...process.env, UNDERWRIGHT_DB: db, UNDERWRIGHT_POLICY: "/tmp/uw-no-policy.json" },
    });
    expect(JSON.parse(out).map((t: any) => t.id)).toContain("tdd");
    rmDb(db);
  });
});
