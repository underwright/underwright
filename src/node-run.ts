/** Outbound daemon with independent liveness and lease loops, typed execution and durable receipts. */
import { createExecutorRegistry, redact, type ExecutorConfig } from './node-executors.js';
import { NODE_MAX_CONCURRENCY } from './node-protocol.js';
import { AttemptJournal, processStart } from './node-journal.js';
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

export function defaultInventoryProbe(): Record<string, unknown> {
  return {
    protocol_version: 1, daemon_version: "0.1.0", os: platform(), arch: arch(),
    labels: [], supported_operation_kinds: ["run-script", "launch-agent", "provision", "install-harness"],
    approved_workspace_ids: [], max_concurrency: 1, current_slots: 0,
    harnesses: ["claude", "codex", "grok", "agy"].map((id) => ({
      id, version: "unknown", installed: false, auth_status: "unknown", quota: { state: "unknown" },
    })),
  };
}

function configSupportedKinds(config: ExecutorConfig): string[] {
  const kinds: string[] = [];
  if (Object.keys(config.scripts ?? {}).length) kinds.push('run-script');
  if (Object.keys(config.harnesses ?? {}).length) kinds.push('launch-agent');
  if (Object.keys(config.repositories ?? {}).length) kinds.push('provision');
  if (Object.keys(config.installers ?? {}).length) kinds.push('install-harness');
  return kinds;
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
} = {}) {
  const dir = opts.dir ?? nodeStateDirectory();
  const cred = readNodeCredential(dir);
  const release = acquireDaemonLock(dir);
  const sleep = opts.sleep ?? sleepSignal;
  let journal: AttemptJournal;
  try { journal = new AttemptJournal(join(dir, 'attempts')); journal.reconcile(); }
  catch (error) { release(); throw error; }
  // config.inventory attests harness readiness; the operational arrays are
  // derived from what the executor registry can actually run.
  const probe = opts.probe ?? (() => ({ ...defaultInventoryProbe(), ...(opts.config?.inventory as object | undefined) }));
  const heartbeatMs = opts.heartbeatMs ?? 15_000;
  const capabilitiesMs = opts.capabilitiesMs ?? 60_000;
  const abort = new AbortController();
  const signal = opts.signal ?? abort.signal;
  if (signal.aborted) abort.abort();
  const onAbort = () => abort.abort();
  signal.addEventListener("abort", onAbort);
  let session_id = "";
  let capabilities_version = 0;
  // gh-91: N parallel worker loops. The jobs themselves already run as child
  // processes via the executor registry — the serial part was only the
  // poll/execute/finish bookkeeping, which is now per-slot.
  const maxConcurrency = Math.max(1, Math.min(NODE_MAX_CONCURRENCY, Math.floor(opts.config?.concurrency ?? 1) || 1));
  if (opts.config?.concurrency !== undefined && Math.floor(opts.config.concurrency) !== maxConcurrency) {
    console.error(`[underwright-node] config.concurrency=${opts.config.concurrency} clamped to ${maxConcurrency}`);
  }
  const activeJobs = new Set<string>();
  const backoff = async (error: any) => {
    const wait = Math.max(1, Math.min(30, Number(error?.retry_after) || 1 + Math.floor(Math.random() * 3)));
    await sleep(wait * 1000, abort.signal);
  };
  try {
    const session = await nodeCall(cred, "/nodes/v1/session", { version: 1 }, "POST", abort.signal);
    if (session.error || !session.session_id) throw Object.assign(new Error("session denied"), session);
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
      while (!abort.signal.aborted) {
        try {
          const active_job_id = [...activeJobs][0];
          const phase = activeJobs.size ? "running" : "idle";
          const result = await nodeCall(cred, "/nodes/v1/heartbeat", { session_id, capabilities_version, active_job_id, phase }, "POST", abort.signal);
          if ([401, 409].includes(result.status)) { abort.abort(); return; }
        } catch (error) { if (abort.signal.aborted) return; await backoff(error); }
        await sleep(heartbeatMs, abort.signal).catch(() => undefined);
      }
    };
    const caps = async () => {
      while (!abort.signal.aborted) {
        try {
          const probed: any = await Promise.race([
            Promise.resolve(probe()),
            sleep(5_000, abort.signal).then(() => { throw Object.assign(new Error("probe timeout"), { timeout: true }); }),
          ]);
          // Live numbers always win over whatever the probe advertises (gh-91).
          if (opts.config) {
            probed.supported_operation_kinds = configSupportedKinds(opts.config);
            probed.approved_workspace_ids = Object.keys(opts.config.workspaces ?? {});
          }
          const inventory = { ...probed, max_concurrency: maxConcurrency, current_slots: activeJobs.size };
          capabilities_version += 1;
          const result = await nodeCall(cred, "/nodes/v1/capabilities", { session_id, version: capabilities_version, inventory }, "PUT", abort.signal);
          if ([401, 409].includes(result.status)) { abort.abort(); return; }
        } catch (error) { if (abort.signal.aborted) return; await backoff(error); }
        await sleep(capabilitiesMs, abort.signal).catch(() => undefined);
      }
    };
    const work = async (slot: number) => {
      // Stagger slot starts so a fleet restart doesn't stampede the poll endpoint.
      if (slot) await sleep((slot * 250) + Math.floor(Math.random() * 250), abort.signal).catch(() => undefined);
      while (!abort.signal.aborted) {
        let job: any;
        let held = false;
        try {
          job = await nodeCall(cred, "/nodes/v1/poll", { session_id, wait_seconds: 25, held_job_ids: [...activeJobs] }, "POST", abort.signal);
          if ([401, 409].includes(job.status)) { abort.abort(); return; }
          if (job.empty || job.status === 204 || !job.id) continue;
          if (activeJobs.has(job.id)) continue; // duplicate delivery; another slot holds it
          activeJobs.add(job.id);
          held = true;
          let record = journal.read(job.id, job.attempt_id);
          let finished = record?.outcome;
          if (!record) {
            record = { job_id: job.id, attempt_id: job.attempt_id, phase: 'started' };
            journal.write(record);
            const childAbort = new AbortController();
            const stopChild = () => childAbort.abort();
            abort.signal.addEventListener('abort', stopChild, { once: true });
            if (abort.signal.aborted) childAbort.abort();
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
            finally { clearInterval(timer); clearInterval(expiryTimer); abort.signal.removeEventListener('abort', stopChild); }
            journal.write({ ...record, phase: 'finished', outcome: finished });
          }
          finished ??= { status: 'failed', result: 'restart/outcome_unknown; automatic replay refused' };
          const receipt = await nodeCall(cred, `/nodes/v1/jobs/${job.id}/finish`, {
            session_id, lease_token: job.lease_token, status: finished.status, result: finished.result,
          });
          if (receipt.error) { if ([401, 409].includes(receipt.status)) abort.abort(); else throw new Error('finish failed'); }
        } catch (error) {
          if (abort.signal.aborted) return;
          await backoff(error);
        } finally {
          if (held) activeJobs.delete(job?.id);
        }
      }
    };
    const loops = [beat, caps, ...Array.from({ length: maxConcurrency }, (_v, i) => () => work(i))]
      .map(async loop => { try { await loop(); } catch (error) { abort.abort(); throw error; } });
    const settled = await Promise.allSettled(loops);
    const failure = settled.find(r => r.status === 'rejected');
    if (failure?.status === 'rejected' && !signal.aborted) throw failure.reason;
  } finally {
    signal.removeEventListener("abort", onAbort);
    abort.abort();
    release();
  }
}
