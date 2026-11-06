import { describe, it, expect, beforeEach, afterEach, beforeAll } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { SqliteStore } from "../src/store.js";
import { PgStore } from "../src/pstore.js";
import { extractAcIds, parseSpecKitContent, importSpecKit } from "../src/speckit.js";
import type { IStore } from "../src/istore.js";

const root = fileURLToPath(new URL("..", import.meta.url));
const cli = join(root, "dist/cli.js");

const SAMPLE_CONSTITUTION = `# Project Constitution

## Principles
- Deterministic gates over LLM judgment
`;

const SAMPLE_SPEC = `# Feature Specification: Spec Kit Interop

## Acceptance Criteria
- [ ] speckit-import: Import constitution, spec, plan, and tasks markdown as spec artifacts
- [ ] ac-linking: Extract acceptance criteria IDs and link them to task.ac_ids
- **AC-01**: Support directory and single-file imports
`;

const SAMPLE_PLAN = `# Implementation Plan

## Architecture
- Add src/speckit.ts parser and importer
`;

const SAMPLE_TASKS = `# Tasks

- [ ] T001 Implement Spec Kit parser [AC: speckit-import]
- [ ] T002 Link AC IDs to tasks (ac: ac-linking, AC-01)
`;

describe("Spec Kit parser (extractAcIds & parseSpecKitContent)", () => {
  it("extracts explicit AC ids from checklists, bullets, and inline tags", () => {
    const ids = extractAcIds(SAMPLE_SPEC + "\n" + SAMPLE_TASKS);
    expect(ids).toEqual(expect.arrayContaining(["speckit-import", "ac-linking", "AC-01"]));
  });

  it("classifies constitution, spec, plan, and tasks markdown documents", () => {
    expect(parseSpecKitContent(SAMPLE_CONSTITUTION, "memory/constitution.md").docType).toBe("constitution");
    expect(parseSpecKitContent(SAMPLE_SPEC, "specs/001-interop/spec.md").docType).toBe("spec");
    expect(parseSpecKitContent(SAMPLE_PLAN, "specs/001-interop/plan.md").docType).toBe("plan");
    const tasksDoc = parseSpecKitContent(SAMPLE_TASKS, "specs/001-interop/tasks.md");
    expect(tasksDoc.docType).toBe("tasks");
    expect(tasksDoc.tasks).toHaveLength(2);
    expect(tasksDoc.tasks[0]).toMatchObject({
      id: "T001",
      title: "Implement Spec Kit parser",
      ac_ids: ["speckit-import"],
    });
    expect(tasksDoc.tasks[1]).toMatchObject({
      id: "T002",
      title: "Link AC IDs to tasks",
      ac_ids: ["ac-linking", "AC-01"],
    });
  });
});

for (const backend of ["sqlite", "postgres"] as const) {
  describe.skipIf(backend === "postgres" && !process.env.DATABASE_URL)(`${backend} Spec Kit compatibility`, () => {
    let store: IStore;
    let dir: string;

    beforeEach(async () => {
      dir = mkdtempSync(join(tmpdir(), "uw-speckit-"));
      process.env.UNDERWRIGHT_POLICY = join(dir, "no-policy.json");
      store = backend === "sqlite"
        ? new SqliteStore(":memory:")
        : await PgStore.connect(process.env.DATABASE_URL!);
    });

    afterEach(async () => {
      await store.close();
      delete process.env.UNDERWRIGHT_POLICY;
      rmSync(dir, { recursive: true, force: true });
    });

    it("speckit-import: accepts constitution/spec/plan/tasks markdown as spec artifacts", async () => {
      const specDir = join(dir, ".specify");
      mkdirSync(join(specDir, "memory"), { recursive: true });
      mkdirSync(join(specDir, "specs", "001-feature"), { recursive: true });
      writeFileSync(join(specDir, "memory", "constitution.md"), SAMPLE_CONSTITUTION);
      writeFileSync(join(specDir, "specs", "001-feature", "spec.md"), SAMPLE_SPEC);
      writeFileSync(join(specDir, "specs", "001-feature", "plan.md"), SAMPLE_PLAN);
      writeFileSync(join(specDir, "specs", "001-feature", "tasks.md"), SAMPLE_TASKS);

      const task = await store.createTask({ title: "Target task" });
      const res = await store.importSpecKit({
        path: specDir,
        task_id: task.id,
        agent_id: "test-agent",
      });

      expect(res.artifacts).toHaveLength(4);
      expect(res.artifacts.map((a: any) => a.doc_type).sort()).toEqual(["constitution", "plan", "spec", "tasks"]);

      const stored = await store.listArtifacts(task.id);
      expect(stored).toHaveLength(4);
      for (const art of stored) {
        expect(art.kind).toBe("spec");
      }

      const hits = await store.searchContext("Constitution", ["artifact"]);
      expect(hits.some((h: any) => h.entity_type === "artifact")).toBe(true);
    });

    it("ac-linking: links extracted ac_ids to an existing task's ac_ids and sets spec_ref", async () => {
      const task = await store.createTask({
        title: "Existing feature task",
        ac_ids: ["existing-ac"],
      });

      const res = await importSpecKit(store, {
        task_id: task.id,
        agent_id: "test-agent",
        documents: [
          { doc_type: "constitution", content: SAMPLE_CONSTITUTION },
          { doc_type: "spec", title: "specs/001/spec.md", content: SAMPLE_SPEC },
          { doc_type: "plan", content: SAMPLE_PLAN },
          { doc_type: "tasks", content: SAMPLE_TASKS },
        ],
      });

      expect(res.ac_ids).toEqual(expect.arrayContaining(["speckit-import", "ac-linking", "AC-01"]));
      const updated = await store.getTask(task.id);
      expect(updated.ac_ids).toEqual(expect.arrayContaining(["existing-ac", "speckit-import", "ac-linking", "AC-01"]));
      expect(updated.spec_ref).toBe("specs/001/spec.md");

      // Evidence gate enforces the newly linked ACs
      const failComplete = await store.completeTask(task.id, "test-agent");
      expect(failComplete).toHaveProperty("error");
      expect(failComplete.error).toContain("speckit-import");
    });

    it("creates tasks from tasks.md items when create_tasks is true and links ac_ids", async () => {
      const res = await store.importSpecKit({
        agent_id: "test-agent",
        create_tasks: true,
        documents: [
          { doc_type: "spec", title: "specs/001/spec.md", content: SAMPLE_SPEC },
          { doc_type: "tasks", title: "specs/001/tasks.md", content: SAMPLE_TASKS },
        ],
      });

      expect(res.created_tasks).toHaveLength(2);
      const t1 = await store.getTask(res.created_tasks[0].id);
      expect(t1.title).toContain("T001");
      expect(t1.ac_ids).toEqual(["speckit-import"]);
      expect(t1.spec_ref).toBe("specs/001/spec.md");

      const t2 = await store.getTask(res.created_tasks[1].id);
      expect(t2.ac_ids).toEqual(["ac-linking", "AC-01"]);
    });
  });
}

describe("CLI speckit import", () => {
  beforeAll(() => {
    if (!existsSync(cli)) execFileSync("npm", ["run", "build"], { cwd: root, stdio: "ignore" });
  });

  it("imports a Spec Kit directory and links ac_ids to --task via CLI", () => {
    const dir = mkdtempSync(join(tmpdir(), "uw-speckit-cli-"));
    const db = join(dir, "uw.db");
    const specFile = join(dir, "spec.md");
    writeFileSync(specFile, SAMPLE_SPEC);

    try {
      const created = JSON.parse(execFileSync(process.execPath, [cli, "create", "--title", "CLI SpecKit Task"], {
        encoding: "utf8",
        env: { ...process.env, UNDERWRIGHT_DB: db, UNDERWRIGHT_POLICY: join(dir, "no-policy.json") },
      }));

      const imported = JSON.parse(execFileSync(
        process.execPath,
        [cli, "speckit", "import", "--path", specFile, "--task", created.id],
        {
          encoding: "utf8",
          env: { ...process.env, UNDERWRIGHT_DB: db, UNDERWRIGHT_POLICY: join(dir, "no-policy.json") },
        }
      ));

      expect(imported.artifacts).toHaveLength(1);
      expect(imported.ac_ids).toEqual(expect.arrayContaining(["speckit-import", "ac-linking", "AC-01"]));

      const store = new SqliteStore(db);
      const updated = store.getTask(created.id);
      store.close();
      expect(updated.ac_ids).toEqual(expect.arrayContaining(["speckit-import", "ac-linking", "AC-01"]));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30000);
});
