#!/usr/bin/env node
// Post coverage from CI to the task linked to the pull request.
// Skips cleanly when the control plane is not configured or no task is linked.
import { readFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? undefined : args[i + 1];
};

const coverageFile = flag("file") ?? process.env.COVERAGE_FILE ?? "coverage/coverage-summary.json";

// Mirrors the GitHub adapter's PR→task resolution: `uw:<id>` in the body, or a
// branch name like feat/task-1234 / fix/gh-19.
function taskFromPullRequest() {
  let pr = {};
  try {
    pr = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH ?? "", "utf8"))?.pull_request ?? {};
  } catch {
    // no event payload in this context
  }
  const body = pr.body ?? "";
  const bodyMarker = body.match(/uw:([\w-]+)/)?.[1]
    ?? body.match(/(?:underwright[-_ ]task|underwright:task)\s*[:=]\s*([A-Za-z0-9._-]+)/i)?.[1];
  const branch = pr.head?.ref ?? process.env.GITHUB_HEAD_REF ?? "";
  const branchMarker = branch.match(/(?:feat\/|fix\/)?((?:task-[a-f0-9]+|gh-\d+))/)?.[1];
  return bodyMarker ?? branchMarker;
}

const taskId = flag("task") ?? process.env.UNDERWRIGHT_TASK_ID ?? taskFromPullRequest();
const rawUrl = flag("url") ?? process.env.UNDERWRIGHT_MCP_URL ?? process.env.UNDERWRIGHT_URL;
const token = process.env.UNDERWRIGHT_TOKEN;
const agentId = flag("agent") ?? process.env.UNDERWRIGHT_AGENT_ID
  ?? (process.env.GITHUB_ACTOR ? `ci@${process.env.GITHUB_ACTOR}` : "ci@github-actions");
const acIds = (flag("ac") ?? process.env.UNDERWRIGHT_AC_IDS ?? "")
  .split(",").map((s) => s.trim()).filter(Boolean);

if (!rawUrl || !taskId) {
  console.log(`[coverage] skipped: ${!rawUrl ? "UNDERWRIGHT_URL is unset" : "no task linked (set UNDERWRIGHT_TASK_ID or add 'uw:<task-id>' to the PR body)"}`);
  console.log(`[coverage] artifact retained at ${coverageFile}`);
  process.exit(0);
}

const endpoint = new URL(rawUrl);
if (!endpoint.pathname || endpoint.pathname === "/") endpoint.pathname = "/mcp";

const output = readFileSync(coverageFile, "utf8");
const client = new Client({ name: "underwright-coverage-reporter", version: "1.0.0" });
try {
  await client.connect(new StreamableHTTPClientTransport(endpoint, {
    requestInit: token ? { headers: { authorization: `Bearer ${token}` } } : {},
  }));
  const result = await client.callTool({
    name: "report_evidence",
    arguments: {
      task_id: taskId,
      agent_id: agentId,
      kind: "coverage",
      command: "vitest run --coverage",
      exit_code: 0,
      output,
      ...(acIds.length ? { ac_ids: acIds } : {}),
    },
  });
  const text = result.content?.[0]?.type === "text" ? result.content[0].text : "";
  const parsed = text ? JSON.parse(text) : {};
  if (result.isError || parsed.error) {
    console.error(`[coverage] report failed: ${parsed.error ?? text}`);
    process.exitCode = 1;
  } else {
    console.log(`[coverage] posted evidence ${parsed.id} to ${taskId}: ${JSON.stringify(parsed.coverage ?? {})}`);
    if (parsed.warning) console.warn(`[coverage] ${parsed.warning}`);
  }
} finally {
  await client.close();
}
