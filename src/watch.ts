// Failure watch: classify recently finished jobs whose output carries a blocker
// signature (permission, quota, ENOENT, trust), escalate them to the human, and
// skip-list the task so the watch producer does not requeue it into the same
// failure. Deterministic — no LLM. Driven by ~/.local/bin/uw-watch.mjs today;
// intended to move into `serve` watch later.
import type { SqliteStore } from "./store.js";

export type BlockerSignature = "permission" | "quota" | "enoent" | "trust";

export interface FailureClass {
  signature: BlockerSignature;
  match: string;
}

// Ordered: first match wins. Patterns are deliberately specific so ordinary
// transcript chatter ("check permissions on…") does not trip them.
const RULES: Array<{ signature: BlockerSignature; re: RegExp }> = [
  { signature: "trust", re: /\b(?:workspace|folder|directory) (?:is )?not trusted\b|\bdo you trust (?:the|this)\b|\btrust (?:this|the) (?:folder|workspace|directory)\b|\buntrusted (?:workspace|folder|directory)\b/i },
  { signature: "quota", re: /\bquota (?:exceeded|exhausted)\b|\binsufficient[_ ]quota\b|\brate[_ -]?limit(?:ed| exceeded| reached)\b|\b(?:usage|credit|spend(?:ing)?) limit (?:reached|exceeded)\b|\binsufficient (?:credits|balance)\b|\bHTTP 429\b|\bstatus(?: code)?:? 429\b|\b429 Too Many Requests\b/i },
  // Errno codes only count in error shape ("EACCES:", "spawn x ENOENT",
  // "code: 'ENOENT'") — a bare mention in an agent's final prose ("handles
  // permission, quota, ENOENT and trust errors") is not a blocker.
  { signature: "permission", re: /\b(?:EACCES|EPERM):|\bcode:? ?['"]?(?:EACCES|EPERM)\b|\bpermission denied\b|\brequires? approval\b|\boperation not permitted\b|\bpermission (?:was )?(?:refused|rejected)\b/i },
  { signature: "enoent", re: /\bENOENT:|\bspawn \S+ ENOENT\b|\bcode:? ?['"]?ENOENT\b|\bcommand not found\b|\bnot found in \$PATH\b|\bno such file or directory\b/i },
];

export function classifyFailure(text: string | null | undefined): FailureClass | null {
  if (!text) return null;
  for (const { signature, re } of RULES) {
    const m = re.exec(text);
    if (m) return { signature, match: m[0] };
  }
  return null;
}

export const WATCH_AGENT_ID = "uw-watch";

// ---------------------------------------------------------------- budget gate

/** Policy `watch` block: spend control for the watch producer. */
export interface WatchBudgetRule {
  /** Agent jobs allowed queued+running at once. Default 3. */
  max_inflight?: number;
  /** Agent jobs allowed per UTC day (the cheap spend proxy). 0/unset = no cap. */
  max_agent_jobs_per_day?: number;
  /** Daily USD budget. Needs usd_per_agent_job until real cost evidence (gh-44) lands. */
  budget_usd_per_day?: number;
  /** Estimated USD per agent job, used to price the day's jobs against budget_usd_per_day. */
  usd_per_agent_job?: number;
  /** CODEX_HOME dirs of available codex subscription seats. On a quota blocker a
   *  codex job is resubmitted with the next untried seat instead of skip-listing. */
  codex_seats?: string[];
}

export interface BudgetGate {
  /** How many agent jobs the producer may submit this wake. 0 = submit none. */
  allowed: number;
  inflight: number;
  jobs_today: number;
  spent_usd_today?: number;
  /** Why submission is halted, when allowed is 0 because of a cap. */
  halted?: "inflight" | "daily_jobs" | "daily_budget";
  /** True when this call messaged the human (once per UTC day per halt reason). */
  notified?: boolean;
}

/** The policy `watch` block (empty when absent: in-flight cap 3, no daily caps). */
export function getWatchPolicy(policy: object): WatchBudgetRule {
  const raw = (policy as { watch?: unknown }).watch;
  return raw && typeof raw === "object" ? raw as WatchBudgetRule : {};
}

function posInt(v: unknown): number | undefined {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/**
 * Gate the watch producer before it submits agent jobs. Returns how many jobs it
 * may submit. The gate halts (allowed 0) when agent jobs in flight reach
 * max_inflight, today's agent jobs reach max_agent_jobs_per_day, or today's
 * estimated spend reaches budget_usd_per_day. On a daily-cap halt it messages the
 * human once per UTC day per reason (deduped by a `watch_budget_halt` event).
 * Reaching max_inflight alone is routine back-pressure and sends no message.
 */
export function budgetGate(
  store: SqliteStore,
  rule: WatchBudgetRule = {},
  opts: { human?: string; agentId?: string; now?: number } = {},
): BudgetGate {
  const human = opts.human ?? "human";
  const agentId = opts.agentId ?? WATCH_AGENT_ID;
  const day = new Date(opts.now ?? Date.now()).toISOString().slice(0, 10);
  const { inflight, jobs_today: jobsToday, halts_notified } = store.watchBudgetStats(day);

  const maxInflight = posInt(rule.max_inflight) ?? 3;
  const maxDaily = posInt(rule.max_agent_jobs_per_day);
  const budget = posInt(rule.budget_usd_per_day);
  const perJob = posInt(rule.usd_per_agent_job);
  const spent = budget && perJob ? Math.round(jobsToday * perJob * 100) / 100 : undefined;

  let allowed = Math.max(0, maxInflight - inflight);
  if (maxDaily) allowed = Math.min(allowed, Math.max(0, maxDaily - jobsToday));
  if (budget && perJob) allowed = Math.min(allowed, Math.max(0, Math.floor((budget - jobsToday * perJob) / perJob + 1e-9)));

  const out: BudgetGate = { allowed, inflight, jobs_today: jobsToday, ...(spent !== undefined ? { spent_usd_today: spent } : {}) };
  if (allowed > 0) return out;

  const halted: BudgetGate["halted"] =
    budget && perJob && budget - jobsToday * perJob < perJob - 1e-9 ? "daily_budget"
      : maxDaily && jobsToday >= maxDaily ? "daily_jobs"
        : "inflight";
  out.halted = halted;
  if (halted === "inflight") return out;

  if (halts_notified.includes(halted)) return out;
  const detail = halted === "daily_budget"
    ? `estimated spend $${spent} (${jobsToday} agent jobs × $${perJob}) leaves less than one job of budget_usd_per_day $${budget}`
    : `${jobsToday} agent jobs today reached max_agent_jobs_per_day ${maxDaily}`;
  store.sendMessage(human, agentId,
    `watch halted for ${day}: ${detail}. No agent jobs will be submitted until tomorrow (UTC) or the policy \`watch\` cap is raised.`);
  store.log("watch", `${day}:${halted}`, "watch_budget_halt", agentId, { day, halted, jobs_today: jobsToday, inflight, spent_usd_today: spent });
  out.notified = true;
  return out;
}

/**
 * The watch producer's requeue gate. A task is skip-listed (never requeued) when
 *  - its status is not open (blocked, claimed, in_review, done) or it is missing;
 *  - it has unfinished blocked_by edges, so claim_task would refuse it anyway; or
 *  - its latest `blocked` event is newer than its latest explicit `updated`
 *    event. That event can come from a uw-watch intervention or from any agent's
 *    `blocked` artifact, because release_task reopens a task an agent escalated.
 * A human clears the event skip by calling update_task on it (any field) once the
 * blocker is fixed. Claims, releases and lease reclaims do not clear it, because
 * those happen as a side effect of the failure.
 */
export function isSkipListed(store: SqliteStore, taskId: string): boolean {
  const task = store.getTask(taskId) as { status?: string; unfinished_blockers?: string[] } | null;
  if (!task?.status || task.status !== "open") return true;
  if (task.unfinished_blockers?.length) return true;
  return store.isWatchSkipListed(taskId, null);
}

/** Narrow check: has the watch itself already intervened on this task (and not been cleared)? */
function watchIntervened(store: SqliteStore, taskId: string, agentId: string): boolean {
  return store.isWatchSkipListed(taskId, agentId);
}

export interface FailureWatchOptions {
  agentId?: string;
  human?: string;
  lookbackMinutes?: number;
  limit?: number;
  /** CODEX_HOME dirs for codex quota failover (policy watch.codex_seats). */
  codexSeats?: string[];
}

export interface FailureWatchAction {
  job_id: string;
  task_id: string;
  signature: BlockerSignature;
  match: string;
  action: "intervened" | "suppressed" | "failover";
  artifact_id?: string;
}

/**
 * Scan recently finished jobs and intervene on blocker signatures. Considers
 * failed jobs, and done jobs whose task is still not done (the agent exited 0
 * but never completed). Idempotent: each job is classified at most once
 * (recorded as a `watch_classified` job event), and a task that is already
 * skip-listed gets no second artifact/message.
 */
export function runFailureWatch(store: SqliteStore, opts: FailureWatchOptions = {}): FailureWatchAction[] {
  const agentId = opts.agentId ?? WATCH_AGENT_ID;
  const human = opts.human ?? "human";
  const lookback = Math.max(1, Math.floor(opts.lookbackMinutes ?? 24 * 60));
  const limit = Math.max(1, Math.floor(opts.limit ?? 200));
  const jobs = store.watchCandidates(lookback, limit);

  const actions: FailureWatchAction[] = [];
  for (const job of jobs) {
    const cls = classifyFailure(`${job.outcome_reason ?? ""}\n${job.result ?? ""}`);
    if (!cls) continue;
    const base = { job_id: job.id, task_id: job.task_id, signature: cls.signature, match: cls.match };
    if (cls.signature === "quota") {
      const seats = opts.codexSeats ?? [];
      let spec: any;
      try { spec = typeof job.agent_spec === "string" ? JSON.parse(job.agent_spec) : job.agent_spec; } catch { spec = null; }
      if (spec?.harness === "codex" && typeof spec.prompt === "string" && seats.length > 1) {
        const tried = new Set(String(spec.env?.UW_CODEX_SEATS_TRIED ?? "").split(",").filter(Boolean));
        const seat = seats.find((s) => !tried.has(s));
        if (seat) {
          const next = { ...spec, env: { ...(spec.env ?? {}), CODEX_HOME: seat, UW_CODEX_SEATS_TRIED: [...tried, seat].join(",") } };
          const r = store.submitJob({ agent_id: agentId, task_id: job.task_id, type: "agent", agent: next }) as { id?: string; error?: string };
          store.log("job", job.id, "watch_classified", agentId, { ...base, action: "failover", seat, resubmitted: r.id ?? r.error });
          actions.push({ ...base, action: "failover" });
          continue;
        }
      }
    }
    if (watchIntervened(store, job.task_id, agentId)) {
      store.log("job", job.id, "watch_classified", agentId, { ...base, action: "suppressed" });
      actions.push({ ...base, action: "suppressed" });
      continue;
    }
    const tail = String(job.result ?? "").slice(-1500);
    const art = store.postArtifact({
      task_id: job.task_id,
      agent_id: agentId,
      kind: "blocked",
      title: `watch: ${cls.signature} blocker on job ${job.id}`,
      content: [
        `Job ${job.id} (${job.type}, ${job.status}) hit a ${cls.signature} blocker: "${cls.match}".`,
        `The watch producer will not requeue ${job.task_id} until a human fixes the cause and calls update_task on it.`,
        job.outcome_reason ? `outcome_reason: ${job.outcome_reason}` : "",
        "--- result tail ---",
        tail,
      ].filter(Boolean).join("\n"),
    }) as { id?: string; error?: string };
    store.sendMessage(human, agentId,
      `${job.task_id}: job ${job.id} blocked by ${cls.signature} ("${cls.match}"). Skip-listed; fix it, then update_task to requeue. Artifact ${art.id}.`,
      job.task_id);
    store.log("job", job.id, "watch_classified", agentId, { ...base, action: "intervened", artifact_id: art.id });
    actions.push({ ...base, action: "intervened", artifact_id: art.id });
  }
  return actions;
}

/** One data-driven unblock rule — first match wins. dep_satisfied checks the
 *  dependency tree deterministically; match/match_regex test the newest
 *  blocked-artifact content. action: reopen | escalate. */
export interface UnblockRule {
  dep_satisfied?: boolean;
  match?: string;
  match_regex?: string;
  action: "reopen" | "escalate";
  note?: string;
}

export interface UnblockPolicy {
  enabled?: boolean;
  stale_hours?: number;
  reblock_hours?: number;
  rules?: UnblockRule[];
  escalate_to?: string;
  /** Resend throttle for repeated escalations of the same blocked task.
   *  First send immediate; resend after base*2^(n-1), capped. Resets when
   *  the task's updated_at changes (new block episode). Defaults 60min/24h. */
  escalate_backoff_base_minutes?: number;
  escalate_backoff_max_hours?: number;
}

export interface UnblockAction {
  task_id: string;
  action: "reopened" | "escalated" | "deferred";
  rule?: string;
}

export function getUnblockPolicy(policy: object): UnblockPolicy {
  const w = (policy as any)?.watch;
  return w?.unblock ?? {};
}

/**
 * The block-removing agent (gh-74): clear blocked tasks whose cause is
 * transient/stale by rule, escalate the rest with a single-letter offer.
 * Demand-triggered — only does work when blocked tasks exist. Data-driven:
 * rules live in policy watch.unblock.rules, not hardcoded.
 */
export function runUnblockWatch(store: SqliteStore, opts: { policy?: object; agentId?: string } = {}): UnblockAction[] {
  const policy = getUnblockPolicy(opts.policy ?? {});
  if (policy.enabled === false) return [];
  const agentId = opts.agentId ?? WATCH_AGENT_ID;
  const human = policy.escalate_to ?? "human";
  const staleHours = policy.stale_hours ?? 24;
  const reblockHours = policy.reblock_hours ?? 12;
  const rules = policy.rules ?? [];

  const blocked = store.blockedTaskSnapshots();
  const actions: UnblockAction[] = [];
  const now = Date.now();

  for (const t of blocked) {
    // Oscillation guard: auto-reopened recently and re-blocked → escalate.
    if (t.last_reopen && (now - new Date(t.last_reopen).getTime()) < reblockHours * 3600e3) {
      const r = escalate(store, t, agentId, human, `re-blocked ${((now - new Date(t.last_reopen).getTime()) / 3600e3).toFixed(1)}h after auto-reopen`, policy);
      actions.push(r); continue;
    }
    const rule = rules.find((r) => {
      if (r.dep_satisfied && !t.deps_done) return false;
      if (r.match && !t.content.includes(r.match)) return false;
      if (r.match_regex && !(new RegExp(r.match_regex, "i")).test(t.content)) return false;
      return true;
    });
    if (rule?.action === "reopen") {
      store.updateTask(t.id, { status: "open" } as any, agentId);
      store.log("task", t.id, "unblock_reopen", agentId, { rule: rule.note ?? JSON.stringify(rule) });
      actions.push({ task_id: t.id, action: "reopened", rule: rule.note });
      continue;
    }
    if (rule?.action === "escalate") { actions.push(escalate(store, t, agentId, human, rule.note ?? "rule: escalate", policy)); continue; }
    // No rule hit: stale blocks escalate, fresh ones defer.
    const ageH = (now - new Date(t.updated_at).getTime()) / 3600e3;
    actions.push(ageH >= staleHours
      ? escalate(store, t, agentId, human, `blocked ${ageH.toFixed(0)}h with no matching rule`, policy)
      : { task_id: t.id, action: "deferred" });
  }
  return actions;
}

function escalate(store: SqliteStore, t: { id: string; title: string; content: string; updated_at?: string }, agentId: string, human: string, reason: string, policy: UnblockPolicy = {}): UnblockAction {
  // Resend throttle: count prior escalations for this block episode (since
  // t.updated_at) and defer until last + base*2^(n-1), capped — gh-48 was
  // messaging the human every wake. gh-69.
  const baseMin = policy.escalate_backoff_base_minutes ?? 60;
  const maxH = policy.escalate_backoff_max_hours ?? 24;
  const prior = (store as any).db.prepare(
    `SELECT created_at FROM events WHERE entity_type='task' AND entity_id=? AND action='unblock_escalated' AND created_at >= ? ORDER BY created_at`
  ).all(t.id, t.updated_at ?? "1970-01-01") as { created_at: string }[];
  const n = prior.length;
  if (n > 0) {
    const intervalH = Math.min(maxH, (baseMin / 60) * 2 ** (n - 1));
    const nextDue = new Date(prior[n - 1].created_at).getTime() + intervalH * 3600e3;
    if (Date.now() < nextDue) {
      return { task_id: t.id, action: "deferred", rule: `escalation backoff (${n} sent, next ${new Date(nextDue).toISOString()})` };
    }
  }
  store.sendMessage(human, agentId,
    `${t.id} blocked — ${reason}.
` +
    `${t.title}
` +
    `A) Reopen anyway
B) Reassign to another seat/harness
C) Cancel task
D) Defer 24h, re-evaluate
` +
    `Reply A/B/C/D.`,
    t.id);
  store.log("task", t.id, "unblock_escalated", agentId, { reason });
  return { task_id: t.id, action: "escalated" };
}
