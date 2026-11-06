import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer as createHttpServer } from "node:http";
import { z } from "zod";
import { openStore } from "./store.js";
import type { IStore } from "./istore.js";
import { indexWorkspace } from "./codeindex.js";
import { startLeaseSweeper } from "./sweeper.js";
import { handleGithubWebhookHttp, isGithubWebhookRequest, webhookSecretFromEnv } from "./webhook.js";

// cli.ts reaches the store through this module so the edge stays cli → server → store.
export { openStore };

const text = (data: unknown) => ({
  content: [{ type: "text" as const, text: typeof data === "string" ? data : JSON.stringify(data, null, 2) }],
});

export function createServer(store: IStore) {
  const server = new McpServer(
    { name: "underwright", version: "0.1.0" },
    { instructions: `Underwright is the shared control plane for agentic development on this workspace.
Rules of engagement:
1. Before writing shared code, call search_context — reuse helpers that exist.
2. Claim a task before working on it; renew the lease on long work.
3. Coordinate through artifacts posted to tasks, never through side channels.
4. Done requires evidence: report_evidence citing the task's acceptance criteria before complete_task.
5. Prefer submit_job for long-running work (tests, builds) over running it in-context.` }
  );

  server.tool("board", "Show the task board: all tasks, who holds each claim, job counts.", {},
    async () => text(await store.board()));

  server.tool("create_task", "Create a task on the board. Reference the spec and list its acceptance criterion ids.", {
    title: z.string(),
    description: z.string().optional(),
    spec_ref: z.string().optional().describe("path or URI of the governing spec"),
    blocked_by: z.array(z.string()).optional().describe("task ids that must be done before claiming; update replaces the list, [] clears it"),
    ac_ids: z.array(z.string()).optional().describe("acceptance criterion ids this task must prove"),
    priority: z.number().int().min(0).max(4).optional(),
    ownership: z.object({ paths: z.array(z.string()).optional(), symbols: z.array(z.string()).optional() }).optional()
      .describe("file globs / symbols this task owns"),
    type: z.enum(["feature", "bug", "deploy", "architecture", "docs", "tdd", "triage"]).optional()
      .describe("task type — drives Definition-of-Done requirements at completion"),
    severity: z.enum(["low", "normal", "high", "critical"]).optional(),
    estimate: z.enum(["S", "M", "L"]).optional().describe("effort in agent-sessions"),
    template: z.string().optional()
      .describe("task template id — expands AC scaffold, type, and a DoR checklist (builtin: feature/bug/architecture/tdd, or policy-defined)"),
    created_by: z.string().optional(),
  }, async (a) => text(await store.createTask(a)));

  server.tool("list_templates", "List task templates (builtin + policy-defined) that seed a task's AC scaffold, type, and DoR checklist.", {},
    async () => text(await store.listTemplates()));

  server.tool("update_task", "Update task fields — the triage action. Set type, severity, estimate, ac_ids before a task is claimable.", {
    task_id: z.string(),
    actor: z.string().describe("who is making the change"),
    title: z.string().optional(),
    description: z.string().optional(),
    spec_ref: z.string().optional(),
    blocked_by: z.array(z.string()).optional().describe("task ids that must be done before claiming; update replaces the list, [] clears it"),
    ac_ids: z.array(z.string()).optional(),
    type: z.enum(["feature", "bug", "deploy", "architecture", "docs", "tdd", "triage"]).optional(),
    severity: z.enum(["low", "normal", "high", "critical"]).optional(),
    estimate: z.enum(["S", "M", "L"]).optional(),
  }, async (a) => {
    const { task_id, actor, ...patch } = a;
    return text(await store.updateTask(task_id, patch, actor ?? "unknown"));
  });

  server.tool("list_tasks", "List tasks, optionally filtered by status.", {
    status: z.enum(["open", "claimed", "in_review", "done", "blocked"]).optional(),
  }, async ({ status }) => text(await store.listTasks(status)));

  server.tool("get_task", "Get a task with its claim state and full detail.", {
    task_id: z.string(),
  }, async ({ task_id }) => text(await store.getTask(task_id) ?? { error: "not found" }));

  server.tool("claim_task", "Atomically claim a task with a lease. Fails if another agent holds an unexpired claim.", {
    task_id: z.string(),
    agent_id: z.string().describe("stable identity for this agent/session"),
    ttl_seconds: z.number().int().optional().describe("lease duration, default 1800"),
    scope: z.object({ paths: z.array(z.string()).optional(), symbols: z.array(z.string()).optional() }).optional()
      .describe("subset of the task's ownership you're claiming"),
  }, async (a) => text(await store.claimTask(a.task_id, a.agent_id, a.ttl_seconds, a.scope)));

  server.tool("release_task", "Release your claim, returning the task to open.", {
    task_id: z.string(), agent_id: z.string(),
  }, async ({ task_id, agent_id }) => text(await store.releaseTask(task_id, agent_id)));

  server.tool("renew_lease", "Extend your claim's lease.", {
    task_id: z.string(), agent_id: z.string(), ttl_seconds: z.number().int().optional(),
  }, async (a) => text(await store.renewLease(a.task_id, a.agent_id, a.ttl_seconds)));

  server.tool("claim_resources", "Lock files/folders/entities so no other agent duplicates your intermediate work. Call check_locks first for batch conflict check.", {
    resources: z.array(z.string()).describe("file globs, folders, or entity refs e.g. 'src/db/**'"),
    agent_id: z.string(),
    task_id: z.string().optional(),
    ttl_seconds: z.number().int().optional(),
  }, async (a) => text(await store.claimResources(a.resources, a.agent_id, a.task_id, a.ttl_seconds)));

  server.tool("release_resources", "Release your resource locks.", {
    resources: z.array(z.string()),
    agent_id: z.string(),
  }, async (a) => text(await store.releaseResources(a.resources, a.agent_id)));

  server.tool("check_locks", "Check whether resources are locked by other agents. Returns only active conflicts — call before touching shared files.", {
    resources: z.array(z.string()),
  }, async (a) => text(await store.checkLocks(a.resources)));

  server.tool("send_message", "Send a direct message to another agent (e.g. blocked-on, handoff request). Keep it structured and short.", {
    to: z.string(), from: z.string(), body: z.string(), task_id: z.string().optional(),
  }, async (a) => text(await store.sendMessage(a.to, a.from, a.body, a.task_id)));

  server.tool("inbox", "Read your messages. Returns unread by default and marks them read.", {
    agent_id: z.string(), unread_only: z.boolean().optional(),
  }, async (a) => text(await store.inbox(a.agent_id, a.unread_only ?? true)));

  server.tool("watch_task", "Subscribe to a task — the control plane messages you when its status or jobs change. This is how agents de-register instead of polling.", {
    agent_id: z.string(), task_id: z.string(),
  }, async (a) => text(await store.watchTask(a.agent_id, a.task_id)));

  server.tool("post_artifact", "Post a durable artifact (spec, design, handoff, note, review) — the only inter-agent communication channel.", {
    task_id: z.string().optional(),
    agent_id: z.string(),
    kind: z.enum(["spec", "design", "handoff", "note", "review"]),
    title: z.string().optional(),
    content: z.string(),
  }, async (a) => text(await store.postArtifact(a)));

  server.tool("search_context", "Search shared knowledge: helpers, specs, handoffs, prior decisions. Call before writing new shared code.", {
    query: z.string(),
    kinds: z.array(z.enum(["helper", "artifact", "evidence", "symbol"])).optional(),
  }, async ({ query, kinds }) => text(await store.searchContext(query, kinds)));

  const codeStore = () => {
    const c = store as any;
    if (typeof c.searchSymbols !== "function") throw new Error("code index is only available on the SQLite store");
    return c;
  };

  server.tool("index_code", "Build or refresh the tree-sitter code index for a directory. Incremental: only files whose content changed are reparsed.", {
    root: z.string().optional().describe("directory to index (default: server working directory)"),
    agent_id: z.string().optional(),
  }, async ({ root, agent_id }) => text(await indexWorkspace(codeStore(), root ?? process.cwd(), agent_id ?? "indexer")));

  server.tool("search_symbols", "Find symbol definitions (functions, classes, methods, types…) by name in the code index.", {
    query: z.string(),
    kind: z.enum(["function", "class", "method", "interface", "type", "enum", "variable"]).optional(),
    limit: z.number().int().min(1).max(100).optional(),
  }, async ({ query, kind, limit }) => text(codeStore().searchSymbols(query, kind, limit)));

  server.tool("find_references", "List where a symbol name is referenced (calls, new, type uses, imports) in the code index.", {
    name: z.string(),
  }, async ({ name }) => text(codeStore().findReferences(name)));

  server.tool("blast_radius", "Transitive callers/users of a symbol: what could break if it changes. Name-based over-approximation.", {
    name: z.string(),
    depth: z.number().int().min(1).max(10).optional(),
  }, async ({ name, depth }) => text(codeStore().blastRadius(name, depth)));

  server.tool("register_helper", "Publish a reusable helper (utility, pattern, config, fixture) so other agents reuse it instead of duplicating.", {
    agent_id: z.string(),
    path: z.string(),
    symbol: z.string().optional(),
    kind: z.enum(["util", "pattern", "config", "fixture"]),
    summary: z.string(),
  }, async (a) => text(await store.registerHelper(a)));

  server.tool("report_evidence", "Attach proof of work to a task: a test run, CI check, review, or coverage result, citing which acceptance criteria it proves.", {
    task_id: z.string(),
    agent_id: z.string(),
    kind: z.enum(["test_run", "ci_check", "review", "coverage", "deploy", "contract_test", "security_scan", "smoke_test", "mutation"]),
    command: z.string().optional(),
    exit_code: z.number().int().optional(),
    output: z.string().optional(),
    ac_ids: z.array(z.string()).optional(),
  }, async (a) => text(await store.reportEvidence(a)));

  server.tool("complete_task", "Mark a task done. Refuses unless every declared acceptance criterion has cited evidence.", {
    task_id: z.string(), agent_id: z.string(),
  }, async ({ task_id, agent_id }) => text(await store.completeTask(task_id, agent_id)));

  server.tool("submit_job", "Submit long-running work (test/build/deploy/review) to the job queue and continue other work. Don't poll in-context — check job_status later or let the runner callback.", {
    agent_id: z.string(),
    task_id: z.string().optional(),
    type: z.enum(["test", "build", "deploy", "review"]),
    command: z.string(),
  }, async (a) => text(await store.submitJob(a)));

  server.tool("job_status", "Check a submitted job's status and result.", {
    job_id: z.string(),
  }, async ({ job_id }) => text(await store.getJob(job_id) ?? { error: "not found" }));

  server.tool("audit_log", "Recent control-plane events (who did what, when).", {
    limit: z.number().int().optional(),
  }, async ({ limit }) => text(await store.auditLog(limit)));

  return { server, store };
}

export async function serve(dbPath: string) {
  const { server, store } = createServer(await openStore(dbPath));
  const stopSweeper = startLeaseSweeper(store);
  const onEnd = () => { void server.close(); };
  server.server.onclose = () => {
    process.stdin.off("end", onEnd);
    void stopSweeper().then(() => store.close()).catch(error => console.error("[underwright] shutdown failed:", error));
  };
  process.stdin.once("end", onEnd);
  try {
    await server.connect(new StdioServerTransport());
  } catch (error) {
    process.stdin.off("end", onEnd);
    await stopSweeper();
    await store.close();
    throw error;
  }
  return server;
}

/** Shared control plane over HTTP — agents on any machine connect to /mcp.
 *  Bearer auth required when UNDERWRIGHT_TOKEN is set. /health stays open.
 *  POST /github/webhook stays open and authenticates with the HMAC secret. */
export async function serveHttp(dbPath: string, host: string, port: number, token?: string) {
  const store = await openStore(dbPath);
  const stopSweeper = startLeaseSweeper(store);
  const http = createHttpServer(async (req, res) => {
    if (isGithubWebhookRequest(req.url)) {
      try {
        await handleGithubWebhookHttp(store, req, res, webhookSecretFromEnv());
      } catch (error) {
        console.error("[underwright] webhook failed:", error);
        if (!res.headersSent) {
          res.writeHead(500, { "content-type": "application/json" }).end('{"error":"webhook handler failed"}');
        }
      }
      return;
    }
    if (token && req.url === "/mcp") {
      const auth = req.headers.authorization;
      if (auth !== `Bearer ${token}`) {
        res.writeHead(401, { "www-authenticate": "Bearer" }).end('{"error":"unauthorized"}');
        return;
      }
    }
    if (req.url === "/mcp") {
      // Stateless mode: fresh transport + server per request — all shared
      // state lives in the store, so any agent can call any tool anytime.
      const { server } = createServer(store);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on("close", () => { transport.close(); server.close(); });
      await server.connect(transport);
      await transport.handleRequest(req, res);
      return;
    }
    if (req.url === "/health") {
      res.writeHead(200, { "content-type": "application/json" }).end('{"ok":true}');
      return;
    }
    res.writeHead(404).end();
  });
  http.once("close", () => {
    void stopSweeper().then(() => store.close()).catch(error => console.error("[underwright] shutdown failed:", error));
  });
  try {
    await new Promise<void>((resolve, reject) => {
      http.once("error", reject);
      http.listen(port, host, () => {
        http.off("error", reject);
        resolve();
      });
    });
  } catch (error) {
    await stopSweeper();
    await store.close();
    throw error;
  }
  const bound = http.address();
  const boundPort = typeof bound === "object" && bound ? bound.port : port;
  console.error(`[underwright] MCP over HTTP at http://${host}:${boundPort}/mcp (stateless${token ? ", bearer-auth" : ", NO AUTH — set UNDERWRIGHT_TOKEN for shared use"}); GitHub webhook POST /github/webhook`);
  return http;
}
