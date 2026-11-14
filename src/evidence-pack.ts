// Evidence pack rendering, shared by the gh-CLI adapter (github.ts) and the
// GitHub App webhook path (webhook.ts). Lives outside github.ts because the
// github-adapter-only rule forbids other modules importing the adapter.

import type { IStore } from "./istore.js";

/** Render a task's evidence pack as markdown (for PR/issue comments or review gates). */
export async function evidencePack(store: IStore, taskId: string) {
  const task = await store.getTask(taskId);
  if (!task) return null;
  const rows = await store.getEvidence(taskId);
  const lines = [
    `### Evidence pack — ${task.id}`,
    `**${task.title}**`,
    "",
    ...rows.map(
      (e) =>
        `- **${e.kind}** by ${e.agent_id} — \`${e.command}\` → exit ${e.exit_code}` +
        (e.ac_ids !== "[]" ? ` (proves: ${e.ac_ids})` : "") +
        (e.output ? `\n  \`\`\`\n  ${String(e.output).slice(0, 500)}\n  \`\`\`` : "")
    ),
  ];
  return lines.join("\n");
}
