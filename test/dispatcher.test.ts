import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteStore } from "../src/store.js";
import { PgStore } from "../src/pstore.js";
import type { IStore } from "../src/istore.js";
import { chooseReassignAgent, chooseReviewer, harnessOf, leaseActive, linkedReviewArgs, nextTaskMessage } from "../src/dispatcher.js";
import { evaluateDoD, getDispatcherPolicy } from "../src/policy.js";

const root = new URL("..", import.meta.url);

describe("dispatcher policy", () => {
  const review = { require_different_harness: true, prefer_stronger: true };

  const retryOff = { kinds: [], max_attempts: 0 };
  it("stays off when the block is absent and reads on/off, cap, and idle minutes", () => {
    expect(getDispatcherPolicy({ dod: {}, enforcement: "observe" })).toEqual({
      enabled: false, max_tasks_per_agent: 0, idle_minutes: 15, review, node_retry: retryOff,
    });
    expect(getDispatcherPolicy({
      dod: {}, enforcement: "warn",
      dispatcher: { enabled: true, max_tasks_per_agent: 4, idle_minutes: 0 },
    })).toEqual({ enabled: true, max_tasks_per_agent: 4, idle_minutes: 0, review, node_retry: retryOff });
    expect(getDispatcherPolicy({
      dod: {}, enforcement: "warn",
      dispatcher: { enabled: false, max_tasks_per_agent: -3, idle_minutes: -1 },
    })).toEqual({ enabled: false, max_tasks_per_agent: 0, idle_minutes: 15, review, node_retry: retryOff });
    expect(getDispatcherPolicy({
      dod: {}, enforcement: "warn",
      dispatcher: { enabled: true, review: { require_different_harness: false, prefer_stronger: false } },
    }).review).toEqual({ require_different_harness: false, prefer_stronger: false });
  });

  it("ships an enabled dispatcher with a cap and an idle window", () => {
    const policy = JSON.parse(readFileSync(new URL("../underwright.policy.json", import.meta.url), "utf8"));
    expect(policy.dispatcher).toMatchObject({ enabled: true, max_tasks_per_agent: 3, idle_minutes: 15 });
    expect(policy.dispatcher.review).toEqual(review);
    expect(policy.dod.review).toEqual({ artifacts: ["review"] });
  });

  it("routes review work to a different, stronger harness and links review_of", () => {
    expect(harnessOf("claude@minipc")).toBe("claude");
    const agents = [
      { id: "grok@alandesktop", workload: 1 },
      { id: "grok@other", workload: 0 },
      { id: "cmdc@box", workload: 0 },
      { id: "claude@minipc", workload: 2 },
    ];
    expect(chooseReviewer({
      implementer: "grok@alandesktop", agents, max: 0,
      requireDifferentHarness: true, preferStronger: true, designReview: false,
    })).toBe("claude@minipc");
    expect(chooseReviewer({
      implementer: "grok@alandesktop",
      agents: [{ id: "grok@other", workload: 0 }],
      max: 0, requireDifferentHarness: true, preferStronger: true, designReview: false,
    })).toBeNull();
    expect(chooseReviewer({
      implementer: "grok@alandesktop",
      agents: [{ id: "grok@other", workload: 0 }, { id: "codex@laptop", workload: 3 }],
      max: 0, requireDifferentHarness: false, preferStronger: false, designReview: false,
    })).toBe("grok@other");
    expect(chooseReviewer({
      implementer: "grok@alandesktop",
      agents: [{ id: "codex@laptop", workload: 0 }, { id: "claude@minipc", workload: 4 }],
      max: 0, requireDifferentHarness: true, preferStronger: true, designReview: true,
    })).toBe("claude@minipc");
    expect(chooseReviewer({
      implementer: "claude@minipc", agents: [{ id: "codex@laptop", workload: 1 }],
      max: 1, requireDifferentHarness: true, preferStronger: true, designReview: true,
    })).toBeNull();

    expect(linkedReviewArgs({ title: "rev", review_of: "task-1" }, null).error).toMatch(/not found/);
    const code = linkedReviewArgs({ review_of: "task-1", blocked_by: [] }, { type: "feature" });
    expect(code.args).toMatchObject({ type: "review", review_kind: "code", blocked_by: ["task-1"] });
    const design = linkedReviewArgs({ review_of: "task-arch" }, { type: "architecture" });
    expect(design.args).toMatchObject({ type: "review", review_kind: "design", blocked_by: [] });
    expect(linkedReviewArgs({ type: "bug", review_of: "task-1" }, { type: "feature" }).error).toMatch(/type review/);
  });

  it("asks a review task for a review artifact", () => {
    const policy = { dod: { review: { artifacts: ["review"] } }, enforcement: "block" as const };
    const missing = evaluateDoD({
      task: { type: "review" }, evidence: [], artifacts: [], claimAgent: "claude@minipc", policy,
    });
    expect(missing.blocked).toBe(true);
    expect(missing.missing.join(" ")).toContain("review");
    const ok = evaluateDoD({
      task: { type: "review" }, evidence: [], artifacts: [{ kind: "review", agent_id: "claude@minipc" }],
      claimAgent: "claude@minipc", policy,
    });
    expect(ok.ok).toBe(true);
    expect(ok.blocked).toBe(false);
  });

  it("picks the least-loaded agent under the cap", () => {
    const agents = [
      { id: "agent-B", workload: 2 },
      { id: "agent-C", workload: 1 },
      { id: "dispatcher", workload: 0 },
    ];
    expect(chooseReassignAgent({ assignee: "agent-A", agents, max: 2 })).toBe("agent-C");
    expect(chooseReassignAgent({ assignee: "agent-A", agents, max: 1 })).toBeNull();
    expect(leaseActive(null)).toBe(false);
    expect(leaseActive(new Date(Date.now() + 60_000).toISOString())).toBe(true);
    expect(leaseActive(new Date(Date.now() - 1000).toISOString())).toBe(false);
  });
});

describe("agent loop docs", () => {
  it("tells agents to read inbox, claim the assignment, and work the board until idle", () => {
    const agents = readFileSync(new URL("../AGENTS.md", import.meta.url), "utf8");
    const contributing = readFileSync(new URL("../CONTRIBUTING.md", import.meta.url), "utf8");
    const harness = readFileSync(new URL("../docs/multi-harness.md", import.meta.url), "utf8");
    const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
    const server = readFileSync(new URL("../src/server.ts", import.meta.url), "utf8");
    for (const text of [agents, contributing, harness, readme, server]) {
      expect(text).toMatch(/work the board until idle/i);
      expect(text).toContain("your next task:");
    }
    expect(agents).toMatch(/complete the task, read/i);
    expect(agents).toMatch(/claim the assigned task/i);
    expect(agents).toMatch(/max_tasks_per_agent/);
    expect(agents).toMatch(/idle_minutes/);
    expect(harness).toContain('claude -p "You are claude@minipc. Read AGENTS.md and follow it. Work the board until idle."');
    expect(harness).toContain("work the board until idle");
    expect(readFileSync(join(root.pathname, "docs/multi-harness.md"), "utf8")).toContain("{{agent_id}}");
  });
});

for (const backend of ["sqlite", "postgres"] as const) {
  describe.skipIf(backend === "postgres" && !process.env.DATABASE_URL)(`${backend} dispatcher`, () => {
    let store: IStore;
    let dir: string;
    let policyPath: string;
    let oldPolicy: string | undefined;

    const basePolicy = {
      dod: { default: { evidence: ["test_run"] } },
      enforcement: "observe",
      dor: { require_type: true, require_ac_ids: true, require_estimate: true },
      dispatcher: { enabled: true, max_tasks_per_agent: 0, idle_minutes: 0 },
    };

    function writePolicy(dispatcher: Record<string, unknown> = basePolicy.dispatcher) {
      writeFileSync(policyPath, JSON.stringify({ ...basePolicy, dispatcher }));
    }

    beforeEach(async () => {
      dir = mkdtempSync(join(tmpdir(), "uw-dispatch-"));
      policyPath = join(dir, "policy.json");
      writePolicy();
      oldPolicy = process.env.UNDERWRIGHT_POLICY;
      process.env.UNDERWRIGHT_POLICY = policyPath;
      store = backend === "sqlite"
        ? new SqliteStore(join(dir, "store.db"))
        : await PgStore.connect(process.env.DATABASE_URL!);
    });

    afterEach(async () => {
      await store.close();
      if (oldPolicy === undefined) delete process.env.UNDERWRIGHT_POLICY;
      else process.env.UNDERWRIGHT_POLICY = oldPolicy;
      rmSync(dir, { recursive: true, force: true });
    });

    async function ready(title: string, extra: Record<string, unknown> = {}) {
      return store.createTask({
        title, ac_ids: ["ac"], type: "feature", estimate: "S", severity: "normal", ...extra,
      });
    }

    async function finish(id: string, agentId = "agent-A") {
      await store.reportEvidence({
        task_id: id, agent_id: agentId, kind: "test_run", exit_code: 0, ac_ids: ["ac"],
      });
      return store.completeTask(id, agentId) as any;
    }

    it("claims the next unblocked task in priority order and mails the agent", async () => {
      const blocker = await ready("blocker");
      const blocked = await ready("blocked", { priority: 0, blocked_by: [blocker.id] });
      const high = await ready("high", { priority: 1 });
      const low = await ready("low", { priority: 3 });
      await store.createTask({ title: "not ready", priority: 0 });
      const done = await ready("done", { priority: 2 });

      const result = await finish(done.id);
      expect(result.dispatched).toEqual({ task_id: high.id, agent_id: "agent-A" });
      expect(await store.getTask(high.id)).toMatchObject({ status: "claimed", claim: { agent_id: "agent-A" } });
      expect((await store.getTask(low.id)).claim).toBeNull();
      expect((await store.getTask(blocked.id)).claim).toBeNull();
      const mail = await store.inbox("agent-A");
      expect(mail).toEqual([expect.objectContaining({
        from_agent: "dispatcher", task_id: high.id, body: nextTaskMessage(high.id),
      })]);
    });

    it("offers a dependent as soon as the last blocker completes", async () => {
      const blocker = await ready("blocker", { priority: 2 });
      const dep = await ready("dep", { priority: 1, blocked_by: [blocker.id] });
      const other = await ready("other", { priority: 3 });
      const result = await finish(blocker.id);
      expect(result.dispatched.task_id).toBe(dep.id);
      expect((await store.getTask(other.id)).claim).toBeNull();
    });

    it("assigns a different task on release and does not hand the released task back", async () => {
      const held = await ready("held");
      await store.claimTask(held.id, "agent-A");
      const alone = await store.releaseTask(held.id, "agent-A") as any;
      expect(alone.dispatched).toBeUndefined();
      expect(await store.getTask(held.id)).toMatchObject({ status: "open", claim: null });

      await store.claimTask(held.id, "agent-A");
      const next = await ready("next");
      const released = await store.releaseTask(held.id, "agent-A") as any;
      expect(released.dispatched).toEqual({ task_id: next.id, agent_id: "agent-A" });
      expect(await store.getTask(held.id)).toMatchObject({ status: "open", claim: null });
      expect((await store.getTask(next.id)).claim.agent_id).toBe("agent-A");
      expect((await store.inbox("agent-A")).map((m: any) => m.body)).toContain(nextTaskMessage(next.id));
    });

    it("does not assign when the dispatcher is off, the agent is at the cap, or completion was refused", async () => {
      writePolicy({ enabled: false, max_tasks_per_agent: 5, idle_minutes: 0 });
      const offNext = await ready("off-next");
      const offDone = await ready("off-done");
      expect((await finish(offDone.id)).dispatched).toBeUndefined();
      expect((await store.getTask(offNext.id)).claim).toBeNull();

      writePolicy({ enabled: true, max_tasks_per_agent: 1, idle_minutes: 0 });
      const cappedNext = await ready("capped-next");
      const cappedDone = await ready("capped-done");
      expect((await finish(cappedDone.id)).dispatched).toBeUndefined();
      expect((await store.getTask(cappedNext.id)).claim).toBeNull();
      expect((await store.auditLog(80)).some((e: any) => e.action === "dispatch_capped")).toBe(true);

      writePolicy({ enabled: true, max_tasks_per_agent: 0, idle_minutes: 0 });
      const refusedNext = await ready("refused-next");
      const refused = await ready("refused");
      expect((await store.completeTask(refused.id, "agent-A") as any).error).toBeTruthy();
      expect((await store.getTask(refusedNext.id)).claim).toBeNull();
      expect((await store.releaseTask(refused.id, "nobody") as any).error).toBeTruthy();
    });

    it("reassigns a stale unclaimed next-task message and leaves an active claim alone", async () => {
      const touch = await ready("touch");
      await store.claimTask(touch.id, "agent-B");
      await store.releaseTask(touch.id, "agent-B");
      const target = await ready("target");
      await store.sendMessage("agent-A", "dispatcher", nextTaskMessage(target.id));
      const sweep = await store.sweepIdleDispatches();
      expect(sweep.reassigned).toEqual([target.id]);
      expect((await store.getTask(target.id)).claim.agent_id).toBe("agent-B");
      expect((await store.inbox("agent-B")).map((m: any) => m.body)).toContain(nextTaskMessage(target.id));
      expect(await store.sweepIdleDispatches()).toEqual({ reassigned: [], logged: [] });

      const held = await ready("held");
      await store.claimTask(held.id, "agent-A");
      await store.sendMessage("agent-A", "dispatcher", nextTaskMessage(held.id), held.id);
      expect(await store.sweepIdleDispatches()).toEqual({ reassigned: [], logged: [] });
      expect((await store.getTask(held.id)).claim.agent_id).toBe("agent-A");
    });

    it("takes over an expired claim and logs once when nobody else can take the task", async () => {
      const touch = await ready("touch");
      await store.claimTask(touch.id, "agent-B");
      await store.releaseTask(touch.id, "agent-B");
      const expired = await ready("expired");
      await store.claimTask(expired.id, "agent-A", -1);
      await store.sendMessage("agent-A", "dispatcher", nextTaskMessage(expired.id), expired.id);
      expect((await store.sweepIdleDispatches()).reassigned).toEqual([expired.id]);
      expect((await store.getTask(expired.id)).claim.agent_id).toBe("agent-B");

      writePolicy({ enabled: true, max_tasks_per_agent: 1, idle_minutes: 0 });
      const done = await ready("done-by-b");
      await finish(done.id, "agent-B");
      const lonely = await ready("lonely");
      await store.sendMessage("agent-A", "dispatcher", nextTaskMessage(lonely.id), lonely.id);
      const logged = await store.sweepIdleDispatches();
      expect(logged).toEqual({ reassigned: [], logged: [lonely.id] });
      expect((await store.getTask(lonely.id)).claim).toBeNull();
      expect((await store.sweepIdleDispatches()).logged).toEqual([]);
      expect((await store.auditLog(100)).some((e: any) => e.action === "dispatch_idle")).toBe(true);
    });

    it("ignores a fresh message when the idle window has not elapsed", async () => {
      writePolicy({ enabled: true, max_tasks_per_agent: 0, idle_minutes: 60 });
      const touch = await ready("touch");
      await store.claimTask(touch.id, "agent-B");
      await store.releaseTask(touch.id, "agent-B");
      const target = await ready("fresh");
      await store.sendMessage("agent-A", "dispatcher", nextTaskMessage(target.id), target.id);
      expect(await store.sweepIdleDispatches()).toEqual({ reassigned: [], logged: [] });
      expect((await store.getTask(target.id)).claim).toBeNull();
    });

    it("logs a blocked assignment instead of claiming it", async () => {
      const blocker = await ready("blocker");
      const target = await ready("blocked-target", { blocked_by: [blocker.id] });
      const other = await ready("other");
      await store.claimTask(other.id, "agent-B");
      await store.releaseTask(other.id, "agent-B");
      await store.sendMessage("agent-A", "dispatcher", nextTaskMessage(target.id), target.id);
      const sweep = await store.sweepIdleDispatches();
      expect(sweep.logged).toContain(target.id);
      expect(sweep.reassigned).not.toContain(target.id);
      expect((await store.getTask(target.id)).claim).toBeNull();
    });

    async function register(agentId: string) {
      const task = await ready(`reg-${agentId}`, { priority: 4 });
      await store.claimTask(task.id, agentId);
      const done = await finish(task.id, agentId) as { error?: string };
      expect(done.error).toBeUndefined();
    }

    it("links a code review to its subject and blocks the claim until that subject is done", async () => {
      const feature = await ready("feature");
      const missing = await store.createTask({
        title: "missing subject", review_of: "missing-task", ac_ids: ["ac"], estimate: "S", type: "review",
      }) as { error?: string };
      expect(missing.error).toMatch(/not found/);
      const wrongType = await store.createTask({
        title: "wrong type", review_of: feature.id, type: "bug", ac_ids: ["ac"], estimate: "S",
      }) as { error?: string };
      expect(wrongType.error).toMatch(/type review/);

      const review = await store.createTask({
        title: "review feature", review_of: feature.id, ac_ids: ["ac"], estimate: "S",
      });
      expect(review).toMatchObject({
        type: "review", review_kind: "code", review_of: feature.id, blocked_by: [feature.id], status: "blocked",
      });
      expect((await store.getTask(feature.id)).reviews).toEqual([review.id]);
      expect((await store.claimTask(review.id, "claude@minipc") as any).error).toMatch(/blocked/);
    });

    it("refuses the implementer at the claim gate and lets a different agent renew", async () => {
      const feature = await ready("feature");
      await store.claimTask(feature.id, "grok@alandesktop");
      const review = await store.createTask({
        title: "review feature", review_of: feature.id, ac_ids: ["ac"], estimate: "S",
      });
      await finish(feature.id, "grok@alandesktop");
      const denied = await store.claimTask(review.id, "grok@alandesktop") as { error?: string };
      expect(denied.error).toMatch(/cannot claim this review/);
      expect(denied.error).toContain("grok@alandesktop");
      const allowed = await store.claimTask(review.id, "claude@minipc") as { error?: string; agent_id?: string };
      expect(allowed.error).toBeUndefined();
      expect(allowed.agent_id).toBe("claude@minipc");
      const renewed = await store.claimTask(review.id, "claude@minipc") as { error?: string };
      expect(renewed.error).toBeUndefined();
    });

    it("routes a code review to a stronger harness and still gives the implementer other work", async () => {
      await register("claude@minipc");
      await register("cmdc@box");
      const feature = await ready("feature");
      await store.claimTask(feature.id, "grok@alandesktop");
      const review = await store.createTask({
        title: "review feature", review_of: feature.id, ac_ids: ["ac"], estimate: "S", priority: 1,
      });
      const follow = await ready("follow", { priority: 3 });
      const result = await finish(feature.id, "grok@alandesktop") as { dispatched?: { task_id: string; agent_id: string } };
      expect((await store.getTask(review.id)).claim.agent_id).toBe("claude@minipc");
      expect((await store.inbox("claude@minipc")).map((m: any) => m.body)).toContain(nextTaskMessage(review.id));
      expect(result.dispatched).toEqual({ task_id: follow.id, agent_id: "grok@alandesktop" });
      expect((await store.getTask(follow.id)).claim.agent_id).toBe("grok@alandesktop");
    });

    it("leaves a review open when the only other agent is the same harness", async () => {
      await register("grok@other");
      const feature = await ready("feature");
      await store.claimTask(feature.id, "grok@alandesktop");
      const review = await store.createTask({
        title: "review feature", review_of: feature.id, ac_ids: ["ac"], estimate: "S", priority: 1,
      });
      const follow = await ready("follow", { priority: 3 });
      const result = await finish(feature.id, "grok@alandesktop") as { dispatched?: { task_id: string } };
      expect((await store.getTask(review.id)).claim).toBeNull();
      expect(result.dispatched).toEqual({ task_id: follow.id, agent_id: "grok@alandesktop" });
    });

    it("routes a design review of an architecture task to a high-tier harness before the subject is done", async () => {
      await register("codex@laptop");
      await register("claude@minipc");
      const arch = await ready("arch", { type: "architecture" });
      await store.claimTask(arch.id, "grok@alandesktop");
      const design = await store.createTask({
        title: "design review", review_of: arch.id, ac_ids: ["ac"], estimate: "S", priority: 1,
      });
      expect(design).toMatchObject({ type: "review", review_kind: "design", blocked_by: [], status: "open" });
      expect((await store.getTask(arch.id)).reviews).toEqual([design.id]);
      const other = await ready("other", { priority: 3 });
      await store.claimTask(other.id, "grok@alandesktop");
      await finish(other.id, "grok@alandesktop");
      expect((await store.getTask(design.id)).claim.agent_id).toBe("claude@minipc");
      expect((await store.getTask(arch.id)).claim.agent_id).toBe("grok@alandesktop");
    });

    it("reassigns a stale review away from the implementer to a stronger harness", async () => {
      await register("claude@minipc");
      await register("grok@other");
      const feature = await ready("feature");
      await store.claimTask(feature.id, "grok@alandesktop");
      await finish(feature.id, "grok@alandesktop");
      const review = await store.createTask({
        title: "review feature", review_of: feature.id, ac_ids: ["ac"], estimate: "S",
      });
      expect((await store.getTask(review.id)).status).toBe("open");
      await store.sendMessage("grok@alandesktop", "dispatcher", nextTaskMessage(review.id), review.id);
      const sweep = await store.sweepIdleDispatches();
      expect(sweep.reassigned).toEqual([review.id]);
      expect((await store.getTask(review.id)).claim.agent_id).toBe("claude@minipc");
    });
  });
}
