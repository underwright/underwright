import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteStore } from "../src/store.js";
import { PgStore } from "../src/pstore.js";
import type { IStore } from "../src/istore.js";

for (const backend of ["sqlite", "postgres"] as const) {
  describe.skipIf(backend === "postgres" && !process.env.DATABASE_URL)(`${backend} automatic reviews`, () => {
    let store: IStore, dir: string, oldPolicy: string | undefined;
    const policy = (lifecycle: object = { enabled: true }) => writeFileSync(join(dir, "policy.json"), JSON.stringify({
      dod: {}, enforcement: "observe", lifecycle,
      dispatcher: { enabled: true, review: { require_different_harness: true, prefer_stronger: true } },
    }));
    beforeEach(async () => {
      dir = mkdtempSync(join(tmpdir(), "uw-auto-review-"));
      oldPolicy = process.env.UNDERWRIGHT_POLICY;
      process.env.UNDERWRIGHT_POLICY = join(dir, "policy.json");
      policy();
      store = backend === "sqlite" ? new SqliteStore(join(dir, "db")) : await PgStore.connect(process.env.DATABASE_URL!);
    });
    afterEach(async () => {
      await store.close();
      if (oldPolicy === undefined) delete process.env.UNDERWRIGHT_POLICY;
      else process.env.UNDERWRIGHT_POLICY = oldPolicy;
      rmSync(dir, { recursive: true, force: true });
    });
    const task = (extra: object = {}) => store.createTask({ title: "implementation", type: "feature", estimate: "M", ac_ids: ["works"], ...extra });
    const prove = (id: string, agent_id = "codex@author") => store.reportEvidence({ task_id: id, agent_id, kind: "test_run", exit_code: 0, ac_ids: ["works"] });

    it("creates and routes an independent review before dispatch; retry reuses it", async () => {
      const registration = await task({ title: "reviewer registration" });
      await store.claimTask(registration.id, "claude@reviewer");
      const t = await task();
      await store.claimTask(t.id, "codex@author");
      await prove(t.id);
      expect(await store.completeTask(t.id, "codex@author")).toMatchObject({ completed: t.id });
      const subject = await store.getTask(t.id);
      expect(subject.reviews).toHaveLength(1);
      const review = await store.getTask(subject.reviews[0]);
      expect(review).toMatchObject({ type: "review", review_of: t.id, review_kind: "code", claim: { agent_id: "claude@reviewer" } });
      expect((await store.claimTask(review.id, "codex@other")).error).toBeTruthy();
      await store.completeTask(t.id, "codex@author");
      await store.setTaskStatus(t.id, "open", "human");
      await store.completeTask(t.id, "codex@author");
      expect((await store.getTask(t.id)).reviews).toEqual([review.id]);
    });
    it("creates a review on the scoped worker completion path and keeps it open without an eligible family", async () => {
      const registration = await task({ title: "same-family registration" });
      await store.claimTask(registration.id, "codex@other");
      const t = await task(); await prove(t.id);
      await store.completeTask(t.id, "codex@author", true);
      const ids = (await store.getTask(t.id)).reviews;
      expect(ids).toHaveLength(1);
      expect(await store.getTask(ids[0])).toMatchObject({ status: "open", claim: null });
      expect((await store.claimTask(ids[0], "codex@other")).error).toMatch(/harness/);
    });
    it("does not spawn when completion fails, lifecycle is disabled, or the pipeline skips review", async () => {
      const t = await task();
      expect((await store.completeTask(t.id, "codex@author")).error).toBeTruthy();
      expect((await store.getTask(t.id)).reviews).toEqual([]);
      await prove(t.id); policy({ enabled: false });
      await store.completeTask(t.id, "codex@author");
      expect((await store.getTask(t.id)).reviews).toEqual([]);
      policy({ enabled: true, pipelines: { feature: { review: false } } });
      const skipped = await task(); await prove(skipped.id);
      await store.completeTask(skipped.id, "codex@author");
      expect((await store.getTask(skipped.id)).reviews).toEqual([]);
    });
    it("reuses a manual review, selects design for architecture, and never reviews reviews", async () => {
      const t = await task({ type: "architecture" });
      const review = await store.createTask({ title: "manual", review_of: t.id, ac_ids: ["works"], estimate: "S" });
      await prove(t.id); await store.completeTask(t.id, "codex@author", true);
      expect((await store.getTask(t.id)).reviews).toEqual([review.id]);
      expect(await store.getTask(review.id)).toMatchObject({ review_kind: "design" });
      await prove(review.id, "claude@reviewer");
      await store.completeTask(review.id, "claude@reviewer", true);
      expect((await store.getTask(review.id)).reviews).toEqual([]);
    });
    it("spawns a design review and supports an explicit pipeline kind", async () => {
      const arch = await task({ type: "architecture" }); await prove(arch.id);
      await store.completeTask(arch.id, "codex@author", true);
      const review = await store.getTask((await store.getTask(arch.id)).reviews[0]);
      expect(review).toMatchObject({ review_kind: "design", blocked_by: [] });
      policy({ enabled: true, pipelines: { feature: { review_kind: "design" } } });
      const custom = await task(); await prove(custom.id);
      await store.completeTask(custom.id, "codex@author", true);
      expect(await store.getTask((await store.getTask(custom.id)).reviews[0])).toMatchObject({ review_kind: "design" });
    });
    it("creates one review for each member sharing a PR reference", async () => {
      const a = await task({ spec_ref: "https://github.com/example/repo/pull/1" });
      const b = await task({ spec_ref: a.spec_ref });
      for (const t of [a,b]) { await prove(t.id); await store.completeTask(t.id, "codex@author", true); }
      const ar = (await store.getTask(a.id)).reviews, br = (await store.getTask(b.id)).reviews;
      expect(ar).toHaveLength(1); expect(br).toHaveLength(1); expect(ar).not.toEqual(br);
    });
  });
}
