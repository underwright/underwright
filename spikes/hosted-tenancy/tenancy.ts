// SPIKE (gh-30, ADR-0010). Throwaway reference for the hosted control plane:
// control DB schema, workspace-scoped tokens, and a tenant router that maps a
// token to an UNMODIFIED OSS SqliteStore per workspace. Not built, not
// published, must not be imported from src/. Production code belongs in the
// private underwright-pro repo (docs/gtm.md, COMMERCIAL.md).

import Database from "better-sqlite3";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { SqliteStore } from "../../src/store.js";
import { runAsPrincipal } from "../../src/principal.js";
import type { IStore } from "../../src/istore.js";

export const CONTROL_SCHEMA = `
CREATE TABLE IF NOT EXISTS tenants (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  plan       TEXT NOT NULL DEFAULT 'team' CHECK (plan IN ('team','enterprise')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS workspaces (
  id         TEXT PRIMARY KEY,
  tenant_id  TEXT NOT NULL REFERENCES tenants(id),
  slug       TEXT NOT NULL,
  store_ref  TEXT NOT NULL,          -- sqlite path (spike) | pg schema name (hosted)
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (tenant_id, slug)
);
CREATE TABLE IF NOT EXISTS workspace_tokens (
  id           TEXT PRIMARY KEY,     -- public lookup key embedded in the token
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  secret_hash  TEXT NOT NULL,        -- sha256(secret) hex; plaintext never stored
  scope        TEXT NOT NULL CHECK (scope IN ('read','agent','admin')),
  label        TEXT NOT NULL DEFAULT '',
  expires_at   TEXT,
  revoked_at   TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS workspace_tokens_ws ON workspace_tokens(workspace_id);
`;

export type Scope = "read" | "agent" | "admin";
export interface Resolved { workspace_id: string; tenant_id: string; scope: Scope; principal: string }
export type ResolveResult = ({ ok: true } & Resolved) | { ok: false; status: 401; error: string };

const TOKEN_RE = /^uwws_([0-9a-f]{32})_([A-Za-z0-9_-]{43})$/;
const sha256 = (s: string) => createHash("sha256").update(s).digest();

/** IStore methods a `read` token may call. Everything else is a mutation.
 *  `digest` is excluded: with `to_agent` it sends mail. */
const READ_METHODS = new Set([
  "board", "getTask", "listTasks", "listArtifacts", "getEvidence", "searchContext",
  "auditLog", "taskEvents", "agentEvents", "dashboard", "getJob", "listTemplates", "checkLocks",
]);
/** Administrator-only methods (mirrors the OSS administrator-only node tools). */
const ADMIN_METHODS = new Set(["approveNodeEnrollment", "rejectNodeEnrollment", "revokeNode", "listNodes", "listNodeEnrollments"]);
/** Never callable through the router: lifecycle and raw audit writes belong to the hosted layer. */
const ROUTER_ONLY = new Set(["close", "log"]);
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

export class ControlPlane {
  readonly db: Database.Database;
  private pool = new Map<string, IStore>();

  constructor(path: string, private dataDir: string, private poolMax = 64) {
    if (!Number.isInteger(poolMax) || poolMax < 1) throw new Error("poolMax must be >= 1");
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.db.exec(CONTROL_SCHEMA);
  }

  createTenant(name: string, plan: "team" | "enterprise" = "team"): string {
    const id = `ten_${randomUUID().replace(/-/g, "")}`;
    this.db.prepare("INSERT INTO tenants (id, name, plan) VALUES (?,?,?)").run(id, name, plan);
    return id;
  }

  /** New workspace with a fresh store, or adopt an existing self-hosted SQLite file as-is. */
  createWorkspace(tenantId: string, slug: string, adoptStoreRef?: string): string {
    if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(slug)) throw new Error("invalid workspace slug");
    const id = `ws_${randomUUID().replace(/-/g, "")}`;
    const storeRef = adoptStoreRef ?? join(this.dataDir, `${id}.db`);
    this.db.prepare("INSERT INTO workspaces (id, tenant_id, slug, store_ref) VALUES (?,?,?,?)").run(id, tenantId, slug, storeRef);
    return id;
  }

  /** Returns the plaintext token exactly once. */
  issueToken(workspaceId: string, scope: Scope, opts: { label?: string; expiresAt?: string } = {}): string {
    // Unparseable expiry would compare as Invalid Date and never expire; require explicit ISO-8601 UTC.
    if (opts.expiresAt !== undefined && (!ISO_UTC.test(opts.expiresAt) || isNaN(Date.parse(opts.expiresAt)))) {
      throw new Error("expiresAt must be ISO-8601 UTC, e.g. 2027-01-01T00:00:00Z");
    }
    const id = randomBytes(16).toString("hex");
    const secret = randomBytes(32).toString("base64url");
    this.db.prepare(`INSERT INTO workspace_tokens (id, workspace_id, secret_hash, scope, label, expires_at)
      VALUES (?,?,?,?,?,?)`).run(id, workspaceId, sha256(secret).toString("hex"), scope, opts.label ?? "", opts.expiresAt ?? null);
    return `uwws_${id}_${secret}`;
  }

  revokeToken(tokenId: string): void {
    this.db.prepare("UPDATE workspace_tokens SET revoked_at = datetime('now') WHERE id = ? AND revoked_at IS NULL").run(tokenId);
  }

  /** Stateless: every call hits the control DB, so revocation is immediate. */
  resolve(authorization: string | undefined, now = new Date()): ResolveResult {
    const deny = (error: string): ResolveResult => ({ ok: false, status: 401, error });
    const m = authorization?.startsWith("Bearer ") ? TOKEN_RE.exec(authorization.slice(7)) : null;
    if (!m) return deny("missing or malformed workspace token");
    const row = this.db.prepare(`SELECT t.*, w.tenant_id FROM workspace_tokens t
      JOIN workspaces w ON w.id = t.workspace_id WHERE t.id = ?`).get(m[1]) as any;
    // Hash comparison runs even for unknown ids so timing does not reveal which ids exist.
    const expected = row ? Buffer.from(row.secret_hash, "hex") : sha256("\0no-such-token");
    const match = timingSafeEqual(sha256(m[2]), expected);
    if (!row || !match) return deny("invalid token");
    if (row.revoked_at) return deny("token revoked");
    if (row.expires_at && new Date(row.expires_at) <= now) return deny("token expired");
    return { ok: true, workspace_id: row.workspace_id, tenant_id: row.tenant_id, scope: row.scope, principal: `token:${row.id}` };
  }

  /** The workspace's unmodified OSS store, from a bounded LRU pool. */
  storeFor(workspaceId: string): IStore {
    const hit = this.pool.get(workspaceId);
    if (hit) { this.pool.delete(workspaceId); this.pool.set(workspaceId, hit); return hit; }
    const ws = this.db.prepare("SELECT store_ref FROM workspaces WHERE id = ?").get(workspaceId) as any;
    if (!ws) throw new Error(`unknown workspace ${workspaceId}`);
    const store = new SqliteStore(ws.store_ref);
    this.pool.set(workspaceId, store);
    if (this.pool.size > this.poolMax) {
      const [oldId, old] = this.pool.entries().next().value as [string, IStore];
      this.pool.delete(oldId);
      void old.close();
    }
    return store;
  }

  /** Router entry point: resolve → scope check → run against the tenant's store as the token principal.
   *  The hosted server would do this once per HTTP request and hand the store to createServer(). */
  async call(authorization: string | undefined, method: keyof IStore, ...args: unknown[]): Promise<any> {
    const r = this.resolve(authorization);
    if (!r.ok) throw Object.assign(new Error(r.error), { status: r.status });
    const m = method as string;
    const forbidden = ROUTER_ONLY.has(m)
      || (r.scope === "read" && !READ_METHODS.has(m))
      || (r.scope !== "admin" && ADMIN_METHODS.has(m));
    if (forbidden) throw Object.assign(new Error(`scope '${r.scope}' cannot call ${m}`), { status: 403 });
    const store = this.storeFor(r.workspace_id);
    return runAsPrincipal(r.principal, () => (store[method] as (...a: unknown[]) => unknown)(...args));
  }

  /** Billing metric derived from each workspace's own audit log (no new OSS instrumentation).
   *  Period is a `YYYY-MM` month. */
  usage(tenantId: string, period: string): { active_agents: number; claimed_tasks: number; by_workspace: Record<string, { active_agents: number; claimed_tasks: number }> } {
    const wss = this.db.prepare("SELECT id, store_ref FROM workspaces WHERE tenant_id = ?").all(tenantId) as any[];
    const agents = new Set<string>();
    let claimed = 0;
    const by_workspace: Record<string, { active_agents: number; claimed_tasks: number }> = {};
    for (const ws of wss) {
      // A workspace that was created but never opened has no store file yet: zero usage, not an error.
      if (!existsSync(ws.store_ref)) { by_workspace[ws.id] = { active_agents: 0, claimed_tasks: 0 }; continue; }
      const db = new Database(ws.store_ref, { readonly: true, fileMustExist: true });
      try {
        const rows = db.prepare(`SELECT actor, entity_id FROM events
          WHERE entity_type = 'task' AND action = 'claimed' AND strftime('%Y-%m', created_at) = ?`).all(period) as any[];
        const wsAgents = new Set(rows.map(r => r.actor));
        // Agent identity is per workspace: the same agent_id in two workspaces bills as two active agents.
        for (const a of wsAgents) agents.add(`${ws.id}:${a}`);
        const wsClaimed = new Set(rows.map(r => r.entity_id)).size;
        claimed += wsClaimed;
        by_workspace[ws.id] = { active_agents: wsAgents.size, claimed_tasks: wsClaimed };
      } finally { db.close(); }
    }
    return { active_agents: agents.size, claimed_tasks: claimed, by_workspace };
  }

  async close(): Promise<void> {
    for (const s of this.pool.values()) await s.close();
    this.pool.clear();
    this.db.close();
  }
}
