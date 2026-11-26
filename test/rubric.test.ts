import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteStore } from "../src/store.js";
import { evaluateDoD, getRubric, type Policy } from "../src/policy.js";

const AURA = "https://github.com/covasant/Aura/issues/123";

describe("repo rubrics (gh-155)", () => {
  const policy: Policy = {
    dod: { bug: { evidence: ["test_run"] } },
    enforcement: "warn",
    rubrics: {
      "covasant/Aura": {
        enforcement: "block",
        prompt: "AURA RUBRIC",
        dod: {
          types: ["bug"],
          evidence: ["smoke_test"],
          evidence_match: [
            { kind: "test_run", pattern: "scripts/validate/", severity: "warn", desc: "no validator run" },
            { kind: "test_run", pattern: "pytest", desc: "no pytest run" },
          ],
        },
        review: { auto: true, types: ["bug"], checklist: "RUBRIC CHECKLIST" },
      },
      "*": { prompt: "generic" },
    },
  };

  it("resolves repo rubric over the * fallback", () => {
    expect(getRubric("covasant/Aura", policy)?.prompt).toBe("AURA RUBRIC");
    expect(getRubric("other/repo", policy)?.prompt).toBe("generic");
    expect(getRubric(null, policy)?.prompt).toBe("generic");
    expect(getRubric("covasant/Aura", { dod: {}, enforcement: "warn" })).toBeUndefined();
  });

  it("blocks completion on rubric-added evidence, without changing base behaviour", () => {
    // base wants test_run (warn-level global); rubric adds smoke_test at block level
    const dod = evaluateDoD({
      task: { type: "bug" }, evidence: [], artifacts: [], policy,
      rubric: getRubric("covasant/Aura", policy),
    });
    expect(dod.blocked).toBe(true);
    expect(dod.missing.join(" ")).toContain("smoke_test (rubric)");
    expect(dod.missing.join(" ")).toContain("pytest");
    // warn-severity evidence_match annotates, never blocks on its own
    expect(dod.warnings.join(" ")).toContain("no validator run");
    expect(dod.missing.join(" ")).not.toContain("no validator run");
  });

  it("scopes rubric dod by task type", () => {
    const dod = evaluateDoD({
      task: { type: "docs" }, evidence: [], artifacts: [], policy,
      rubric: getRubric("covasant/Aura", policy),
    });
    expect(dod.missing).toEqual([]);
    expect(dod.blocked).toBe(false);
  });

  it("accepts matching evidence rows as proof", () => {
    const dod = evaluateDoD({
      task: { type: "bug" },
      evidence: [
        { kind: "test_run", command: "uv run pytest tests/", output: "ok", exit_code: 0 },
        { kind: "test_run", command: "python scripts/validate/5123.py --selftest", output: "PASS", exit_code: 0 },
        { kind: "smoke_test", command: "", output: "ok", exit_code: 0 },
      ],
      artifacts: [], policy, rubric: getRubric("covasant/Aura", policy),
    });
    expect(dod.missing).toEqual([]);
    expect(dod.blocked).toBe(false);
  });

  describe("auto-review spawn", () => {
    const dirs: string[] = [];
    afterEach(() => { delete process.env.UNDERWRIGHT_POLICY; for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

    function fixture(pol: object) {
      const dir = mkdtempSync(join(tmpdir(), "uw-rubric-"));
      dirs.push(dir);
      process.env.UNDERWRIGHT_POLICY = join(dir, "policy.json");
      writeFileSync(process.env.UNDERWRIGHT_POLICY, JSON.stringify(pol));
      return new SqliteStore(join(dir, "t.db"));
    }

    function doneTask(store: SqliteStore) {
      const t = store.createTask({
        title: "fix it", spec_ref: AURA, type: "bug", estimate: "M", ac_ids: ["ac1"],
      }) as any;
      store.claimTask(t.id, "claude@laptop");
      store.reportEvidence({ task_id: t.id, agent_id: "claude@laptop", kind: "test_run",
        command: "uv run pytest tests/", output: "ok", exit_code: 0, ac_ids: ["ac1"] });
      store.reportEvidence({ task_id: t.id, agent_id: "claude@laptop", kind: "smoke_test", output: "ok", exit_code: 0 });
      return t;
    }

    it("spawns a linked review task on rubric completion", () => {
      const store = fixture(policy);
      const t = doneTask(store);
      const res = store.completeTask(t.id, "claude@laptop") as any;
      expect(res.completed).toBe(t.id);
      const reviews = store.getTask(t.id).reviews;
      expect(reviews).toHaveLength(1);
      const r = store.getTask(reviews[0]);
      expect(r.type).toBe("review");
      expect(r.review_of).toBe(t.id);
      expect(r.spec_ref).toBe(AURA);
      expect(r.description).toContain("RUBRIC CHECKLIST");
      expect(r.estimate).toBe("M");
      expect(r.ac_ids).toEqual(["ac1"]);
      store.close();
    });

    it("refuses completion when rubric-required evidence is absent", () => {
      const store = fixture(policy);
      const t = store.createTask({ title: "fix", spec_ref: AURA, type: "bug", estimate: "M", ac_ids: ["ac1"] }) as any;
      store.claimTask(t.id, "claude@laptop");
      store.reportEvidence({ task_id: t.id, agent_id: "claude@laptop", kind: "test_run",
        command: "uv run pytest", output: "ok", exit_code: 0, ac_ids: ["ac1"] });
      const res = store.completeTask(t.id, "claude@laptop") as any;
      expect(res.error).toContain("smoke_test");
      expect(store.getTask(t.id).status).not.toBe("done");
      store.close();
    });

    it("does not spawn a review without rubric review.auto", () => {
      const store = fixture({ dod: {}, enforcement: "warn", rubrics: { "covasant/Aura": { dod: { types: ["bug"], evidence: ["test_run"] } } } });
      const t = doneTask(store);
      const res = store.completeTask(t.id, "claude@laptop") as any;
      expect(res.completed).toBe(t.id);
      expect(store.getTask(t.id).reviews).toHaveLength(0);
      store.close();
    });

    it("does not review a review task (no review-of-review)", () => {
      const store = fixture(policy);
      const t = doneTask(store);
      store.completeTask(t.id, "claude@laptop");
      const reviewId = store.getTask(t.id).reviews[0];
      const r = store.getTask(reviewId);
      store.claimTask(reviewId, "kimi@yoga");
      store.postArtifact({ task_id: reviewId, agent_id: "kimi@yoga", kind: "review", content: "verdict" });
      store.reportEvidence({ task_id: reviewId, agent_id: "kimi@yoga", kind: "review", output: "PASS", exit_code: 0, ac_ids: ["ac1"] });
      const res = store.completeTask(reviewId, "kimi@yoga") as any;
      expect(res.completed).toBe(reviewId);
      expect(store.getTask(reviewId).reviews).toHaveLength(0);
      store.close();
    });

    it("dod.review.artifacts refuses a review task closed without its artifact (gh-257)", () => {
      const store = fixture({ dod: { review: { artifacts: ["review"] } }, enforcement: "block" });
      const subj = store.createTask({ title: "subject", spec_ref: AURA, type: "bug", estimate: "M", ac_ids: ["ac1"] }) as any;
      const r = store.createTask({ title: "rubric review", type: "review", review_of: subj.id, review_kind: "code", estimate: "M", ac_ids: ["ac1"] }) as any;
      store.claimTask(r.id, "codex@laptop");
      store.reportEvidence({ task_id: r.id, agent_id: "codex@laptop", kind: "review", output: "PASS", exit_code: 0, ac_ids: ["ac1"] });
      const denied = store.completeTask(r.id, "codex@laptop") as any;
      expect(denied.error).toContain("artifact kind: review");
      expect(store.getTask(r.id).status).not.toBe("done");
      store.postArtifact({ task_id: r.id, agent_id: "codex@laptop", kind: "review", title: "rubric verdict", content: "ACs verified" });
      const ok = store.completeTask(r.id, "codex@laptop") as any;
      expect(ok.completed).toBe(r.id);
      store.close();
    });
  });
});
