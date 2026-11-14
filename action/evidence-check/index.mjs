// underwright/evidence-check: post a CI result to an Underwright control plane
// as ci_check / smoke_test evidence. Zero dependencies — consumer repos run this
// without node_modules, so it speaks raw JSON-RPC to the stateless /mcp endpoint.
import { appendFileSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const KINDS = new Set(["ci_check", "smoke_test"]);
const MAX_OUTPUT = 60_000;
const PROTOCOL = "2025-03-26";

/** GitHub exposes inputs as INPUT_<NAME> (uppercased, spaces → _, hyphens kept). */
function input(env, name) {
  const v = env[`INPUT_${name.replace(/ /g, "_").toUpperCase()}`];
  return typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;
}

/** Same PR→task resolution as scripts/report-coverage.mjs and the GitHub adapter. */
export function taskFromPullRequest(env) {
  let pr = {};
  try {
    pr = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH ?? "", "utf8"))?.pull_request ?? {};
  } catch {
    // no event payload in this context
  }
  const body = pr.body ?? "";
  const bodyMarker = body.match(/uw:([\w-]+)/)?.[1]
    ?? body.match(/(?:underwright[-_ ]task|underwright:task)\s*[:=]\s*([A-Za-z0-9._-]+)/i)?.[1];
  const branch = pr.head?.ref ?? env.GITHUB_HEAD_REF ?? "";
  const branchMarker = branch.match(/(?:feat\/|fix\/)?((?:task-[a-f0-9]+|gh-\d+))/)?.[1];
  return bodyMarker ?? branchMarker;
}

export function mcpEndpoint(raw) {
  const url = new URL(raw);
  if (!url.pathname || url.pathname === "/") url.pathname = "/mcp";
  return url.toString();
}

function clip(text) {
  return text.length <= MAX_OUTPUT ? text : `…[clipped ${text.length - MAX_OUTPUT} chars]\n${text.slice(-MAX_OUTPUT)}`;
}

/** Resolve inputs into a report_evidence call, or { skip } with a reason. */
export function buildReport(env) {
  const rawUrl = input(env, "url") ?? env.UNDERWRIGHT_MCP_URL ?? env.UNDERWRIGHT_URL;
  const taskId = input(env, "task-id") ?? env.UNDERWRIGHT_TASK_ID ?? taskFromPullRequest(env);
  if (!rawUrl) return { skip: "no control plane url (set the url input or UNDERWRIGHT_URL)" };
  if (!taskId) return { skip: "no task linked (set task-id, UNDERWRIGHT_TASK_ID, or add 'uw:<task-id>' to the PR body)" };

  const kind = input(env, "kind") ?? "ci_check";
  if (!KINDS.has(kind)) throw new Error(`kind must be ci_check or smoke_test, got '${kind}'`);

  const explicit = input(env, "exit-code");
  let exitCode;
  if (explicit !== undefined) {
    exitCode = Number.parseInt(explicit, 10);
    if (!Number.isInteger(exitCode)) throw new Error(`exit-code must be an integer, got '${explicit}'`);
  } else {
    exitCode = (input(env, "status") ?? "success").toLowerCase() === "success" ? 0 : 1;
  }

  const acIds = (input(env, "ac-ids") ?? env.UNDERWRIGHT_AC_IDS ?? "").split(/[\s,]+/).filter(Boolean);
  const agentId = input(env, "agent-id") ?? env.UNDERWRIGHT_AGENT_ID
    ?? (env.GITHUB_ACTOR ? `ci@${env.GITHUB_ACTOR}` : "ci@github-actions");

  const header = [];
  if (env.GITHUB_SERVER_URL && env.GITHUB_REPOSITORY && env.GITHUB_RUN_ID) {
    header.push(`run: ${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`);
  }
  if (env.GITHUB_WORKFLOW || env.GITHUB_JOB) header.push(`workflow: ${env.GITHUB_WORKFLOW ?? "?"} / job: ${env.GITHUB_JOB ?? "?"}`);
  if (env.GITHUB_SHA) header.push(`sha: ${env.GITHUB_SHA}`);
  header.push(`status: ${input(env, "status") ?? "success"} (exit ${exitCode})`);
  const parts = [header.join("\n")];
  const out = input(env, "output");
  if (out) parts.push(out);
  const file = input(env, "output-file");
  if (file) parts.push(readFileSync(file, "utf8"));

  return {
    endpoint: mcpEndpoint(rawUrl),
    token: input(env, "token") ?? env.UNDERWRIGHT_TOKEN,
    args: {
      task_id: taskId,
      agent_id: agentId,
      kind,
      command: input(env, "command") ?? `${env.GITHUB_WORKFLOW ?? "ci"}${env.GITHUB_JOB ? `/${env.GITHUB_JOB}` : ""}`,
      exit_code: exitCode,
      output: clip(parts.join("\n\n")),
      ...(acIds.length ? { ac_ids: acIds } : {}),
    },
  };
}

/** Parse a Streamable HTTP response body (JSON or SSE) into the JSON-RPC message for `id`. */
export function parseRpc(text, contentType = "", id) {
  const messages = [];
  if (contentType.includes("text/event-stream")) {
    for (const event of text.split(/\r?\n\r?\n/)) {
      const data = event.split(/\r?\n/).filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trimStart()).join("\n");
      if (data) messages.push(JSON.parse(data));
    }
  } else if (text.trim()) {
    const parsed = JSON.parse(text);
    messages.push(...(Array.isArray(parsed) ? parsed : [parsed]));
  }
  const msg = messages.find((m) => m.id === id) ?? messages.find((m) => "result" in m || "error" in m);
  if (!msg) throw new Error("no JSON-RPC response in body");
  if (msg.error) throw new Error(`rpc error ${msg.error.code}: ${msg.error.message}`);
  return msg.result;
}

async function rpc(endpoint, token, id, method, params, fetchImpl) {
  const headers = { "content-type": "application/json", accept: "application/json, text/event-stream" };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetchImpl(endpoint, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id, method, params }) });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${endpoint}: ${text.slice(0, 200)}`);
  return parseRpc(text, res.headers.get("content-type") ?? "", id);
}

/** initialize + tools/call report_evidence. Returns the parsed tool result ({ id }). */
export async function postEvidence(report, fetchImpl = fetch) {
  await rpc(report.endpoint, report.token, 1, "initialize", {
    protocolVersion: PROTOCOL,
    capabilities: {},
    clientInfo: { name: "underwright-evidence-check", version: "1.0.0" },
  }, fetchImpl);
  const result = await rpc(report.endpoint, report.token, 2, "tools/call", { name: "report_evidence", arguments: report.args }, fetchImpl);
  const text = result?.content?.find?.((c) => c.type === "text")?.text ?? "";
  let parsed = {};
  try { parsed = text ? JSON.parse(text) : {}; } catch { parsed = { error: text }; }
  if (result?.isError || parsed.error) throw new Error(`report_evidence failed: ${parsed.error ?? text}`);
  if (!parsed.id) throw new Error(`report_evidence returned no evidence id: ${text.slice(0, 200)}`);
  return parsed;
}

/** Run the action. Returns the process exit code. */
export async function main(env = process.env, { fetchImpl = fetch, log = console.log } = {}) {
  const failOnError = (input(env, "fail-on-error") ?? "true").toLowerCase() !== "false";
  let token;
  try {
    const report = buildReport(env);
    if (report.skip) {
      log(`[evidence-check] skipped: ${report.skip}`);
      return 0;
    }
    token = report.token;
    const posted = await postEvidence(report, fetchImpl);
    if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, `evidence-id=${posted.id}\n`);
    log(`[evidence-check] posted ${report.args.kind} evidence ${posted.id} to ${report.args.task_id} (exit ${report.args.exit_code})`);
    return 0;
  } catch (error) {
    let message = error instanceof Error ? error.message : String(error);
    if (token) message = message.split(token).join("***");
    log(`::${failOnError ? "error" : "warning"} title=underwright evidence-check::${message.replace(/\r?\n/g, " ")}`);
    return failOnError ? 1 : 0;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
