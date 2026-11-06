import { describe, it, expect, beforeEach, afterEach, beforeAll } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { SqliteStore } from "../src/store.js";
import {
  AGENTS_MD,
  DEFAULT_POLICY,
  TRIAGE_TASK_ID,
  initWorkspace,
  mcpConfig,
  remoteMcpUrl,
} from "../src/init.js";

// `underwright init` scaffolds a workspace: agent rules, MCP client config,
// policy defaults, ignore entries, and the first triage task.

const root = fileURLToPath(new URL("..", import.meta.url));
const cli = join(root, "dist/cli.js");
let dir: string;
let store: SqliteStore;
let oldPolicy: string | undefined;

const read = (name: string) => readFileSync(join(dir, name), "utf8");

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "uw-init-"));
  oldPolicy = process.env.UNDERWRIGHT_POLICY;
  process.env.UNDERWRIGHT_POLICY = join(dir, "absent-policy.json");
  store = new SqliteStore(join(dir, "underwright.db"));
});

afterEach(() => {
  store.close();
  if (oldPolicy === undefined) delete process.env.UNDERWRIGHT_POLICY;
  else process.env.UNDERWRIGHT_POLICY = oldPolicy;
  rmSync(dir, { recursive: true, force: true });
});

describe("init-files", () => {
  it("writes AGENTS.md, .mcp.json, policy, .gitignore, and seeds the triage task", async () => {
    const result = await initWorkspace(store, { cwd: dir });

    for (const name of ["AGENTS.md", ".mcp.json", "underwright.policy.json", ".gitignore"]) {
      expect(existsSync(join(dir, name))).toBe(true);
    }
    expect(result.created).toEqual(expect.arrayContaining(["AGENTS.md", ".mcp.json", "underwright.policy.json", ".gitignore"]));

    expect(read("AGENTS.md")).toBe(AGENTS_MD);
    expect(read("AGENTS.md")).toContain("Claim before work");
    expect(read("AGENTS.md")).toContain("Anti-escalation");

    expect(JSON.parse(read(".mcp.json"))).toEqual(mcpConfig());
    const mcp = JSON.parse(read(".mcp.json")).mcpServers.underwright;
    expect(mcp.command).toBe("npx");
    expect(mcp.args).toEqual(["-y", "underwright", "serve"]);

    expect(JSON.parse(read("underwright.policy.json"))).toEqual(DEFAULT_POLICY);
    expect(read(".gitignore").split("\n")).toContain("underwright.db*");

    const task = await store.getTask(TRIAGE_TASK_ID);
    expect(task).toMatchObject({ id: TRIAGE_TASK_ID, type: "docs", spec_ref: "README.md" });
    expect(task.ac_ids.length).toBeGreaterThan(0);
    expect(result.seeded?.id).toBe(TRIAGE_TASK_ID);
    expect(result.next_steps.join("\n")).toContain(TRIAGE_TASK_ID);
  });

  it("keeps the repo's AGENTS.md and the shipped template in sync", () => {
    expect(readFileSync(join(root, "AGENTS.md"), "utf8")).toBe(AGENTS_MD);
  });
});

describe("init-remote", () => {
  it("writes the http .mcp.json variant with token instructions", async () => {
    const result = await initWorkspace(store, { cwd: dir, remote: "http://host:8741" });

    const mcp = JSON.parse(read(".mcp.json")).mcpServers.underwright;
    expect(mcp).toEqual({
      type: "http",
      url: "http://host:8741/mcp",
      headers: { Authorization: "Bearer ${UNDERWRIGHT_TOKEN}" },
    });
    expect(result.next_steps.join("\n")).toContain("UNDERWRIGHT_TOKEN");
    expect(result.next_steps.join("\n")).toContain("serve --http");
  });

  it("accepts a full /mcp endpoint and rejects non-http schemes", async () => {
    expect(remoteMcpUrl("https://control.example.com/mcp")).toBe("https://control.example.com/mcp");
    expect(remoteMcpUrl("http://host:8741/")).toBe("http://host:8741/mcp");
    expect(() => remoteMcpUrl("ftp://host:8741")).toThrow(/http\(s\) URL/);
  });
});

describe("init-idempotent", () => {
  it("does not clobber existing files without --force", async () => {
    writeFileSync(join(dir, "AGENTS.md"), "keep me\n");
    writeFileSync(join(dir, ".mcp.json"), '{"mine":true}\n');

    const result = await initWorkspace(store, { cwd: dir });

    expect(read("AGENTS.md")).toBe("keep me\n");
    expect(read(".mcp.json")).toBe('{"mine":true}\n');
    expect(result.skipped).toEqual(expect.arrayContaining(["AGENTS.md", ".mcp.json"]));
    expect(result.next_steps.join("\n")).toContain("--force");
  });

  it("overwrites with --force and appends ignore entries without dropping the rest", async () => {
    writeFileSync(join(dir, "AGENTS.md"), "keep me\n");
    writeFileSync(join(dir, ".gitignore"), "node_modules/\n");
    await initWorkspace(store, { cwd: dir });
    expect(read(".gitignore")).toBe("node_modules/\nunderwright.db*\n");

    const result = await initWorkspace(store, { cwd: dir, force: true });
    expect(read("AGENTS.md")).toBe(AGENTS_MD);
    expect(result.updated).toEqual(expect.arrayContaining(["AGENTS.md", ".mcp.json", "underwright.policy.json"]));
  });

  it("re-runs without duplicating the triage task or the ignore entry", async () => {
    await initWorkspace(store, { cwd: dir });
    const second = await initWorkspace(store, { cwd: dir });

    expect(second.seeded).toBeNull();
    expect(second.created).toEqual([]);
    expect(read(".gitignore").match(/underwright\.db\*/g)).toHaveLength(1);
    expect((await store.board()).tasks.filter((t: any) => t.id === TRIAGE_TASK_ID)).toHaveLength(1);
  });
});

describe("cli", () => {
  beforeAll(() => {
    if (!existsSync(cli)) execFileSync("npm", ["run", "build"], { cwd: root, stdio: "ignore" });
  });

  it("bootstraps the current directory: underwright init", () => {
    const out = execFileSync(process.execPath, [cli, "init"], {
      cwd: dir,
      encoding: "utf8",
      env: { ...process.env, UNDERWRIGHT_DB: join(dir, "underwright.db"), UNDERWRIGHT_POLICY: join(dir, "absent-policy.json") },
    });
    expect(out).toContain("created: AGENTS.md, .mcp.json, underwright.policy.json, .gitignore");
    expect(out).toContain("Next steps:");
    expect(read(".mcp.json")).toContain('"npx"');
    expect(existsSync(join(dir, "underwright.db"))).toBe(true);
  }, 20000);
});
