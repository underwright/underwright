#!/usr/bin/env node
import { execSync } from "node:child_process";
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

  case "run": {
    // Local job runner: executes queued jobs one at a time, records results.
    // This is the "agents wait on processes" half of the loop.
    const store = await openStore(dbPath);
    let job;
    let ran = 0;
    while ((job = await store.nextJob("local-runner"))) {
      ran++;
      console.log(`[underwright] running ${job.id}: ${job.command}`);
      let status: "done" | "failed" = "done";
      let result: string;
      try {
        result = execSync(job.command, { encoding: "utf8", timeout: 10 * 60 * 1000, stdio: ["ignore", "pipe", "pipe"] });
      } catch (e: any) {
        status = "failed";
        result = `${e.stdout ?? ""}\n${e.stderr ?? e.message}`;
      }
      await store.finishJob(job.id, status, result.slice(-8000));
      console.log(`[underwright] ${job.id} ${status}`);
    }
    if (!ran) console.log("[underwright] no queued jobs");
    await store.close();
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
  underwright serve --http H:P   MCP server over HTTP at host:port (/mcp) — shared across machines.
  underwright run                Execute queued jobs locally (test/build/deploy/review).
  underwright board              Print the task board.

Env:
  UNDERWRIGHT_DB      Path to workspace DB (default: ./underwright.db)`);
}
