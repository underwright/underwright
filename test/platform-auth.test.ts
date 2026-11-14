import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFileSync, rmSync } from "node:fs";
import { once } from "node:events";
import { request } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SqliteStore } from "../src/store.js";
import { serveHttp } from "../src/server.js";
import { handleDashboardRequest } from "../src/dashboard.js";
import { databricksAuth, forwardedPrincipal, parseHttpAddr, principalAllowed } from "../src/platform-auth.js";
import { getAuthPolicy } from "../src/policy.js";
import { currentPrincipal, runAsPrincipal, withPrincipal } from "../src/principal.js";

const DB = "/tmp/uw-test-platform-auth.db";
const wipe = () => { for (const s of ["", "-wal", "-shm"]) rmSync(`${DB}${s}`, { force: true }); };
const DATABRICKS = { mode: "databricks" as const, allowed_users: [] as string[] };
const USER = { "x-forwarded-email": "ada@example.com", "x-forwarded-user": "1234@5678", "x-forwarded-access-token": "dapi-secret" };

beforeEach(() => { wipe(); process.env.UNDERWRIGHT_POLICY = "/tmp/uw-no-policy.json"; });
afterEach(wipe);

describe("auth policy", () => {
  it("defaults to token mode; env overrides policy; unknown modes fail loudly", () => {
    expect(getAuthPolicy({ dod: {}, enforcement: "warn" }, {})).toEqual({ mode: "token", allowed_users: [] });
    expect(getAuthPolicy({ dod: {}, enforcement: "warn", auth: { mode: "databricks", allowed_users: [" Ada@Example.com ", "@corp.io", ""] } }, {}))
      .toEqual({ mode: "databricks", allowed_users: ["ada@example.com", "@corp.io"] });
    expect(getAuthPolicy({ dod: {}, enforcement: "warn" }, { UNDERWRIGHT_AUTH_MODE: "Databricks" }).mode).toBe("databricks");
    expect(() => getAuthPolicy({ dod: {}, enforcement: "warn" }, { UNDERWRIGHT_AUTH_MODE: "oidc" })).toThrow(/unknown auth mode/);
  });
});

describe("forwarded identity", () => {
  it("prefers email, falls back to preferred username then user id", () => {
    expect(forwardedPrincipal(USER)).toBe("ada@example.com");
    expect(forwardedPrincipal({ "x-forwarded-preferred-username": "ada", "x-forwarded-user": "1@2" })).toBe("ada");
    expect(forwardedPrincipal({ "x-forwarded-user": " 1@2 " })).toBe("1@2");
    expect(forwardedPrincipal({})).toBeUndefined();
  });

  it("rejects control characters and oversized values", () => {
    expect(forwardedPrincipal({ "x-forwarded-email": "a@b\nX-Evil: 1" })).toBeUndefined();
    expect(forwardedPrincipal({ "x-forwarded-email": "a".repeat(201) })).toBeUndefined();
  });

  it("allow-list matches exact emails and @domain suffixes case-insensitively", () => {
    expect(principalAllowed("anyone@x.io", [])).toBe(true);
    expect(principalAllowed("Ada@Example.com", ["ada@example.com"])).toBe(true);
    expect(principalAllowed("bob@corp.io", ["@corp.io"])).toBe(true);
    expect(principalAllowed("bob@evilcorp.io.attacker", ["@corp.io"])).toBe(false);
    expect(principalAllowed("eve@example.com", ["ada@example.com", "@corp.io"])).toBe(false);
  });

  it("databricksAuth: 401 without identity, 403 outside allow-list, bearer machine path", () => {
    expect(databricksAuth(DATABRICKS, undefined, {})).toMatchObject({ ok: false, status: 401 });
    expect(databricksAuth({ ...DATABRICKS, allowed_users: ["@corp.io"] }, undefined, USER)).toMatchObject({ ok: false, status: 403 });
    expect(databricksAuth(DATABRICKS, undefined, USER)).toEqual({ ok: true, via: "databricks", principal: "ada@example.com" });
    expect(databricksAuth(DATABRICKS, "tok", { authorization: "Bearer tok" })).toEqual({ ok: true, via: "bearer" });
    expect(databricksAuth(DATABRICKS, "tok", { authorization: "Bearer nope" })).toMatchObject({ ok: false, status: 401 });
  });
});

describe("principal context", () => {
  it("scopes the principal to the async call and stamps audit payloads", async () => {
    expect(currentPrincipal()).toBeUndefined();
    expect(withPrincipal({ a: 1 })).toEqual({ a: 1 });
    await runAsPrincipal("ada@example.com", async () => {
      await new Promise(r => setTimeout(r, 1));
      expect(currentPrincipal()).toBe("ada@example.com");
      expect(withPrincipal({ a: 1 })).toEqual({ a: 1, principal: "ada@example.com" });
      expect(withPrincipal("x")).toEqual({ value: "x", principal: "ada@example.com" });
    });
    expect(runAsPrincipal(undefined, () => currentPrincipal())).toBeUndefined();
  });
});

describe("parseHttpAddr", () => {
  it("uses DATABRICKS_APP_PORT when --http gives only a host", () => {
    expect(parseHttpAddr("0.0.0.0", { DATABRICKS_APP_PORT: "8000" })).toEqual({ host: "0.0.0.0", port: 8000 });
    expect(parseHttpAddr("0.0.0.0:9000", { DATABRICKS_APP_PORT: "8000" })).toEqual({ host: "0.0.0.0", port: 9000 });
    expect(parseHttpAddr(undefined, {})).toEqual({ host: "127.0.0.1", port: 8741 });
    expect(parseHttpAddr("0.0.0.0", {})).toEqual({ host: "0.0.0.0", port: 8741 });
    expect(() => parseHttpAddr("h:99999", {})).toThrow(/invalid port/);
  });
});

describe("dashboard with a platform principal", () => {
  it("forces the principal as actor for every mutation", async () => {
    const store = new SqliteStore(DB);
    try {
      const post = (path: string, body: Record<string, string>) =>
        handleDashboardRequest(store, "POST", new URL(path, "http://x"), new URLSearchParams(body), undefined, "ada@example.com");
      const created = await post("/tasks", { title: "t", agent_id: "mallory" });
      const id = created.redirect!.match(/task\/([^?]+)/)![1];
      expect((await store.getTask(id) as any).created_by).toBe("ada@example.com");
      await post(`/task/${id}/claim`, { agent_id: "mallory" });
      expect((await store.getTask(id) as any).claim.agent_id).toBe("ada@example.com");
      await post("/messages", { to_agent: "bot", from_agent: "mallory", body: "hi" });
      expect((await store.inbox("bot", true))[0].from_agent).toBe("ada@example.com");
      const board = await handleDashboardRequest(store, "GET", new URL("http://x/board"), new URLSearchParams(), undefined, "ada@example.com");
      expect(board.html).toContain("signed in as ada@example.com");
      expect(board.html).toContain("/inbox/ada%40example.com");
    } finally { store.close(); }
  });
});

describe("serveHttp in databricks mode", () => {
  it("gates /mcp and the dashboard on forwarded identity and stamps the audit actor", async () => {
    const http = await serveHttp(DB, "127.0.0.1", 0, "machine-token", DATABRICKS);
    const base = `http://127.0.0.1:${(http.address() as any).port}`;
    try {
      expect((await fetch(`${base}/health`)).status).toBe(200);
      expect((await fetch(`${base}/board`)).status).toBe(401);
      expect((await fetch(`${base}/board?token=machine-token`)).status).toBe(401);
      const board = await fetch(`${base}/board`, { headers: USER });
      expect(board.status).toBe(200);
      expect(await board.text()).toContain("signed in as ada@example.com");
      const login = await fetch(`${base}/login`, { headers: USER, redirect: "manual" });
      expect(login.status).toBe(303);
      expect(login.headers.get("set-cookie")).toBeNull();
      const anon = await fetch(`${base}/mcp`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: "{}" });
      expect(anon.status).toBe(401);

      const client = new Client({ name: "t", version: "0" });
      await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: USER } }));
      const res: any = await client.callTool({ name: "create_task", arguments: { title: "via app", created_by: "claude@app" } });
      const task = JSON.parse(res.content[0].text);
      const admin: any = await client.callTool({ name: "list_nodes", arguments: {} });
      expect(admin.content[0].text).toContain("Configure UNDERWRIGHT_TOKEN");
      await client.close();

      const machine = new Client({ name: "m", version: "0" });
      await machine.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { authorization: "Bearer machine-token" } } }));
      const nodes: any = await machine.callTool({ name: "list_nodes", arguments: {} });
      expect(nodes.content[0].text).not.toContain("Configure UNDERWRIGHT_TOKEN");
      await machine.close();

      const store = new SqliteStore(DB);
      try {
        const events = store.auditLog(50).filter((e: any) => e.entity_id === task.id);
        expect(events.length).toBeGreaterThan(0);
        const data = typeof events[0].data === "string" ? JSON.parse(events[0].data) : events[0].data;
        expect(events[0].actor).toBe("claude@app");
        expect(data.principal).toBe("ada@example.com");
        expect(JSON.stringify(events)).not.toContain("dapi-secret");
      } finally { store.close(); }
    } finally {
      const closed = once(http, "close");
      http.close();
      await closed;
    }
  });

  it("dot-segment paths cannot sidestep the gate even with no token configured", async () => {
    const http = await serveHttp(DB, "127.0.0.1", 0, undefined, DATABRICKS);
    const port = (http.address() as any).port;
    const raw = (path: string, headers: Record<string, string> = {}) => new Promise<number>((resolve, reject) => {
      request({ host: "127.0.0.1", port, path, headers }, res => { res.resume(); resolve(res.statusCode!); }).on("error", reject).end();
    });
    try {
      expect(await raw("/x/../board")).toBe(401);
      expect(await raw("/x/../board", USER)).toBe(200);
    } finally {
      const closed = once(http, "close");
      http.close();
      await closed;
    }
  });

  it("token mode ignores forwarded headers entirely", async () => {
    const http = await serveHttp(DB, "127.0.0.1", 0, "machine-token", { mode: "token", allowed_users: [] });
    const base = `http://127.0.0.1:${(http.address() as any).port}`;
    try {
      expect((await fetch(`${base}/board`, { headers: USER })).status).toBe(401);
      expect((await fetch(`${base}/board`, { headers: { authorization: "Bearer machine-token" } })).status).toBe(200);
    } finally {
      const closed = once(http, "close");
      http.close();
      await closed;
    }
  });
});

describe("bundle files", () => {
  it("app.yaml runs the HTTP server in databricks mode with DATABASE_URL from the lakebase resource", () => {
    const app = readFileSync(new URL("../app.yaml", import.meta.url), "utf8");
    expect(app).toContain('command: ["node", "dist/cli.js", "serve", "--http", "0.0.0.0"]');
    expect(app).toMatch(/name: UNDERWRIGHT_AUTH_MODE\s+value: databricks/);
    expect(app).toMatch(/name: DATABASE_URL\s+valueFrom: lakebase-url/);
  });

  it("databricks.yml declares the app with the lakebase-url secret and a Lakebase database resource", () => {
    const bundle = readFileSync(new URL("../databricks.yml", import.meta.url), "utf8");
    expect(bundle).toMatch(/apps:\s+underwright:/);
    expect(bundle).toContain("source_code_path: .");
    expect(bundle).toMatch(/- name: lakebase-url\s[\s\S]*secret:/);
    expect(bundle).toMatch(/database:\s+instance_name: \$\{var\.lakebase_instance\}/);
  });
});
