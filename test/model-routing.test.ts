import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteStore } from "../src/store.js";
import type { Policy } from "../src/policy.js";
import { agentInvocation } from "../src/runner.js";
import {
  classifyTask,
  escalatedSpec,
  getModelRouting,
  isModelEscalation,
  modelFlag,
  modelTierReport,
  nextTier,
  resolveModel,
  routeAgentSpec,
  runModelEscalation,
} from "../src/model-routing.js";

const cleanups: (() => void)[] = [];
afterEach(() => { cleanups.splice(0).reverse().forEach(f => f()); });
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "uw-model-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const store = new SqliteStore(join(dir, "model.db"));
  cleanups.push(() => store.close());
  return store;
}

const routed: Policy = {
  dod: {}, enforcement: "observe",
  model_routing: {
    enabled: true,
    models: {
      claude: { light: "haiku", standard: "sonnet", heavy: "opus" },
      codex: { light: "gpt-5.4-mini", heavy: "gpt-5.4" },
    },
  },
} as Policy;

const spec = { executable: "claude", args: ["-p"], prompt: "work {{task_id}}", harness: "claude" };

describe("complexity-map", () => {
  const r = getModelRouting(routed);
  it.each([
    [{ estimate: "S", type: "feature" }, "light"],
    [{ estimate: "M", type: "feature" }, "standard"],
    [{ estimate: "L", type: "feature" }, "heavy"],
    [{ estimate: "S", type: "architecture" }, "heavy"],
    [{ estimate: "M", type: "review", review_kind: "design" }, "heavy"],
    [{ type: "docs" }, "light"],
    [{ estimate: "M", ac_ids: ["a", "b", "c", "d", "e", "f"] }, "heavy"],
    [{}, "standard"],
  ])("%o → %s", (task, tier) => {
    expect(classifyTask(task as any, r).tier).toBe(tier);
  });

  it("policy rules win, first match, incl. repo area by ownership path", () => {
    const custom = getModelRouting({
      ...routed,
      model_routing: {
        enabled: true,
        rules: [
          { paths: ["src/schema.ts", "src/store/**"], tier: "heavy" },
          { estimate: ["S", "M"], tier: "light" },
        ],
        default_tier: "standard",
      },
    } as Policy);
    expect(classifyTask({ estimate: "S", ownership: { paths: ["src/schema.ts"] } } as any, custom))
      .toMatchObject({ tier: "heavy", reason: expect.stringContaining("paths") });
    expect(classifyTask({ estimate: "M", ownership: { paths: ["src/store/x.ts"] } } as any, custom).tier).toBe("heavy");
    expect(classifyTask({ estimate: "M", ownership: { paths: ["docs/a.md"] } } as any, custom).tier).toBe("light");
    expect(classifyTask({ estimate: "L" } as any, custom).tier).toBe("standard");
  });

  it("is off when the policy block is missing or disabled", () => {
    expect(getModelRouting({ dod: {}, enforcement: "observe" }).enabled).toBe(false);
    expect(getModelRouting({ ...routed, model_routing: { enabled: false } } as Policy).enabled).toBe(false);
  });

  it("drops malformed rules and tiers", () => {
    const r2 = getModelRouting({ ...routed, model_routing: { enabled: true, default_tier: "huge", rules: [{ tier: "mega" }, null, { type: ["bug"], tier: "light" }] } } as any);
    expect(r2.default_tier).toBe("standard");
    expect(r2.rules).toHaveLength(1);
  });

  it("resolves per-harness model names with family fallback", () => {
    expect(resolveModel("claude-sdk", "heavy", r)).toBe("opus");
    expect(resolveModel("claude", "light", r)).toBe("haiku");
    expect(resolveModel("codex", "standard", r)).toBeUndefined();
    expect(resolveModel("grok", "heavy", r)).toBeUndefined();
    expect(resolveModel("claude", undefined, r)).toBeUndefined();
  });

  it("nextTier climbs light → standard → heavy → null", () => {
    expect(nextTier("light")).toBe("standard");
    expect(nextTier("standard")).toBe("heavy");
    expect(nextTier("heavy")).toBeNull();
  });
});

describe("dispatch-model-arg", () => {
  it("routeAgentSpec stamps model_tier and keeps explicit choices", () => {
    expect(routeAgentSpec(spec, { estimate: "S" } as any, routed)).toMatchObject({ model_tier: "light" });
    expect(routeAgentSpec({ ...spec, model_tier: "heavy" }, { estimate: "S" } as any, routed).model_tier).toBe("heavy");
    expect(routeAgentSpec({ ...spec, model: "x" }, { estimate: "S" } as any, routed)).toEqual({ ...spec, model: "x" });
    expect(routeAgentSpec(spec, { estimate: "S" } as any, { dod: {}, enforcement: "observe" })).toEqual(spec);
  });

  it("submitJob routes agent jobs for a task", () => {
    const store = fixture();
    const task = store.createTask({ title: "tiny docs fix", estimate: "S", created_by: "t" } as any) as any;
    const prev = process.env.UNDERWRIGHT_POLICY;
    process.env.UNDERWRIGHT_POLICY = "/nonexistent/policy.json";
    try {
      const job = store.submitJob({ agent_id: "a", task_id: task.id, type: "agent", agent: spec }, routed) as any;
      const row = store.getJob(job.id) as any;
      expect(JSON.parse(row.agent_spec).model_tier).toBe("light");
    } finally {
      if (prev === undefined) delete process.env.UNDERWRIGHT_POLICY; else process.env.UNDERWRIGHT_POLICY = prev;
    }
  });

  it("modelFlag knows each harness CLI's flag", () => {
    expect(modelFlag("claude")).toBe("--model");
    expect(modelFlag("claude-sdk")).toBe("--model");
    expect(modelFlag("codex")).toBe("-m");
    expect(modelFlag("unknown-cli")).toBeNull();
  });

  it("runner passes --model to raw claude and -m to raw codex", () => {
    const job = (agent: any) => ({ id: "job-1", task_id: "t1", agent_spec: JSON.stringify(agent) });
    const claude = agentInvocation(job({ ...spec, model_tier: "heavy" }), "claude@h", "h", { policy: routed, omniAvailable: false });
    expect(claude.args.slice(0, 3)).toEqual(["--model", "opus", "-p"]);
    expect(claude.model).toBe("opus");
    const codex = agentInvocation(job({ executable: "codex", args: ["exec"], prompt: "p", model: "gpt-5.4" }), "codex@h", "h", { policy: routed, omniAvailable: false });
    expect(codex.args).toEqual(["exec", "-m", "gpt-5.4", "p"]);
  });

  it("runner passes --model through omni run", () => {
    const job = { id: "job-1", task_id: "t1", agent_spec: JSON.stringify({ ...spec, harness: "claude-sdk", backend: "omnigent", model_tier: "light" }) };
    const inv = agentInvocation(job, "claude@h", "h", { policy: routed, omniAvailable: true });
    expect(inv.executable).toBe("omni");
    expect(inv.args).toEqual(["run", "--harness", "claude-sdk", "--model", "haiku", "-p", "work t1"]);
  });

  it("runner leaves args alone when no model resolves or one is already set", () => {
    const job = (agent: any) => ({ id: "job-1", task_id: "t1", agent_spec: JSON.stringify(agent) });
    expect(agentInvocation(job({ ...spec, model_tier: "heavy" }), "a", "h", { policy: { dod: {}, enforcement: "observe" }, omniAvailable: false }).args)
      .toEqual(["-p", "work t1"]);
    expect(agentInvocation(job({ ...spec, args: ["--model", "sonnet", "-p"], model: "opus" }), "a", "h", { policy: routed, omniAvailable: false }).args)
      .toEqual(["--model", "sonnet", "-p", "work t1"]);
  });
});

describe("escalation-path", () => {
  it("recognizes the needs-stronger-model marker only", () => {
    expect(isModelEscalation("needs-stronger-model: the refactor spans 3 packages")).toBe(true);
    expect(isModelEscalation("NEEDS STRONGER MODEL")).toBe(true);
    expect(isModelEscalation("blocked on permission denied")).toBe(false);
  });

  it("escalatedSpec bumps the tier and clears the pinned model", () => {
    const r = getModelRouting(routed);
    expect(escalatedSpec({ ...spec, model_tier: "light", model: "haiku" }, r))
      .toEqual({ from: "light", to: "standard", spec: { ...spec, model_tier: "standard" } });
    expect(escalatedSpec({ ...spec, model_tier: "heavy" }, r)).toBeNull();
    expect(escalatedSpec(spec, r)?.to).toBe("heavy");
  });

  it("re-dispatches a heavier job once per blocked artifact, then hands heavy-tier blocks to the human", () => {
    const store = fixture();
    const task = store.createTask({ title: "epic", estimate: "S", created_by: "t" } as any) as any;
    store.submitJob({ agent_id: "uw-watch", task_id: task.id, type: "agent", agent: spec }, routed);
    store.postArtifact({ task_id: task.id, agent_id: "claude@h", kind: "blocked", content: "needs-stronger-model: too gnarly for haiku" });
    store.postArtifact({ task_id: task.id, agent_id: "claude@h", kind: "blocked", content: "permission denied" });

    const first = runModelEscalation(store, { policy: routed });
    expect(first).toEqual([expect.objectContaining({ task_id: task.id, action: "redispatched", from: "light", to: "standard" })]);
    const job = store.getJob(first[0].job_id!) as any;
    expect(JSON.parse(job.agent_spec)).toMatchObject({ model_tier: "standard" });
    expect(runModelEscalation(store, { policy: routed })).toEqual([]);

    store.postArtifact({ task_id: task.id, agent_id: "claude@h", kind: "blocked", content: "needs-stronger-model again" });
    expect(runModelEscalation(store, { policy: routed })[0]).toMatchObject({ action: "redispatched", from: "standard", to: "heavy" });
    store.postArtifact({ task_id: task.id, agent_id: "claude@h", kind: "blocked", content: "needs-stronger-model still" });
    expect(runModelEscalation(store, { policy: routed })[0]).toMatchObject({ action: "escalated" });
    const inbox = store.inbox("human") as any[];
    expect(inbox.some(m => m.body.includes(task.id) && m.body.includes("heaviest"))).toBe(true);
  });

  it("does nothing when routing is off", () => {
    const store = fixture();
    const task = store.createTask({ title: "x", created_by: "t" } as any) as any;
    store.postArtifact({ task_id: task.id, agent_id: "a", kind: "blocked", content: "needs-stronger-model" });
    expect(runModelEscalation(store, { policy: { dod: {}, enforcement: "observe" } })).toEqual([]);
  });
});

describe("metrics", () => {
  it("rolls tokens per task by model tier × estimate", () => {
    const report = modelTierReport(
      [
        { job_id: "j1", task_id: "t1", estimate: "S", agent_spec: JSON.stringify({ model_tier: "light", model: "haiku" }) },
        { job_id: "j2", task_id: "t2", estimate: "S", agent_spec: JSON.stringify({ model_tier: "light" }) },
        { job_id: "j3", task_id: "t3", estimate: "L", agent_spec: JSON.stringify({ model_tier: "heavy" }) },
        { job_id: "j4", task_id: "t4", estimate: null, agent_spec: JSON.stringify({}) },
      ],
      [
        { task_id: "t1", output: JSON.stringify({ tokens_in: 1000, tokens_out: 200, cost_usd: 0.01 }) },
        { task_id: "t2", output: "tokens_in=3000 tokens_out=600 cost_usd=0.03" },
        { task_id: "t3", output: JSON.stringify({ tokens_in: 50000, tokens_out: 9000, cost_usd: 2.5 }) },
        { task_id: "t3", output: "not a cost row" },
      ],
    );
    expect(report.by_tier.light).toMatchObject({ tasks: 2, tokens_in: 4000, tokens_out: 800, tokens_per_task: 2400, cost_usd: 0.04 });
    expect(report.by_tier.heavy).toMatchObject({ tasks: 1, tokens_per_task: 59000 });
    expect(report.by_tier.unrouted).toMatchObject({ tasks: 1, tokens_per_task: 0 });
    expect(report.by_tier_estimate["light:S"]).toMatchObject({ tasks: 2 });
    expect(report.by_tier_estimate["heavy:L"]).toMatchObject({ tasks: 1 });
    expect(report.by_tier_estimate["unrouted:?"]).toMatchObject({ tasks: 1 });
  });

  it("store.modelReport reads agent jobs and token-bearing evidence", () => {
    const store = fixture();
    const task = store.createTask({ title: "x", estimate: "M", created_by: "t" } as any) as any;
    store.submitJob({ agent_id: "a", task_id: task.id, type: "agent", agent: spec }, routed);
    store.reportEvidence({ task_id: task.id, agent_id: "a", kind: "test_run", output: '{"tokens_in":10,"tokens_out":5}' } as any);
    const report = store.modelReport() as any;
    expect(report.by_tier.standard).toMatchObject({ tasks: 1, tokens_in: 10, tokens_out: 5 });
  });
});
