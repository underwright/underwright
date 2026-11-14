import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteStore } from "../src/store.js";
import { renderDashboard } from "../src/dashboard.js";
import { LAUNCH_PROMPT } from "../src/dispatcher.js";
import { ARTIFACT_KINDS } from "../src/schema.js";

const DB = "/tmp/uw-test-escalation.db";
let store: SqliteStore;

beforeEach(() => {
  for (const suffix of ["", "-wal", "-shm"]) rmSync(`${DB}${suffix}`, { force: true });
  process.env.UNDERWRIGHT_POLICY = "/tmp/uw-no-policy.json";
  store = new SqliteStore(DB);
});
afterEach(() => store.close());

describe("blocked artifact kind", () => {
  it("accepts kind blocked, records a distinct event, and surfaces the task on the board", () => {
    const task = store.createTask({ title: "stuck", ac_ids: ["a"], type: "triage", estimate: "S" });
    store.watchTask("alan", task.id);
    const posted = store.postArtifact({
      task_id: task.id,
      agent_id: "grok@alandesktop",
      kind: "blocked",
      title: "could not migrate",
      content: "tried search_context, task artifacts, and the alternate harness CLI",
    }) as { id: string; error?: string };

    expect(posted.error).toBeUndefined();
    expect(store.listArtifacts(task.id).map((a: any) => a.kind)).toContain("blocked");
    expect(store.getTask(task.id).artifacts.map((a: any) => a.kind)).toContain("blocked");
    expect(store.board().tasks).toContainEqual(expect.objectContaining({
      id: task.id, blocked_artifacts: 1,
    }));

    const actions = (store.auditLog(20) as any[]).filter((e) => e.action === "blocked");
    expect(actions.map((e) => e.entity_type).sort()).toEqual(["artifact", "task"]);
    expect(store.inbox("alan").some((m: any) => /escalat/i.test(m.body))).toBe(true);
  });

  it("rejects an unknown artifact kind", () => {
    const task = store.createTask({ title: "x", ac_ids: ["a"], type: "triage", estimate: "S" });
    const posted = store.postArtifact({
      task_id: task.id, agent_id: "a", kind: "nope", content: "x",
    }) as { error?: string };
    expect(posted.error).toMatch(/unknown artifact kind/);
  });

  it("keeps existing artifacts when widening the kind check", () => {
    store.close();
    for (const suffix of ["", "-wal", "-shm"]) rmSync(`${DB}${suffix}`, { force: true });
    const db = new Database(DB);
    db.exec(`
      CREATE TABLE tasks (
        id TEXT PRIMARY KEY, title TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open',
        priority INTEGER NOT NULL DEFAULT 2, created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE artifacts (
        id TEXT PRIMARY KEY, task_id TEXT REFERENCES tasks(id), agent_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('spec','design','handoff','note','review')),
        title TEXT NOT NULL DEFAULT '', content TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO tasks (id, title) VALUES ('t1', 'old');
      INSERT INTO artifacts (id, task_id, agent_id, kind, content) VALUES ('a1', 't1', 'a', 'note', 'kept');
      PRAGMA user_version = 6;
    `);
    db.close();
    store = new SqliteStore(DB);
    expect(store.listArtifacts("t1").map((a: any) => a.content)).toEqual(["kept"]);
    expect(store.postArtifact({
      task_id: "t1", agent_id: "a", kind: "blocked", content: "still stuck",
    })).not.toHaveProperty("error");
    expect(store.listArtifacts("t1").map((a: any) => a.kind).sort()).toEqual(["blocked", "note"]);
  });
});

describe("dashboard blocked surface", () => {
  it("renders escalations and blocked events apart from ordinary rows", () => {
    const html = renderDashboard({
      tasks: [
        { id: "gh-38", title: "Anti-escalation", status: "claimed", priority: 1, claimed_by: "grok", blocked_artifacts: 1 },
        { id: "gh-17", title: "Deps", status: "blocked", priority: 2, claimed_by: null, blocked_artifacts: 0 },
        { id: "gh-1", title: "Plain", status: "open", priority: 3, claimed_by: null },
      ],
      events: [
        { created_at: "2026-01-01", actor: "grok", action: "blocked", entity_type: "task", entity_id: "gh-38", data: "{\"artifact_id\":\"art-1\"}" },
        { created_at: "2026-01-01", actor: "grok", action: "posted", entity_type: "artifact", entity_id: "art-2", data: { kind: "note" } },
      ],
    });

    expect(html).toContain("Blocked escalations");
    expect(html).toContain("badge-blocked");
    expect(html).toContain("gh-38");
    const escalation = html.split("Blocked escalations")[1]?.split("<h2>")[0] ?? "";
    expect(escalation).toContain("gh-38");
    expect(escalation).not.toContain("gh-1");
    expect(html).toContain('<tr class="blocked">');
    const events = html.split("Recent events")[1] ?? "";
    expect(events).toContain('<tr class="blocked">');
    expect(events).toContain('<tr><td data-label="Time">2026-01-01</td>');
  });
});

describe("escalation protocol text", () => {
  it("documents the protocol in AGENTS.md, server instructions, and the launch prompt", () => {
    const agents = readFileSync(new URL("../AGENTS.md", import.meta.url), "utf8");
    const server = readFileSync(new URL("../src/server.ts", import.meta.url), "utf8");
    const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
    const harness = readFileSync(new URL("../docs/multi-harness.md", import.meta.url), "utf8");

    for (const text of [agents, server]) {
      expect(text).toMatch(/search_context/);
      expect(text).toMatch(/artifact/i);
      expect(text).toMatch(/alternate harness/i);
      expect(text).toMatch(/kind[^\n]{0,40}blocked/);
      expect(text).toMatch(/send_message/);
      expect(text).toMatch(/do not go idle|do not idle/i);
    }
    expect(readme).toContain(LAUNCH_PROMPT);
    expect(harness).toContain(LAUNCH_PROMPT);
    expect(LAUNCH_PROMPT).toMatch(/search_context/);
    expect(LAUNCH_PROMPT).toMatch(/kind=blocked/);
    expect(LAUNCH_PROMPT).toMatch(/send_message/);
    expect(LAUNCH_PROMPT).toMatch(/do not idle/i);
    expect(ARTIFACT_KINDS).toContain("blocked");
    expect(server).toMatch(/z\.enum\(\[[^\]]*["']blocked["']/);
  });
});

describe("fresh database accepts blocked without a legacy table", () => {
  it("opens a temp store and posts blocked", () => {
    const dir = mkdtempSync(join(tmpdir(), "uw-esc-"));
    const fresh = new SqliteStore(join(dir, "store.db"));
    try {
      const task = fresh.createTask({ title: "fresh", ac_ids: ["a"], type: "triage", estimate: "S" });
      expect(fresh.postArtifact({
        task_id: task.id, agent_id: "a", kind: "blocked", content: "tried the alternates",
      })).not.toHaveProperty("error");
    } finally {
      fresh.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
