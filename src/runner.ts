import { spawn, spawnSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import type { AgentBackend, AgentJobSpec } from "./istore.js";
import { getHarnessBackend, getHarnessMatrix, type Policy } from "./policy.js";

export type JobCall = (name: string, args: Record<string, unknown>) => Promise<any>;

/** Built-in omnigent coverage table: which harnesses `omni run` can drive
 *  today. The policy harness_matrix.coverage overrides these defaults;
 *  harnesses not marked true (or absent) launch raw. */
export const OMNIGENT_HARNESS_SUPPORT: Record<string, boolean> = {
  codex: true,
  "claude-sdk": true,
  cmdc: false, // pending the new omnigent support landing
};

/** True when the `omni` CLI resolves on PATH. Probed per call: one spawn against a
 *  multi-minute job is noise, and it keeps tests hermetic through PATH. */
export function omniAvailable(): boolean {
  try {
    return spawnSync("omni", ["--version"], { stdio: "ignore" }).status === 0;
  } catch {
    return false;
  }
}

export interface InvocationContext {
  /** Probe override; defaults to checking PATH for `omni` at call time. */
  omniAvailable?: boolean;
  /** Policy carrying harness_matrix; defaults to loadPolicy(). */
  policy?: Policy;
}

export interface AgentInvocation {
  executable: string;
  args: string[];
  backend: AgentBackend;
  harness?: string;
  server?: string | null;
}

const executableBase = (path: string) => path.split(/[\\/]/).pop() ?? path;

/** Expand only known placeholders; prompts are passed as argv, never shell code.
 *  Resolution order: per-job spec fields win, then the policy harness_matrix
 *  (exact agent_id, then "*"), then built-in defaults. Omnigent is preferred
 *  whenever the resolved backend is omnigent, `omni` is on PATH, and the
 *  harness is in the coverage table; anything else falls back to the raw CLI. */
export function agentInvocation(job: any, agentId: string, host: string, context: InvocationContext = {}): AgentInvocation {
  const spec: AgentJobSpec = typeof job.agent_spec === "string" ? JSON.parse(job.agent_spec) : job.agent_spec;
  if (!spec?.executable || !Array.isArray(spec.args) || !spec.prompt) throw new Error("invalid agent job specification");
  const values: Record<string, string> = { task_id: job.task_id ?? "", agent_id: agentId, host, job_id: job.id };
  const prompt = spec.prompt.replace(/\{\{(task_id|agent_id|host|job_id)\}\}/g, (_, key) => values[key]);
  const matrix = getHarnessMatrix(context.policy);
  const pref = matrix.agents[agentId] ?? matrix.agents["*"] ?? {};
  const harness = spec.harness ?? pref.harness ?? executableBase(spec.executable);
  const coverage = { ...OMNIGENT_HARNESS_SUPPORT, ...matrix.coverage };
  const backend = spec.backend ?? pref.backend ?? (coverage[harness] === true ? "omnigent" : "raw");
  const server = spec.server ?? pref.server;
  if (backend === "omnigent" && (context.omniAvailable ?? omniAvailable()) && coverage[harness] === true) {
    const args = ["run", "--harness", harness];
    if (server) args.push("--server", server);
    args.push("-p", prompt);
    return { executable: "omni", args, backend: "omnigent", harness, server: server ?? null };
  }
  // An explicit {{prompt}} argv slot is optional; by default append the prompt.
  const args = spec.args.map(arg => arg === "{{prompt}}" ? prompt : arg);
  if (!spec.args.includes("{{prompt}}")) args.push(prompt);
  return { executable: spec.executable, args, backend: "raw", harness };
}

const SESSION_MARKER = /omnigent session[:\s]+(\S+)/i;
const SESSION_URL = /https?:\/\/\S*omni\S*/i;

/** Omnigent transcript locator from process output: the last `omnigent session: X`
 *  marker, else the last URL that looks like an omnigent transcript. */
export function extractOmnigentSession(output: string): string | null {
  const markers = [...output.matchAll(new RegExp(SESSION_MARKER.source, "gi"))].map(m => m[1]);
  if (markers.length) return markers[markers.length - 1];
  const urls = [...output.matchAll(new RegExp(SESSION_URL.source, "gi"))].map(m => m[0]);
  return urls.length ? urls[urls.length - 1] : null;
}

/** Execute one lease, publish stdout/stderr snapshots, and stop the process group on lease loss. */
export async function executeLeasedJob(job: any, call: JobCall, options: {
  agentId: string; host: string; ttlSeconds?: number; timeoutMs?: number; signal?: AbortSignal;
  output?: (chunk: string) => void;
}) {
  const ttl = options.ttlSeconds ?? 60;
  const owner = { job_id: job.id, agent_id: options.agentId, lease_token: job.lease_token };
  let result = "";
  const append = (chunk: string) => { result = (result + chunk).slice(-64000); options.output?.(chunk); };
  let invocation;
  try {
    invocation = job.type === "agent" ? agentInvocation(job, options.agentId, options.host) :
      { executable: job.command, args: [], backend: "raw" as const };
  } catch (error) {
    return call("finish_job", { ...owner, status: "failed", result: String(error) });
  }
  if (options.signal?.aborted) return;
  const child = spawn(invocation.executable, invocation.args, {
    shell: job.type !== "agent", detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", chunk => append(chunk.toString()));
  child.stderr.on("data", chunk => append(chunk.toString()));
  let stopped = false;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  const kill = (signal: NodeJS.Signals) => {
    if (!child.pid) return;
    try { if (process.platform === "win32") child.kill(signal); else process.kill(-child.pid, signal); }
    catch (error: any) { if (error.code !== "ESRCH") throw error; }
  };
  const stop = () => {
    if (stopped) return;
    stopped = true;
    kill("SIGTERM");
    killTimer = setTimeout(() => kill("SIGKILL"), 2000);
  };
  const abort = () => { append("\nrunner shutting down\n"); stop(); };
  options.signal?.addEventListener("abort", abort, { once: true });
  // Close the race between the initial signal check and listener registration.
  if (options.signal?.aborted) abort();
  const timeout = setTimeout(() => { append("\njob execution timed out\n"); stop(); }, options.timeoutMs ?? 600000);
  let leaseDeadline = Date.parse(job.lease_expires);
  let leaseLost = false;
  let renewing = false;
  let heartbeat: Promise<void> = Promise.resolve();
  const ticker = setInterval(() => {
    if (Date.now() >= leaseDeadline) { leaseLost = true; stop(); }
    if (renewing || leaseLost) return;
    renewing = true;
    heartbeat = (async () => {
      try {
        const renewal = await call("renew_job", { ...owner, ttl_seconds: ttl, result });
        if (renewal.error) { leaseLost = true; stop(); }
        else leaseDeadline = Date.parse(renewal.lease_expires);
      } catch { if (Date.now() >= leaseDeadline) { leaseLost = true; stop(); } }
      finally { renewing = false; }
    })();
  }, Math.min(1000, ttl * 1000 / 3));
  try {
    const code = await new Promise<number | null>(resolve => {
      child.once("error", error => append(`\n${error.message}\n`));
      child.once("close", code => resolve(code));
    });
    await heartbeat;
    if (leaseLost) throw new Error(`lost lease for ${job.id}`);
    if (invocation.backend === "omnigent") {
      // Link the task to the omnigent transcript: normalize whatever the CLI printed.
      const session = extractOmnigentSession(result);
      if (session && !new RegExp(`omnigent session: ?${session.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`).test(result)) {
        result = (result + `\nomnigent session: ${session}`).slice(-64000);
      }
    }
    // Retry completion while heartbeats keep ownership alive during transient outages.
    while (Date.now() < leaseDeadline && !leaseLost) {
      try {
        const finished = await call("finish_job", { ...owner, status: code === 0 && !stopped ? "done" : "failed", result });
        if (finished.error) throw new Error(finished.error);
        return finished;
      } catch (error) {
        if (Date.now() >= leaseDeadline || leaseLost || options.signal?.aborted) throw error;
        await delay(500);
      }
    }
    throw new Error(`lost lease for ${job.id}`);
  } finally {
    clearInterval(ticker);
    clearTimeout(timeout);
    if (killTimer) { kill("SIGKILL"); clearTimeout(killTimer); }
    options.signal?.removeEventListener("abort", abort);
    await heartbeat;
  }
}

export async function runSupervisor(call: JobCall, options: {
  agentId: string; host: string; signal: AbortSignal; pollMs?: number; once?: boolean;
}) {
  do {
    try {
      const job = await call("next_job", { agent_id: options.agentId, host: options.host, ttl_seconds: 60 });
      if (job?.error) throw new Error(job.error);
      if (job) {
        console.error(`[uw-runner] running ${job.id}`);
        await executeLeasedJob(job, call, { ...options, output: chunk => process.stdout.write(chunk) });
      }
    } catch (error) { console.error("[uw-runner]", error); if (options.once) throw error; }
    if (options.once || options.signal.aborted) break;
    await delay(options.pollMs ?? 2000, undefined, { signal: options.signal }).catch(() => {});
  } while (!options.signal.aborted);
}
