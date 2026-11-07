/** Outbound node daemon: session, poll, independent heartbeat/capability loops, harmless executor. */
import { closeSync, existsSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { arch, platform } from "node:os";
import { join } from "node:path";
import { nodeStateDirectory, readNodeCredential, secureDirectory } from "./node-client.js";
import { sleepSignal, type NodeCredential } from "./node-protocol.js";

export type NodeExecutor = (job: any) => Promise<{ status: "done" | "failed"; result: string }>;
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
  const res = await fetch(cred.url + path, {
    method, redirect: "error",
    headers: { "content-type": "application/json", authorization: "Bearer " + cred.token },
    body: JSON.stringify(body),
    signal: signal ?? AbortSignal.timeout(35_000),
  });
  if (res.status === 204) return { empty: true, status: 204 };
  const result = await res.json() as any;
  return { ...result, status: res.status, retry_after: Number(res.headers.get("retry-after") ?? result.retry_after ?? 0) };
}

export const harmlessExecutor: NodeExecutor = async (job) => ({
  status: "done",
  result: `harmless:${job?.node_spec?.kind ?? "node"}`,
});

export function defaultInventoryProbe(): unknown {
  return {
    protocol_version: 1, daemon_version: "0.1.0", os: platform(), arch: arch(),
    labels: [], supported_operation_kinds: ["run-script", "launch-agent", "provision", "install-harness"],
    approved_workspace_ids: [], max_concurrency: 1, current_slots: 0,
    harnesses: ["claude", "codex", "grok", "agy"].map((id) => ({
      id, version: "unknown", installed: false, auth_status: "unknown", quota: { state: "unknown" },
    })),
  };
}

export async function runNode(opts: {
  dir?: string;
  signal?: AbortSignal;
  executor?: NodeExecutor;
  probe?: NodeProbe;
  heartbeatMs?: number;
  capabilitiesMs?: number;
  sleep?: typeof sleepSignal;
} = {}) {
  const dir = opts.dir ?? nodeStateDirectory();
  const cred = readNodeCredential(dir);
  const release = acquireDaemonLock(dir);
  const sleep = opts.sleep ?? sleepSignal;
  const executor = opts.executor ?? harmlessExecutor;
  const probe = opts.probe ?? defaultInventoryProbe;
  const heartbeatMs = opts.heartbeatMs ?? 15_000;
  const capabilitiesMs = opts.capabilitiesMs ?? 60_000;
  const abort = new AbortController();
  const signal = opts.signal ?? abort.signal;
  const onAbort = () => abort.abort();
  signal.addEventListener("abort", onAbort);
  let session_id = "";
  let capabilities_version = 0;
  let active_job_id: string | undefined;
  let phase: "idle" | "polling" | "running" = "idle";
  const backoff = async (error: any) => {
    const wait = Math.max(1, Math.min(30, Number(error?.retry_after) || 1 + Math.floor(Math.random() * 3)));
    await sleep(wait * 1000, abort.signal);
  };
  try {
    const session = await nodeCall(cred, "/nodes/v1/session", { version: 1 });
    if (session.error || !session.session_id) throw Object.assign(new Error("session denied"), session);
    session_id = session.session_id;
    const beat = async () => {
      while (!abort.signal.aborted) {
        try {
          const result = await nodeCall(cred, "/nodes/v1/heartbeat", { session_id, capabilities_version, active_job_id, phase }, "POST", abort.signal);
          if (result.status === 401) { abort.abort(); return; }
        } catch (error) { if (abort.signal.aborted) return; await backoff(error); }
        await sleep(heartbeatMs, abort.signal).catch(() => undefined);
      }
    };
    const caps = async () => {
      while (!abort.signal.aborted) {
        try {
          const inventory = await Promise.race([
            Promise.resolve(probe()),
            sleep(5_000, abort.signal).then(() => { throw Object.assign(new Error("probe timeout"), { timeout: true }); }),
          ]);
          capabilities_version += 1;
          const result = await nodeCall(cred, "/nodes/v1/capabilities", { session_id, version: capabilities_version, inventory }, "PUT", abort.signal);
          if (result.status === 401) { abort.abort(); return; }
        } catch (error) { if (abort.signal.aborted) return; await backoff(error); }
        await sleep(capabilitiesMs, abort.signal).catch(() => undefined);
      }
    };
    const work = async () => {
      while (!abort.signal.aborted) {
        try {
          phase = "polling";
          const job = await nodeCall(cred, "/nodes/v1/poll", { session_id, wait_seconds: 25 }, "POST", abort.signal);
          if (job.status === 401) { abort.abort(); return; }
          if (job.empty || job.status === 204 || !job.id) { phase = "idle"; continue; }
          active_job_id = job.id;
          phase = "running";
          const finished = await executor(job);
          await nodeCall(cred, `/nodes/v1/jobs/${job.id}/finish`, {
            session_id, lease_token: job.lease_token, status: finished.status, result: finished.result,
          });
        } catch (error) {
          if (abort.signal.aborted) return;
          await backoff(error);
        } finally {
          active_job_id = undefined;
          phase = "idle";
        }
      }
    };
    await Promise.all([beat(), caps(), work()]);
  } finally {
    signal.removeEventListener("abort", onAbort);
    release();
  }
}
