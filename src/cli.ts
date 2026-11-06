#!/usr/bin/env node
import { hostname } from "node:os";
import { executeLeasedJob } from "./runner.js";
import { openStore, serve, serveHttp } from "./server.js";
import {
  syncIssues,
  syncPRs,
  checkPRGate,
  linkPR,
  postEvidenceComment,
} from "./github.js";

const [cmd, ...args] = process.argv.slice(2);
const dbPath = process.env.UNDERWRIGHT_DB ?? "underwright.db";

/** Value of `--name value`, or undefined when the flag is absent. */
const flag = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? undefined : args[i + 1];
};

switch (cmd) {
  case "serve": {
    const httpIdx = args.indexOf("--http");
    if (httpIdx !== -1) {
      const [host, port] = (args[httpIdx + 1] ?? "127.0.0.1:8741").split(":");
      await serveHttp(dbPath, host, Number(port), process.env.UNDERWRIGHT_TOKEN);
    } else {
      await serve(dbPath);
    }
    break;
  }

  case "board": {
    const store = await openStore(dbPath);
    console.log(JSON.stringify(await store.board(), null, 2));
    await store.close();
    break;
  }

  case "create": {
    // underwright create --template feature --title ... [--type T] [--ac a,b] [--spec REF]
    const title = flag("title");
    if (!title) {
      console.error("usage: underwright create --title TITLE [--template ID] [--type TYPE] [--ac id,id] [--spec REF] [--description TEXT]");
      process.exit(1);
    }
    const ac = flag("ac");
    const store = await openStore(dbPath);
    console.log(JSON.stringify(await store.createTask({
      title,
      template: flag("template"),
      type: flag("type"),
      spec_ref: flag("spec"),
      description: flag("description"),
      ac_ids: ac ? ac.split(",").map((s) => s.trim()).filter(Boolean) : undefined,
      created_by: flag("by") ?? "cli",
    }), null, 2));
    await store.close();
    break;
  }

  case "templates": {
    const store = await openStore(dbPath);
    console.log(JSON.stringify(await store.listTemplates(), null, 2));
    await store.close();
    break;
  }

  case "speckit": {
    // underwright speckit [import] --path DIR_OR_FILE [--task ID] [--create-tasks] [--by AGENT]
    const path = flag("path") ?? (args[0] && !args[0].startsWith("--") && args[0] !== "import" ? args[0] : undefined);
    if (!path) {
      console.error("usage: underwright speckit import --path DIR_OR_FILE [--task ID] [--create-tasks] [--by AGENT]");
      process.exit(1);
    }
    const store = await openStore(dbPath);
    console.log(JSON.stringify(await store.importSpecKit({
      path,
      task_id: flag("task"),
      agent_id: flag("by") ?? "cli",
      create_tasks: args.includes("--create-tasks"),
    }), null, 2));
    await store.close();
    break;
  }

  case "run": {
    // Local job runner: executes queued jobs one at a time, records results.
    // This is the "agents wait on processes" half of the loop.
    const store = await openStore(dbPath);
    const shutdown = new AbortController();
    const stop = () => shutdown.abort();
    process.once("SIGTERM", stop);
    process.once("SIGINT", stop);
    let ran = 0;
    try {
      let job;
      while (!shutdown.signal.aborted && (job = await store.nextJob("local-runner", hostname()))) {
        ran++;
        console.log(`[underwright] running ${job.id}: ${job.command}`);
        const finished = await executeLeasedJob(job, async (name, a) => name === "renew_job"
          ? store.renewJob(a.job_id as string, a.agent_id as string, a.lease_token as string, a.ttl_seconds as number, a.result as string)
          : store.finishJob(a.job_id as string, a.status as "done" | "failed", a.result as string, a.agent_id as string, a.lease_token as string),
          { agentId: "local-runner", host: hostname(), signal: shutdown.signal, output: chunk => process.stdout.write(chunk) });
        console.log(`[underwright] ${job.id} ${finished?.status ?? "interrupted"}`);
      }
      if (!ran) console.log("[underwright] no queued jobs");
    } finally {
      process.off("SIGTERM", stop);
      process.off("SIGINT", stop);
      await store.close();
    }
    break;
  }

  case "github": {
    const sub = args[0];
    const repo = args[args.indexOf("--repo") + 1];
    if (!repo) {
      console.error("usage: underwright github sync|sync-prs|gate|post-evidence|link-pr --repo owner/name [--task ID] [--pr NUM]");
      process.exit(1);
    }
    const store = await openStore(dbPath);
    if (sub === "sync") {
      const wIdx = args.indexOf("--watch");
      const prsFlag = args.includes("--prs");
      if (wIdx !== -1) {
        const interval = Number(args[wIdx + 1] ?? 60) * 1000;
        console.error(`[underwright] watching ${repo} every ${interval / 1000}s`);
        for (;;) {
          try {
            console.error(new Date().toISOString(), JSON.stringify(await syncIssues(store, repo)));
            if (prsFlag) {
              console.error(new Date().toISOString(), JSON.stringify(await syncPRs(store, repo)));
            }
          } catch (e: any) {
            console.error("sync error:", e.message);
          }
          await new Promise((r) => setTimeout(r, interval));
        }
      }
      const issueRes = await syncIssues(store, repo);
      const prRes = prsFlag ? await syncPRs(store, repo) : null;
      console.log(JSON.stringify(prsFlag ? { issues: issueRes, prs: prRes } : issueRes, null, 2));
    } else if (sub === "sync-prs") {
      console.log(JSON.stringify(await syncPRs(store, repo), null, 2));
    } else if (sub === "gate" || sub === "check-gate") {
      const task = args[args.indexOf("--task") + 1];
      console.log(JSON.stringify(await checkPRGate(store, repo, task), null, 2));
    } else if (sub === "post-evidence") {
      const task = args[args.indexOf("--task") + 1];
      console.log(JSON.stringify(await postEvidenceComment(store, repo, task)));
    } else if (sub === "link-pr") {
      const task = args[args.indexOf("--task") + 1];
      const pr = args[args.indexOf("--pr") + 1];
      console.log(JSON.stringify(await linkPR(store, task, pr, repo)));
    }
    await store.close();
    break;
  }

  default:
    console.log(`underwright — control plane for agentic software development

Usage:
  underwright serve              MCP server over stdio (local agent config).
  underwright serve --http H:P   MCP over HTTP at host:port (/mcp, POST /github/webhook, GET /board) — shared across machines.
  underwright run                Execute queued jobs locally (including agent jobs).
  underwright board              Print the task board.
  underwright create             Create a task, optionally from a template (--template feature).
  underwright templates          List task templates (builtin + policy-defined).
  underwright speckit import     Import Spec Kit markdown (constitution/spec/plan/tasks) and link ac_ids.

Env:
  UNDERWRIGHT_DB      Path to workspace DB (default: ./underwright.db)
  UNDERWRIGHT_GITHUB_WEBHOOK_SECRET
                      HMAC secret for POST /github/webhook.
                      GITHUB_WEBHOOK_SECRET is the fallback. See docs/webhook.md.`);
}
