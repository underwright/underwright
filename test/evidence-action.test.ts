import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import type { Server } from "node:http";
import { serveHttp } from "../src/server.js";
import { SqliteStore } from "../src/store.js";
// @ts-expect-error plain ESM action entrypoint, no type declarations
import { buildReport, main, mcpEndpoint, parseRpc } from "../action/evidence-check/index.mjs";

const ACTION_DIR = join(import.meta.dirname, "..", "action", "evidence-check");

/** Minimal reader for the flat action.yml shape: top-level keys and one nesting level of maps. */
function readActionYaml(text: string) {
  const top: Record<string, any> = {};
  let section: string | undefined;
  let entry: string | undefined;
  for (const line of text.split("\n")) {
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const indent = line.length - line.trimStart().length;
    const m = line.trim().match(/^([\w-]+):\s*(.*)$/);
    if (!m) continue;
    const [, key, value] = m;
    if (indent === 0) { section = key; entry = undefined; top[key] = value || {}; }
    else if (indent === 2 && section) { entry = key; top[section][key] = value || {}; }
    else if (indent === 4 && section && entry) top[section][entry][key] = value.replace(/^"(.*)"$/, "$1");
  }
  return top;
}

describe("evidence-check action.yml (AC action-yaml)", () => {
  it("declares a node20 action with the documented inputs and evidence-id output", () => {
    const yml = readActionYaml(readFileSync(join(ACTION_DIR, "action.yml"), "utf8"));
    expect(yml.runs).toMatchObject({ using: "node20", main: "index.mjs" });
    expect(existsSync(join(ACTION_DIR, yml.runs.main))).toBe(true);
    for (const name of ["url", "token", "task-id", "agent-id", "kind", "ac-ids", "status", "exit-code", "command", "output", "output-file", "fail-on-error"]) {
      expect(yml.inputs[name], `input ${name}`).toBeTypeOf("object");
    }
    expect(yml.inputs.kind.default).toBe("ci_check");
    expect(yml.inputs["fail-on-error"].default).toBe("true");
    expect(yml.outputs["evidence-id"]).toBeTypeOf("object");
  });
});

describe("evidence-check input handling", () => {
  it("normalises base urls to /mcp and keeps explicit paths", () => {
    expect(mcpEndpoint("https://uw.example.com")).toBe("https://uw.example.com/mcp");
    expect(mcpEndpoint("https://uw.example.com/mcp")).toBe("https://uw.example.com/mcp");
  });

  it("skips without a url or a task", () => {
    expect(buildReport({ "INPUT_TASK-ID": "task-1" }).skip).toMatch(/url/);
    expect(buildReport({ INPUT_URL: "http://x" }).skip).toMatch(/no task/);
  });

  it("maps status, resolves the task from the PR and clips long output to the tail", () => {
    const dir = mkdtempSync(join(tmpdir(), "uw-evact-"));
    const event = join(dir, "event.json");
    writeFileSync(event, JSON.stringify({ pull_request: { body: "fixes uw:task-abc123", head: { ref: "feat/gh-9" } } }));
    const r = buildReport({
      INPUT_URL: "http://x", INPUT_STATUS: "failure", INPUT_OUTPUT: "x".repeat(70_000) + "END",
      "INPUT_AC-IDS": "a, b c", GITHUB_EVENT_PATH: event, GITHUB_ACTOR: "octo",
    });
    expect(r.args).toMatchObject({ task_id: "task-abc123", agent_id: "ci@octo", kind: "ci_check", exit_code: 1, ac_ids: ["a", "b", "c"] });
    expect(r.args.output.length).toBeLessThan(61_000);
    expect(r.args.output.endsWith("END")).toBe(true);
    expect(buildReport({ INPUT_URL: "http://x", "INPUT_TASK-ID": "t", INPUT_STATUS: "failure", "INPUT_EXIT-CODE": "0" }).args.exit_code).toBe(0);
    expect(() => buildReport({ INPUT_URL: "http://x", "INPUT_TASK-ID": "t", INPUT_KIND: "review" })).toThrow(/ci_check or smoke_test/);
    rmSync(dir, { recursive: true, force: true });
  });

  it("parses JSON and SSE bodies", () => {
    expect(parseRpc('{"jsonrpc":"2.0","id":2,"result":{"ok":1}}', "application/json", 2)).toEqual({ ok: 1 });
    expect(parseRpc('event: message\ndata: {"jsonrpc":"2.0","id":2,"result":{"ok":2}}\n\n', "text/event-stream", 2)).toEqual({ ok: 2 });
    expect(() => parseRpc('{"jsonrpc":"2.0","id":2,"error":{"code":-32601,"message":"nope"}}', "application/json", 2)).toThrow(/nope/);
  });
});

describe("evidence-check against a live control plane (AC evidence-post)", () => {
  const dir = mkdtempSync(join(tmpdir(), "uw-evact-live-"));
  const db = join(dir, "uw.db");
  const TOKEN = "ci-secret-token";
  let http: Server;
  let base: string;
  let taskId: string;

  beforeAll(async () => {
    const seed = new SqliteStore(db);
    taskId = (seed.createTask({ title: "action target", ac_ids: ["ci-green", "smoke"] }) as any).id;
    seed.close();
    http = await serveHttp(db, "127.0.0.1", 0, TOKEN, { mode: "token", allowed_users: [] });
    base = `http://127.0.0.1:${(http.address() as any).port}`;
  });

  afterAll(async () => {
    const closed = once(http, "close");
    http.close();
    await closed;
    rmSync(dir, { recursive: true, force: true });
  });

  const run = (env: Record<string, string>) => {
    const lines: string[] = [];
    return main(env, { log: (l: string) => lines.push(l) }).then((code: number) => ({ code, lines }));
  };

  it("posts ci_check and smoke_test evidence and writes the evidence-id output", async () => {
    const ghOut = join(dir, "gh-output");
    writeFileSync(ghOut, "");
    const ci = await run({
      INPUT_URL: base, INPUT_TOKEN: TOKEN, "INPUT_TASK-ID": taskId, "INPUT_AC-IDS": "ci-green",
      INPUT_STATUS: "success", INPUT_OUTPUT: "all 42 tests passed", GITHUB_OUTPUT: ghOut,
      GITHUB_SERVER_URL: "https://github.com", GITHUB_REPOSITORY: "o/r", GITHUB_RUN_ID: "77", GITHUB_SHA: "deadbeef",
    });
    expect(ci.code).toBe(0);
    const evidenceId = readFileSync(ghOut, "utf8").match(/^evidence-id=(ev-[\w-]+)$/m)?.[1];
    expect(evidenceId).toBeDefined();

    const smoke = await run({
      UNDERWRIGHT_URL: `${base}/mcp`, UNDERWRIGHT_TOKEN: TOKEN, UNDERWRIGHT_TASK_ID: taskId,
      INPUT_KIND: "smoke_test", "INPUT_AC-IDS": "smoke", INPUT_STATUS: "failure", INPUT_COMMAND: "curl /health",
    });
    expect(smoke.code).toBe(0);

    const store = new SqliteStore(db);
    const rows = store.getEvidence(taskId) as any[];
    store.close();
    const ciRow = rows.find(r => r.id === evidenceId);
    expect(ciRow).toMatchObject({ kind: "ci_check", exit_code: 0, agent_id: "ci@github-actions" });
    expect(JSON.parse(ciRow.ac_ids)).toEqual(["ci-green"]);
    expect(ciRow.output).toContain("run: https://github.com/o/r/actions/runs/77");
    expect(ciRow.output).toContain("all 42 tests passed");
    const smokeRow = rows.find(r => r.kind === "smoke_test");
    expect(smokeRow).toMatchObject({ exit_code: 1, command: "curl /health" });
    expect(JSON.parse(smokeRow.ac_ids)).toEqual(["smoke"]);
  });

  it("fails on a bad token without leaking it, or warns when fail-on-error is false", async () => {
    const bad = await run({ INPUT_URL: base, INPUT_TOKEN: "wrong-token", "INPUT_TASK-ID": taskId });
    expect(bad.code).toBe(1);
    expect(bad.lines.join("\n")).toMatch(/::error .*HTTP 401/);
    expect(bad.lines.join("\n")).not.toContain("wrong-token");
    const soft = await run({ INPUT_URL: base, INPUT_TOKEN: "wrong-token", "INPUT_TASK-ID": taskId, "INPUT_FAIL-ON-ERROR": "false" });
    expect(soft.code).toBe(0);
    expect(soft.lines.join("\n")).toMatch(/::warning /);
  });

  it("skips cleanly with exit 0 when nothing is configured", async () => {
    const r = await run({});
    expect(r.code).toBe(0);
    expect(r.lines[0]).toMatch(/skipped/);
  });
});
