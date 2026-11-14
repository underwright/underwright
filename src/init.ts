import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { IStore } from "./istore.js";

// Workspace bootstrap: `underwright init` writes the files an agent host needs
// (AGENTS.md, .mcp.json, policy, .gitignore) and seeds the first triage task.
// Templates live here so they ship in dist/ — a docs file would drift.

export const TRIAGE_TASK_ID = "init-triage";

/** The agent rules written to AGENTS.md. Keep verbatim with this repo's AGENTS.md. */
export const AGENTS_MD = `# Agent rules for this repo

Underwright is built by agents, through its own control plane. If you are an
agent working in this repo, follow these rules — they are not suggestions.

## Coordination

1. **Check the board first.** Call \`board\` (or \`underwright board\`) before
   starting work. Pick up an open task or propose a new one via \`create_task\`.
2. **Claim before work.** Call \`claim_task\` with a stable \`agent_id\` naming
   your harness+host (e.g. \`claude@minipc\`, \`kimi@laptop-2\`). Renew the lease
   on long work. Release if you stop.
3. **Search before building.** Call \`search_context\` before writing any new
   shared utility, pattern, or config. If a helper exists, reuse it. When you
   create something reusable, call \`register_helper\`.
4. **Communicate through artifacts.** Post specs, designs, and handoffs with
   \`post_artifact\` on the task. No side channels — the artifact store is the
   record.
5. **Done requires evidence.** \`complete_task\` refuses without
   \`report_evidence\` citing every \`ac_id\` on the task. Run the build/tests,
   attach real output.
6. **Long work goes to the queue.** \`submit_job\` for test suites, builds, and
   anything slow. Don't block your context waiting on processes.
7. **Work the board until idle.** The loop is: complete the task, read
   \`inbox\`, claim the assigned task, repeat until the board is empty.
   A message \`your next task: <id>\` is the assignment. The dispatcher
   claims it for your \`agent_id\` when you are under the policy cap. If
   you do not hold that claim, \`claim_task\` it yourself. Stop when no
   next-task message arrives — you are idle.

Dispatcher policy lives in \`underwright.policy.json\` under \`dispatcher\`.
\`enabled\` turns assignment on or off. \`max_tasks_per_agent\` caps how many
tasks one agent is given (completions plus active claims; \`0\` means no cap).
\`idle_minutes\` is how long a next-task message may sit before the sweeper
reassigns that task if it is still unclaimed, or logs \`dispatch_idle\` when
nobody else can take it.

## Where work comes from

GitHub issues are the system of truth for work items. Board tasks exist to
coordinate execution of an issue, not as a separate backlog. Under normal
flow a board item is a \`gh-*\` task synced from an issue via
\`underwright github sync\` (or the repo webhook). When you discover work that
has no issue — a bug, a gap, follow-up work — raise it:

1. \`gh issue create\` in the affected repo with a clear title and scope.
2. \`underwright github sync --repo <owner/name>\` to pull it onto the board
   as a \`gh-<n>\` task (webhook-synced repos skip this — the task appears on
   its own).
3. Claim and work the board task as usual; link the issue in artifacts.

Use \`create_task\` directly only for board-internal bookkeeping that does not
belong on the issue tracker (review tasks, probes, ephemeral coordination).
If in doubt, it belongs on GitHub.

## Anti-escalation

Escalation is a last resort and goes through the mailbox. Never stop silently.

Before escalating:

1. Call \`search_context\` for helpers, specs, and prior decisions.
2. Check artifacts and handoffs already posted on the task. \`get_task\` returns them.
3. Try the alternate harness CLI path (claude, codex, grok, agy, or cmdc; see \`docs/multi-harness.md\`).
4. If still blocked, \`post_artifact\` with kind \`blocked\` recording what was tried, \`send_message\` the human, then \`release_task\` so the dispatcher assigns the next task. Read \`inbox\` and continue. Do not go idle.

**Wrong model for the job?** Agent jobs run at a model tier routed from the
task (\`model_routing\` in the policy: estimate S/docs → light, architecture,
design review, L, or core-store paths → heavy). If the task is beyond your
model, do not thrash. Post a \`blocked\` artifact whose content includes
\`needs-stronger-model\` and says why, then \`release_task\`. The watch
re-dispatches the task one tier heavier. At the heavy tier it goes to the
human instead.

## Git hygiene

Work happens on branches, never as dirty files on \`main\`:

1. **Branch before editing.** Work in a \`feat/gh-<n>-*\` branch or a \`uw-*\`
   worktree — never accumulate uncommitted changes in the \`main\` checkout.
   \`git status\` on \`main\` must be empty when you stop for the day.
2. **Push when done.** When a task completes, commit and push its branch (or
   the merge to \`main\` when that's the flow). Do not leave finished work
   local-only — an unpushed commit is undelivered work.
3. **No orphans.** Uncommitted work you're not finishing right now goes to a
   named branch or a labeled stash with a \`post_artifact\` noting where it
   lives. Never leave files dirty on \`main\` with no record.
4. **Stale branches are board items.** If you create or find a stale
   \`feat/*\`/\`worktree-*\` branch, note it in a handoff artifact so the
   hygiene sweep can classify it.

## Stack

- TypeScript, Node 18+, ESM (\`Node16\` modules — import with \`.js\` extensions)
- \`npm run build\` to compile, \`npm test\` when tests exist
- better-sqlite3 for the store; MCP SDK for the protocol surface
- Schema lives in \`src/schema.ts\` (single source — no .sql files)

## Conventions

- All mutations flow through \`Store\` methods which write to the audit log
- New MCP tools: zod schema + \`server.tool()\` in \`src/server.ts\`, thin
  delegation to a \`Store\` method
- Stateless HTTP mode: no per-request state — everything durable goes in SQLite
`;

/** Default policy for a fresh workspace. Same shape the control plane already understands. */
export const DEFAULT_POLICY = {
  dod: {
    feature: { evidence: ["test_run", "coverage", "review"], tdd: true, min_coverage: 80 },
    bug: { evidence: ["test_run", "review"], tdd: true },
    deploy: { evidence: ["deploy", "smoke_test"] },
    architecture: { artifacts: ["design"], evidence: ["review"] },
    docs: { evidence: ["review"] },
    tdd: { evidence: ["test_run"], tdd: true },
    review: { artifacts: ["review"] },
    default: { evidence: ["test_run"] },
  },
  enforcement: "warn",
  dor: { require_type: true, require_ac_ids: true, require_estimate: true, require_description: false },
  dispatcher: {
    enabled: true,
    max_tasks_per_agent: 0,
    idle_minutes: 15,
    review: { require_different_harness: true, prefer_stronger: true },
  },
  harness_matrix: {
    agents: {},
    coverage: { codex: true, "claude-sdk": true, cmdc: false },
  },
};

export const GITIGNORE_ENTRIES = ["underwright.db*"];

export interface McpConfig {
  mcpServers: Record<string, Record<string, unknown>>;
}

/** Base URL or full /mcp endpoint → the endpoint clients should call. */
export function remoteMcpUrl(remote: string): string {
  const url = new URL(remote);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`--remote must be an http(s) URL, got ${remote}`);
  }
  const path = url.pathname.replace(/\/+$/, "");
  url.pathname = path === "" || path === "/" ? "/mcp" : path;
  return url.toString().replace(/\/$/, "");
}

export function mcpConfig(remote?: string): McpConfig {
  if (!remote) {
    return {
      mcpServers: {
        underwright: {
          command: "npx",
          args: ["-y", "underwright", "serve"],
          env: { UNDERWRIGHT_DB: "underwright.db" },
        },
      },
    };
  }
  return {
    mcpServers: {
      underwright: {
        type: "http",
        url: remoteMcpUrl(remote),
        headers: { Authorization: "Bearer ${UNDERWRIGHT_TOKEN}" },
      },
    },
  };
}

const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

export interface InitOptions {
  /** Workspace directory to scaffold. Defaults to process.cwd(). */
  cwd?: string;
  /** Remote control-plane URL; writes the http .mcp.json variant. */
  remote?: string;
  /** Overwrite existing files. Without it, existing files are left alone. */
  force?: boolean;
  /** Seed the triage task. Default true. */
  seed?: boolean;
}

export interface InitResult {
  cwd: string;
  created: string[];
  updated: string[];
  skipped: string[];
  seeded: { id: string; title: string } | null;
  next_steps: string[];
}

function writeScaffoldFile(
  cwd: string,
  name: string,
  content: string,
  force: boolean,
  result: Pick<InitResult, "created" | "updated" | "skipped">
) {
  const path = join(cwd, name);
  if (existsSync(path)) {
    if (!force) {
      result.skipped.push(name);
      return;
    }
    writeFileSync(path, content);
    result.updated.push(name);
    return;
  }
  writeFileSync(path, content);
  result.created.push(name);
}

/** Add missing ignore entries without touching the rest of the user's .gitignore. */
function ensureGitignore(cwd: string, result: Pick<InitResult, "created" | "updated">) {
  const path = join(cwd, ".gitignore");
  if (!existsSync(path)) {
    writeFileSync(path, `${GITIGNORE_ENTRIES.join("\n")}\n`);
    result.created.push(".gitignore");
    return;
  }
  const current = readFileSync(path, "utf8");
  const present = new Set(current.split(/\r?\n/).map((line) => line.trim()));
  const missing = GITIGNORE_ENTRIES.filter((entry) => !present.has(entry));
  if (missing.length === 0) return;
  const separator = current.length > 0 && !current.endsWith("\n") ? "\n" : "";
  writeFileSync(path, `${current}${separator}${missing.join("\n")}\n`);
  result.updated.push(".gitignore");
}

async function seedTriageTask(store: IStore): Promise<InitResult["seeded"]> {
  if (await store.getTask(TRIAGE_TASK_ID)) return null;
  const title = "Triage repo docs and seed the backlog";
  const task = await store.createTask({
    id: TRIAGE_TASK_ID,
    title,
    type: "docs",
    estimate: "S",
    spec_ref: "README.md",
    ac_ids: ["triage-docs-read", "triage-backlog-seeded"],
    created_by: "underwright-init",
    description: [
      "## Triage this repository",
      "",
      "Turn the repository's own docs into an actionable backlog.",
      "",
      "1. Read README.md and everything under docs/ (if present).",
      "2. Create tasks for the work those docs describe — one acceptance-criterion list per task.",
      "3. Give every task a type, ac_ids, and an estimate so it passes the Definition of Ready.",
    ].join("\n"),
  });
  if (!task || task.error) throw new Error(`could not seed triage task: ${task?.error ?? "unknown error"}`);
  return { id: task.id, title: task.title };
}

function nextSteps(remote: string | undefined, skipped: string[], seeded: InitResult["seeded"]): string[] {
  const steps: string[] = [];
  if (remote) {
    steps.push(`Remote control plane: .mcp.json calls ${remoteMcpUrl(remote)} and reads the bearer token from UNDERWRIGHT_TOKEN.`);
    steps.push("Set UNDERWRIGHT_TOKEN on the server and every agent host (openssl rand -hex 32), then start the server:");
    steps.push("`UNDERWRIGHT_TOKEN=<token> underwright serve --http 127.0.0.1:8741` — put a TLS proxy or Tailscale in front before exposing it (docs/tls-reverse-proxy.md).");
  } else {
    steps.push("Stdio control plane: .mcp.json runs `npx -y underwright serve` against ./underwright.db.");
  }
  steps.push("Reload your agent so it picks up .mcp.json.");
  steps.push("Open the board: `underwright board`.");
  if (seeded) {
    steps.push(`Claim the seeded triage task: \`claim_task\` with task_id "${seeded.id}", then work the board.`);
  } else {
    steps.push(`The triage task "${TRIAGE_TASK_ID}" already exists — claim it if it is still open.`);
  }
  if (skipped.length > 0) {
    steps.push(`Left existing files untouched: ${skipped.join(", ")}. Rerun with --force to regenerate them.`);
  }
  return steps;
}

export async function initWorkspace(store: IStore, opts: InitOptions = {}): Promise<InitResult> {
  if (opts.remote) remoteMcpUrl(opts.remote);
  const cwd = opts.cwd ?? process.cwd();
  const force = opts.force ?? false;
  const result: InitResult = { cwd, created: [], updated: [], skipped: [], seeded: null, next_steps: [] };

  writeScaffoldFile(cwd, "AGENTS.md", AGENTS_MD, force, result);
  writeScaffoldFile(cwd, ".mcp.json", json(mcpConfig(opts.remote)), force, result);
  writeScaffoldFile(cwd, "underwright.policy.json", json(DEFAULT_POLICY), force, result);
  ensureGitignore(cwd, result);

  if (opts.seed !== false) result.seeded = await seedTriageTask(store);
  result.next_steps = nextSteps(opts.remote, result.skipped, result.seeded);
  return result;
}

export function formatInitResult(result: InitResult): string {
  const lines = [`underwright init: ${result.cwd}`];
  if (result.created.length) lines.push(`  created: ${result.created.join(", ")}`);
  if (result.updated.length) lines.push(`  updated: ${result.updated.join(", ")}`);
  if (result.skipped.length) lines.push(`  skipped: ${result.skipped.join(", ")}`);
  if (result.seeded) lines.push(`  seeded task ${result.seeded.id}: ${result.seeded.title}`);
  lines.push("", "Next steps:");
  for (const [i, step] of result.next_steps.entries()) lines.push(`  ${i + 1}. ${step}`);
  return lines.join("\n");
}
