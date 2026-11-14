/** Outbound daemon with independent liveness and lease loops, typed execution and durable receipts. */
import { createExecutorRegistry, redact, sanitizedEnv, type ExecutorConfig } from './node-executors.js';
import { AttemptJournal, processStart } from './node-journal.js';
import { execFile } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { arch, platform } from "node:os";
import { join } from "node:path";
import { nodeStateDirectory, readNodeCredential, secureDirectory } from "./node-client.js";
import { sleepSignal, type NodeCredential } from "./node-protocol.js";

export type NodeExecutor = (job: any, signal?: AbortSignal) => Promise<{ status: "done" | "failed"; result: string }>;
export type NodeProbe = () => Promise<unknown> | unknown;

function acquireDaemonLock(dir: string) {
  secureDirectory(dir);
  const path = join(dir, "daemon.lock");
  if (existsSync(path)) {
    const pid = Number(readFileSync(path, "utf8").trim());
    if (pid && !Number.isNaN(pid)) {
      try { process.kill(pid, 0); throw new Error("node daemon already running"); }
      catch (error: any) { if (error?.code !== "ESRCH") throw error instanceof Error && error.message.includes("already running") ? error : new Error("node daemon already running"); }
    }
    try { unlinkSync(path); } catch { /* replaced */ }
  }
  const fd = openSync(path, "wx", 0o600);
  writeFileSync(fd, String(process.pid));
  closeSync(fd);
  return () => { try { unlinkSync(path); } catch { /* shutdown */ } };
}

async function nodeCall(cred: NodeCredential, path: string, body: unknown, method = "POST", signal?: AbortSignal) {
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  if (signal?.aborted) controller.abort();
  const timeout = setTimeout(() => controller.abort(), 35000);
  try {
  const res = await fetch(cred.url + path, {
    method, redirect: "error",
    headers: { "content-type": "application/json", authorization: "Bearer " + cred.token },
    body: JSON.stringify(body),
    signal: controller.signal,
  });
  if (res.status === 204) return { empty: true, status: 204 };
  const result = await res.json() as any;
  return { ...result, status: res.status, retry_after: Number(res.headers.get("retry-after") ?? result.retry_after ?? 0) };
  } finally { clearTimeout(timeout); signal?.removeEventListener('abort', onAbort); }
}

export const harmlessExecutor: NodeExecutor = async (job) => ({
  status: "done",
  result: `harmless:${job?.node_spec?.kind ?? "node"}`,
});

const DEFAULT_HARNESSES = ["claude", "codex", "grok", "agy"];

/** Run `<executable> --version` (argv only, no shell) and return the first version-looking token. */
function probeVersion(executable: string, args: string[], timeoutMs: number): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(executable, args, { timeout: timeoutMs, killSignal: "SIGKILL", maxBuffer: 64 * 1024, env: sanitizedEnv() },
      (error, stdout, stderr) => {
        if (error) return resolve(null);
        const text = `${stdout}\n${stderr}`;
        const version = text.match(/v?\d+\.\d+(?:\.\d+)?(?:[-+][\w.]+)?/)?.[0] ?? text.trim().split("\n")[0] ?? "";
        resolve(version.slice(0, 64) || "installed");
      });
  });
}

/** Capability inventory for this node. An explicit operator `config.inventory` snapshot wins;
 *  otherwise each locally approved harness (or the default set on PATH) is probed for a real
 *  install/version. Auth readiness cannot be observed without touching vendor credentials, so it
 *  comes from the operator's `auth` declaration on the harness entry. */
export async function probeInventory(
  config?: ExecutorConfig,
  opts: { timeoutMs?: number; versionArgs?: Record<string, string[]> } = {},
): Promise<unknown> {
  if (config?.inventory) return config.inventory;
  const timeoutMs = opts.timeoutMs ?? 4_000;
  type HarnessEntry = NonNullable<ExecutorConfig["harnesses"]>[string];
  const entries: [string, HarnessEntry][] = config?.harnesses
    ? Object.entries(config.harnesses)
    : DEFAULT_HARNESSES.map((id) => [id, { executable: id }]);
  const harnesses = await Promise.all(entries.slice(0, 16).map(async ([id, h]) => {
    const version = await probeVersion(h.executable, opts.versionArgs?.[id] ?? ["--version"], timeoutMs);
    return {
      id, version: version ?? "unknown", installed: version !== null,
      auth_status: version === null ? "missing" : (h.auth ?? "unknown"),
      quota: { state: "unknown" },
    };
  }));
  return {
    protocol_version: 1, daemon_version: "0.1.0", os: platform(), arch: arch(),
    labels: [], supported_operation_kinds: ["run-script", "launch-agent", "provision", "install-harness"],
    approved_workspace_ids: Object.keys(config?.workspaces ?? {}).slice(0, 32), max_concurrency: 1, current_slots: 0,
    harnesses,
  };
}

/** @deprecated static fallback kept for callers without config; prefer probeInventory. */
export function defaultInventoryProbe(): unknown {
  return {
    protocol_version: 1, daemon_version: "0.1.0", os: platform(), arch: arch(),
    labels: [], supported_operation_kinds: ["run-script", "launch-agent", "provision", "install-harness"],
    approved_workspace_ids: [], max_concurrency: 1, current_slots: 0,
    harnesses: DEFAULT_HARNESSES.map((id) => ({
      id, version: "unknown", installed: false, auth_status: "unknown", quota: { state: "unknown" },
    })),
  };
}

export async function runNode(opts: {
  dir?: string;
  signal?: AbortSignal;
  executor?: NodeExecutor;
  config?: ExecutorConfig;
  renewMs?: number;
  probe?: NodeProbe;
  heartbeatMs?: number;
  capabilitiesMs?: number;
  sleep?: typeof sleepSignal;
  /** Operational log sink; defaults to stderr. */
  log?: (message: string) => void;
} = {}) {
  const dir = opts.dir ?? nodeStateDirectory();
  const cred = readNodeCredential(dir);
  const release = acquireDaemonLock(dir);
  const sleep = opts.sleep ?? sleepSignal;
  let journal: AttemptJournal;
  try { journal = new AttemptJournal(join(dir, 'attempts')); journal.reconcile(); }
  catch (error) { release(); throw error; }
  const probe = opts.probe ?? (() => probeInventory(opts.config));
  const heartbeatMs = opts.heartbeatMs ?? 15_000;
  const capabilitiesMs = opts.capabilitiesMs ?? 60_000;
  const abort = new AbortController();
  const signal = opts.signal ?? abort.signal;
  if (signal.aborted) abort.abort();
  const onAbort = () => abort.abort();
  signal.addEventListener("abort", onAbort);
  let session_id = "";
  let capabilities_version = 0;
  let active_job_id: string | undefined;
  let phase: "idle" | "polling" | "running" = "idle";
  const backoff = async (error: any, during: AbortSignal) => {
    const wait = Math.max(1, Math.min(30, Number(error?.retry_after) || 1 + Math.floor(Math.random() * 3)));
    await sleep(wait * 1000, during).catch(() => undefined);
  };
  const log = opts.log ?? ((message: string) => console.error(`[underwright-node] ${message}`));
  let authFailures = 0;
  try {
    // Outer session loop (task-570d289b): a lost/expired session or an outage
    // re-sessions with the stored credential and backs off. It never exits;
    // only the shutdown signal ends the daemon.
    while (!abort.signal.aborted) {
      let session: any;
      try {
        session = await nodeCall(cred, "/nodes/v1/session", { version: 1 }, "POST", abort.signal);
      } catch (error) {
        if (abort.signal.aborted) break;
        session = { error: error instanceof Error ? error.message : String(error), status: 0 };
      }
      if (session.error || !session.session_id) {
        authFailures += 1;
        const wait = sessionBackoffSeconds(authFailures, session.retry_after);
        log(`session start failed (${session.status ?? "?"}: ${session.error ?? "no session"}); retry ${authFailures} in ${wait}s`);
        await sleep(wait * 1000, abort.signal).catch(() => undefined);
        continue;
      }
      if (authFailures) log(`session re-established after ${authFailures} failed attempt(s)`);
      authFailures = 0;
      const ended = await runSession(session);
      if (abort.signal.aborted) break;
      log(`session ${session.session_id.slice(0, 8)} ended (${ended}); re-authenticating`);
      // Brief jittered pause so a fleet does not stampede the server together.
      await sleep((1 + Math.floor(Math.random() * 2)) * 1000, abort.signal).catch(() => undefined);
    }
  } finally {
    signal.removeEventListener("abort", onAbort);
    abort.abort();
    release();
  }

  /** Run the heartbeat, capabilities and work loops for one session. Resolves with the reason it ended. */
  async function runSession(session: any): Promise<string> {
    const sess = new AbortController();
    const stopSess = () => sess.abort();
    abort.signal.addEventListener("abort", stopSess, { once: true });
    let reason = "shutdown";
    const lost = (where: string, status: number) => { reason = `${where} ${status}`; sess.abort(); };
    session_id = session.session_id;
    const execute = opts.executor ?? (async (job: any, childSignal?: AbortSignal) => {
      if (!opts.config) return { status: 'failed' as const, result: 'executor config required; use node run --config FILE' };
      const registry = createExecutorRegistry(session.policy, {
        ...opts.config,
        timeoutMs: Math.min(opts.config.timeoutMs ?? 600000, (job.node_spec.timeout_seconds ?? 600) * 1000),
        onSpawn: pid => journal.write({ job_id: job.id, attempt_id: job.attempt_id, phase: 'started', pid, process_start: processStart(pid) }),
      });
      let worker: Record<string, string> | undefined;
      if (job.node_spec.kind === 'launch-agent') {
        const issued = await nodeCall(cred, `/nodes/v1/jobs/${job.id}/worker`, { session_id, lease_token: job.lease_token });
        if (issued.error || !issued.token) return { status: 'failed' as const, result: 'worker credential denied' };
        worker = { UNDERWRIGHT_TOKEN: issued.token, UNDERWRIGHT_MCP_URL: cred.url + '/worker/mcp', UNDERWRIGHT_TASK_ID: issued.task_id, UNDERWRIGHT_AGENT_ID: issued.agent_id, UNDERWRIGHT_JOB_ID: issued.job_id, UNDERWRIGHT_ATTEMPT_ID: issued.attempt_id };
      }
      return registry.execute({ id: job.id, type: job.node_spec.kind, params: job.node_spec.payload, worker }, childSignal);
    });
    const beat = async () => {
      while (!sess.signal.aborted) {
        try {
          const result = await nodeCall(cred, "/nodes/v1/heartbeat", { session_id, capabilities_version, active_job_id, phase }, "POST", sess.signal);
          if ([401, 409].includes(result.status)) { lost("heartbeat", result.status); return; }
        } catch (error) { if (sess.signal.aborted) return; await backoff(error, sess.signal); }
        await sleep(heartbeatMs, sess.signal).catch(() => undefined);
      }
    };
    const caps = async () => {
      while (!sess.signal.aborted) {
        try {
          const inventory = await Promise.race([
            Promise.resolve(probe()),
            sleep(5_000, sess.signal).then(() => { throw Object.assign(new Error("probe timeout"), { timeout: true }); }),
          ]);
          capabilities_version += 1;
          const result = await nodeCall(cred, "/nodes/v1/capabilities", { session_id, version: capabilities_version, inventory }, "PUT", sess.signal);
          if ([401, 409].includes(result.status)) { lost("capabilities", result.status); return; }
        } catch (error) { if (sess.signal.aborted) return; await backoff(error, sess.signal); }
        await sleep(capabilitiesMs, sess.signal).catch(() => undefined);
      }
    };
    const work = async () => {
      while (!sess.signal.aborted) {
        try {
          phase = "polling";
          const job = await nodeCall(cred, "/nodes/v1/poll", { session_id, wait_seconds: 25 }, "POST", sess.signal);
          if ([401, 409].includes(job.status)) { lost("poll", job.status); return; }
          if (job.empty || job.status === 204 || !job.id) { phase = "idle"; continue; }
          active_job_id = job.id;
          phase = "running";
          let record = journal.read(job.id, job.attempt_id);
          let finished = record?.outcome;
          if (!record) {
            record = { job_id: job.id, attempt_id: job.attempt_id, phase: 'started' };
            journal.write(record);
            const childAbort = new AbortController();
            const stopChild = () => childAbort.abort();
            sess.signal.addEventListener('abort', stopChild, { once: true });
            if (sess.signal.aborted) childAbort.abort();
            let expires = Date.parse(job.lease_expires);
            let renewing = false;
            const timer = setInterval(() => {
              if (Date.now() >= expires) childAbort.abort();
              if (renewing || childAbort.signal.aborted) return;
              renewing = true;
              void nodeCall(cred, `/nodes/v1/jobs/${job.id}/renew`, { session_id, lease_token: job.lease_token }, 'POST', AbortSignal.timeout(Math.max(1, Math.min(10000, expires - Date.now()))))
                .then(r => { if (r.error || !r.lease_expires) childAbort.abort(); else expires = Date.parse(r.lease_expires); })
                .catch(() => childAbort.abort()).finally(() => { renewing = false; });
            }, opts.renewMs ?? 10000);
            const expiryTimer = setInterval(() => { if (Date.now() >= expires) childAbort.abort(); }, 100);
            try {
              finished = await execute(job, childAbort.signal);
              finished = { status: childAbort.signal.aborted ? 'failed' : finished.status, result: redact(finished.result).slice(-64000) };
            } catch { finished = { status: 'failed', result: 'executor failed/outcome_unknown' }; }
            finally { clearInterval(timer); clearInterval(expiryTimer); sess.signal.removeEventListener('abort', stopChild); }
            journal.write({ ...record, phase: 'finished', outcome: finished });
          }
          finished ??= { status: 'failed', result: 'restart/outcome_unknown; automatic replay refused' };
          const receipt = await nodeCall(cred, `/nodes/v1/jobs/${job.id}/finish`, {
            session_id, lease_token: job.lease_token, status: finished.status, result: finished.result,
          });
          if (receipt.error) {
            // 401: the session is gone, so re-session. 409: this job's lease was lost
            // (the sweeper records outcome_unknown), but the session is fine. Keep polling.
            if (receipt.status === 401) { lost("finish", 401); return; }
            if (receipt.status === 409) log(`finish ${job.id} refused (lease lost); outcome kept in journal`);
            else throw new Error('finish failed');
          }
        } catch (error) {
          if (sess.signal.aborted) return;
          await backoff(error, sess.signal);
        } finally {
          active_job_id = undefined;
          phase = "idle";
        }
      }
    };
    const loops = [beat, caps, work].map(async loop => {
      try { await loop(); } catch (error) { reason = `error: ${error instanceof Error ? error.message : String(error)}`; sess.abort(); }
    });
    await Promise.all(loops);
    abort.signal.removeEventListener("abort", stopSess);
    return reason;
  }
}

/** Re-session backoff: 1, 2, 4 … seconds capped at 5 minutes, at least the server's retry-after, with jitter. */
export function sessionBackoffSeconds(failures: number, retryAfter?: number, random = Math.random): number {
  const base = Math.min(300, 2 ** Math.max(0, failures - 1));
  const jittered = Math.ceil(base * (0.75 + random() * 0.5));
  return Math.min(300, Math.max(1, jittered, Number(retryAfter) || 0));
}
