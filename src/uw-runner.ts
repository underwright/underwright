#!/usr/bin/env node
import { hostname } from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { runSupervisor, type JobCall } from "./runner.js";

const args = process.argv.slice(2);
const flag = (name: string) => { const i = args.indexOf(`--${name}`); return i < 0 ? undefined : args[i + 1]; };
if (args.includes("--help")) {
  console.log("uw-runner --url http://host:8741/mcp [--host NAME] [--agent-id ID] [--poll-ms 2000] [--once]\nEnv: UNDERWRIGHT_URL, UNDERWRIGHT_TOKEN. Runs jobs in the current working directory.");
} else {
  const url = flag("url") ?? process.env.UNDERWRIGHT_URL;
  if (!url) throw new Error("--url or UNDERWRIGHT_URL is required");
  const host = flag("host") ?? hostname();
  const agentId = flag("agent-id") ?? `uw-runner@${host}`;
  const pollMs = Number(flag("poll-ms") ?? 2000);
  if (!Number.isFinite(pollMs) || pollMs < 100) throw new Error("--poll-ms must be at least 100");
  const shutdown = new AbortController();
  process.once("SIGTERM", () => shutdown.abort());
  process.once("SIGINT", () => shutdown.abort());
  let client: Client | undefined;
  const call: JobCall = async (name, arguments_) => {
    try {
      if (!client) {
        const next = new Client({ name: "uw-runner", version: "0.1.0" });
        const token = process.env.UNDERWRIGHT_TOKEN;
        try {
          await next.connect(new StreamableHTTPClientTransport(new URL(url), {
            requestInit: { headers: token ? { Authorization: `Bearer ${token}` } : {} },
          }), { timeout: 10000 });
          client = next;
        } catch (error) { await next.close().catch(() => {}); throw error; }
      }
      const response = await client.callTool({ name, arguments: arguments_ }, undefined, { timeout: 10000 });
      if (response.isError) throw new Error(JSON.stringify(response.content));
      const content = response.content as { type: string; text?: string }[];
      return JSON.parse(content.find(c => c.type === "text")?.text ?? "null");
    } catch (error) {
      const old = client; client = undefined;
      await old?.close().catch(() => {});
      throw error;
    }
  };
  try { await runSupervisor(call, { agentId, host, signal: shutdown.signal, pollMs, once: args.includes("--once") }); }
  finally { await client?.close(); }
}
