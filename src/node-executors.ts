/**
 * Typed executor registry for node task types (gh-57 design, part D).
 * Every operation is a literal argv spawned with shell:false and a sanitized env.
 * Nothing here falls back to legacy shell-command execution. The control-plane
 * link is the injected NodeTransport, so the HTTP client can land independently.
 */
import { spawn } from 'node:child_process';
import { lstatSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { isAbsolute, relative, resolve } from 'node:path';
import { z } from 'zod';
import type { NodePolicy } from './node-protocol.js';

export const NODE_TASK_TYPES = ['launch-agent', 'provision', 'install-harness', 'run-script'] as const;
export type NodeTaskType = (typeof NODE_TASK_TYPES)[number];

export interface NodeTask { id: string; type: NodeTaskType; params: unknown; lease_expires?: string; worker?: Record<string, string> }
export interface NodeResult { status: 'done' | 'failed'; result: string }

/** Injectable transport for single-attempt callers; the daemon owns its HTTP receipt journal. */
export interface NodeTransport {
  poll(): Promise<NodeTask | null>;
  renew(taskId: string, result: string): Promise<{ lease_expires: string } | { error: string }>;
  finish(taskId: string, outcome: NodeResult): Promise<{ error?: string } | void>;
}

/** Locally approved resources: the control plane only ever names ids, never executables or paths. */
export interface ExecutorConfig {
  inventory?: unknown;                                     // operator-approved readiness probe snapshot
  workspaces: Record<string, string>;                       // workspace id -> absolute root
  repositories?: Record<string, string>;                    // repository id -> clone URL
  harnesses?: Record<string, { executable: string; args?: string[] }>;   // launch-agent targets
  installers?: Record<string, { executable: string; args?: string[] }>;  // install-harness targets
  scripts?: Record<string, { executable: string; args?: string[] }>;     // run-script targets
  envAllow?: string[];                                      // extra env names to pass through
  timeoutMs?: number;
  onSpawn?: (pid: number) => void;
  maxOutput?: number;
}

export class PolicyError extends Error {}

const id = z.string().min(1).max(128);
const argv = z.array(z.string().max(4096)).max(64).default([]);
const subdir = z.string().max(512).default('.');
const schemas = {
  'launch-agent': z.object({ workspace_id: id, harness: id, prompt: z.string().min(1).max(32768), cwd: subdir }).strict(),
  provision: z.object({ workspace_id: id, repository_id: id, dest: z.string().min(1).max(512) }).strict(),
  'install-harness': z.object({ harness: id }).strict(),
  'run-script': z.object({ workspace_id: id, script: id, args: argv, cwd: subdir }).strict(),
} as const;

const BASE_ENV = ['PATH', 'HOME', 'LANG', 'TZ', 'TMPDIR'];
export function sanitizedEnv(extra: string[] = [], source: NodeJS.ProcessEnv = process.env) {
  const env: Record<string, string> = {};
  for (const k of [...BASE_ENV, ...extra]) if (!/^UNDERWRIGHT_/.test(k) && source[k] !== undefined) env[k] = source[k]!;
  return env;
}

/** Resolve sub inside root, rejecting traversal and any symlink escape. */
export function containedPath(root: string, sub: string): string {
  const realRoot = realpathSync(root);
  if (isAbsolute(sub)) throw new PolicyError('path must be relative to the workspace');
  const target = resolve(realRoot, sub);
  const rel = relative(realRoot, target);
  if (rel.startsWith('..') || isAbsolute(rel)) throw new PolicyError('path escapes workspace');
  // Walk existing components: any symlink or escaping realpath is refused.
  let cur = realRoot;
  for (const part of rel.split(/[\\/]/).filter(Boolean)) {
    cur = resolve(cur, part);
    let st;
    try { st = lstatSync(cur); } catch (e: any) { if (e.code === 'ENOENT') break; throw e; }
    if (st.isSymbolicLink()) throw new PolicyError('symlinks are not allowed in node paths');
  }
  return target;
}

interface Plan { executable: string; args: string[]; cwd?: string; env?: Record<string, string> }

export function planTask(task: NodeTask, policy: NodePolicy, cfg: ExecutorConfig): Plan {
  if (!policy.allowed_task_types.includes(task.type)) throw new PolicyError(`task type ${task.type} not allowed for this node`);
  const schema = schemas[task.type];
  if (!schema) throw new PolicyError('unknown task type');
  const p: any = schema.parse(task.params);
  const workspace = (wid: string) => {
    if (!policy.workspace_ids.includes(wid)) throw new PolicyError(`workspace ${wid} not approved`);
    const root = cfg.workspaces[wid];
    if (!root) throw new PolicyError(`workspace ${wid} not configured locally`);
    return root;
  };
  const approved = <T>(table: Record<string, T> | undefined, key: string, what: string): T => {
    const v = table && Object.hasOwn(table, key) ? table[key] : undefined;
    if (!v) throw new PolicyError(`${what} ${key} not approved locally`);
    return v;
  };
  switch (task.type) {
    case 'launch-agent': {
      const h = approved(cfg.harnesses, p.harness, 'harness');
      return { executable: h.executable, args: [...(h.args ?? []), p.prompt], cwd: containedPath(workspace(p.workspace_id), p.cwd) };
    }
    case 'provision': {
      if (!(policy.repository_ids ?? []).includes(p.repository_id)) throw new PolicyError(`repository ${p.repository_id} not approved`);
      const url = approved(cfg.repositories, p.repository_id, 'repository');
      const root = workspace(p.workspace_id);
      return { executable: 'git', args: ['clone', '--', url, containedPath(root, p.dest)], cwd: realpathSync(root) };
    }
    case 'install-harness': {
      const i = approved(cfg.installers, p.harness, 'installer');
      if (i.executable === 'packaged-install-agents') {
        if (!['codex', 'claude', 'antigravity', 'kimi', 'opencode', 'command-code', 'cline', 'grok', 'cursor'].includes(p.harness)) throw new PolicyError('unsupported packaged harness');
        return { executable: 'bash', args: [fileURLToPath(new URL('../scripts/install-agents.sh', import.meta.url)), 'install', '--agents', p.harness, '--yes', '--no-open'] };
      }
      return { executable: i.executable, args: [...(i.args ?? [])] };
    }
    case 'run-script': {
      const s = approved(cfg.scripts, p.script, 'script');
      return { executable: s.executable, args: [...(s.args ?? []), ...p.args], cwd: containedPath(workspace(p.workspace_id), p.cwd) };
    }
  }
}

export const redact = (text: string) =>
  text.replace(/uw_(?:node|worker)_[a-f0-9]{16,}/g, '[redacted]')
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+\/=-]{8,}/gi, '$1[redacted]')
    .replace(/\b((?:token|secret|password|api[_-]?key)\s*[=:]\s*)\S+/gi, '$1[redacted]');

/** Run a plan in its own process group; TERM then KILL on timeout/abort. */
export function runPlan(plan: Plan, cfg: ExecutorConfig, signal?: AbortSignal, onOutput?: (s: string) => void): Promise<NodeResult> {
  const max = Math.max(1, Math.min(64000, cfg.maxOutput ?? 64000));
  let out = '';
  const append = (s: string) => {
    // Scrub complete scoped secrets before trimming. The extra tail retains any
    // split credential until its next chunk, even with a tiny output budget.
    out = (out + s).replace(/uw_(?:node|worker)_[a-f0-9]{64}/g, '[redacted]').slice(-Math.max(256, max));
    onOutput?.(redact(s));
  };
  return new Promise(done => {
    if (signal?.aborted) return done({ status: 'failed', result: 'aborted before start' });
    const child = spawn(plan.executable, plan.args, {
      shell: false, cwd: plan.cwd, env: { ...sanitizedEnv(cfg.envAllow), ...plan.env },
      detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'],
    });
    try { if (child.pid) cfg.onSpawn?.(child.pid); }
    catch (error) { if (child.pid) { try { process.platform === 'win32' ? child.kill('SIGKILL') : process.kill(-child.pid, 'SIGKILL'); } catch {} } throw error; }
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', append); child.stderr.on('data', append);
    let stopped = false; let killTimer: ReturnType<typeof setTimeout> | undefined;
    const kill = (sig: NodeJS.Signals) => {
      if (!child.pid) return;
      try { process.platform === 'win32' ? child.kill(sig) : process.kill(-child.pid, sig); } catch (e: any) { if (e.code !== 'ESRCH') throw e; }
    };
    const stop = (why: string) => { if (stopped) return; stopped = true; append(`\n${why}\n`); kill('SIGTERM'); killTimer = setTimeout(() => kill('SIGKILL'), 2000); };
    const onAbort = () => stop('aborted');
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
    const timer = setTimeout(() => stop('timed out'), cfg.timeoutMs ?? 600000);
    const end = (r: NodeResult) => { clearTimeout(timer); if (killTimer) { kill('SIGKILL'); clearTimeout(killTimer); } signal?.removeEventListener('abort', onAbort); done({ status: r.status, result: redact(r.result).slice(-max) }); };
    child.once('error', e => { append(`\n${e.message}\n`); end({ status: 'failed', result: out }); });
    child.once('close', code => end({ status: code === 0 && !stopped ? 'done' : 'failed', result: out }));
  });
}

export interface ExecutorRegistry {
  execute(task: NodeTask, signal?: AbortSignal): Promise<NodeResult>;
  /** Poll once, execute, finish. Returns false when idle. */
  runOnce(transport: NodeTransport, signal?: AbortSignal): Promise<boolean>;
}

export function createExecutorRegistry(policy: NodePolicy, cfg: ExecutorConfig): ExecutorRegistry {
  const execute = async (task: NodeTask, signal?: AbortSignal): Promise<NodeResult> => {
    let plan: Plan;
    try { plan = planTask(task, policy, cfg); }
    catch (e) { return { status: 'failed', result: e instanceof PolicyError ? `denied: ${e.message}` : 'invalid task parameters' }; }
    plan.env = task.worker;
    return runPlan(plan, cfg, signal);
  };
  return {
    execute,
    async runOnce(transport, signal) {
      const task = await transport.poll();
      if (!task) return false;
      const controller = new AbortController();
      const stop = () => controller.abort();
      signal?.addEventListener('abort', stop, { once: true });
      if (signal?.aborted) stop();
      let deadline = task.lease_expires ? Date.parse(task.lease_expires) : undefined;
      let lost = deadline !== undefined && (!Number.isFinite(deadline) || Date.now() >= deadline);
      if (lost) stop();
      let renewing = false;
      let renewal = Promise.resolve();
      const timer = deadline === undefined ? undefined : setInterval(() => {
        if (Date.now() >= deadline!) { lost = true; stop(); }
        if (renewing || controller.signal.aborted) return;
        renewing = true;
        renewal = transport.renew(task.id, '').then(r => {
          if ('error' in r || !Number.isFinite(Date.parse(r.lease_expires))) { lost = true; stop(); }
          else deadline = Date.parse(r.lease_expires);
        }).catch(() => { lost = true; stop(); }).finally(() => { renewing = false; });
      }, 100);
      try {
        const outcome = await execute(task, controller.signal);
        await renewal;
        if (lost) throw new Error('node job lease lost; result not uploaded');
        const receipt = await transport.finish(task.id, outcome);
        if (receipt?.error) throw new Error(receipt.error);
        return true;
      } finally { if (timer) clearInterval(timer); signal?.removeEventListener('abort', stop); }
    },
  };
}
