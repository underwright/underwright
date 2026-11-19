import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteStore } from "../src/store.js";
import { budgetGate, classifyFailure, getWatchPolicy, isSkipListed, runFailureWatch } from "../src/watch.js";

const cleanups: (() => void)[] = [];
afterEach(() => { cleanups.splice(0).reverse().forEach(f => f()); });
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "uw-watch-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const store = new SqliteStore(join(dir, "watch.db"));
  cleanups.push(() => store.close());
  return store;
}
function finishedJob(store: SqliteStore, taskId: string, status: "done" | "failed", result: string) {
  const job = store.submitJob({ agent_id: "uw-watch", task_id: taskId, type: "build", command: "echo x" });
  const leased = store.nextJob("runner", undefined, 60) as any;
  expect(leased.id).toBe(job.id);
  expect(store.finishJob(job.id, status, result, "runner", leased.lease_token)).toEqual({ id: job.id, status });
  return job.id as string;
}

describe("classifyFailure", () => {
  it.each([
    ["Error: EACCES: permission denied, open '/etc/x'", "permission"],
    ["Bash command requires approval", "permission"],
    ["spawn claude ENOENT", "enoent"],
    ["Error: ENOENT: no such file or directory, open 'x'", "enoent"],
    ["{ errno: -13, code: 'EPERM', syscall: 'kill' }", "permission"],
    ["Executable not found in $PATH: partyline-channel", "enoent"],
    ["bash: codex: command not found", "enoent"],
    ["API error 429 Too Many Requests", "quota"],
    ["insufficient_quota: you exceeded your current quota", "quota"],
    ["Claude usage limit reached; resets at 5pm", "quota"],
    ["This workspace is not trusted. Do you trust the files in this folder?", "trust"],
  ])("%s → %s", (text, sig) => {
    expect(classifyFailure(text)?.signature).toBe(sig);
  });

  it("ignores ordinary failures and transcript chatter", () => {
    expect(classifyFailure("AssertionError: expected 2 to be 3")).toBeNull();
    expect(classifyFailure("I checked the permissions model and trust boundaries; tests pass.")).toBeNull();
    // Regression: a done agent job's prose describing the feature tripped "enoent".
    expect(classifyFailure("They already contain a failure classifier for permission, quota, ENOENT and trust errors.")).toBeNull();
    expect(classifyFailure("maps EACCES/EPERM to the permission signature")).toBeNull();
    expect(classifyFailure("")).toBeNull();
    expect(classifyFailure(null)).toBeNull();
  });
});

describe("runFailureWatch", () => {
  it("intervenes on a blocker: blocked artifact, human message, skip-list", () => {
    const store = fixture();
    const task = store.createTask({ title: "t", ac_ids: ["a"], estimate: "S" }) as any;
    const jobId = finishedJob(store, task.id, "failed", "spawn claude ENOENT");

    const actions = runFailureWatch(store);
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({ job_id: jobId, task_id: task.id, signature: "enoent", action: "intervened" });

    const detail = store.getTask(task.id) as any;
    const blocked = detail.artifacts.filter((a: any) => a.kind === "blocked");
    expect(blocked).toHaveLength(1);
    expect(blocked[0].agent_id).toBe("uw-watch");
    expect(blocked[0].content).toContain(jobId);

    const inbox = store.inbox("human") as any[];
    expect(inbox).toHaveLength(1);
    expect(inbox[0].body).toContain("enoent");
    expect(inbox[0].task_id).toBe(task.id);

    expect(isSkipListed(store, task.id)).toBe(true);
  });

  it("flags done jobs whose task is not done, but not done jobs on done tasks or plain failures", () => {
    const store = fixture();
    const open = store.createTask({ title: "open", ac_ids: ["a"], estimate: "S" }) as any;
    const plain = store.createTask({ title: "plain", ac_ids: ["a"], estimate: "S" }) as any;
    finishedJob(store, open.id, "done", "Claude usage limit reached");
    finishedJob(store, plain.id, "failed", "AssertionError: expected 1 to be 2");
    const actions = runFailureWatch(store);
    expect(actions.map(a => [a.task_id, a.signature])).toEqual([[open.id, "quota"]]);
    expect(isSkipListed(store, plain.id)).toBe(false);
  });

  it("does not reflood: rescans are idempotent and repeat failures on a skip-listed task are suppressed", () => {
    const store = fixture();
    const task = store.createTask({ title: "t", ac_ids: ["a"], estimate: "S" }) as any;
    finishedJob(store, task.id, "failed", "EACCES: permission denied");
    expect(runFailureWatch(store)).toHaveLength(1);
    expect(runFailureWatch(store)).toEqual([]);

    const second = finishedJob(store, task.id, "failed", "EACCES: permission denied");
    expect(runFailureWatch(store)).toEqual([expect.objectContaining({ job_id: second, action: "suppressed" })]);
    expect((store.getTask(task.id) as any).artifacts.filter((a: any) => a.kind === "blocked")).toHaveLength(1);
    expect(store.inbox("human")).toHaveLength(1);

    // Claim/release churn does not clear the skip; an explicit update_task does.
    store.claimTask(task.id, "someone");
    store.releaseTask(task.id, "someone");
    expect(isSkipListed(store, task.id)).toBe(true);
    store.updateTask(task.id, { description: "fixed PATH" }, "human");
    expect(isSkipListed(store, task.id)).toBe(false);

    // After the human clears it, a fresh failure intervenes again.
    finishedJob(store, task.id, "failed", "EACCES: permission denied");
    expect(runFailureWatch(store)).toEqual([expect.objectContaining({ action: "intervened" })]);
    expect(isSkipListed(store, task.id)).toBe(true);
  });
});

describe("isSkipListed (watch producer requeue gate)", () => {
  it("skip-blocked-status: skips tasks that are blocked, in_review or done, and missing tasks", () => {
    const store = fixture();
    const open = store.createTask({ title: "open", ac_ids: ["a"], estimate: "S" }) as any;
    const blocked = store.createTask({ title: "blocked", ac_ids: ["a"], estimate: "S" }) as any;
    const review = store.createTask({ title: "review", ac_ids: ["a"], estimate: "S" }) as any;
    const done = store.createTask({ title: "done", ac_ids: ["a"], estimate: "S" }) as any;
    expect(isSkipListed(store, open.id)).toBe(false);

    // Status is set directly: the gate reads status, independent of lifecycle policy.
    const setStatus = (id: string, s: string) => store.db.prepare("UPDATE tasks SET status=? WHERE id=?").run(s, id);
    setStatus(blocked.id, "blocked");
    setStatus(review.id, "in_review");
    setStatus(done.id, "done");
    expect(isSkipListed(store, blocked.id)).toBe(true);
    expect(isSkipListed(store, review.id)).toBe(true);
    expect(isSkipListed(store, done.id)).toBe(true);
    expect(isSkipListed(store, "task-missing")).toBe(true);
  });

  it("skip-unfinished-blockers: skips open tasks with unfinished blocked_by edges until the blocker is done", () => {
    const store = fixture();
    const blocker = store.createTask({ title: "blocker", ac_ids: ["a"], estimate: "S" }) as any;
    const epic = store.createTask({ title: "epic", ac_ids: ["a"], estimate: "S", blocked_by: [blocker.id] }) as any;
    expect((store.getTask(epic.id) as any).unfinished_blockers).toEqual([blocker.id]);
    expect(isSkipListed(store, epic.id)).toBe(true);

    store.db.prepare("UPDATE tasks SET status='done' WHERE id=?").run(blocker.id);
    expect((store.getTask(epic.id) as any).unfinished_blockers).toEqual([]);
    expect(isSkipListed(store, epic.id)).toBe(false);
  });

  it("an agent's blocked artifact skip-lists the task even after release_task reopens it; update_task clears it", () => {
    const store = fixture();
    const task = store.createTask({ title: "t", ac_ids: ["a"], estimate: "S" }) as any;
    store.claimTask(task.id, "claude@host");
    store.postArtifact({ task_id: task.id, agent_id: "claude@host", kind: "blocked", content: "needs a human" });
    store.releaseTask(task.id, "claude@host");
    expect((store.getTask(task.id) as any).status).toBe("open");
    expect(isSkipListed(store, task.id)).toBe(true);

    store.updateTask(task.id, { description: "unblocked" }, "human");
    expect(isSkipListed(store, task.id)).toBe(false);
  });

  it("an agent's blocked artifact does not suppress the watch's own intervention", () => {
    const store = fixture();
    const task = store.createTask({ title: "t", ac_ids: ["a"], estimate: "S" }) as any;
    store.postArtifact({ task_id: task.id, agent_id: "claude@host", kind: "blocked", content: "stuck" });
    finishedJob(store, task.id, "failed", "spawn claude ENOENT");
    expect(runFailureWatch(store)).toEqual([expect.objectContaining({ action: "intervened" })]);
  });
});

describe("budgetGate (watch producer spend control)", () => {
  const agentJob = (store: SqliteStore, n = 1) => {
    for (let i = 0; i < n; i++) {
      expect(store.submitJob({ agent_id: "uw-watch", type: "agent",
        agent: { executable: "claude", args: [], prompt: `p${i}` } } as any)).toHaveProperty("status", "queued");
    }
  };
  const finishAll = (store: SqliteStore) => {
    for (;;) {
      const j = store.nextJob("runner", undefined, 60) as any;
      if (!j?.id) break;
      store.finishJob(j.id, "done", "ok", "runner", j.lease_token);
    }
  };

  it("defaults to three in flight and halts silently at the in-flight cap", () => {
    const store = fixture();
    expect(budgetGate(store)).toMatchObject({ allowed: 3, inflight: 0, jobs_today: 0 });
    agentJob(store, 3);
    const g = budgetGate(store);
    expect(g).toMatchObject({ allowed: 0, inflight: 3, halted: "inflight" });
    expect(g.notified).toBeUndefined();
    expect(store.inbox("human")).toHaveLength(0);
  });

  it("caps agent jobs per day and messages the human once", () => {
    const store = fixture();
    const rule = { max_inflight: 10, max_agent_jobs_per_day: 4 };
    agentJob(store, 3);
    expect(budgetGate(store, rule)).toMatchObject({ allowed: 1, jobs_today: 3 });
    agentJob(store, 1);
    finishAll(store); // nothing in flight; the daily cap alone halts
    expect(budgetGate(store, rule)).toMatchObject({ allowed: 0, inflight: 0, jobs_today: 4, halted: "daily_jobs", notified: true });
    expect(budgetGate(store, rule).notified).toBeUndefined();
    const inbox = store.inbox("human");
    expect(inbox).toHaveLength(1);
    expect(inbox[0].body).toContain("max_agent_jobs_per_day 4");
    // A different UTC day starts a fresh window.
    expect(budgetGate(store, rule, { now: Date.now() + 86_400_000 })).toMatchObject({ allowed: 4, jobs_today: 0 });
  });

  it("prices the day's jobs against budget_usd_per_day", () => {
    const store = fixture();
    const rule = { max_inflight: 10, budget_usd_per_day: 5, usd_per_agent_job: 2 };
    expect(budgetGate(store, rule)).toMatchObject({ allowed: 2, spent_usd_today: 0 });
    agentJob(store, 2);
    // $4 spent; one more $2 job would exceed $5.
    expect(budgetGate(store, rule)).toMatchObject({ allowed: 0, spent_usd_today: 4, halted: "daily_budget", notified: true });
    finishAll(store);
    expect(budgetGate(store, rule)).toMatchObject({ allowed: 0, halted: "daily_budget" });
    expect(store.inbox("human")).toHaveLength(1);
  });

  const finishN = (store: SqliteStore, n: number, outcome: "done" | "failed") => {
    for (let i = 0; i < n; i++) {
      const j = store.nextJob("runner", undefined, 60) as any;
      store.finishJob(j.id, outcome, outcome === "failed" ? "boom" : "ok", "runner", j.lease_token);
    }
  };

  it("throttles submission rate per rolling minute, silently", () => {
    const store = fixture();
    const rule = { max_inflight: 10, max_agent_jobs_per_minute: 3 };
    agentJob(store, 2);
    expect(budgetGate(store, rule)).toMatchObject({ allowed: 1 });
    agentJob(store, 1);
    const g = budgetGate(store, rule);
    expect(g).toMatchObject({ allowed: 0, halted: "rate" });
    expect(g.notified).toBeUndefined();
    expect(store.inbox("human")).toHaveLength(0); // transient — self-resolves
  });

  it("halts on a failure storm only once min samples are in the window", () => {
    const store = fixture();
    const rule = { max_inflight: 10, failure_window_minutes: 15, failure_min_samples: 4, failure_max_pct: 50 };
    agentJob(store, 3);
    finishN(store, 2, "failed");
    finishN(store, 1, "done"); // 2/3 failed = 66% but below min_samples 4
    expect(budgetGate(store, rule).allowed).toBeGreaterThan(0);
    agentJob(store, 1);
    finishN(store, 1, "failed"); // 3/4 failed = 75% with 4 samples
    const g = budgetGate(store, rule);
    expect(g).toMatchObject({ allowed: 0, halted: "failure_storm", notified: true });
    const inbox = store.inbox("human");
    expect(inbox).toHaveLength(1);
    expect(inbox[0].body).toContain("failure_max_pct 50");
    expect(inbox[0].body).toContain("3/4");
    expect(budgetGate(store, rule).notified).toBeUndefined(); // once per day
  });

  it("ignores non-agent jobs and nonsense caps", () => {
    const store = fixture();
    store.submitJob({ agent_id: "x", type: "test", command: "npm test" });
    expect(budgetGate(store, { max_inflight: -1, max_agent_jobs_per_day: 0, budget_usd_per_day: 5 } as any))
      .toMatchObject({ allowed: 3, inflight: 0, jobs_today: 0 });
    expect(getWatchPolicy({})).toEqual({});
    expect(getWatchPolicy({ watch: { max_inflight: 2 } })).toEqual({ max_inflight: 2 });
  });
});
