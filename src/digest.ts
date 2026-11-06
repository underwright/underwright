import { getHumanNotifyPolicy, loadPolicy, type HumanNotifyEventKind, type Policy } from "./policy.js";
import type { DigestArgs, DigestResult } from "./istore.js";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Normalize a SQLite `YYYY-MM-DD HH:MM:SS`, ISO8601 string, or Date into an ISO8601 UTC string. */
export function normalizeTimestamp(raw: unknown): string | null {
  if (raw instanceof Date) {
    return Number.isFinite(raw.getTime()) ? raw.toISOString() : null;
  }
  if (typeof raw !== "string") return null;
  const s = raw.trim();
  if (!s) return null;
  const isoCandidate = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(s)
    ? `${s.replace(" ", "T")}Z`
    : s;
  const ms = Date.parse(isoCandidate);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/** Resolve an optional `since` parameter (ISO/SQLite timestamp or relative shorthand like `24h`, `30m`, `7d`). */
export function resolveSinceTimestamp(since?: string, nowMs = Date.now()): string {
  if (since === undefined || since === null || since.trim() === "") {
    return new Date(nowMs - DAY_MS).toISOString();
  }
  const trimmed = since.trim();
  const rel = /^(\d+)\s*([smhd])$/i.exec(trimmed);
  if (rel) {
    const amount = Number(rel[1]);
    const unit = rel[2].toLowerCase();
    const mult =
      unit === "s" ? 1000 :
      unit === "m" ? 60_000 :
      unit === "h" ? 3_600_000 :
      DAY_MS;
    return new Date(nowMs - amount * mult).toISOString();
  }
  const normalized = normalizeTimestamp(trimmed);
  if (!normalized) {
    throw new Error(`Invalid since timestamp: ${since}`);
  }
  return normalized;
}

function parseEventData(raw: unknown): Record<string, any> {
  if (!raw) return {};
  if (typeof raw === "object") return raw as Record<string, any>;
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      return {};
    }
  }
  return {};
}

export interface DigestInput {
  since?: string;
  nowMs?: number;
  tasks: any[];
  events: any[];
}

export function buildDigest(input: DigestInput): Omit<DigestResult, "sent_to"> {
  const nowMs = input.nowMs ?? Date.now();
  const generated_at = new Date(nowMs).toISOString();
  const since = resolveSinceTimestamp(input.since, nowMs);
  const sinceMs = Date.parse(since);

  const taskById = new Map<string, any>();
  for (const t of input.tasks) {
    if (t?.id) taskById.set(String(t.id), t);
  }

  const normalizedEvents = input.events
    .map((e) => {
      const iso = normalizeTimestamp(e.created_at) ?? String(e.created_at ?? "");
      const ms = Date.parse(iso);
      return {
        id: e.id,
        entity_type: String(e.entity_type ?? ""),
        entity_id: String(e.entity_id ?? ""),
        action: String(e.action ?? ""),
        actor: String(e.actor ?? ""),
        data: parseEventData(e.data),
        created_at: iso,
        _ms: ms,
      };
    })
    .filter((e) => Number.isFinite(e._ms) && e._ms >= sinceMs)
    .sort((a, b) => a._ms - b._ms || Number(a.id ?? 0) - Number(b.id ?? 0));

  const titleFor = (taskId: string, data?: Record<string, any>): string => {
    return taskById.get(taskId)?.title ?? (typeof data?.title === "string" ? data.title : "");
  };

  const tasks_created = normalizedEvents
    .filter((e) => e.entity_type === "task" && e.action === "created")
    .map((e) => ({
      id: e.entity_id,
      title: titleFor(e.entity_id, e.data),
      actor: e.actor,
      created_at: e.created_at,
    }));

  const tasks_completed = normalizedEvents
    .filter((e) => e.entity_type === "task" && (e.action === "completed" || e.action === "status:done"))
    .map((e) => ({
      id: e.entity_id,
      title: titleFor(e.entity_id, e.data),
      actor: e.actor,
      created_at: e.created_at,
    }));

  const tasks_claimed = normalizedEvents
    .filter((e) => e.entity_type === "task" && e.action === "claimed")
    .map((e) => ({
      id: e.entity_id,
      title: titleFor(e.entity_id, e.data),
      actor: e.actor,
      created_at: e.created_at,
    }));

  const tasks_released = normalizedEvents
    .filter((e) => e.entity_type === "task" && e.action === "released")
    .map((e) => ({
      id: e.entity_id,
      title: titleFor(e.entity_id, e.data),
      actor: e.actor,
      created_at: e.created_at,
    }));

  const claims_reclaimed = normalizedEvents
    .filter((e) => e.entity_type === "task" && e.action === "lease_expired")
    .map((e) => ({
      id: e.entity_id,
      title: titleFor(e.entity_id, e.data),
      agent_id: String(e.data.agent_id ?? e.actor),
      reopened: Boolean(e.data.reopened),
      created_at: e.created_at,
    }));

  const tasks_unblocked = normalizedEvents
    .filter((e) => e.entity_type === "task" && e.action === "unblocked")
    .map((e) => ({
      id: e.entity_id,
      title: titleFor(e.entity_id, e.data),
      actor: e.actor,
      blocker_id: e.data.blocker_id ? String(e.data.blocker_id) : undefined,
      created_at: e.created_at,
    }));

  const jobs_submitted = normalizedEvents.filter((e) => e.entity_type === "job" && e.action === "submitted").length;
  const jobs_finished = normalizedEvents.filter(
    (e) => e.entity_type === "job" && (e.action === "done" || e.action === "failed")
  ).length;
  const artifacts_posted = normalizedEvents.filter((e) => e.entity_type === "artifact" && e.action === "posted").length;
  const evidence_reported = normalizedEvents.filter((e) => e.entity_type === "evidence" && e.action === "reported").length;
  const messages_sent = normalizedEvents.filter((e) => e.entity_type === "message" && e.action === "sent").length;

  const board_totals = {
    open: 0,
    claimed: 0,
    in_review: 0,
    blocked: 0,
    done: 0,
    total: input.tasks.length,
  };
  const active_claims: { task_id: string; title: string; agent_id: string; lease_expires: string }[] = [];

  for (const t of input.tasks) {
    const status = String(t.status ?? "open") as keyof typeof board_totals;
    if (status in board_totals && status !== "total") {
      board_totals[status]++;
    }
    if (t.claimed_by) {
      active_claims.push({
        task_id: String(t.id),
        title: String(t.title ?? ""),
        agent_id: String(t.claimed_by),
        lease_expires: normalizeTimestamp(t.lease_expires) ?? String(t.lease_expires ?? ""),
      });
    }
  }

  const counts = {
    tasks_created: tasks_created.length,
    tasks_completed: tasks_completed.length,
    tasks_claimed: tasks_claimed.length,
    tasks_released: tasks_released.length,
    claims_reclaimed: claims_reclaimed.length,
    tasks_unblocked: tasks_unblocked.length,
    jobs_submitted,
    jobs_finished,
    artifacts_posted,
    evidence_reported,
    messages_sent,
    total_events: normalizedEvents.length,
  };

  const events = normalizedEvents.map(({ _ms, ...rest }) => rest);

  const summary = formatDigestSummary({
    since,
    generated_at,
    counts,
    tasks_created,
    tasks_completed,
    tasks_claimed,
    tasks_released,
    claims_reclaimed,
    tasks_unblocked,
    active_claims,
    board_totals,
  });

  return {
    since,
    generated_at,
    counts,
    tasks_created,
    tasks_completed,
    tasks_claimed,
    tasks_released,
    claims_reclaimed,
    tasks_unblocked,
    active_claims,
    board_totals,
    events,
    summary,
  };
}

export function formatDigestSummary(d: {
  since: string;
  generated_at: string;
  counts: DigestResult["counts"];
  tasks_created: DigestResult["tasks_created"];
  tasks_completed: DigestResult["tasks_completed"];
  tasks_claimed: DigestResult["tasks_claimed"];
  tasks_released: DigestResult["tasks_released"];
  claims_reclaimed: DigestResult["claims_reclaimed"];
  tasks_unblocked: DigestResult["tasks_unblocked"];
  active_claims: DigestResult["active_claims"];
  board_totals: DigestResult["board_totals"];
}): string {
  const fmtTask = (item: { id: string; title?: string; actor?: string; agent_id?: string }) => {
    const who = item.actor ?? item.agent_id;
    return `${item.id}${item.title ? ` (${item.title})` : ""}${who ? ` by ${who}` : ""}`;
  };

  const lines: string[] = [
    `Board digest since ${d.since} (${d.counts.total_events} events):`,
    `- Completed (${d.tasks_completed.length}): ${d.tasks_completed.length ? d.tasks_completed.map(fmtTask).join(", ") : "none"}`,
    `- Claimed (${d.tasks_claimed.length}): ${d.tasks_claimed.length ? d.tasks_claimed.map(fmtTask).join(", ") : "none"}`,
    `- Created (${d.tasks_created.length}): ${d.tasks_created.length ? d.tasks_created.map(fmtTask).join(", ") : "none"}`,
    `- Reclaimed leases (${d.claims_reclaimed.length}): ${d.claims_reclaimed.length ? d.claims_reclaimed.map(fmtTask).join(", ") : "none"}`,
  ];
  if (d.tasks_released.length) {
    lines.push(`- Released (${d.tasks_released.length}): ${d.tasks_released.map(fmtTask).join(", ")}`);
  }
  if (d.tasks_unblocked.length) {
    lines.push(`- Unblocked (${d.tasks_unblocked.length}): ${d.tasks_unblocked.map(fmtTask).join(", ")}`);
  }
  lines.push(
    `- Board totals: ${d.board_totals.open} open, ${d.board_totals.claimed} claimed, ${d.board_totals.blocked} blocked, ${d.board_totals.in_review} in_review, ${d.board_totals.done} done (${d.board_totals.total} total)`
  );
  return lines.join("\n");
}

export interface HumanNotifyEventInput {
  event: HumanNotifyEventKind;
  task_id: string;
  title?: string;
  agent_id: string;
  reopened?: boolean;
  lease_expires?: string | Date | null;
  timestamp?: string;
}

export interface HumanNotifyPayload {
  event: HumanNotifyEventKind;
  task_id: string;
  title: string;
  agent_id: string;
  reopened?: boolean;
  lease_expires?: string | null;
  timestamp: string;
  text: string;
  content: string;
}

export function buildHumanNotifyPayload(input: HumanNotifyEventInput): HumanNotifyPayload {
  const timestamp = normalizeTimestamp(input.timestamp) ?? new Date().toISOString();
  const title = input.title ?? "";
  if (input.event === "task_completed") {
    const text = `[underwright] Task completed: ${input.task_id}${title ? ` (${title})` : ""} by ${input.agent_id}`;
    return {
      event: "task_completed",
      task_id: input.task_id,
      title,
      agent_id: input.agent_id,
      timestamp,
      text,
      content: text,
    };
  }
  const leaseExpires = input.lease_expires ? (normalizeTimestamp(input.lease_expires) ?? String(input.lease_expires)) : null;
  const text = `[underwright] Claim reclaimed: ${input.task_id}${title ? ` (${title})` : ""} from ${input.agent_id}${input.reopened ? " → open" : ""}`;
  return {
    event: "claim_reclaimed",
    task_id: input.task_id,
    title,
    agent_id: input.agent_id,
    reopened: Boolean(input.reopened),
    lease_expires: leaseExpires,
    timestamp,
    text,
    content: text,
  };
}

const inFlightNotifications = new Set<Promise<unknown>>();

export async function sendHumanNotification(
  input: HumanNotifyEventInput,
  policy: Policy = loadPolicy(),
  fetchImpl: typeof fetch = globalThis.fetch
): Promise<{ sent: boolean; status?: number; reason?: string; error?: string }> {
  const cfg = getHumanNotifyPolicy(policy);
  if (!cfg.enabled || !cfg.webhook_url) {
    return { sent: false, reason: "disabled" };
  }
  if (!cfg.events.includes(input.event)) {
    return { sent: false, reason: "filtered" };
  }
  const payload = buildHumanNotifyPayload(input);
  const work = (async () => {
    try {
      const response = await fetchImpl(cfg.webhook_url!, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      return { sent: response.ok, status: response.status };
    } catch (error: any) {
      return { sent: false, error: String(error?.message ?? error) };
    }
  })();
  inFlightNotifications.add(work);
  try {
    return await work;
  } finally {
    inFlightNotifications.delete(work);
  }
}

export async function flushNotifications(): Promise<void> {
  while (inFlightNotifications.size > 0) {
    await Promise.allSettled([...inFlightNotifications]);
  }
}

export function normalizeDigestArgs(sinceOrArgs?: string | DigestArgs): DigestArgs {
  if (!sinceOrArgs) return {};
  if (typeof sinceOrArgs === "string") return { since: sinceOrArgs };
  return sinceOrArgs;
}
