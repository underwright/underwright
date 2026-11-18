import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

export const CATALOG_HARNESSES = ["codex", "claude", "kimi", "grok", "cursor", "cmdc"] as const;
export type CatalogHarness = typeof CATALOG_HARNESSES[number];
export interface CatalogResult { harness: string; models: string[]; error?: string; excluded?: boolean }
export interface CatalogDiff extends CatalogResult { added: string[]; removed: string[]; unassigned: string[] }
const run = promisify(execFile);

/** Catalog formats are deliberately strict: help text is never a model list. */
export function parseCatalog(output: string): string[] {
  const clean = output.replace(/\x1b\[[0-9;]*m/g, "").trim();
  let ids: unknown[];
  try {
    const json = JSON.parse(clean);
    const rows = Array.isArray(json) ? json : json.data ?? json.models;
    if (!Array.isArray(rows)) throw new Error("no model array");
    ids = rows.map((r: unknown) => typeof r === "string" ? r : (r as { id?: string; model?: string }).id ?? (r as {model?: string}).model);
  } catch {
    ids = clean.split("\n").map(line => line.trim().replace(/^[-*•>]\s+/, "").split(/\s+/)[0])
      .filter(id => /[-._/0-9]/.test(id) || ["auto", "haiku", "sonnet", "opus"].includes(id));
  }
  const models = [...new Set(ids.filter((id): id is string => typeof id === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/.test(id)))].sort();
  if (!models.length) throw new Error("catalog contained no recognizable model IDs");
  return models;
}

export function diffCatalog(result: CatalogResult, assigned: Record<string, string> = {}): CatalogDiff {
  const configured = [...new Set(Object.values(assigned))].sort();
  const added = result.error || result.excluded ? [] : result.models.filter(id => !configured.includes(id));
  return { ...result, added, removed: result.error || result.excluded ? [] : configured.filter(id => !result.models.includes(id)), unassigned: [...added] };
}

async function apiCatalog(harness: "claude" | "kimi"): Promise<string[]> {
  const key = process.env[harness === "claude" ? "ANTHROPIC_API_KEY" : "KIMI_API_KEY"];
  if (!key) throw new Error(`missing ${harness === "claude" ? "ANTHROPIC_API_KEY" : "KIMI_API_KEY"}; catalog unavailable`);
  const headers: Record<string, string> = harness === "claude" ? { "x-api-key": key, "anthropic-version": "2023-06-01" } : { authorization: `Bearer ${key}` };
  const base = harness === "claude" ? "https://api.anthropic.com/v1/models" : "https://api.moonshot.ai/v1/models";
  const models: string[] = [];
  let after: string | undefined;
  const seen = new Set<string>();
  const signal = AbortSignal.timeout(20_000);
  for (let page = 0; page < 100; page++) {
    const url = new URL(base);
    if (after) url.searchParams.set("after_id", after);
    const response = await fetch(url, { headers, signal });
    if (!response.ok) throw new Error(`catalog HTTP ${response.status}`);
    const json = await response.json() as { has_more?: boolean; last_id?: string };
    models.push(...parseCatalog(JSON.stringify(json)));
    if (!json.has_more) return [...new Set(models)].sort();
    if (harness !== "claude" || !json.last_id || seen.has(json.last_id)) throw new Error("catalog pagination did not advance");
    after = json.last_id;
    seen.add(after);
  }
  throw new Error("catalog exceeded pagination limit");
}

/** App-server model/list uses the authenticated CLI account and refreshes its catalog. */
async function codexCatalog(): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const child = spawn("codex", ["app-server"], { stdio: ["pipe", "pipe", "ignore"] });
    let buffer = "";
    const models: string[] = [];
    const cursors = new Set<string>();
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      if (error) reject(error); else resolve([...new Set(models)].sort());
    };
    const timer = setTimeout(() => finish(new Error("catalog app-server timed out")), 20_000);
    const send = (message: object) => child.stdin.write(JSON.stringify(message) + "\n");
    child.on("error", error => finish(error));
    child.stdin.on("error", error => finish(error));
    child.on("exit", () => finish(new Error("catalog app-server exited before completing model/list")));
    child.stdout.on("data", chunk => {
      buffer += chunk;
      if (buffer.length > 1024 * 1024) return finish(new Error("catalog app-server output too large"));
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        try {
          const message = JSON.parse(line);
          if (message.error) return finish(new Error("catalog app-server rejected request"));
          if (message.id === 1) {
            send({ method: "initialized", params: {} });
            send({ id: 2, method: "model/list", params: { limit: 100, includeHidden: true } });
          } else if (message.id === 2) {
            models.push(...parseCatalog(JSON.stringify(message.result.data)));
            const cursor = message.result.nextCursor;
            if (cursor) {
              if (cursors.has(cursor) || cursors.size >= 100) return finish(new Error("catalog pagination did not advance"));
              cursors.add(cursor);
              send({ id: 2, method: "model/list", params: { limit: 100, includeHidden: true, cursor } });
            } else finish();
          }
        } catch { finish(new Error("catalog app-server returned invalid data")); }
      }
    });
    send({ id: 1, method: "initialize", params: { clientInfo: { name: "underwright-model-catalog", version: "1" } } });
  });
}

export async function probeCatalog(harness: CatalogHarness): Promise<CatalogResult> {
  try {
    let models: string[];
    if (harness === "claude" || harness === "kimi") models = await apiCatalog(harness);
    else if (harness === "codex") {
      models = await codexCatalog();
    } else {
      const [executable, args]: [string, string[]] = harness === "cursor" ? ["agent", ["--list-models"]] : harness === "cmdc" ? ["cmdc", ["--list-models"]] : ["grok", ["models"]];
      const { stdout } = await run(executable, args, { timeout: 20_000, maxBuffer: 1024 * 1024, env: { ...process.env, NO_COLOR: "1", CI: "1" } });
      models = parseCatalog(stdout);
    }
    if (harness === "claude") {
      // Claude Code accepts these documented family aliases as model selectors.
      models = [...models, ...["haiku", "sonnet", "opus"].filter(alias => models.some(id => id.startsWith(`claude-${alias}-`)))].sort();
    }
    return { harness, models };
  } catch (error) {
    // Do not include CLI stderr or credentials in published artifacts.
    return { harness, models: [], error: error instanceof Error && /^(missing |catalog |paginated |Codex )/.test(error.message) ? error.message : "catalog probe failed; check CLI installation, authentication and noninteractive support" };
  }
}

export async function refreshCatalog(table: Record<string, Record<string, string>>, harness?: string): Promise<CatalogDiff[]> {
  if (harness && !(CATALOG_HARNESSES as readonly string[]).includes(harness) && harness !== "devin") throw new Error(`unknown harness: ${harness}`);
  const selected = harness === "devin" ? [] : harness ? [harness as CatalogHarness] : [...CATALOG_HARNESSES];
  const results = await Promise.all(selected.map(probeCatalog));
  const diffs = results.map(result => diffCatalog(result, table[result.harness] ?? (result.harness === "cmdc" ? table["command-code"] : undefined) ?? table["*"]));
  if (!harness || harness === "devin") diffs.push(diffCatalog({ harness: "devin", models: ["adaptive"], excluded: true }));
  return diffs;
}
