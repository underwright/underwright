/**
 * Spawned-agent permissions: pre-answer the gates a headless harness would
 * otherwise stop at, per workspace + harness.
 *
 * Claude Code has three:
 *   1. workspace trust   — ~/.claude.json  projects[<dir>].hasTrustDialogAccepted
 *   2. project MCP server — .claude/settings.local.json  enabledMcpjsonServers
 *   3. tool permissions  — .claude/settings.local.json  permissions.allow
 *
 * The allowlist goes to settings.local.json (per-machine, git-ignored by Claude
 * Code), not the committed settings.json, so one node's grants never leak into
 * the repo. Every write merges with existing content, is idempotent, and is
 * atomic (temp file + rename). Unparseable JSON is never overwritten.
 */
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

/** Matches the manual fix: underwright MCP tools plus the core file/shell tools. */
export const DEFAULT_CLAUDE_ALLOW = ["mcp__underwright", "Bash", "Read", "Write", "Edit", "Glob", "Grep"] as const;
export const DEFAULT_MCP_SERVERS = ["underwright"] as const;

export interface HarnessPrepOptions {
  /** Path to Claude's global state file. Default ~/.claude.json. */
  claudeJson?: string;
  /** permissions.allow entries to merge. Default DEFAULT_CLAUDE_ALLOW. */
  allow?: string[];
  /** Project .mcp.json servers to pre-approve. Default ["underwright"]. */
  mcpServers?: string[];
  /** Settings file under <workspace>/.claude/. Default settings.local.json. */
  settingsFile?: "settings.local.json" | "settings.json";
}

export interface HarnessPrepResult {
  harness: string;
  workspace: string;
  supported: boolean;
  trust?: { path: string; changed: boolean };
  allowlist?: { path: string; changed: boolean; added: string[] };
}

class UnparseableJson extends Error {}

function readJson(path: string): Record<string, any> {
  if (!existsSync(path)) return {};
  const raw = readFileSync(path, "utf8");
  if (!raw.trim()) return {};
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new UnparseableJson(`refusing to rewrite unparseable JSON: ${path}`); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new UnparseableJson(`expected a JSON object in ${path}`);
  return parsed as Record<string, any>;
}

function writeJsonAtomic(path: string, value: unknown, defaultMode: number) {
  mkdirSync(dirname(path), { recursive: true });
  let mode = defaultMode;
  try { mode = statSync(path).mode & 0o777; } catch { /* new file */ }
  const tmp = `${path}.uw-${process.pid}-${Date.now()}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n", { mode });
  renameSync(tmp, path);
}

const union = (existing: unknown, add: readonly string[]) => {
  const list = Array.isArray(existing) ? existing.filter((x): x is string => typeof x === "string") : [];
  const added = add.filter((x) => !list.includes(x));
  return { list: [...list, ...added], added };
};

const canonical = (dir: string) => realpathSync(dir);

/** Gate 1: mark the workspace trusted in ~/.claude.json. Preserves every other key. */
export function trustClaudeWorkspace(workspace: string, opts: Pick<HarnessPrepOptions, "claudeJson"> = {}) {
  const path = opts.claudeJson ?? join(homedir(), ".claude.json");
  const dir = canonical(workspace);
  const state = readJson(path);
  const projects = state.projects && typeof state.projects === "object" && !Array.isArray(state.projects) ? state.projects : {};
  const project = projects[dir] && typeof projects[dir] === "object" ? projects[dir] : {};
  if (project.hasTrustDialogAccepted === true) return { path, changed: false };
  state.projects = { ...projects, [dir]: { ...project, hasTrustDialogAccepted: true } };
  writeJsonAtomic(path, state, 0o600);
  return { path, changed: true };
}

/** Gates 2+3: merge MCP server approval and tool allowlist into the workspace settings. */
export function allowClaudeWorkspace(workspace: string, opts: Omit<HarnessPrepOptions, "claudeJson"> = {}) {
  const path = join(canonical(workspace), ".claude", opts.settingsFile ?? "settings.local.json");
  const settings = readJson(path);
  const permissions = settings.permissions && typeof settings.permissions === "object" && !Array.isArray(settings.permissions) ? settings.permissions : {};
  const allow = union(permissions.allow, opts.allow ?? DEFAULT_CLAUDE_ALLOW);
  const servers = union(settings.enabledMcpjsonServers, opts.mcpServers ?? DEFAULT_MCP_SERVERS);
  if (!allow.added.length && !servers.added.length) return { path, changed: false, added: [] as string[] };
  settings.permissions = { ...permissions, allow: allow.list };
  settings.enabledMcpjsonServers = servers.list;
  writeJsonAtomic(path, settings, 0o644);
  return { path, changed: true, added: [...allow.added, ...servers.added.map((s) => `mcp-server:${s}`)] };
}

/** Which harness family an id/executable belongs to; only "claude" needs prep today. */
export function harnessKind(harness: string, executable?: string): string {
  const exe = executable ? basename(executable).replace(/\.(exe|cmd)$/i, "") : "";
  if (harness === "claude" || harness.startsWith("claude@") || harness.startsWith("claude-") || exe === "claude") return "claude";
  return harness;
}

/** Pre-answer every permission gate for `harness` in `workspace`. Unsupported harnesses are a no-op. */
export function prepareHarnessWorkspace(harness: string, workspace: string, opts: HarnessPrepOptions & { executable?: string } = {}): HarnessPrepResult {
  const kind = harnessKind(harness, opts.executable);
  if (kind !== "claude") return { harness, workspace, supported: false };
  return {
    harness, workspace: canonical(workspace), supported: true,
    trust: trustClaudeWorkspace(workspace, opts),
    allowlist: allowClaudeWorkspace(workspace, opts),
  };
}
