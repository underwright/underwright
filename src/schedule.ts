import type { IStore } from "./istore.js";
import { loadPolicy, type Policy } from "./policy.js";

/** Declarative cadences from policy `schedule[]` (task-9f0e5ba9).
 *
 *  "schedule": [
 *    { "id": "morning-digest", "cron": "0 9 * * 1-5", "action": "digest", "to": "alan", "since": "24h" },
 *    { "id": "nightly-build",  "every": "24h", "action": "build", "command": "npm run build && npm test" },
 *    { "id": "node-health",    "every": "15m", "action": "node_health", "to": "alan" }
 *  ]
 *
 *  Exactly one of `every` (30s|15m|6h|1d, min 60s) or `cron` (5-field, UTC) is
 *  required. Last-run state is durable: each run is an audit event on entity
 *  `schedule:<id>`, so a restart neither replays nor forgets a cadence. Runs
 *  only in the resident HTTP control plane; stdio sessions do not schedule. */

export const SCHEDULER_ACTOR = "scheduler";
export const SCHEDULE_ACTIONS = ["digest", "build", "node_health"] as const;
export type ScheduleAction = typeof SCHEDULE_ACTIONS[number];

export interface ScheduleEntry {
  id: string;
  action: ScheduleAction;
  every_ms?: number;
  cron?: CronSpec;
  cron_text?: string;
  enabled: boolean;
  /** digest + node_health: mailbox recipient. */
  to?: string;
  /** digest: window, e.g. "24h". */
  since?: string;
  /** build: shell command for the queued build job. */
  command?: string;
  /** build: pin the job to one runner agent. */
  target_agent_id?: string;
  task_id?: string;
}

export interface CronSpec { minute: Set<number>; hour: Set<number>; dom: Set<number>; month: Set<number>; dow: Set<number>; domStar: boolean; dowStar: boolean }

const ID = /^[A-Za-z0-9._-]{1,64}$/;
const MIN_EVERY_MS = 60_000;
/** A late tick catches up on cron minutes missed within this window, no further:
 *  after downtime a cadence fires at most once, never a backlog. */
const CRON_CATCHUP_MINUTES = 5;

export function parseDuration(raw: unknown): number | null {
  if (typeof raw === "number") return Number.isFinite(raw) && raw > 0 ? raw * 1000 : null;
  if (typeof raw !== "string") return null;
  const m = /^\s*(\d+)\s*([smhd])\s*$/i.exec(raw);
  if (!m) return null;
  const mult = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2].toLowerCase() as "s" | "m" | "h" | "d"];
  return Number(m[1]) * mult;
}

function cronField(text: string, min: number, max: number, isDow = false): Set<number> | null {
  const out = new Set<number>();
  for (const part of text.split(",")) {
    const m = /^(\*|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/.exec(part.trim());
    if (!m) return null;
    const lo = m[1] === "*" ? min : Number(m[2]);
    const hi = m[1] === "*" ? max : m[3] !== undefined ? Number(m[3]) : (m[4] !== undefined ? max : lo);
    const step = m[4] !== undefined ? Number(m[4]) : 1;
    // Day-of-week accepts 7 as Sunday; it is folded to 0 below.
    if (step < 1 || lo < min || hi > (isDow ? 7 : max) || lo > hi) return null;
    for (let v = lo; v <= hi; v += step) out.add(isDow && v === 7 ? 0 : v);
  }
  return out;
}

/** Standard 5-field cron (minute hour day-of-month month day-of-week), UTC.
 *  Supports *, lists, ranges and steps. When both day fields are restricted a
 *  date matches either (Vixie cron semantics). */
export function parseCron(text: unknown): CronSpec | null {
  if (typeof text !== "string") return null;
  const f = text.trim().split(/\s+/);
  if (f.length !== 5) return null;
  const minute = cronField(f[0], 0, 59), hour = cronField(f[1], 0, 23), dom = cronField(f[2], 1, 31),
    month = cronField(f[3], 1, 12), dow = cronField(f[4], 0, 6, true);
  if (!minute || !hour || !dom || !month || !dow) return null;
  return { minute, hour, dom, month, dow, domStar: f[2] === "*", dowStar: f[4] === "*" };
}

export function cronMatches(spec: CronSpec, at: Date): boolean {
  if (!spec.minute.has(at.getUTCMinutes()) || !spec.hour.has(at.getUTCHours()) || !spec.month.has(at.getUTCMonth() + 1)) return false;
  const domOk = spec.dom.has(at.getUTCDate()), dowOk = spec.dow.has(at.getUTCDay());
  if (spec.domStar || spec.dowStar) return domOk && dowOk;
  return domOk || dowOk;
}

/** Parse policy `schedule[]`. Invalid entries are skipped and reported, never thrown:
 *  one bad cadence must not take the others (or serve) down. */
export function getSchedulePolicy(policy: Policy = loadPolicy()): { entries: ScheduleEntry[]; errors: string[] } {
  const raw = (policy as Policy & { schedule?: unknown }).schedule;
  const entries: ScheduleEntry[] = [];
  const errors: string[] = [];
  if (raw === undefined) return { entries, errors };
  if (!Array.isArray(raw)) return { entries, errors: ["schedule must be an array"] };
  const seen = new Set<string>();
  raw.forEach((item: any, i) => {
    const where = `schedule[${i}]`;
    if (!item || typeof item !== "object") { errors.push(`${where}: not an object`); return; }
    if (typeof item.id !== "string" || !ID.test(item.id)) { errors.push(`${where}: id must match ${ID}`); return; }
    if (seen.has(item.id)) { errors.push(`${where}: duplicate id ${item.id}`); return; }
    if (!SCHEDULE_ACTIONS.includes(item.action)) { errors.push(`${item.id}: action must be one of ${SCHEDULE_ACTIONS.join("|")}`); return; }
    const hasEvery = item.every !== undefined, hasCron = item.cron !== undefined;
    if (hasEvery === hasCron) { errors.push(`${item.id}: exactly one of every or cron is required`); return; }
    const entry: ScheduleEntry = { id: item.id, action: item.action, enabled: item.enabled !== false };
    if (hasEvery) {
      const ms = parseDuration(item.every);
      if (ms === null || ms < MIN_EVERY_MS) { errors.push(`${item.id}: every must be a duration >= 60s (e.g. 15m, 6h, 1d)`); return; }
      entry.every_ms = ms;
    } else {
      const cron = parseCron(item.cron);
      if (!cron) { errors.push(`${item.id}: cron must be 5 fields (minute hour dom month dow)`); return; }
      entry.cron = cron;
      entry.cron_text = String(item.cron).trim();
    }
    for (const k of ["to", "since", "command", "target_agent_id", "task_id"] as const) {
      if (item[k] !== undefined) {
        if (typeof item[k] !== "string" || !item[k].trim()) { errors.push(`${item.id}: ${k} must be a non-empty string`); return; }
        entry[k] = item[k].trim();
      }
    }
    if (entry.action === "build" && !entry.command) { errors.push(`${item.id}: build requires command`); return; }
    if (entry.action === "node_health" && !entry.to) { errors.push(`${item.id}: node_health requires to`); return; }
    seen.add(entry.id);
    entries.push(entry);
  });
  return { entries, errors };
}

/** Is the entry due at `now` given its last run (ms epoch, or null if never)? */
export function isDue(entry: ScheduleEntry, lastRunMs: number | null, now: number): boolean {
  if (!entry.enabled) return false;
  if (entry.every_ms !== undefined) return lastRunMs === null || now - lastRunMs >= entry.every_ms;
  if (!entry.cron) return false;
  const minuteMs = 60_000;
  const thisMinute = Math.floor(now / minuteMs) * minuteMs;
  for (let k = 0; k < CRON_CATCHUP_MINUTES; k++) {
    const slot = thisMinute - k * minuteMs;
    if (lastRunMs !== null && lastRunMs >= slot) return false; // already ran for this (or a later) slot
    if (cronMatches(entry.cron, new Date(slot))) return true;
  }
  return false;
}

const scheduleEntity = (id: string) => `schedule:${id}`;

/** Run time of a schedule event: the logical `at` the pass recorded, else created_at. */
function eventMs(e: any): number | null {
  let data: any = e?.data;
  if (typeof data === "string") { try { data = JSON.parse(data); } catch { data = null; } }
  const at = typeof data?.at === "string" ? Date.parse(data.at) : NaN;
  if (Number.isFinite(at)) return at;
  const raw = e?.created_at;
  if (raw instanceof Date) return raw.getTime();
  if (typeof raw !== "string") return null;
  const iso = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d+)?$/.test(raw) ? `${raw.replace(" ", "T")}Z` : raw;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

/** Durable last-run: the newest `ran`/`failed` event on `schedule:<id>`. A failed
 *  run counts as a run so a broken action does not retry every tick. */
export async function lastRun(store: Pick<IStore, "taskEvents">, id: string): Promise<number | null> {
  const events = await store.taskEvents(scheduleEntity(id));
  let last: number | null = null;
  for (const e of events) {
    if (e.entity_type !== "schedule" || (e.action !== "ran" && e.action !== "failed")) continue;
    const ms = eventMs(e);
    if (ms !== null && (last === null || ms > last)) last = ms;
  }
  return last;
}

type ScheduleStore = Pick<IStore, "taskEvents" | "log" | "digest" | "submitJob" | "listNodes" | "sendMessage">;

/** Execute one action; returns a small, audit-safe result summary. */
export async function runAction(store: ScheduleStore, entry: ScheduleEntry): Promise<Record<string, unknown>> {
  switch (entry.action) {
    case "digest": {
      const d = await store.digest({ since: entry.since ?? "24h", to_agent: entry.to, from_agent: SCHEDULER_ACTOR });
      return { since: d.since, sent_to: d.sent_to ?? null };
    }
    case "build": {
      const job = await store.submitJob({
        agent_id: SCHEDULER_ACTOR, type: "build", command: entry.command!,
        target_agent_id: entry.target_agent_id, task_id: entry.task_id,
      });
      if (job?.error) throw new Error(String(job.error));
      return { job_id: job.id };
    }
    case "node_health": {
      const nodes = await store.listNodes();
      const unhealthy = nodes
        .filter((n: any) => n.state !== "revoked" && !String(n.liveness ?? "").endsWith("online"))
        .map((n: any) => ({ id: n.id, name: n.name, liveness: n.liveness, last_seen_at: n.last_seen_at ?? null }));
      if (unhealthy.length) {
        const lines = unhealthy.map(n => `- ${n.name ?? n.id} (${n.id}): ${n.liveness}, last seen ${n.last_seen_at ?? "never"}`);
        await store.sendMessage(entry.to!, SCHEDULER_ACTOR, `node health: ${unhealthy.length}/${nodes.length} node(s) not online\n${lines.join("\n")}`);
      }
      return { nodes: nodes.length, unhealthy: unhealthy.map(n => n.id) };
    }
  }
}

/** One scheduler pass: run every due entry, record `ran`/`failed` on `schedule:<id>`. */
export async function runDueSchedules(store: ScheduleStore, entries: ScheduleEntry[], now = Date.now()) {
  const ran: string[] = [];
  const failed: string[] = [];
  for (const entry of entries) {
    if (!isDue(entry, await lastRun(store, entry.id), now)) continue;
    const base = { at: new Date(now).toISOString(), action: entry.action, ...(entry.cron_text ? { cron: entry.cron_text } : { every_ms: entry.every_ms }) };
    try {
      const result = await runAction(store, entry);
      await store.log("schedule", scheduleEntity(entry.id), "ran", SCHEDULER_ACTOR, { ...base, result });
      ran.push(entry.id);
    } catch (error) {
      await store.log("schedule", scheduleEntity(entry.id), "failed", SCHEDULER_ACTOR, { ...base, error: String((error as Error)?.message ?? error) });
      failed.push(entry.id);
    }
  }
  return { ran, failed };
}

/** Resident loop for serveHttp: one pass at start, then every `intervalMs`.
 *  Policy is re-read each pass so edits apply without a restart. */
export function startScheduler(
  store: ScheduleStore,
  opts: { intervalMs?: number; policy?: () => Policy; now?: () => number } = {},
  onError: (error: unknown) => void = error => console.error("[underwright] schedule pass failed:", error),
) {
  const intervalMs = opts.intervalMs ?? 30_000;
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) throw new RangeError("schedule interval must be positive and finite");
  let stopped = false;
  let running = false;
  let pending: Promise<void> = Promise.resolve();
  let lastErrors = "";
  const tick = () => {
    if (stopped || running) return;
    running = true;
    pending = (async () => {
      try {
        const { entries, errors } = getSchedulePolicy(opts.policy ? opts.policy() : loadPolicy());
        const key = errors.join("; ");
        if (key && key !== lastErrors) console.error(`[underwright] schedule policy: ${key}`);
        lastErrors = key;
        if (entries.length) await runDueSchedules(store, entries, opts.now ? opts.now() : Date.now());
      } catch (error) {
        onError(error);
      } finally {
        running = false;
      }
    })();
  };
  const timer = setInterval(tick, intervalMs);
  timer.unref();
  tick();
  return async () => {
    stopped = true;
    clearInterval(timer);
    await pending;
  };
}
