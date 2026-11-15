import { expect, it } from "vitest";
import { aggregateProviders, classifyFailure } from "../src/provider-health.js";

it("classifies execution failures into provider issue buckets", () => {
  expect(classifyFailure("Error: inner executor error: Your workspace is out of credits.; codexErrorInfo=usageLimitExceeded")).toBe("billing");
  expect(classifyFailure("You've hit your 5-hour limit · resets 8:50am (America/New_York)")).toBe("rate_limit");
  expect(classifyFailure("error: a value is required for '--single <PROMPT>' but none was supplied")).toBe("config");
  expect(classifyFailure("the REPL-only option(s) -p/--prompt have no effect there")).toBe("config");
  expect(classifyFailure("AntigravityExecutor requires the 'google-antigravity' package")).toBe("config");
  expect(classifyFailure("aborted")).toBe("aborted");
  expect(classifyFailure("HTTP 401 unauthorized")).toBe("auth");
  expect(classifyFailure("something weird")).toBe("other");
  expect(classifyFailure(null)).toBe("other");
});

it("aggregates attested quota, job activity, and issues per provider", () => {
  const nodes = [
    { name: "desktop", harnesses: [
      { id: "claude", installed: true, auth_status: "ready", quota: { state: "exhausted", resets_at: "2026-11-16T16:46:00Z" } },
      { id: "grok", installed: true, auth_status: "ready", quota: { state: "unknown" } },
      { id: "opencode", installed: false, auth_status: "unknown", quota: { state: "unknown" } }, // not installed → skipped
    ] },
    { name: "laptop", harnesses: [
      { id: "claude", installed: true, auth_status: "ready", quota: { state: "unknown" } },
      { id: "grok", installed: true, auth_status: "unknown", quota: { state: "unknown" } },
    ] },
  ];
  const failures = [
    { agent_id: "codex@desktop", result: "x\nYour workspace is out of credits", finished_at: "2026-11-15T13:00:00Z" },
    { agent_id: "codex@desktop", result: "x\nusageLimitExceeded", finished_at: "2026-11-15T13:05:00Z" },
    { agent_id: "claude@laptop", result: "x\nYou've hit your 5-hour limit · resets 8:50am", finished_at: "2026-11-15T13:10:00Z" },
  ];
  const counts = [
    { agent_id: "codex@desktop", status: "failed", n: 7 },
    { agent_id: "claude@laptop", status: "done", n: 2 },
    { agent_id: "grok@desktop", status: "failed", n: 3 },
  ];

  const rows = aggregateProviders(nodes, failures, counts, Date.parse("2026-11-15T13:20:00Z"));
  const byId = Object.fromEntries(rows.map(r => [r.id, r]));

  expect(byId.claude.nodes).toBe(2);
  expect(byId.claude.ready).toBe(1);          // desktop exhausted+past-reset? no — future reset → blocked; laptop ready
  expect(byId.claude.exhausted).toBe(1);
  expect(byId.claude.resets_at).toBe("2026-11-16T16:46:00Z");
  expect(byId.claude.jobs_6h.done).toBe(2);
  expect(byId.claude.issues[0].kind).toBe("rate_limit");

  expect(byId.grok.nodes).toBe(2);
  expect(byId.grok.ready).toBe(1);            // desktop auth ready; laptop auth unknown → not ready
  expect(byId.grok.jobs_6h.failed).toBe(3);

  expect(byId.codex.nodes).toBe(0);           // never attested installed — jobs still surface it
  expect(byId.codex.jobs_6h.failed).toBe(7);
  expect(byId.codex.issues[0].kind).toBe("billing");
  expect(byId.codex.issues[0].count).toBe(2);
  expect(byId.codex.issues[0].last_msg).toBe("usageLimitExceeded"); // newer failure wins excerpt

  expect(byId.opencode).toBeUndefined();       // not installed anywhere

  // billing sorts first (severity), before clean providers
  expect(rows[0].id).toBe("codex");
});

it("treats exhausted with a past resets_at as usable again", () => {
  const rows = aggregateProviders(
    [{ name: "n", harnesses: [{ id: "grok", installed: true, auth_status: "ready", quota: { state: "exhausted", resets_at: "2026-11-10T00:00:00Z" } }] }],
    [], [], Date.parse("2026-11-15T13:20:00Z"));
  expect(rows[0].ready).toBe(1);
  expect(rows[0].exhausted).toBe(1);          // still declared exhausted, but allowed
  expect(rows[0].resets_at).toBeNull();        // reset is past → nothing upcoming
});
