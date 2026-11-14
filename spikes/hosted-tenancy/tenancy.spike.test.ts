// SPIKE test (gh-30, ADR-0010). Runs under `npm test` via vitest's default include.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteStore } from "../../src/store.js";
import { ControlPlane } from "./tenancy.js";

let dir: string;
let cp: ControlPlane;
let tenant: string;
let wsA: string;
let wsB: string;
const bearer = (t: string) => `Bearer ${t}`;
const tokenId = (t: string) => t.split("_")[1];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "uw-spike-tenancy-"));
  cp = new ControlPlane(join(dir, "control.db"), dir);
  tenant = cp.createTenant("acme");
  wsA = cp.createWorkspace(tenant, "web");
  wsB = cp.createWorkspace(tenant, "api");
});
afterEach(async () => { await cp.close(); rmSync(dir, { recursive: true, force: true }); });

describe("hosted tenancy spike: database-per-workspace", () => {
  it("isolates boards and audit logs between workspaces of one tenant", async () => {
    const a = bearer(cp.issueToken(wsA, "agent"));
    const b = bearer(cp.issueToken(wsB, "agent"));
    const t = await cp.call(a, "createTask", { title: "only in A", created_by: "claude@x" });
    expect((await cp.call(a, "listTasks")).map((x: any) => x.title)).toEqual(["only in A"]);
    expect(await cp.call(b, "listTasks")).toEqual([]);
    expect(await cp.call(b, "getTask", t.id)).toBeFalsy();
    expect((await cp.call(b, "auditLog", 100)).some((e: any) => e.entity_id === t.id)).toBe(false);
  });

  it("stamps the token principal on the workspace audit log", async () => {
    const tok = cp.issueToken(wsA, "agent");
    const t = await cp.call(bearer(tok), "createTask", { title: "x", created_by: "claude@x" });
    const ev = (await cp.call(bearer(tok), "taskEvents", t.id)) as any[];
    expect(ev.length).toBeGreaterThan(0);
    expect(JSON.parse(ev[0].data).principal).toBe(`token:${tokenId(tok)}`);
  });
});

describe("hosted tenancy spike: workspace-scoped tokens", () => {
  it("never stores the plaintext secret", () => {
    const tok = cp.issueToken(wsA, "agent");
    const secret = tok.split("_").slice(2).join("_");
    expect(tok).toMatch(/^uwws_[0-9a-f]{32}_[A-Za-z0-9_-]{43}$/);
    const row = cp.db.prepare("SELECT * FROM workspace_tokens WHERE id = ?").get(tokenId(tok)) as any;
    expect(JSON.stringify(row)).not.toContain(secret);
    // WAL mode: fresh rows live in -wal until checkpoint, so scan both files (the hash must be present to prove the scan works).
    const onDisk = Buffer.concat(["control.db", "control.db-wal"].filter(f => existsSync(join(dir, f))).map(f => readFileSync(join(dir, f))));
    expect(onDisk.includes(Buffer.from(row.secret_hash))).toBe(true);
    expect(onDisk.includes(Buffer.from(secret))).toBe(false);
  });

  it("rejects missing, malformed, unknown, wrong-secret, expired and revoked tokens", () => {
    const good = cp.issueToken(wsA, "agent");
    expect(cp.resolve(bearer(good))).toMatchObject({ ok: true, workspace_id: wsA, tenant_id: tenant, scope: "agent" });
    expect(cp.resolve(undefined)).toMatchObject({ ok: false, status: 401 });
    expect(cp.resolve("Bearer nope")).toMatchObject({ ok: false });
    expect(cp.resolve(good)).toMatchObject({ ok: false }); // no Bearer prefix
    const wrongSecret = good.slice(0, -4) + (good.endsWith("AAAA") ? "BBBB" : "AAAA");
    expect(cp.resolve(bearer(wrongSecret))).toMatchObject({ ok: false, error: "invalid token" });
    const unknownId = `uwws_${"0".repeat(32)}_${good.split("_").slice(2).join("_")}`;
    expect(cp.resolve(bearer(unknownId))).toMatchObject({ ok: false, error: "invalid token" });

    const exp = cp.issueToken(wsA, "agent", { expiresAt: "2020-01-01T00:00:00Z" });
    expect(cp.resolve(bearer(exp))).toMatchObject({ ok: false, error: "token expired" });

    cp.revokeToken(tokenId(good));
    expect(cp.resolve(bearer(good))).toMatchObject({ ok: false, error: "token revoked" });
  });

  it("binds a token to exactly one workspace: A's token cannot reach B", async () => {
    const a = bearer(cp.issueToken(wsA, "admin"));
    const b = bearer(cp.issueToken(wsB, "agent"));
    const tb = await cp.call(b, "createTask", { title: "B secret", created_by: "claude@x" });
    // No API takes a workspace id from the caller; the token alone selects the store.
    expect(await cp.call(a, "getTask", tb.id)).toBeFalsy();
    expect(await cp.call(a, "claimTask", tb.id, "claude@x")).toEqual({ error: `task ${tb.id} not found` });
    expect((await cp.call(b, "getTask", tb.id)).status).toBe("open");
  });

  it("revocation takes effect on the very next call", async () => {
    const tok = cp.issueToken(wsA, "agent");
    await cp.call(bearer(tok), "board");
    cp.revokeToken(tokenId(tok));
    await expect(cp.call(bearer(tok), "board")).rejects.toMatchObject({ status: 401 });
  });

  it("read scope can read but not mutate; agent scope can mutate", async () => {
    const ro = bearer(cp.issueToken(wsA, "read"));
    const rw = bearer(cp.issueToken(wsA, "agent"));
    await expect(cp.call(ro, "createTask", { title: "nope" })).rejects.toMatchObject({ status: 403 });
    const t = await cp.call(rw, "createTask", { title: "ok", created_by: "claude@x" });
    expect((await cp.call(ro, "getTask", t.id)).title).toBe("ok");
    await expect(cp.call(ro, "claimTask", t.id, "claude@x")).rejects.toMatchObject({ status: 403 });
    // digest can send mail (to_agent), so it is not a read.
    await expect(cp.call(ro, "digest", { to_agent: "victim" })).rejects.toMatchObject({ status: 403 });
    expect(await cp.call(rw, "inbox", "victim")).toEqual([]);
  });

  it("admin-only methods need admin scope; close/log are never routable", async () => {
    const rw = bearer(cp.issueToken(wsA, "agent"));
    const adm = bearer(cp.issueToken(wsA, "admin"));
    await expect(cp.call(rw, "listNodes")).rejects.toMatchObject({ status: 403 });
    await expect(cp.call(rw, "revokeNode", "n1")).rejects.toMatchObject({ status: 403 });
    expect(Array.isArray(await cp.call(adm, "listNodes"))).toBe(true);
    for (const k of [rw, adm]) {
      await expect(cp.call(k, "close")).rejects.toMatchObject({ status: 403 });
      await expect(cp.call(k, "log", "task", "x", "forged", "someone")).rejects.toMatchObject({ status: 403 });
    }
    await cp.call(rw, "board"); // pooled store still open
  });

  it("refuses unparseable or non-UTC expiry instead of issuing a never-expiring token", () => {
    expect(() => cp.issueToken(wsA, "agent", { expiresAt: "next tuesday" })).toThrow(/ISO-8601/);
    expect(() => cp.issueToken(wsA, "agent", { expiresAt: "2027-01-01 00:00:00" })).toThrow(/ISO-8601/);
    const future = cp.issueToken(wsA, "agent", { expiresAt: "2999-01-01T00:00:00Z" });
    expect(cp.resolve(bearer(future))).toMatchObject({ ok: true });
    expect(cp.resolve(bearer(future), new Date("3000-01-01T00:00:00Z"))).toMatchObject({ ok: false, error: "token expired" });
  });
});

describe("hosted tenancy spike: billing boundary + migration", () => {
  it("meters active agents and claimed tasks per tenant from claim audit events", async () => {
    const a = bearer(cp.issueToken(wsA, "agent"));
    const b = bearer(cp.issueToken(wsB, "agent"));
    const t1 = await cp.call(a, "createTask", { title: "1", created_by: "h" });
    const t2 = await cp.call(a, "createTask", { title: "2", created_by: "h" });
    const t3 = await cp.call(b, "createTask", { title: "3", created_by: "h" });
    await cp.call(a, "claimTask", t1.id, "claude@x");
    await cp.call(a, "claimTask", t2.id, "codex@y");
    await cp.call(b, "claimTask", t3.id, "claude@x");
    const period = new Date().toISOString().slice(0, 7);
    const u = cp.usage(tenant, period);
    expect(u.claimed_tasks).toBe(3);
    expect(u.active_agents).toBe(3); // per (workspace, agent_id)
    expect(u.by_workspace[wsA]).toEqual({ active_agents: 2, claimed_tasks: 2 });
    expect(cp.usage(tenant, "1999-01").claimed_tasks).toBe(0);
    const other = cp.createTenant("other");
    expect(cp.usage(other, period)).toMatchObject({ active_agents: 0, claimed_tasks: 0 });
    // A never-opened workspace (no store file yet) does not break the tenant's metering.
    const idle = cp.createWorkspace(tenant, "idle");
    expect(cp.usage(tenant, period)).toMatchObject({ claimed_tasks: 3, by_workspace: { [idle]: { active_agents: 0, claimed_tasks: 0 } } });
  });

  it("adopts a self-hosted SQLite workspace unchanged (migration = copy)", async () => {
    const selfHosted = join(dir, "self-hosted.db");
    const local = new SqliteStore(selfHosted);
    const t = await local.createTask({ title: "from self-hosted", id: "gh-99", ac_ids: ["adr"], created_by: "h" });
    await local.claimTask(t.id, "claude@laptop");
    await local.close();

    const ws = cp.createWorkspace(tenant, "migrated", selfHosted);
    const tok = bearer(cp.issueToken(ws, "agent"));
    const got = await cp.call(tok, "getTask", "gh-99");
    expect(got).toMatchObject({ id: "gh-99", title: "from self-hosted", status: "claimed" });
    expect(got.claim.agent_id).toBe("claude@laptop");
    expect((await cp.call(tok, "auditLog", 100)).length).toBeGreaterThan(0);
  });

  it("bounds the open-store pool", async () => {
    const small = new ControlPlane(join(dir, "c2.db"), dir, 1);
    const t = small.createTenant("t");
    const w1 = small.createWorkspace(t, "one");
    const w2 = small.createWorkspace(t, "two");
    const k1 = bearer(small.issueToken(w1, "agent"));
    const k2 = bearer(small.issueToken(w2, "agent"));
    await small.call(k1, "createTask", { title: "a", created_by: "h" });
    await small.call(k2, "createTask", { title: "b", created_by: "h" }); // evicts w1
    expect((await small.call(k1, "listTasks")).map((x: any) => x.title)).toEqual(["a"]); // reopened from disk
    await small.close();
  });
});
