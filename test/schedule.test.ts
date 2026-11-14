import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { SqliteStore } from "../src/store.js";
import {
  cronMatches, getSchedulePolicy, isDue, lastRun, parseCron, parseDuration,
  runDueSchedules, startScheduler, SCHEDULER_ACTOR, type ScheduleEntry,
} from "../src/schedule.js";
import type { Policy } from "../src/policy.js";

// Scheduled activities (task-9f0e5ba9): policy schedule[] → digest / build /
// node_health actions, durable last-run in the audit log.

const cleanup: (() => void)[] = [];
afterEach(() => { cleanup.splice(0).reverse().forEach(f => f()); });

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "uw-schedule-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const store: any = new SqliteStore(join(dir, "store.db"));
  cleanup.push(() => store.close());
  return { store, path: join(dir, "store.db") };
}

const policy = (schedule: unknown): Policy => ({ dod: {}, enforcement: "observe", schedule } as any);
const T = (iso: string) => Date.parse(iso);

describe("schedule policy parsing (schedule-policy)", () => {
  it("accepts every/cron entries and normalizes fields", () => {
    const { entries, errors } = getSchedulePolicy(policy([
      { id: "digest", cron: "0 9 * * 1-5", action: "digest", to: "alan", since: "24h" },
      { id: "build", every: "6h", action: "build", command: "npm test", target_agent_id: "runner@minipc" },
      { id: "nodes", every: 900, action: "node_health", to: "alan", enabled: false },
    ]));
    expect(errors).toEqual([]);
    expect(entries.map(e => e.id)).toEqual(["digest", "build", "nodes"]);
    expect(entries[0]).toMatchObject({ action: "digest", cron_text: "0 9 * * 1-5", to: "alan", since: "24h", enabled: true });
    expect(entries[1]).toMatchObject({ every_ms: 6 * 3_600_000, command: "npm test", target_agent_id: "runner@minipc" });
    expect(entries[2]).toMatchObject({ every_ms: 900_000, enabled: false });
  });

  it("missing block is empty; non-array is an error", () => {
    expect(getSchedulePolicy(policy(undefined))).toEqual({ entries: [], errors: [] });
    expect(getSchedulePolicy(policy({})).errors).toEqual(["schedule must be an array"]);
  });

  it("skips invalid entries without dropping valid ones", () => {
    const { entries, errors } = getSchedulePolicy(policy([
      { id: "ok", every: "1h", action: "digest" },
      { id: "ok", every: "1h", action: "digest" },             // duplicate
      { id: "bad id!", every: "1h", action: "digest" },
      { id: "both", every: "1h", cron: "* * * * *", action: "digest" },
      { id: "neither", action: "digest" },
      { id: "fast", every: "10s", action: "digest" },           // < 60s
      { id: "cronbad", cron: "61 * * * *", action: "digest" },
      { id: "verb", every: "1h", action: "rm -rf" },
      { id: "nobuild", every: "1h", action: "build" },
      { id: "nohealth", every: "1h", action: "node_health" },
      { id: "emptyto", every: "1h", action: "digest", to: "  " },
      "nope",
    ]));
    expect(entries.map(e => e.id)).toEqual(["ok"]);
    expect(errors).toHaveLength(11);
    expect(errors.join("\n")).toMatch(/duplicate id ok/);
    expect(errors.join("\n")).toMatch(/build requires command/);
  });
});

describe("cadence math", () => {
  it("parses durations", () => {
    expect(parseDuration("15m")).toBe(900_000);
    expect(parseDuration("1d")).toBe(86_400_000);
    expect(parseDuration(120)).toBe(120_000);
    expect(parseDuration("soon")).toBeNull();
  });

  it("matches cron fields (UTC) with lists, ranges, steps and Sunday=7", () => {
    const weekday9 = parseCron("0 9 * * 1-5")!;
    expect(cronMatches(weekday9, new Date("2026-11-09T09:00:00Z"))).toBe(true);  // Monday
    expect(cronMatches(weekday9, new Date("2026-11-08T09:00:00Z"))).toBe(false); // Sunday
    expect(cronMatches(weekday9, new Date("2026-11-09T09:01:00Z"))).toBe(false);
    const quarter = parseCron("*/15 * * * *")!;
    expect([0, 15, 30, 45].every(m => cronMatches(quarter, new Date(Date.UTC(2026, 0, 1, 3, m))))).toBe(true);
    expect(cronMatches(quarter, new Date(Date.UTC(2026, 0, 1, 3, 7)))).toBe(false);
    expect(cronMatches(parseCron("0 0 * * 7")!, new Date("2026-11-08T00:00:00Z"))).toBe(true);
    // dom and dow both restricted: either matches (Vixie semantics).
    const either = parseCron("0 0 1 * 1")!;
    expect(cronMatches(either, new Date("2026-12-01T00:00:00Z"))).toBe(true);  // 1st (Tue)
    expect(cronMatches(either, new Date("2026-11-09T00:00:00Z"))).toBe(true);  // Monday
    expect(cronMatches(either, new Date("2026-11-10T00:00:00Z"))).toBe(false);
    expect(parseCron("0 9 * *")).toBeNull();
    expect(parseCron("0 24 * * *")).toBeNull();
  });

  it("interval is due when never run or elapsed", () => {
    const e: ScheduleEntry = { id: "x", action: "digest", every_ms: 3_600_000, enabled: true };
    const now = T("2026-11-09T10:00:00Z");
    expect(isDue(e, null, now)).toBe(true);
    expect(isDue(e, now - 3_599_000, now)).toBe(false);
    expect(isDue(e, now - 3_600_000, now)).toBe(true);
    expect(isDue({ ...e, enabled: false }, null, now)).toBe(false);
  });

  it("cron fires once per slot, catches up a late tick, never a backlog", () => {
    const e: ScheduleEntry = { id: "x", action: "digest", cron: parseCron("0 9 * * *")!, enabled: true };
    expect(isDue(e, null, T("2026-11-09T09:00:30Z"))).toBe(true);
    expect(isDue(e, T("2026-11-09T09:00:31Z"), T("2026-11-09T09:00:50Z"))).toBe(false);
    expect(isDue(e, T("2026-11-08T09:00:05Z"), T("2026-11-09T09:03:00Z"))).toBe(true);  // late tick
    expect(isDue(e, T("2026-11-08T09:00:05Z"), T("2026-11-09T09:30:00Z"))).toBe(false); // outside catch-up
    expect(isDue(e, null, T("2026-11-09T08:59:59Z"))).toBe(false);
  });
});

describe("actions against a real store", () => {
  it("digest action sends the digest to the configured recipient (digest-action)", async () => {
    const { store } = fixture();
    await store.createTask({ title: "something happened" });
    const { entries } = getSchedulePolicy(policy([{ id: "morning", every: "1d", action: "digest", to: "alan", since: "24h" }]));
    expect(await runDueSchedules(store, entries)).toEqual({ ran: ["morning"], failed: [] });
    const mail = await store.inbox("alan");
    expect(mail).toHaveLength(1);
    expect(mail[0].from_agent).toBe(SCHEDULER_ACTOR);
    const ran = (await store.taskEvents("schedule:morning")).filter((e: any) => e.action === "ran");
    expect(ran).toHaveLength(1);
    expect(JSON.parse(ran[0].data)).toMatchObject({ action: "digest", result: { sent_to: "alan" } });
  });

  it("build action queues a build job a runner can lease (build-action)", async () => {
    const { store } = fixture();
    const { entries } = getSchedulePolicy(policy([{ id: "nightly", cron: "0 2 * * *", action: "build", command: "npm run build && npm test", target_agent_id: "runner@minipc" }]));
    const res = await runDueSchedules(store, entries, T("2026-11-09T02:00:10Z"));
    expect(res).toEqual({ ran: ["nightly"], failed: [] });
    const data = JSON.parse((await store.taskEvents("schedule:nightly"))[0].data);
    const job = await store.getJob(data.result.job_id);
    expect(job).toMatchObject({ type: "build", status: "queued", command: "npm run build && npm test", agent_id: SCHEDULER_ACTOR, target_agent_id: "runner@minipc" });
    expect(await store.nextJob("someone-else")).toBeFalsy();
    expect(await store.nextJob("runner@minipc")).toMatchObject({ id: job.id });
    // Same slot again: not due.
    expect(await runDueSchedules(store, entries, T("2026-11-09T02:00:40Z"))).toEqual({ ran: [], failed: [] });
  });

  it("node_health reports non-online nodes and stays quiet otherwise", async () => {
    const { store } = fixture();
    const secret = randomBytes(32).toString("hex");
    const e = await store.createNodeEnrollment({ version: 1, name: "laptop", device_secret_hash: createHash("sha256").update(secret).digest("hex"), platform: "linux", arch: "x64", insecure_transport: true });
    const node = await store.approveNodeEnrollment(e.id, e.code, { allowed_task_types: ["run-script"], workspace_ids: ["w"], repository_ids: [] }, "admin");
    const { entries } = getSchedulePolicy(policy([{ id: "nodes", every: "15m", action: "node_health", to: "alan" }]));
    await runDueSchedules(store, entries);
    const mail = await store.inbox("alan");
    expect(mail).toHaveLength(1);
    expect(mail[0].body).toMatch(/1\/1 node\(s\) not online/);
    expect(mail[0].body).toContain(node.node_id);

    store.db.prepare("UPDATE nodes SET last_seen_at=?").run(new Date().toISOString());
    await runDueSchedules(store, entries, Date.now() + 16 * 60_000);
    expect(await store.inbox("alan")).toHaveLength(0);
  });

  it("records failures without retrying every tick", async () => {
    const { store } = fixture();
    const broken = { ...store, taskEvents: store.taskEvents.bind(store), log: store.log.bind(store),
      submitJob: () => ({ error: "runner plane disabled" }) };
    const { entries } = getSchedulePolicy(policy([{ id: "b", every: "1h", action: "build", command: "x" }]));
    const now = T("2026-11-09T10:00:00Z");
    expect(await runDueSchedules(broken, entries, now)).toEqual({ ran: [], failed: ["b"] });
    const ev = (await store.taskEvents("schedule:b"))[0];
    expect(ev).toMatchObject({ entity_type: "schedule", action: "failed", actor: SCHEDULER_ACTOR });
    expect(JSON.parse(ev.data).error).toBe("runner plane disabled");
    expect(await runDueSchedules(broken, entries, now + 60_000)).toEqual({ ran: [], failed: [] });
  });

  it("last run survives a restart (durable in the audit log)", async () => {
    const { store, path } = fixture();
    const { entries } = getSchedulePolicy(policy([{ id: "d", every: "1h", action: "digest" }]));
    await runDueSchedules(store, entries);
    store.close();
    cleanup.pop();
    const reopened: any = new SqliteStore(path);
    cleanup.push(() => reopened.close());
    expect(await lastRun(reopened, "d")).not.toBeNull();
    expect(await runDueSchedules(reopened, entries)).toEqual({ ran: [], failed: [] });
  });
});

describe("startScheduler loop", () => {
  it("runs a pass at start, re-reads policy, and stops cleanly", async () => {
    const { store } = fixture();
    let current = policy([{ id: "d", every: "1h", action: "digest", to: "alan" }]);
    const stop = startScheduler(store, { intervalMs: 10, policy: () => current });
    await new Promise(r => setTimeout(r, 50));
    expect(await store.inbox("alan")).toHaveLength(1);    // ran once, then not due
    current = policy([{ id: "e", every: "1h", action: "digest", to: "bob" }]);
    await new Promise(r => setTimeout(r, 50));
    await stop();
    expect(await store.inbox("bob")).toHaveLength(1);
  });

  it("rejects a non-positive interval", () => {
    expect(() => startScheduler({} as any, { intervalMs: 0 })).toThrow(RangeError);
  });
});
