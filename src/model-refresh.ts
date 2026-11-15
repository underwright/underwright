import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CatalogDiff } from "./model-catalog.js";

/** Publish proposals through Store-backed tools; discovery never writes routing policy. */
export async function publishCatalog(diffs: CatalogDiff[], options: { url: string; token: string; taskId?: string; agentId: string; recipient: string }) {
  const client = new Client({ name: "underwright-model-catalog", version: "1" });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(options.url), {
      requestInit: { headers: { authorization: `Bearer ${options.token}` } },
    }));
    const call = async (name: string, args: Record<string, unknown>) => {
      const result = await client.callTool({ name, arguments: args });
      if (result.isError) throw new Error(`${name} failed`);
      const contents = result.content as { type: string; text?: string }[];
      for (const content of contents) {
        if (content.type === "text" && content.text) {
          let body;
          try { body = JSON.parse(content.text); } catch { continue; }
          if (body?.error) throw new Error(`${name} failed`);
        }
      }
      return result;
    };
    await call("post_artifact", {
      task_id: options.taskId, agent_id: options.agentId, kind: "design",
      title: "Model catalog refresh: proposed routing review",
      content: JSON.stringify({ generated_at: new Date().toISOString(), review_required: true,
        warning: "New models require explicit tier assignment. Removed models require checking queued and running job references before any deletion. Failed probes do not establish removals. Policy has not been changed.",
        proposed_assignments: diffs.flatMap(diff => diff.unassigned.map(model => ({ harness: diff.harness, model, tier: null }))), diffs }, null, 2),
    });
    if (diffs.some(diff => diff.unassigned.length || diff.removed.length || diff.error)) {
      await call("send_message", { to: options.recipient, from: options.agentId, task_id: options.taskId,
        body: `Model catalog proposal posted for review: ${diffs.reduce((n, d) => n + d.unassigned.length, 0)} unassigned models, ${diffs.reduce((n, d) => n + d.removed.length, 0)} removed models, ${diffs.filter(d => d.error).length} failed probes. Review the artifact before changing routing.` });
    }
  } finally { await client.close(); }
}
