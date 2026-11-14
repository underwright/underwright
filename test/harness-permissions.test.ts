import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_CLAUDE_ALLOW, allowClaudeWorkspace, harnessKind, prepareHarnessWorkspace, trustClaudeWorkspace,
} from "../src/harness-permissions.js";
import { createExecutorRegistry } from "../src/node-executors.js";

let root: string, ws: string, claudeJson: string;
const json = (p: string) => JSON.parse(readFileSync(p, "utf8"));

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "uw-perm-"));
  ws = join(root, "ws");
  mkdirSync(ws);
  claudeJson = join(root, "home", ".claude.json");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("trust", () => {
  it("marks the canonical workspace trusted, preserving other state, idempotently", () => {
    mkdirSync(join(root, "home"));
    writeFileSync(claudeJson, JSON.stringify({ userID: "u1", projects: { "/other": { hasTrustDialogAccepted: false, x: 1 }, [realpathSync(ws)]: { allowedTools: ["Foo"] } } }), { mode: 0o600 });
    expect(trustClaudeWorkspace(ws, { claudeJson }).changed).toBe(true);
    const state = json(claudeJson);
    expect(state.userID).toBe("u1");
    expect(state.projects["/other"]).toEqual({ hasTrustDialogAccepted: false, x: 1 });
    expect(state.projects[realpathSync(ws)]).toEqual({ allowedTools: ["Foo"], hasTrustDialogAccepted: true });
    expect(statSync(claudeJson).mode & 0o777).toBe(0o600);
    expect(trustClaudeWorkspace(ws, { claudeJson }).changed).toBe(false);
  });

  it("creates ~/.claude.json (0600) when missing and refuses to clobber invalid JSON", () => {
    expect(trustClaudeWorkspace(ws, { claudeJson }).changed).toBe(true);
    expect(statSync(claudeJson).mode & 0o777).toBe(0o600);
    writeFileSync(claudeJson, "{not json");
    expect(() => trustClaudeWorkspace(ws, { claudeJson })).toThrow(/unparseable/);
    expect(readFileSync(claudeJson, "utf8")).toBe("{not json");
  });
});

describe("allowlist", () => {
  it("merges defaults + MCP server approval into settings.local.json without dropping user entries", () => {
    mkdirSync(join(ws, ".claude"));
    const path = join(ws, ".claude", "settings.local.json");
    writeFileSync(path, JSON.stringify({ permissions: { allow: ["Bash", "WebFetch"], deny: ["Read(./.env)"] }, model: "x" }));
    const r = allowClaudeWorkspace(ws);
    expect(r.changed).toBe(true);
    const s = json(path);
    expect(s.model).toBe("x");
    expect(s.permissions.deny).toEqual(["Read(./.env)"]);
    expect(s.permissions.allow).toEqual(["Bash", "WebFetch", ...DEFAULT_CLAUDE_ALLOW.filter((a) => a !== "Bash")]);
    expect(s.enabledMcpjsonServers).toEqual(["underwright"]);
    expect(allowClaudeWorkspace(ws).changed).toBe(false);
    expect(existsSync(join(ws, ".claude", "settings.json"))).toBe(false);
  });

  it("honours custom allow list and the shared settings.json option", () => {
    const r = allowClaudeWorkspace(ws, { allow: ["Read"], settingsFile: "settings.json" });
    expect(r.path).toBe(join(realpathSync(ws), ".claude", "settings.json"));
    expect(json(r.path).permissions.allow).toEqual(["Read"]);
  });
});

describe("prepareHarnessWorkspace", () => {
  it("does all gates for claude and is a no-op for other harnesses", () => {
    const r = prepareHarnessWorkspace("claude", ws, { claudeJson });
    expect(r).toMatchObject({ supported: true, trust: { changed: true }, allowlist: { changed: true } });
    expect(prepareHarnessWorkspace("codex", ws, { claudeJson })).toEqual({ harness: "codex", workspace: ws, supported: false });
    expect(harnessKind("worker-1", "/usr/local/bin/claude")).toBe("claude");
    expect(harnessKind("claude@minipc")).toBe("claude");
  });
});

describe("launch-agent executor hook", () => {
  const node = process.execPath;
  const policy = { allowed_task_types: ["launch-agent"] as any, workspace_ids: ["w1"], repository_ids: [] as string[] };
  const task = { id: "t1", type: "launch-agent" as const, params: { workspace_id: "w1", harness: "claude", prompt: "hi" } };
  const harnesses = { claude: { executable: node, args: ["-e", "console.log('ran')", "--"] } };

  it("prepares the launch dir before spawning when enabled", async () => {
    const reg = createExecutorRegistry(policy, { workspaces: { w1: ws }, harnesses, prepareHarnesses: { claudeJson } });
    const r = await reg.execute(task);
    expect(r).toMatchObject({ status: "done" });
    expect(json(claudeJson).projects[realpathSync(ws)].hasTrustDialogAccepted).toBe(true);
    expect(json(join(ws, ".claude", "settings.local.json")).permissions.allow).toContain("mcp__underwright");
  });

  it("is off by default and fails cleanly when prep cannot write", async () => {
    await createExecutorRegistry(policy, { workspaces: { w1: ws }, harnesses }).execute(task);
    expect(existsSync(join(ws, ".claude"))).toBe(false);
    mkdirSync(join(root, "home"));
    writeFileSync(claudeJson, "garbage");
    const r = await createExecutorRegistry(policy, { workspaces: { w1: ws }, harnesses, prepareHarnesses: { claudeJson } }).execute(task);
    expect(r.status).toBe("failed");
    expect(r.result).toMatch(/^harness setup failed: refusing to rewrite unparseable JSON/);
  });
});
