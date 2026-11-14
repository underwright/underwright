import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, isAbsolute, delimiter } from "node:path";
import type { ExecutorConfig } from "./node-executors.js";

export const DEFAULT_NODE_CONFIG_PATH = join(homedir(), ".config", "underwright", "node-executors.json");

/** Candidate executables per harness id, in preference order. `agent` is Cursor's CLI. */
const HARNESS_BINARIES: Record<string, string[]> = {
  claude: ["claude"],
  codex: ["codex"],
  grok: ["grok"],
  agy: ["agy", "antigravity"],
  kimi: ["kimi"],
  "command-code": ["cmdc", "command-code"],
  cursor: ["agent", "cursor-agent"],
  devin: ["devin"],
  copilot: ["copilot"],
  opencode: ["opencode"],
  pi: ["pi"],
};

/** Args that put each native CLI in single-prompt mode (prompt is appended last). */
const NATIVE_ARGS: Record<string, string[]> = {
  claude: ["-p"],
  grok: ["--single"],
  cursor: ["-p"],
  copilot: ["-p"],
  devin: ["-p"],
};

/** Harnesses with a known-good omnigent invocation when no native CLI is found. */
const OMNI_HARNESSES = ["codex", "kimi", "agy", "command-code", "opencode", "grok", "cursor"];

const KNOWN_SECTIONS = new Set([
  "workspaces", "repositories", "harnesses", "installers", "scripts",
  "inventory", "concurrency", "timeoutMs", "envAllow", "maxOutput",
  "prepareHarnesses",
]);

export interface ConfigIssue {
  level: "error" | "warning";
  section: string;
  id?: string;
  message: string;
}

export interface ConfigReport {
  ok: boolean;
  issues: ConfigIssue[];
}

export const which = (executable: string, pathEnv = process.env.PATH ?? ""): string | null => {
  if (executable === "packaged-install-agents") return executable;
  if (executable.includes("/")) return existsSync(executable) ? executable : null;
  for (const dir of pathEnv.split(delimiter)) {
    if (!dir) continue;
    const full = join(dir, executable);
    try { if (statSync(full).isFile()) return full; } catch { /* keep scanning */ }
  }
  return null;
};

/** Validate an ExecutorConfig against the host it would run on. */
export function validateConfig(config: unknown, pathEnv?: string): ConfigReport {
  const issues: ConfigIssue[] = [];
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    return { ok: false, issues: [{ level: "error", section: "", message: "config must be a JSON object" }] };
  }
  const c = config as ExecutorConfig & Record<string, unknown>;
  const whichHere = (e: string) => which(e, pathEnv);

  for (const key of Object.keys(c)) {
    if (!KNOWN_SECTIONS.has(key)) issues.push({ level: "warning", section: key, message: `unknown top-level key "${key}"` });
  }

  if (!c.workspaces || typeof c.workspaces !== "object" || !Object.keys(c.workspaces).length) {
    issues.push({ level: "error", section: "workspaces", message: "workspaces is required and must be a non-empty object" });
  } else {
    for (const [id, root] of Object.entries(c.workspaces)) {
      if (typeof root !== "string" || !isAbsolute(root)) {
        issues.push({ level: "error", section: "workspaces", id, message: `workspace root must be absolute: ${JSON.stringify(root)}` });
      } else if (!existsSync(root)) {
        issues.push({ level: "error", section: "workspaces", id, message: `workspace path does not exist: ${root}` });
      }
    }
  }

  for (const section of ["harnesses", "scripts", "installers"] as const) {
    const entries = c[section] as Record<string, { executable?: string }> | undefined;
    if (!entries) continue;
    for (const [id, entry] of Object.entries(entries)) {
      if (section === "installers" && entry?.executable === "packaged-install-agents") continue;
      if (!entry || !whichHere(entry.executable ?? "")) {
        issues.push({ level: "error", section, id, message: `executable not found: ${entry?.executable ?? "(missing)"}` });
      }
    }
  }

  if (c.repositories) {
    for (const [id, url] of Object.entries(c.repositories)) {
      if (typeof url !== "string" || !/^(https?:\/\/|git@|ssh:\/\/|file:\/\/)/.test(url)) {
        issues.push({ level: "warning", section: "repositories", id, message: `unusual clone URL: ${JSON.stringify(url)}` });
      }
    }
  }

  if (c.concurrency !== undefined) {
    const n = Math.floor(Number(c.concurrency));
    if (!Number.isFinite(n) || n < 1 || n > 8) {
      issues.push({ level: "warning", section: "concurrency", message: `concurrency ${c.concurrency} will be clamped to [1,8]` });
    }
  }
  if (c.timeoutMs !== undefined && (!Number.isFinite(Number(c.timeoutMs)) || Number(c.timeoutMs) <= 0)) {
    issues.push({ level: "warning", section: "timeoutMs", message: "timeoutMs should be a positive number" });
  }

  const attested = (c.inventory as { harnesses?: { id?: string }[] } | undefined)?.harnesses;
  if (Array.isArray(attested)) {
    for (const h of attested) {
      if (!h?.id) { issues.push({ level: "warning", section: "inventory", message: "attested harness entry missing id" }); continue; }
      if (!(c.harnesses ?? {})[h.id]) {
        issues.push({ level: "warning", section: "inventory", id: h.id, message: `attested harness "${h.id}" is not in harnesses — launch-agent jobs for it will fail` });
      }
    }
  }
  for (const id of Object.keys(c.harnesses ?? {})) {
    if (!attested?.some((h) => h.id === id)) {
      issues.push({ level: "warning", section: "inventory", id, message: `configured harness "${id}" is not attested — run 'node config attest' after verifying its auth` });
    }
  }
  if (attested && !Array.isArray(attested)) {
    issues.push({ level: "warning", section: "inventory", message: "inventory.harnesses should be an array" });
  }

  return { ok: !issues.some((i) => i.level === "error"), issues };
}

/** Probe PATH for known harness CLIs and omni; return a harnesses section. */
export function probeHarnesses(pathEnv = process.env.PATH ?? ""): Record<string, { executable: string; args: string[] }> {
  const found: Record<string, { executable: string; args: string[] }> = {};
  const omni = which("omni", pathEnv);
  for (const [id, bins] of Object.entries(HARNESS_BINARIES)) {
    for (const bin of bins) {
      const exe = which(bin, pathEnv);
      if (!exe) continue;
      // Prefer omnigent for harnesses without a known single-prompt native form.
      if (omni && OMNI_HARNESSES.includes(id) && !NATIVE_ARGS[id]) {
        found[id] = { executable: omni, args: ["run", "--harness", id === "command-code" ? "commandcode" : id, "-p"] };
      } else {
        found[id] = { executable: exe, args: NATIVE_ARGS[id] ?? [] };
      }
      break;
    }
  }
  // Omni can still carry harnesses whose native CLI is absent.
  if (omni) {
    for (const id of OMNI_HARNESSES) {
      if (!found[id]) found[id] = { executable: omni, args: ["run", "--harness", id === "command-code" ? "commandcode" : id, "-p"] };
    }
  }
  return found;
}

/** Scaffold a fresh config for this host. */
export function initConfig(opts: { workspaces?: Record<string, string>; concurrency?: number; pathEnv?: string } = {}): ExecutorConfig {
  const harnesses = probeHarnesses(opts.pathEnv);
  return {
    workspaces: opts.workspaces ?? { home: homedir() },
    scripts: { smoke: { executable: "echo", args: ["node-ok"] } },
    ...(Object.keys(harnesses).length ? { harnesses } : {}),
    concurrency: opts.concurrency ?? 1,
    timeoutMs: 600000,
  };
}

/** Refresh inventory.harnesses from what actually resolves on this host. */
export function attestHarnesses(config: ExecutorConfig, pathEnv = process.env.PATH ?? ""): ExecutorConfig {
  const prior = new Map(
    ((config.inventory as { harnesses?: any[] } | undefined)?.harnesses ?? []).map((h: any) => [h.id, h]),
  );
  const harnesses = Object.entries(config.harnesses ?? {}).map(([id, h]) => {
    const installed = Boolean(h?.executable && which(h.executable, pathEnv));
    const keep = prior.get(id);
    return {
      id,
      version: keep?.version ?? "unknown",
      installed,
      // Preserve an operator-flipped ready state only while the binary still resolves.
      auth_status: installed ? (keep?.auth_status === "ready" ? "ready" : "unknown") : "unknown",
      quota: keep?.quota ?? { state: "unknown" },
    };
  });
  return { ...config, inventory: { ...(config.inventory as object | undefined), harnesses } };
}
