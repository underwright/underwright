import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { realpath } from 'node:fs/promises';

const ALLOW = ['mcp__underwright__*', 'Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep'];
type JsonObject = Record<string, any>;
function object(value: unknown, label: string): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as JsonObject;
}
async function readObject(path: string): Promise<JsonObject> {
  try { return object(JSON.parse(await readFile(path, 'utf8')), path); }
  catch (error: any) { if (error.code === 'ENOENT') return {}; throw error; }
}
async function replace(path: string, value: JsonObject) {
  const content = JSON.stringify(value, null, 2) + '\n';
  try { if (await readFile(path, 'utf8') === content) return; }
  catch (error: any) { if (error.code !== 'ENOENT') throw error; }
  await mkdir(dirname(path), { recursive: true });
  let mode = 0o600;
  try { mode = (await stat(path)).mode & 0o777; }
  catch (error: any) { if (error.code !== 'ENOENT') throw error; }
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, content, { flag: 'wx', mode });
    await rename(temp, path);
  } finally { await rm(temp, { force: true }); }
}

/** Prepare an operator-approved Claude launch, preserving unrelated settings and
 * explicit deny/ask rules. Other harnesses have different configuration formats.
 * A per-home filesystem lock also serializes concurrent node worker processes.
 */
export async function prepareHarnessPermissions(harness: string, workspace: string, home = homedir()): Promise<void> {
  if (!['claude', 'claude-sdk'].includes(harness)) return;
  const root = await realpath(workspace);
  const trustPath = join(resolve(home), '.claude.json');
  const settingsPath = join(root, '.claude', 'settings.json');
  const lock = `${trustPath}.underwright-lock`;
  await mkdir(home, { recursive: true });
  for (let attempt = 0; ; attempt++) {
    try { await mkdir(lock); break; }
    catch (error: any) {
      if (error.code !== 'EEXIST') throw error;
      if (attempt >= 100) throw new Error(`timed out acquiring harness configuration lock: ${lock}`);
      await delay(50);
    }
  }
  try {
    const trust = await readObject(trustPath);
    const settings = await readObject(settingsPath);
    const projects = object(trust.projects ?? {}, 'projects');
    const project = object(Object.hasOwn(projects, root) ? projects[root] : {}, 'project');
    const permissions = object(settings.permissions ?? {}, 'permissions');
    const allow = permissions.allow ?? [];
    if (!Array.isArray(allow) || allow.some(value => typeof value !== 'string')) throw new Error('permissions.allow must be a string array');
    // Validate both files before changing either. Deny/ask retain precedence.
    trust.projects = { ...projects, [root]: { ...project, hasTrustDialogAccepted: true } };
    settings.permissions = { ...permissions, allow: [...new Set([...allow, ...ALLOW])] };
    await replace(trustPath, trust);
    await replace(settingsPath, settings);
  } finally { await rm(lock, { recursive: true, force: true }); }
}
