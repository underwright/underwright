import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { SqliteStore } from "../src/store.js";
import {
  syncPRs,
  checkPRGate,
  postEvidenceComment,
  linkPR,
  evidencePack,
  autoMergePR,
} from "../src/github.js";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";

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

describe("automerge: PR green + independent review -> merge to main", () => {
  const greenRollup = {
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

  function usePolicy(pol: object) {
    const dir = mkdtempSync("/tmp/uw-automerge-pol-");
    const file = `${dir}/policy.json`;
    writeFileSync(file, JSON.stringify(pol));
    process.env.UNDERWRIGHT_POLICY = file;
    return dir;
  }

  it("policy: skips automerge unless repo is opted in via policy file", async () => {
    const dir = usePolicy({ automerge: { "other/repo": true } });
    try {
      const task = store.createTask({
        id: "task-am-skip",
        title: "Unopted repo PR",
        spec_ref: "https://github.com/org/repo/pull/70",
      });
      store.claimTask(task.id, "agent-author");
      store.reportEvidence({ task_id: task.id, agent_id: "agent-reviewer", kind: "review", exit_code: 0 });

      const cmds: string[] = [];
      const runner = (cmd: string) => {
        cmds.push(cmd);
        if (cmd.startsWith("pr list")) {
          return [{
            number: 70,
            title: "Unopted PR",
            body: "uw:task-am-skip",
            url: "https://github.com/org/repo/pull/70",
            state: "OPEN",
            labels: [],
            headRefName: "feat/am-skip",
          }];
        }
        return greenRollup;
      };

      const res = await syncPRs(store, "org/repo", "automerge-bot", { runner });
      expect(res.merged).toEqual([]);
      expect(cmds.some((c) => c.startsWith("pr merge"))).toBe(false);
      expect(store.getTask(task.id).status).toBe("claimed");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("automerge & policy: merges via gh when checks green and independent review exists, recording audit event", async () => {
    const dir = usePolicy({
      automerge: {
        "org/repo": { enabled: true, method: "squash", delete_branch: true },
      },
    });
    try {
      const task = store.createTask({
        id: "task-am-pass",
        title: "Ready to merge",
        ac_ids: ["automerge"],
      });
      store.claimTask(task.id, "agent-author");
      store.reportEvidence({
        task_id: task.id,
        agent_id: "agent-author",
        kind: "test_run",
        command: "npm test",
        exit_code: 0,
      });
      store.reportEvidence({
        task_id: task.id,
        agent_id: "agent-reviewer",
        kind: "review",
        output: "LGTM",
        exit_code: 0,
      });

      const cmds: string[] = [];
      const runner = (cmd: string) => {
        cmds.push(cmd);
        if (cmd.startsWith("pr list")) {
          return [{
            number: 71,
            title: "Auto-merge ready PR",
            body: "Implements feature\n\nuw:task-am-pass",
            url: "https://github.com/org/repo/pull/71",
            state: "OPEN",
            labels: [],
            headRefName: "feat/am-pass",
          }];
        }
        if (cmd.includes("pr view 71")) return greenRollup;
        if (cmd.startsWith("pr merge 71")) return "Merged PR #71";
        throw new Error(`Unexpected command: ${cmd}`);
      };

      const res = await syncPRs(store, "org/repo", "automerge-bot", { runner });
      expect(res.merged).toEqual([{ taskId: "task-am-pass", pr: 71 }]);
      expect(cmds).toContain("pr merge 71 --repo org/repo --squash --delete-branch");
      expect(store.getTask("task-am-pass").status).toBe("done");

      const events = store.auditLog(50).filter((e: any) => e.entity_id === "task-am-pass" && e.action === "automerge");
      expect(events).toHaveLength(1);
      expect(events[0].actor).toBe("automerge-bot");
      const data = typeof events[0].data === "string" ? JSON.parse(events[0].data) : events[0].data;
      expect(data).toMatchObject({
        repo: "org/repo",
        pr: 71,
        method: "squash",
        merged_by: "automerge-bot",
        reviewer: "agent-reviewer",
        author: "agent-author",
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("automerge: refuses to merge on self-review or missing review or failing checks", async () => {
    const dir = usePolicy({ automerge: { "org/repo": true } });
    try {
      const task = store.createTask({
        id: "task-am-self",
        title: "Self-reviewed PR",
        spec_ref: "https://github.com/org/repo/pull/72",
      });
      store.claimTask(task.id, "agent-author");
      // Self-review from the same agent_id as claim holder
      store.reportEvidence({
        task_id: task.id,
        agent_id: "agent-author",
        kind: "review",
        output: "Self LGTM",
        exit_code: 0,
      });

      const cmds: string[] = [];
      const runner = (cmd: string) => {
        cmds.push(cmd);
        if (cmd.includes("pr view 72")) return greenRollup;
        throw new Error(`Unexpected command: ${cmd}`);
      };

      const resSelf = await autoMergePR(store, "org/repo", "task-am-self", {
        actor: "automerge-bot",
        runner,
      });
      expect(resSelf.merged).toBe(false);
      expect(resSelf.reason).toBe("self_review");
      expect(cmds.some((c) => c.startsWith("pr merge"))).toBe(false);

      // Now add independent review, but make CI checks fail
      store.reportEvidence({
        task_id: task.id,
        agent_id: "agent-reviewer",
        kind: "review",
        output: "Independent LGTM",
        exit_code: 0,
      });
      const resFailChecks = await autoMergePR(store, "org/repo", "task-am-self", {
        actor: "automerge-bot",
        runner: (cmd: string) => {
          if (cmd.includes("pr view 72")) {
            return {
              statusCheckRollup: [
                { __typename: "CheckRun", name: "test", status: "COMPLETED", conclusion: "FAILURE" },
              ],
            };
          }
          throw new Error(`Unexpected command: ${cmd}`);
        },
      });
      expect(resFailChecks.merged).toBe(false);
      expect(resFailChecks.reason).toBe("checks_not_green");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("conflict-handling: on merge conflict, comments on PR, notifies watchers, and leaves task to agent", async () => {
    const dir = usePolicy({ automerge: { "org/repo": true } });
    try {
      const task = store.createTask({
        id: "task-am-conflict",
        title: "Conflicting PR",
      });
      store.claimTask(task.id, "agent-author");
      store.watchTask("watcher-1", task.id);
      store.watchTask("agent-author", task.id);
      store.reportEvidence({
        task_id: task.id,
        agent_id: "agent-reviewer",
        kind: "review",
        output: "Approved",
        exit_code: 0,
      });

      let commentCmd = "";
      let commentBody = "";
      const runner = (cmd: string, input?: string) => {
        if (cmd.startsWith("pr list")) {
          return [{
            number: 73,
            title: "Conflicting PR",
            body: "uw:task-am-conflict",
            url: "https://github.com/org/repo/pull/73",
            state: "OPEN",
            labels: [],
            headRefName: "feat/am-conflict",
          }];
        }
        if (cmd.includes("pr view 73")) return greenRollup;
        if (cmd.startsWith("pr merge 73")) {
          throw new Error("GraphQL: Pull Request is not mergeable: merge conflict (mergePullRequest)");
        }
        if (cmd.startsWith("pr comment 73")) {
          commentCmd = cmd;
          commentBody = input ?? "";
          return "";
        }
        throw new Error(`Unexpected command: ${cmd}`);
      };

      const res = await syncPRs(store, "org/repo", "automerge-bot", { runner });
      expect(res.merged).toEqual([]);
      expect(res.conflicts).toEqual([{ taskId: "task-am-conflict", pr: 73 }]);

      // Commented on PR
      expect(commentCmd).toContain("pr comment 73 --repo org/repo");
      expect(commentBody).toMatch(/conflict/i);

      // Notified task watchers
      const watcherMsgs = store.inbox("watcher-1");
      expect(watcherMsgs).toHaveLength(1);
      expect(watcherMsgs[0].body).toMatch(/conflict/i);
      expect(watcherMsgs[0].body).toContain("73");

      const authorMsgs = store.inbox("agent-author");
      expect(authorMsgs).toHaveLength(1);
      expect(authorMsgs[0].body).toMatch(/conflict/i);

      // Left to agent: still claimed by agent-author, not marked done
      const updated = store.getTask("task-am-conflict");
      expect(updated.status).toBe("claimed");
      expect(updated.claim?.agent_id).toBe("agent-author");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
