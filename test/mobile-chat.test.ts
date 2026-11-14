import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { rmSync } from "node:fs";
import { once } from "node:events";
import { SqliteStore } from "../src/store.js";
import {
  renderDashboard, renderChatLog, chatPeers, handleDashboardRequest,
  dashboardAuth, readCookie, sessionCookie, SESSION_COOKIE, MOBILE_CSS,
} from "../src/dashboard.js";
import { serveHttp } from "../src/server.js";

const DB = "/tmp/uw-test-mobile-chat.db";
let store: SqliteStore;

beforeEach(() => {
  for (const suffix of ["", "-wal", "-shm"]) rmSync(`${DB}${suffix}`, { force: true });
  process.env.UNDERWRIGHT_POLICY = "/tmp/uw-no-policy.json";
  store = new SqliteStore(DB);
});
afterEach(() => store.close());

const get = (path: string) => handleDashboardRequest(store, "GET", new URL(path, "http://x"), new URLSearchParams());
const post = (path: string, body: Record<string, string>) =>
  handleDashboardRequest(store, "POST", new URL(path, "http://x"), new URLSearchParams(body));

describe("mobile board", () => {
  it("labels every cell so tables collapse into cards on narrow screens", () => {
    const html = renderDashboard({
      tasks: [{ id: "task-1", title: "Ship", status: "open", priority: 1 }],
      jobs: [{ id: "job-1", type: "test", status: "queued", agent_id: "a", command: "npm test", created_at: "now" }],
    });
    expect(html).toContain('name="viewport" content="width=device-width, initial-scale=1"');
    expect(html).toContain("@media (max-width:720px)");
    expect(html).toContain("td[data-label]::before{content:attr(data-label)");
    expect(html).toContain('<td data-label="Status">open</td>');
    expect(html).toContain('<td data-label="Command" class="cmd">npm test</td>');
    expect(html).toContain('name="theme-color"');
    // every non-empty data cell is labelled
    const cells = html.match(/<td(?![^>]*class="empty")[^>]*>/g) ?? [];
    expect(cells.length).toBeGreaterThan(0);
    for (const c of cells) expect(c).toContain("data-label=");
  });

  it("interactive board and subpages carry the mobile CSS and a chat link", async () => {
    store.createTask({ title: "x", ac_ids: ["a"], type: "triage", estimate: "S" });
    const board = await get("/board");
    expect(board.html).toContain(MOBILE_CSS);
    expect(board.html).toContain('<a href="/chat">chat</a>');
    const chat = await get("/chat");
    expect(chat.html).toContain(MOBILE_CSS);
  });
});

describe("remote chat", () => {
  it("sends as human, lists the thread both ways, and never marks the agent's mail read", async () => {
    const t = store.createTask({ title: "Chatty", ac_ids: ["a"], type: "triage", estimate: "S" });
    store.claimTask(t.id, "claude@box");

    const index = await get("/chat");
    expect(index.html).toContain("/chat/claude%40box");

    const sent = await post("/chat/claude%40box", { me: "human", body: "how is it going?", task_id: t.id });
    expect(sent.redirect).toBe("/chat/claude%40box");
    store.sendMessage("human", "claude@box", "tests green <b>", t.id);
    store.sendMessage("human", "other@box", "unrelated");

    const log = await get("/chat/claude%40box/log");
    expect(log.html).toContain("how is it going?");
    expect(log.html).toContain("tests green &lt;b&gt;");
    expect(log.html).not.toContain("unrelated");
    expect(log.html).toContain('class="msg mine"');
    expect(log.html).toContain('http-equiv="refresh"');
    expect(log.html!.indexOf("how is it going?")).toBeLessThan(log.html!.indexOf("tests green"));

    // the agent still receives the message through its normal inbox
    const inbox = store.inbox("claude@box");
    expect(inbox).toEqual([expect.objectContaining({ from_agent: "human", body: "how is it going?", task_id: t.id })]);

    const page = await get("/chat/claude%40box?task=" + t.id);
    expect(page.html).toContain('<iframe class="chatlog"');
    expect(page.html).toContain('action="/chat/claude%40box"');
    expect(page.html).toContain(`value="${t.id}"`);
  });

  it("conversation() is read-only and bounded", () => {
    for (let i = 0; i < 5; i++) store.sendMessage("a", "b", `m${i}`);
    expect(store.conversation("a", "b", 3).map((m: any) => m.body)).toEqual(["m2", "m3", "m4"]);
    expect(store.inbox("a").length).toBe(5);
  });

  it("supports a custom operator identity and rejects bad input", async () => {
    const r = await post("/chat/agent-x", { me: "alan@phone", body: "hi" });
    expect(r.redirect).toBe("/chat/agent-x?me=alan%40phone");
    expect(store.conversation("alan@phone", "agent-x")).toHaveLength(1);
    expect((await post("/chat/agent-x", { body: "" })).status).toBe(400);
    expect((await post("/chat/%E0%A4%A", { body: "x" })).status).toBe(400);
    expect((await post("/chat/agent-x", { body: "x".repeat(17 * 1024) })).status).toBe(413);
    expect((await get("/chat/open?peer=kimi%40laptop")).redirect).toBe("/chat/kimi%40laptop");
  });

  it("picks peers from claims, locks, jobs and events, excluding self", () => {
    expect(chatPeers({
      tasks: [{ claimed_by: "a" }, { claimed_by: null }],
      locks: [{ agent_id: "b" }], jobs: [{ agent_id: "a" }],
      events: [{ actor: "human" }, { actor: "c" }],
    }, "human")).toEqual(["a", "b", "c"]);
  });

  it("escapes message bodies and agent ids", () => {
    const html = renderChatLog("human", "<x>", [{ from_agent: "<x>", body: "<script>1</script>", created_at: "t" }]);
    expect(html).not.toContain("<script>1</script>");
    expect(html).toContain("&lt;script&gt;");
  });
});

describe("remote reach auth", () => {
  const url = (q = "") => new URL(`/board${q}`, "http://x");
  it("accepts bearer, query token and session cookie; rejects wrong values", () => {
    expect(dashboardAuth(undefined, {}, url()).ok).toBe(true);
    expect(dashboardAuth("s3cret", { authorization: "Bearer s3cret" }, url()).via).toBe("bearer");
    expect(dashboardAuth("s3cret", {}, url("?token=s3cret")).via).toBe("query");
    expect(dashboardAuth("s3cret", { cookie: `a=1; ${SESSION_COOKIE}=s3cret` }, url()).via).toBe("cookie");
    expect(dashboardAuth("s3cret", { cookie: `${SESSION_COOKIE}=nope` }, url("?token=bad")).ok).toBe(false);
  });

  it("session cookie is HttpOnly + SameSite=Strict, Secure behind HTTPS", () => {
    expect(sessionCookie("t", false)).toMatch(/HttpOnly; SameSite=Strict; Max-Age=\d+$/);
    expect(sessionCookie("t", true)).toMatch(/; Secure$/);
    expect(readCookie("x=1; uw_token=a%20b", "uw_token")).toBe("a b");
  });

  it("serveHttp: /login trades the token for a cookie that then authorizes chat", async () => {
    const http = await serveHttp("/tmp/uw-test-mobile-chat-http.db", "127.0.0.1", 0, "phone-token");
    try {
      const port = (http.address() as any).port;
      const base = `http://127.0.0.1:${port}`;
      expect((await fetch(`${base}/chat`)).status).toBe(401);
      const login = await fetch(`${base}/login?token=phone-token`, { redirect: "manual", headers: { "x-forwarded-proto": "https" } });
      expect(login.status).toBe(303);
      expect(login.headers.get("location")).toBe("/board");
      const cookie = login.headers.get("set-cookie")!;
      expect(cookie).toContain("HttpOnly");
      expect(cookie).toContain("Secure");
      const jar = cookie.split(";")[0];
      const chat = await fetch(`${base}/chat`, { headers: { cookie: jar } });
      expect(chat.status).toBe(200);
      const sent = await fetch(`${base}/chat/agent-z`, {
        method: "POST", redirect: "manual",
        headers: { cookie: jar, "content-type": "application/x-www-form-urlencoded" },
        body: "body=ping",
      });
      expect(sent.status).toBe(303);
      expect((await fetch(`${base}/login?token=wrong`, { redirect: "manual" })).status).toBe(401);
      const logout = await fetch(`${base}/logout`, { redirect: "manual" });
      expect(logout.headers.get("set-cookie")).toContain("Max-Age=0");
    } finally {
      const closed = once(http, "close");
      http.close();
      await closed;
      for (const s of ["", "-wal", "-shm"]) rmSync(`/tmp/uw-test-mobile-chat-http.db${s}`, { force: true });
    }
  });
});
