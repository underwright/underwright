#!/usr/bin/env node
import { execSync } from "node:child_process";
import { serve } from "./server.js";
import { Store } from "./store.js";

const [cmd, ...args] = process.argv.slice(2);
const dbPath = process.env.UNDERWRIGHT_DB ?? "underwright.db";

switch (cmd) {
  case "serve":
    await serve(dbPath);
    break;

  case "board": {
    const store = new Store(dbPath);
    console.log(JSON.stringify(store.board(), null, 2));
    store.close();
    break;
  }

  case "run": {
    // Local job runner: executes queued jobs one at a time, records results.
    // This is the "agents wait on processes" half of the loop.
    const store = new Store(dbPath);
    let job;
    let ran = 0;
    while ((job = store.nextJob("local-runner"))) {
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
      store.finishJob(job.id, status, result.slice(-8000));
      console.log(`[underwright] ${job.id} ${status}`);
    }
    if (!ran) console.log("[underwright] no queued jobs");
    store.close();
    break;
  }

  default:
    console.log(`underwright — control plane for agentic software development

Usage:
  underwright serve   Start the MCP server (stdio). Point your agent's MCP config at this.
  underwright run     Execute queued jobs locally (test/build/deploy/review).
  underwright board   Print the task board.

Env:
  UNDERWRIGHT_DB      Path to workspace DB (default: ./underwright.db)`);
}
