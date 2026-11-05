import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { SqliteStore } from "../src/store.js";
import {
  syncPRs,
  checkPRGate,
  postEvidenceComment,
  linkPR,
  evidencePack,
} from "../src/github.js";
import { rmSync } from "node:fs";

const DB = "/tmp/uw-test-github.db";
let store: SqliteStore;

beforeEach(() => {
  rmSync(DB, { force: true });
  rmSync(`${DB}-wal`, { force: true });
  rmSync(`${DB}-shm`, { force: true });
  process.env.UNDERWRIGHT_POLICY = "/tmp/uw-no-policy.json";
  store = new SqliteStore(DB);
});

afterEach(() => store.close());

describe("pr-link: syncPRs & linkPR", () => {
  it("imports new open PR as task when unmapped", async () => {
    const mockPrs = [
      {
        number: 42,
        title: "Add awesome feature",
        body: "Detailed description",
        url: "https://github.com/org/repo/pull/42",
        state: "OPEN",
        labels: [{ name: "p1" }],
        headRefName: "feat/awesome",
      },
    ];

    const runner = (cmd: string) => {
      if (cmd.startsWith("pr list")) return mockPrs;
      throw new Error(`Unexpected command: ${cmd}`);
    };

    const res = await syncPRs(store, "org/repo", "test-agent", { runner });
    expect(res.imported).toBe(1);

    const task = store.getTask("pr-42");
    expect(task).toBeDefined();
    expect(task.title).toBe("[PR #42] Add awesome feature");
    expect(task.spec_ref).toBe("https://github.com/org/repo/pull/42");
    expect(task.priority).toBe(1);
  });

  it("links PR to existing task via uw:task-id marker in body and reports pr-link", async () => {
    const task = store.createTask({
      id: "task-feat-1",
      title: "Existing task",
      ac_ids: ["pr-link"],
    });

    const mockPrs = [
      {
        number: 43,
        title: "Fix existing task",
        body: "Work on feature.\n\nuw:task-feat-1\n",
        url: "https://github.com/org/repo/pull/43",
        state: "OPEN",
        labels: [],
        headRefName: "patch-1",
      },
    ];

    const runner = (cmd: string) => {
      if (cmd.startsWith("pr list")) return mockPrs;
      throw new Error(`Unexpected command: ${cmd}`);
    };

    const res = await syncPRs(store, "org/repo", "test-agent", { runner });
    expect(res.linked).toEqual([{ taskId: "task-feat-1", pr: 43 }]);

    const updated = store.getTask("task-feat-1");
    expect(updated.spec_ref).toBe("https://github.com/org/repo/pull/43");

    const evidence = store.getEvidence("task-feat-1");
    const proven = new Set(evidence.flatMap((e: any) => JSON.parse(e.ac_ids)));
    expect(proven.has("pr-link")).toBe(true);
  });

  it("linkPR directly links task to PR and attaches pr-link evidence", async () => {
    const task = store.createTask({
      id: "task-direct-1",
      title: "Direct link task",
      ac_ids: ["pr-link"],
    });

    await linkPR(store, "task-direct-1", 99, "org/repo", { actor: "test-agent" });

    const updated = store.getTask("task-direct-1");
    expect(updated.spec_ref).toBe("https://github.com/org/repo/pull/99");

    const evidence = store.getEvidence("task-direct-1");
    const proven = new Set(evidence.flatMap((e: any) => JSON.parse(e.ac_ids)));
    expect(proven.has("pr-link")).toBe(true);
  });
});

describe("checks-gate: checkPRGate", () => {
  it("blocks task completion when PR checks fail or are pending", async () => {
    const task = store.createTask({
      id: "task-gate-1",
      title: "Gate test task",
      spec_ref: "https://github.com/org/repo/pull/50",
      ac_ids: ["checks-gate"],
    });

    const mockChecksFail = {
      statusCheckRollup: [
        {
          __typename: "CheckRun",
          name: "test",
          status: "COMPLETED",
          conclusion: "FAILURE",
          detailsUrl: "https://ci/test",
        },
        {
          __typename: "CheckRun",
          name: "build",
          status: "IN_PROGRESS",
          conclusion: null,
          detailsUrl: "https://ci/build",
        },
      ],
    };

    const runner = (cmd: string) => {
      if (cmd.includes("pr view 50")) return mockChecksFail;
      throw new Error(`Unexpected command: ${cmd}`);
    };

    const gate = await checkPRGate(store, "org/repo", "task-gate-1", {
      actor: "gate-agent",
      runner,
    });

    expect(gate.ok).toBe(false);
    expect(gate.failed).toBe(1);
    expect(gate.pending).toBe(1);

    // completeTask must refuse because checks-gate has no valid proof
    const completion = store.completeTask("task-gate-1", "test-agent");
    expect(completion).toHaveProperty("error");
    expect(completion.error).toContain("checks-gate");
  });

  it("proves checks-gate and allows completion when all PR checks succeed", async () => {
    const task = store.createTask({
      id: "task-gate-2",
      title: "Passing gate task",
      spec_ref: "https://github.com/org/repo/pull/51",
      ac_ids: ["checks-gate"],
    });

    const mockChecksPass = {
      statusCheckRollup: [
        {
          __typename: "CheckRun",
          name: "test",
          status: "COMPLETED",
          conclusion: "SUCCESS",
          detailsUrl: "https://ci/test",
        },
        {
          __typename: "CheckRun",
          name: "build",
          status: "COMPLETED",
          conclusion: "SUCCESS",
          detailsUrl: "https://ci/build",
        },
      ],
    };

    const runner = (cmd: string) => {
      if (cmd.includes("pr view 51")) return mockChecksPass;
      throw new Error(`Unexpected command: ${cmd}`);
    };

    const gate = await checkPRGate(store, "org/repo", "task-gate-2", {
      actor: "gate-agent",
      runner,
    });

    expect(gate.ok).toBe(true);
    expect(gate.passed).toBe(2);
    expect(gate.failed).toBe(0);

    const completion = store.completeTask("task-gate-2", "gate-agent");
    expect(completion).toHaveProperty("completed", "task-gate-2");
  });
});

describe("evidence-comment: postEvidenceComment", () => {
  it("posts evidence comment to PR and attaches evidence-comment proof", async () => {
    const task = store.createTask({
      id: "task-comm-1",
      title: "Comment test task",
      spec_ref: "https://github.com/org/repo/pull/60",
      ac_ids: ["evidence-comment"],
    });

    store.reportEvidence({
      task_id: "task-comm-1",
      agent_id: "agent-1",
      kind: "test_run",
      command: "npm test",
      exit_code: 0,
      output: "All 10 tests passed",
    });

    let postedCmd = "";
    let postedInput = "";
    const runner = (cmd: string, input?: string) => {
      postedCmd = cmd;
      postedInput = input ?? "";
      return "";
    };

    const res = await postEvidenceComment(store, "org/repo", "task-comm-1", {
      actor: "agent-1",
      runner,
    });

    expect(res).toEqual({ posted: "pr#60" });
    expect(postedCmd).toContain("pr comment 60 --repo org/repo");
    expect(postedInput).toContain("### Evidence pack — task-comm-1");
    expect(postedInput).toContain("npm test");

    // Check evidence-comment was proven
    const completion = store.completeTask("task-comm-1", "agent-1");
    expect(completion).toHaveProperty("completed", "task-comm-1");
  });
});
