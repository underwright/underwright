import { afterEach, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deriveState, mergeQuota, mergeUsageQuota, paceByHarness, paceForHarness, paceWeights, sampleRow, type UsageRow } from "../src/quota-usage.js";
import { nodeHeartbeatSchema, nodeHarnessSchema, quotaAllows } from "../src/node-protocol.js";
import { launchableHarnesses } from "../src/node-dispatch.js";
import { aggregateProviders } from "../src/provider-health.js";
import { pendingUsage, readUsageSources } from "../src/node-run.js";

// gh-149: quota pacing — usage samples → burn rate, pace, projection, routing.

const H = 3_600_000;
const NOW = Date.parse("2026-11-18T12:00:00Z");
const iso = (ms: number) => new Date(ms).toISOString();
const cleanup: (() => void)[] = [];
afterEach(() => cleanup.splice(0).forEach(f => f()));

/** Weekly window that resets 3.5 days from NOW → 50% elapsed. */
const WEEK_RESET = iso(NOW + 3.5 * 24 * H);

it("heartbeat schema accepts usage samples and rejects malformed ones", () => {
  const ok = nodeHeartbeatSchema.safeParse({
    session_id: "s1",
    usage: [{ harness: "grok", tokens_in: 10, tokens_out: 5, cost: 0.1, window_used_pct: 21, window_kind: "weekly", resets_at: WEEK_RESET, vendor_state: "available", sampled_at: iso(NOW) }],
  });
  expect(ok.success).toBe(true);
  // negative: unknown window kind, unknown field, missing sampled_at
  expect(nodeHeartbeatSchema.safeParse({ session_id: "s1", usage: [{ harness: "grok", window_kind: "hourly", sampled_at: iso(NOW) }] }).success).toBe(false);
  expect(nodeHeartbeatSchema.safeParse({ session_id: "s1", usage: [{ harness: "grok", bogus: 1, sampled_at: iso(NOW) }] }).success).toBe(false);
  expect(nodeHeartbeatSchema.safeParse({ session_id: "s1", usage: [{ harness: "grok" }] }).success).toBe(false);
  expect(nodeHeartbeatSchema.safeParse({ session_id: "s1", usage: [{ harness: "grok", tokens_in: -1, sampled_at: iso(NOW) }] }).success).toBe(false);
});

it("rate_limited is a first-class quota state that blocks until resets_at, then re-enters alone", () => {
  const h = nodeHarnessSchema.parse({ id: "claude", installed: true, auth_status: "ready", quota: { state: "rate_limited", resets_at: iso(NOW + H) } });
  expect(h.quota.state).toBe("rate_limited");
  expect(quotaAllows(h.quota, NOW)).toBe(false);
  expect(quotaAllows(h.quota, NOW + H + 1)).toBe(true);   // no fresh attestation needed
  expect(quotaAllows({ state: "rate_limited" }, NOW)).toBe(false); // no reset → stays blocked
});

it("derives quota state from vendor state and window %", () => {
  expect(deriveState({ vendor_state: "rate_limited", resets_at: iso(NOW + H) }, NOW)).toBe("rate_limited");
  expect(deriveState({ vendor_state: "rate_limited", resets_at: iso(NOW - 1) }, NOW)).toBe("available");
  expect(deriveState({ vendor_state: "exhausted" }, NOW)).toBe("exhausted");
  expect(deriveState({ window_used_pct: 99.7, resets_at: iso(NOW + H) }, NOW)).toBe("exhausted");
  expect(deriveState({ window_used_pct: 60 }, NOW)).toBe("available");
  expect(deriveState({}, NOW)).toBe("unknown");
});

it("manual override beats derived state; otherwise the more restrictive wins", () => {
  const pace = paceForHarness("claude", [{ node_id: "n", harness: "claude", sampled_at: iso(NOW), vendor_state: "rate_limited", resets_at: iso(NOW + H) }], NOW)!;
  expect(mergeQuota({ state: "available" }, pace)).toMatchObject({ state: "rate_limited", resets_at: iso(NOW + H), source: "usage" });
  expect(mergeQuota({ state: "available", override: true }, pace)).toEqual({ state: "available", override: true });
  expect(mergeQuota({ state: "exhausted", resets_at: iso(NOW + 9 * H) }, pace).state).toBe("exhausted");
  const caps = mergeUsageQuota(JSON.stringify({ harnesses: [{ id: "claude", quota: { state: "available" } }, { id: "codex", quota: { state: "available" } }] }), new Map([["claude", pace]]));
  const parsed = JSON.parse(caps);
  expect(parsed.harnesses[0].quota.state).toBe("rate_limited");
  expect(parsed.harnesses[1].quota.state).toBe("available");
});

it("computes burn rate, pace delta and projected % at reset from history", () => {
  // grok: weekly window 50% elapsed. 10% → 30% over the last 10h = 2%/h;
  // 84h remain → projects 30 + 2*84 = 198% (way ahead of pace, exhausts early).
  const rows: UsageRow[] = [
    { node_id: "a", harness: "grok", sampled_at: iso(NOW - 10 * H), tokens_in: 1000, tokens_out: 500, cost: 1, window_used_pct: 10, window_kind: "weekly", resets_at: WEEK_RESET },
    { node_id: "a", harness: "grok", sampled_at: iso(NOW - 5 * H), tokens_in: 3000, tokens_out: 1500, cost: 3, window_used_pct: 20, window_kind: "weekly", resets_at: WEEK_RESET },
    // counter reset on node a (new session): post-reset value counts as burn
    { node_id: "a", harness: "grok", sampled_at: iso(NOW), tokens_in: 500, tokens_out: 0, cost: 0.5, window_used_pct: 30, window_kind: "weekly", resets_at: WEEK_RESET },
    // second node contributes token burn only
    { node_id: "b", harness: "grok", sampled_at: iso(NOW - 10 * H), tokens_in: 0, tokens_out: 0 },
    { node_id: "b", harness: "grok", sampled_at: iso(NOW - H), tokens_in: 1000, tokens_out: 0 },
  ];
  const p = paceByHarness(rows, NOW).get("grok")!;
  expect(p.nodes).toBe(2);
  expect(p.window_used_pct).toBe(30);
  expect(p.expected_pct).toBe(50);
  expect(p.pace_delta).toBe(-20);              // behind the linear-to-100% curve
  expect(p.pct_per_hr).toBe(2);
  expect(p.projected_pct_at_reset).toBe(198);
  // tokens: node a (2000+1000) + (500) + node b 1000 = 4500 over 10h
  expect(p.tokens_per_hr).toBe(450);
  expect(p.cost_per_hr).toBe(0.25);            // (2 + 0.5) / 10h
  expect(p.derived_state).toBe("available");
});

it("projects under-use: a slow burner finishes the week well short of 100%", () => {
  const rows: UsageRow[] = [
    { node_id: "a", harness: "grok", sampled_at: iso(NOW - 24 * H), window_used_pct: 20, window_kind: "weekly", resets_at: WEEK_RESET },
    { node_id: "a", harness: "grok", sampled_at: iso(NOW), window_used_pct: 26, window_kind: "weekly", resets_at: WEEK_RESET },
  ];
  const p = paceForHarness("grok", rows, NOW)!;
  expect(p.pct_per_hr).toBe(0.25);
  expect(p.projected_pct_at_reset).toBe(47);   // 26 + 0.25*84
  expect(p.pace_delta).toBe(-24);
});

it("pace-aware routing prefers the ready harness behind its window-pace curve", () => {
  const caps = JSON.stringify({ harnesses: [
    { id: "claude", installed: true, auth_status: "ready", quota: { state: "available" } },
    { id: "grok", installed: true, auth_status: "ready", quota: { state: "available" } },
  ] });
  const order = ["claude", "grok"];
  // no samples → static harness_order
  expect(launchableHarnesses(caps, order, NOW)).toEqual(["claude", "grok"]);
  const rows: UsageRow[] = [
    { node_id: "a", harness: "claude", sampled_at: iso(NOW), window_used_pct: 80, window_kind: "weekly", resets_at: WEEK_RESET }, // +30 ahead
    { node_id: "a", harness: "grok", sampled_at: iso(NOW), window_used_pct: 20, window_kind: "weekly", resets_at: WEEK_RESET },   // -30 behind
  ];
  const weights = paceWeights(paceByHarness(rows, NOW));
  expect(weights.grok).toBeLessThan(weights.claude);
  expect(launchableHarnesses(caps, order, NOW, [], weights)).toEqual(["grok", "claude"]);
  // inside the deadband both read on-pace → harness_order still breaks the tie
  const near = paceWeights(paceByHarness([
    { node_id: "a", harness: "claude", sampled_at: iso(NOW), window_used_pct: 51, window_kind: "weekly", resets_at: WEEK_RESET },
    { node_id: "a", harness: "grok", sampled_at: iso(NOW), window_used_pct: 49, window_kind: "weekly", resets_at: WEEK_RESET },
  ], NOW));
  expect(launchableHarnesses(caps, order, NOW, [], near)).toEqual(["claude", "grok"]);
});

it("providers panel rows carry window position, burn and projection", () => {
  const nodes = [{ name: "box", harnesses: [
    { id: "grok", installed: true, auth_status: "ready", quota: { state: "available" } },
    { id: "claude", installed: true, auth_status: "ready", quota: { state: "available" } },
  ] }];
  const pace = paceByHarness([
    { node_id: "a", harness: "grok", sampled_at: iso(NOW - 24 * H), window_used_pct: 20, window_kind: "weekly", resets_at: WEEK_RESET },
    { node_id: "a", harness: "grok", sampled_at: iso(NOW), window_used_pct: 26, window_kind: "weekly", resets_at: WEEK_RESET },
    { node_id: "a", harness: "claude", sampled_at: iso(NOW), vendor_state: "rate_limited", resets_at: iso(NOW + H) },
  ], NOW);
  const rows = aggregateProviders(nodes, [], [{ agent_id: "grok@box", status: "done", n: 12 }], NOW, pace);
  const by = Object.fromEntries(rows.map(r => [r.id, r]));
  expect(by.grok.usage?.projected_pct_at_reset).toBe(47);
  expect(by.grok.usage?.window_kind).toBe("weekly");
  expect(by.grok.jobs_per_hr).toBe(2);
  expect(by.claude.rate_limited).toBe(1);
  expect(by.claude.ready).toBe(0);
  expect(by.claude.resets_at).toBe(iso(NOW + H));
});

it("daemon reads usage source files, skips bad ones, and resends only unacked readings", () => {
  const dir = mkdtempSync(join(tmpdir(), "uw-usage-src-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, "grok.json"), JSON.stringify({ window_used_pct: 40, window_kind: "weekly", sampled_at: iso(NOW) }));
  writeFileSync(join(dir, "bad.json"), "{not json");
  writeFileSync(join(dir, "invalid.json"), JSON.stringify({ window_kind: "fortnightly", sampled_at: iso(NOW) }));
  const samples = readUsageSources({
    grok: { file: join(dir, "grok.json") },
    bad: { file: join(dir, "bad.json") },
    invalid: { file: join(dir, "invalid.json") },
    missing: { file: join(dir, "nope.json") },
  });
  expect(samples).toEqual([{ harness: "grok", window_used_pct: 40, window_kind: "weekly", sampled_at: iso(NOW) }]);
  const acked = new Map<string, string>();
  expect(pendingUsage(samples, acked)).toHaveLength(1);
  acked.set("grok", iso(NOW));
  expect(pendingUsage(samples, acked)).toHaveLength(0);
});

it("sampleRow normalizes timestamps to UTC ISO", () => {
  const r = sampleRow("n", { harness: "grok", sampled_at: "2026-11-18T07:00:00-05:00", resets_at: "2026-11-20T00:00:00+00:00" });
  expect(r.sampled_at).toBe("2026-11-18T12:00:00.000Z");
  expect(r.resets_at).toBe("2026-11-20T00:00:00.000Z");
  expect(r.tokens_in).toBeNull();
});
