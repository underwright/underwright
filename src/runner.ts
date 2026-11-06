import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import type { AgentJobSpec } from "./istore.js";

export type JobCall = (name: string, args: Record<string, unknown>) => Promise<any>;

/** Expand only known placeholders; prompts are passed as argv, never shell code. */
export function agentInvocation(job: any, agentId: string, host: string) {
  const spec: AgentJobSpec = typeof job.agent_spec === "string" ? JSON.parse(job.agent_spec) : job.agent_spec;
  if (!spec?.executable || !Array.isArray(spec.args) || !spec.prompt) throw new Error("invalid agent job specification");
  const values: Record<string, string> = { task_id: job.task_id ?? "", agent_id: agentId, host, job_id: job.id };
  const prompt = spec.prompt.replace(/\{\{(task_id|agent_id|host|job_id)\}\}/g, (_, key) => values[key]);
  // An explicit {{prompt}} argv slot is optional; by default append the prompt.
  const args = spec.args.map(arg => arg === "{{prompt}}" ? prompt : arg);
  if (!spec.args.includes("{{prompt}}")) args.push(prompt);
  return { executable: spec.executable, args };
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
      { executable: job.command, args: [] };
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
