// Built-in executable routines ("playbooks"): submit_job command templates
// that replace per-prompt inference for routine work. `run_helper` resolves
// a playbook by name, renders its command from run args, then executes it
// synchronously (bounded) or queues it as a job. This module is pure
// catalog + rendering + a bounded sync executor — no store, no server.

import { spawn } from "node:child_process";

export interface Playbook {
  name: string;
  description: string;
  /** Job type used when the run is queued instead of executed synchronously. */
  type: string;
  /** Shell command template; `{{placeholders}}` are filled from run args. */
  command: string;
  /** Args that must be supplied for the command to render. */
  required: string[];
  /** Default cap for synchronous execution. */
  timeout_ms: number;
}

export const PLAYBOOKS: Playbook[] = [
  {
    name: "github-sync",
    description: "Sync GitHub issues and PRs into board tasks.",
    type: "deploy",
    command: "node dist/cli.js github sync --repo {{repo}} --prs",
    required: ["repo"],
    timeout_ms: 120_000,
  },
  {
    name: "merge-and-verify",
    description: "Merge a branch, then build and test before it ships.",
    type: "test",
    command: "git merge --no-edit {{branch}} && npm run build && npm test",
    required: ["branch"],
    timeout_ms: 300_000,
  },
  {
    name: "evidence-attach",
    description: "Attach a command output file to a task as evidence.",
    type: "test",
    command: "node dist/cli.js evidence --task {{task_id}} --kind {{kind}} --file {{file}} --by {{agent_id}}",
    required: ["kind", "file"],
    timeout_ms: 60_000,
  },
  {
    name: "index-refresh",
    description: "Refresh the tree-sitter code index for a workspace root.",
    type: "build",
    command: "node dist/cli.js index --root {{root}}",
    required: ["root"],
    timeout_ms: 120_000,
  },
  {
    name: "branch-worktree-setup",
    description: "Check out a branch in a git worktree for isolated work.",
    type: "build",
    command: "git worktree add {{path}} {{branch}}",
    required: ["path", "branch"],
    timeout_ms: 60_000,
  },
];

export function getPlaybook(name: string): Playbook | undefined {
  return PLAYBOOKS.find((p) => p.name === name);
}

export interface RenderedCommand {
  command?: string;
  error?: string;
}

/** Fill `{{placeholders}}` from args. `task_id`/`agent_id` are always available.
 *  Leftover placeholders mean a required arg was missed — an error, not a guess. */
export function renderCommand(template: string, args: Record<string, unknown>): RenderedCommand {
  const missing: string[] = [];
  const command = template.replace(/\{\{(\w+)\}\}/g, (_, key: string) => {
    const value = args[key];
    if (value === undefined || value === null || value === "") {
      missing.push(key);
      return "";
    }
    return String(value);
  });
  if (missing.length) return { error: `missing required argument(s): ${[...new Set(missing)].join(", ")}` };
  return { command };
}

export interface SyncResult {
  exit_code: number | null;
  output: string;
  duration_ms: number;
  timed_out?: boolean;
}

/** Execute one shell command in the background with a hard timeout; bounded capture.
 *  The promise never rejects — failures land in the result. */
export function runCommandSync(command: string, timeoutMs: number): Promise<SyncResult> {
  return new Promise((resolve) => {
    const started = Date.now();
    let output = "";
    const append = (chunk: string) => { output = (output + chunk).slice(-64000); };
    let child;
    try {
      child = spawn(command, { shell: true, stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      resolve({ exit_code: null, output: String(error), duration_ms: Date.now() - started });
      return;
    }
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (c: string) => append(c));
    child.stderr.on("data", (c: string) => append(c));
    const timer = setTimeout(() => {
      append("\nhelper execution timed out\n");
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 2000).unref();
    }, timeoutMs);
    timer.unref?.();
    child.once("error", (error) => {
      clearTimeout(timer);
      resolve({ exit_code: null, output: output + String(error), duration_ms: Date.now() - started });
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve({ exit_code: code, output, duration_ms: Date.now() - started });
    });
  });
}
