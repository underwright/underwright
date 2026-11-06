import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { createServer as createHttpServer, type Server } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { SqliteStore } from "../src/store.js";
import { PgStore } from "../src/pstore.js";
import type { IStore } from "../src/istore.js";
import { getHumanNotifyPolicy } from "../src/policy.js";
import { buildHumanNotifyPayload, flushNotifications, resolveSinceTimestamp, sendHumanNotification } from "../src/digest.js";

const root = fileURLToPath(new URL("..", import.meta.url));

describe("human-notify policy parsing", () => {
  it("defaults to disabled when absent and supports string or object under human_notify/human-notify/notifications", () => {
    expect(getHumanNotifyPolicy({ dod: {}, enforcement: "observe" })).toEqual({
      enabled: false,
      webhook_url: null,
      events: ["task_completed", "claim_reclaimed"],
    });

    expect(getHumanNotifyPolicy({
      dod: {},
      enforcement: "warn",
      "human-notify": "https://hooks.slack.com/services/T00/B00/X00",
    })).toEqual({
      enabled: true,
      webhook_url: "https://hooks.slack.com/services/T00/B00/X00",
      events: ["task_completed", "claim_reclaimed"],
    });

    expect(getHumanNotifyPolicy({
      dod: {},
      enforcement: "warn",
      human_notify: {
        enabled: true,
        webhook_url: "https://discord.com/api/webhooks/123/abc",
        events: ["completed"],
      },
    })).toEqual({
      enabled: true,
      webhook_url: "https://discord.com/api/webhooks/123/abc",
      events: ["task_completed"],
    });

    expect(getHumanNotifyPolicy({
      dod: {},
      enforcement: "warn",
      notifications: {
        enabled: false,
        url: "https://example.com/hook",
        events: ["lease_expired"],
      },
    })).toEqual({
      enabled: false,
      webhook_url: "https://example.com/hook",
      events: ["claim_reclaimed"],
    });
  });

  it("builds Slack/Discord/generic compatible webhook payloads and resolves relative or ISO timestamps", () => {
    const completed = buildHumanNotifyPayload({
      event: "task_completed",
      task_id: "gh-32",
      title: "Mailbox digest",
      agent_id: "agy-2@alandesktop",
      timestamp: "2026-11-06T14:00:00.000Z",
    });
    expect(completed.event).toBe("task_completed");
    expect(completed.text).toContain("gh-32");
    expect(completed.text).toContain("Mailbox digest");
    expect(completed.content).toBe(completed.text);

    const reclaimed = buildHumanNotifyPayload({
      event: "claim_reclaimed",
      task_id: "gh-32",
      title: "Mailbox digest",
      agent_id: "stale-agent",
      reopened: true,
      lease_expires: "2026-11-06T13:00:00.000Z",
      timestamp: "2026-11-06T14:00:00.000Z",
    });
    expect(reclaimed.event).toBe("claim_reclaimed");
    expect(reclaimed.reopened).toBe(true);
    expect(reclaimed.text).toContain("stale-agent");
    expect(reclaimed.content).toBe(reclaimed.text);

    const refNow = Date.parse("2026-11-06T12:00:00.000Z");
    expect(resolveSinceTimestamp(undefined, refNow)).toBe("2026-11-05T12:00:00.000Z");
    expect(resolveSinceTimestamp("2h", refNow)).toBe("2026-11-06T10:00:00.000Z");
    expect(resolveSinceTimestamp("30m", refNow)).toBe("2026-11-06T11:30:00.000Z");
    expect(resolveSinceTimestamp("45s", refNow)).toBe("2026-11-06T11:59:15.000Z");
    expect(resolveSinceTimestamp("2d", refNow)).toBe("2026-11-04T12:00:00.000Z");
    expect(resolveSinceTimestamp("2026-11-06 08:00:00", refNow)).toBe("2026-11-06T08:00:00.000Z");
    expect(() => resolveSinceTimestamp("not-a-timestamp", refNow)).toThrow(/invalid since timestamp/i);
  });

  it("handles filtered events and network errors gracefully without throwing", async () => {
    const filtered = await sendHumanNotification(
      { event: "claim_reclaimed", task_id: "t-1", agent_id: "a" },
      { dod: {}, enforcement: "observe", human_notify: { webhook_url: "http://127.0.0.1:9/hook", events: ["task_completed"] } }
    );
    expect(filtered).toEqual({ sent: false, reason: "filtered" });

    const failedFetch = vi.fn().mockRejectedValue(new Error("connection refused"));
    const res = await sendHumanNotification(
      { event: "task_completed", task_id: "t-1", agent_id: "a" },
      { dod: {}, enforcement: "observe", human_notify: "https://example.invalid/hook" },
      failedFetch as any
    );
    expect(res.sent).toBe(false);
    expect(res.error).toContain("connection refused");
  });
});

for (const backend of ["sqlite", "postgres"] as const) {
  describe.skipIf(backend === "postgres" && !process.env.DATABASE_URL)(`${backend} digest & human-notify`, () => {
    let store: IStore;
    let dir: string;
    let policyPath: string;
    let oldPolicy: string | undefined;

    function writePolicy(extra: Record<string, unknown> = {}) {
      writeFileSync(policyPath, JSON.stringify({
        dod: { default: { evidence: ["test_run"] } },
        enforcement: "observe",
        dor: { require_type: true, require_ac_ids: true, require_estimate: true },
        ...extra,
      }));
    }

    beforeEach(async () => {
      dir = mkdtempSync(join(tmpdir(), "uw-digest-"));
      policyPath = join(dir, "policy.json");
      writePolicy();
      oldPolicy = process.env.UNDERWRIGHT_POLICY;
      process.env.UNDERWRIGHT_POLICY = policyPath;
      store = backend === "sqlite"
        ? new SqliteStore(join(dir, "store.db"))
        : await PgStore.connect(process.env.DATABASE_URL!);
    });

    afterEach(async () => {
      await flushNotifications();
      await store.close();
      if (oldPolicy === undefined) delete process.env.UNDERWRIGHT_POLICY;
      else process.env.UNDERWRIGHT_POLICY = oldPolicy;
      rmSync(dir, { recursive: true, force: true });
    });

    it("summarizes board delta since timestamp and optionally delivers digest to an agent mailbox", async () => {
      const older = await store.createTask({
        title: "Before cutoff",
        ac_ids: ["ac1"],
        type: "feature",
        estimate: "S",
      });
      await new Promise((r) => setTimeout(r, 15));
      const since = new Date().toISOString();
      await new Promise((r) => setTimeout(r, 15));

      const t1 = await store.createTask({
        title: "Digest completed task",
        ac_ids: ["ac1"],
        type: "feature",
        estimate: "S",
      });
      const t2 = await store.createTask({
        title: "Digest expired task",
        ac_ids: ["ac1"],
        type: "feature",
        estimate: "S",
      });

      await store.claimTask(t1.id, "agent-A");
      await store.reportEvidence({
        task_id: t1.id,
        agent_id: "agent-A",
        kind: "test_run",
        exit_code: 0,
        ac_ids: ["ac1"],
      });
      await store.completeTask(t1.id, "agent-A");

      await store.claimTask(t2.id, "agent-B", -5);
      await store.sweepExpiredClaims();

      const res = await store.digest({
        since,
        to_agent: "lead@laptop",
        from_agent: "standup-bot",
      });

      expect(res.since).toBe(since);
      expect(res.counts.tasks_created).toBeGreaterThanOrEqual(2);
      expect(res.counts.tasks_completed).toBe(1);
      expect(res.counts.claims_reclaimed).toBe(1);
      expect(res.tasks_created.map((t: any) => t.id)).toContain(t1.id);
      expect(res.tasks_created.map((t: any) => t.id)).toContain(t2.id);
      expect(res.tasks_created.map((t: any) => t.id)).not.toContain(older.id);
      expect(res.tasks_completed.map((t: any) => t.id)).toEqual([t1.id]);
      expect(res.claims_reclaimed.map((t: any) => t.id)).toEqual([t2.id]);
      expect(res.summary).toContain(t1.id);
      expect(res.summary).toContain(t2.id);
      expect(res.sent_to).toBe("lead@laptop");

      const inbox = await store.inbox("lead@laptop");
      expect(inbox).toHaveLength(1);
      expect(inbox[0]).toMatchObject({
        to_agent: "lead@laptop",
        from_agent: "standup-bot",
      });
      expect(inbox[0].body).toBe(res.summary);
    });

    it("POSTs webhook notifications on task completed and claim-reclaimed events when configured in policy", async () => {
      const received: any[] = [];
      const server: Server = createHttpServer((req, res) => {
        let raw = "";
        req.on("data", (chunk) => { raw += chunk; });
        req.on("end", () => {
          received.push({
            method: req.method,
            headers: req.headers,
            body: JSON.parse(raw),
          });
          res.writeHead(200, { "content-type": "application/json" }).end('{"ok":true}');
        });
      });

      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
      const addr = server.address() as { port: number };
      const webhookUrl = `http://127.0.0.1:${addr.port}/webhook`;

      try {
        writePolicy({
          "human-notify": {
            webhook_url: webhookUrl,
            events: ["task_completed", "claim_reclaimed"],
          },
        });

        const t1 = await store.createTask({
          title: "Notify on complete",
          ac_ids: ["ac1"],
          type: "feature",
          estimate: "S",
        });
        await store.claimTask(t1.id, "agent-complete");
        await store.reportEvidence({
          task_id: t1.id,
          agent_id: "agent-complete",
          kind: "test_run",
          exit_code: 0,
          ac_ids: ["ac1"],
        });
        await store.completeTask(t1.id, "agent-complete");

        const t2 = await store.createTask({
          title: "Notify on reclaim",
          ac_ids: ["ac1"],
          type: "feature",
          estimate: "S",
        });
        await store.claimTask(t2.id, "agent-expired", -10);
        await store.sweepExpiredClaims();

        await flushNotifications();

        expect(received).toHaveLength(2);
        expect(received[0].method).toBe("POST");
        expect(received[0].headers["content-type"]).toContain("application/json");
        expect(received[0].body).toMatchObject({
          event: "task_completed",
          task_id: t1.id,
          title: "Notify on complete",
          agent_id: "agent-complete",
        });
        expect(received[0].body.text).toContain(t1.id);
        expect(received[0].body.content).toBe(received[0].body.text);

        expect(received[1].body).toMatchObject({
          event: "claim_reclaimed",
          task_id: t2.id,
          title: "Notify on reclaim",
          agent_id: "agent-expired",
          reopened: true,
        });
        expect(received[1].body.text).toContain(t2.id);
        expect(received[1].body.content).toBe(received[1].body.text);
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });
  });
}

describe("CLI underwright digest", () => {
  it("runs `underwright digest --since ... --to ...` and outputs JSON or text summary", () => {
    const dir = mkdtempSync(join(tmpdir(), "uw-cli-digest-"));
    const dbPath = join(dir, "cli.db");
    const policyPath = join(dir, "no-policy.json");
    try {
      const store = new SqliteStore(dbPath);
      const since = new Date(Date.now() - 60_000).toISOString();
      const task = store.createTask({ title: "CLI digest task", ac_ids: ["a1"], type: "feature", estimate: "S" });
      store.claimTask(task.id, "cli-agent");
      store.close();

      const raw = execFileSync(
        process.execPath,
        [join(root, "dist/cli.js"), "digest", "--since", since, "--to", "human@desk"],
        {
          cwd: root,
          env: { ...process.env, DATABASE_URL: "", UNDERWRIGHT_DB: dbPath, UNDERWRIGHT_POLICY: policyPath },
          encoding: "utf8",
        }
      );
      const parsed = JSON.parse(raw);
      expect(parsed.since).toBe(since);
      expect(parsed.counts.tasks_created).toBe(1);
      expect(parsed.counts.tasks_claimed).toBe(1);
      expect(parsed.sent_to).toBe("human@desk");
      expect(parsed.summary).toContain(task.id);

      const textOut = execFileSync(
        process.execPath,
        [join(root, "dist/cli.js"), "digest", "--since", since, "--text"],
        {
          cwd: root,
          env: { ...process.env, DATABASE_URL: "", UNDERWRIGHT_DB: dbPath, UNDERWRIGHT_POLICY: policyPath },
          encoding: "utf8",
        }
      );
      expect(textOut).toContain("Board digest since");
      expect(textOut).toContain(task.id);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
