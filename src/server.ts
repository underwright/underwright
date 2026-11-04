import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer as createHttpServer } from "node:http";
import { z } from "zod";
import { Store } from "./store.js";

const text = (data: unknown) => ({
  content: [{ type: "text" as const, text: typeof data === "string" ? data : JSON.stringify(data, null, 2) }],
});

export function createServer(dbPath: string) {
  const store = new Store(dbPath);
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
    async () => text(store.board()));

  server.tool("create_task", "Create a task on the board. Reference the spec and list its acceptance criterion ids.", {
    title: z.string(),
    description: z.string().optional(),
    spec_ref: z.string().optional().describe("path or URI of the governing spec"),
    ac_ids: z.array(z.string()).optional().describe("acceptance criterion ids this task must prove"),
    priority: z.number().int().min(0).max(4).optional(),
    ownership: z.object({ paths: z.array(z.string()).optional(), symbols: z.array(z.string()).optional() }).optional()
      .describe("file globs / symbols this task owns"),
    created_by: z.string().optional(),
  }, async (a) => text(store.createTask(a)));

  server.tool("list_tasks", "List tasks, optionally filtered by status.", {
    status: z.enum(["open", "claimed", "in_review", "done", "blocked"]).optional(),
  }, async ({ status }) => text(store.listTasks(status)));

  server.tool("get_task", "Get a task with its claim state and full detail.", {
    task_id: z.string(),
  }, async ({ task_id }) => text(store.getTask(task_id) ?? { error: "not found" }));

  server.tool("claim_task", "Atomically claim a task with a lease. Fails if another agent holds an unexpired claim.", {
    task_id: z.string(),
    agent_id: z.string().describe("stable identity for this agent/session"),
    ttl_seconds: z.number().int().optional().describe("lease duration, default 1800"),
    scope: z.object({ paths: z.array(z.string()).optional(), symbols: z.array(z.string()).optional() }).optional()
      .describe("subset of the task's ownership you're claiming"),
  }, async (a) => text(store.claimTask(a.task_id, a.agent_id, a.ttl_seconds, a.scope)));

  server.tool("release_task", "Release your claim, returning the task to open.", {
    task_id: z.string(), agent_id: z.string(),
  }, async ({ task_id, agent_id }) => text(store.releaseTask(task_id, agent_id)));

  server.tool("renew_lease", "Extend your claim's lease.", {
    task_id: z.string(), agent_id: z.string(), ttl_seconds: z.number().int().optional(),
  }, async (a) => text(store.renewLease(a.task_id, a.agent_id, a.ttl_seconds)));

  server.tool("post_artifact", "Post a durable artifact (spec, design, handoff, note, review) — the only inter-agent communication channel.", {
    task_id: z.string().optional(),
    agent_id: z.string(),
    kind: z.enum(["spec", "design", "handoff", "note", "review"]),
    title: z.string().optional(),
    content: z.string(),
  }, async (a) => text(store.postArtifact(a)));

  server.tool("search_context", "Search shared knowledge: helpers, specs, handoffs, prior decisions. Call before writing new shared code.", {
    query: z.string(),
    kinds: z.array(z.enum(["helper", "artifact", "evidence"])).optional(),
  }, async ({ query, kinds }) => text(store.searchContext(query, kinds)));

  server.tool("register_helper", "Publish a reusable helper (utility, pattern, config, fixture) so other agents reuse it instead of duplicating.", {
    agent_id: z.string(),
    path: z.string(),
    symbol: z.string().optional(),
    kind: z.enum(["util", "pattern", "config", "fixture"]),
    summary: z.string(),
  }, async (a) => text(store.registerHelper(a)));

  server.tool("report_evidence", "Attach proof of work to a task: a test run, CI check, review, or coverage result, citing which acceptance criteria it proves.", {
    task_id: z.string(),
    agent_id: z.string(),
    kind: z.enum(["test_run", "ci_check", "review", "coverage", "deploy", "contract_test", "security_scan", "smoke_test", "mutation"]),
    command: z.string().optional(),
    exit_code: z.number().int().optional(),
    output: z.string().optional(),
    ac_ids: z.array(z.string()).optional(),
  }, async (a) => text(store.reportEvidence(a)));

  server.tool("complete_task", "Mark a task done. Refuses unless every declared acceptance criterion has cited evidence.", {
    task_id: z.string(), agent_id: z.string(),
  }, async ({ task_id, agent_id }) => text(store.completeTask(task_id, agent_id)));

  server.tool("submit_job", "Submit long-running work (test/build/deploy/review) to the job queue and continue other work. Don't poll in-context — check job_status later or let the runner callback.", {
    agent_id: z.string(),
    task_id: z.string().optional(),
    type: z.enum(["test", "build", "deploy", "review"]),
    command: z.string(),
  }, async (a) => text(store.submitJob(a)));

  server.tool("job_status", "Check a submitted job's status and result.", {
    job_id: z.string(),
  }, async ({ job_id }) => text(store.getJob(job_id) ?? { error: "not found" }));

  server.tool("audit_log", "Recent control-plane events (who did what, when).", {
    limit: z.number().int().optional(),
  }, async ({ limit }) => text(store.auditLog(limit)));

  return { server, store };
}

export async function serve(dbPath: string) {
  const { server } = createServer(dbPath);
  await server.connect(new StdioServerTransport());
}

/** Shared control plane over HTTP — agents on any machine connect to /mcp. */
export async function serveHttp(dbPath: string, host: string, port: number) {
  const http = createHttpServer(async (req, res) => {
    if (req.url === "/mcp") {
      // Stateless mode: fresh transport + server per request — all shared
      // state lives in the store, so any agent can call any tool anytime.
      const { server } = createServer(dbPath);
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
  await new Promise<void>((resolve) => http.listen(port, host, resolve));
  console.error(`[underwright] MCP over HTTP at http://${host}:${port}/mcp (stateless)`);
}
