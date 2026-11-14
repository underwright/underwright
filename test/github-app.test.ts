import { createVerify, generateKeyPairSync } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteStore } from "../src/store.js";
import { dispatchGithubEvent } from "../src/webhook.js";
import { evidencePack as packFromAdapter } from "../src/github.js";
import { evidencePack } from "../src/evidence-pack.js";
import {
  APP_EVENTS,
  appCredsFromEnv,
  appJwt,
  appPublisher,
  commentOnIssue,
  convertManifestCode,
  githubAppManifest,
  handleGithubAppHttp,
  installationToken,
  isGithubAppRequest,
} from "../src/github-app.js";

const DB = "/tmp/uw-test-github-app.db";
let store: SqliteStore;
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PEM = privateKey.export({ type: "pkcs8", format: "pem" }).toString();

type Call = { url: string; init: any };
function stubFetch(responses: Record<string, { status?: number; body: any }>) {
  const calls: Call[] = [];
  const fetchImpl = async (url: string, init?: any) => {
    calls.push({ url, init });
    const key = Object.keys(responses).find((k) => url.endsWith(k));
    const r = key ? responses[key] : { status: 404, body: { message: "Not Found" } };
    const status = r.status ?? 200;
    return {
      ok: status < 300,
      status,
      json: async () => r.body,
      text: async () => JSON.stringify(r.body),
    };
  };
  return { calls, fetchImpl };
}

beforeEach(() => {
  for (const s of ["", "-wal", "-shm"]) rmSync(`${DB}${s}`, { force: true });
  store = new SqliteStore(DB);
});
afterEach(() => store.close());

describe("githubAppManifest", () => {
  it("points the hook and redirect at this server with scoped permissions", () => {
    const m = githubAppManifest({ baseUrl: "https://uw.example.com/" });
    expect(m.name).toBe("underwright");
    expect(m.url).toBe("https://uw.example.com");
    expect(m.hook_attributes).toEqual({ url: "https://uw.example.com/github/webhook", active: true });
    expect(m.redirect_url).toBe("https://uw.example.com/github/app/callback");
    expect(m.public).toBe(false);
    expect(m.default_permissions).toEqual({
      metadata: "read",
      issues: "write",
      pull_requests: "write",
      checks: "read",
    });
    expect(m.default_events).toEqual(["issues", "check_run", "check_suite", "pull_request_review"]);
    expect(APP_EVENTS).toContain("check_suite");
  });
});

describe("appJwt", () => {
  it("signs an RS256 JWT that verifies against the app public key", () => {
    const jwt = appJwt("12345", PEM, 1_700_000_000);
    const [h, p, sig] = jwt.split(".");
    expect(JSON.parse(Buffer.from(h, "base64url").toString())).toEqual({ alg: "RS256", typ: "JWT" });
    expect(JSON.parse(Buffer.from(p, "base64url").toString())).toEqual({
      iat: 1_700_000_000 - 60,
      exp: 1_700_000_000 + 540,
      iss: "12345",
    });
    const v = createVerify("RSA-SHA256");
    v.update(`${h}.${p}`);
    expect(v.verify(publicKey, Buffer.from(sig, "base64url"))).toBe(true);
  });
});

describe("REST calls", () => {
  it("mints an installation token with the app JWT", async () => {
    const { calls, fetchImpl } = stubFetch({ "/app/installations/77/access_tokens": { status: 201, body: { token: "ghs_x" } } });
    const token = await installationToken({ appId: "1", privateKey: PEM }, 77, fetchImpl);
    expect(token).toBe("ghs_x");
    expect(calls[0].url).toBe("https://api.github.com/app/installations/77/access_tokens");
    expect(calls[0].init.method).toBe("POST");
    expect(calls[0].init.headers.authorization).toMatch(/^Bearer [\w-]+\.[\w-]+\.[\w-]+$/);
  });

  it("comments on an issue/PR with the installation token", async () => {
    const { calls, fetchImpl } = stubFetch({ "/repos/org/repo/issues/7/comments": { status: 201, body: { id: 9, html_url: "u" } } });
    expect(await commentOnIssue("ghs_x", "org/repo", 7, "hello", fetchImpl)).toEqual({ id: 9, html_url: "u" });
    expect(calls[0].init.headers.authorization).toBe("Bearer ghs_x");
    expect(JSON.parse(calls[0].init.body)).toEqual({ body: "hello" });
    await expect(commentOnIssue("t", "bad repo/../x", 1, "b", fetchImpl)).rejects.toThrow(/invalid repo/);
  });

  it("surfaces API errors", async () => {
    const { fetchImpl } = stubFetch({});
    await expect(commentOnIssue("t", "org/repo", 1, "b", fetchImpl)).rejects.toThrow(/404/);
  });

  it("converts a manifest code into app credentials", async () => {
    const { calls, fetchImpl } = stubFetch({
      "/app-manifests/abc123/conversions": {
        status: 201,
        body: { id: 42, slug: "uw", pem: PEM, webhook_secret: "whs", html_url: "https://github.com/apps/uw", extra: 1 },
      },
    });
    const app = await convertManifestCode("abc123", fetchImpl);
    expect(app).toEqual({ id: 42, slug: "uw", pem: PEM, webhook_secret: "whs", html_url: "https://github.com/apps/uw" });
    expect(calls[0].init.headers.authorization).toBeUndefined();
    await expect(convertManifestCode("../x", fetchImpl)).rejects.toThrow(/invalid/);
  });

  it("publisher mints a token and posts the comment", async () => {
    const { calls, fetchImpl } = stubFetch({
      "/app/installations/5/access_tokens": { status: 201, body: { token: "ghs_y" } },
      "/repos/org/repo/issues/3/comments": { status: 201, body: { id: 1 } },
    });
    await appPublisher({ appId: "1", privateKey: PEM }, fetchImpl)("org/repo", 3, "pack", 5);
    expect(calls.map((c) => c.url)).toEqual([
      "https://api.github.com/app/installations/5/access_tokens",
      "https://api.github.com/repos/org/repo/issues/3/comments",
    ]);
  });
});

describe("appCredsFromEnv", () => {
  it("reads id + escaped key, or a key file, and returns null when unset", () => {
    expect(appCredsFromEnv({})).toBeNull();
    expect(appCredsFromEnv({ UNDERWRIGHT_GITHUB_APP_ID: "1" })).toBeNull();
    const escaped = PEM.trim().replace(/\n/g, "\\n");
    expect(appCredsFromEnv({ UNDERWRIGHT_GITHUB_APP_ID: "1", UNDERWRIGHT_GITHUB_APP_PRIVATE_KEY: escaped }))
      .toEqual({ appId: "1", privateKey: PEM.trim() });
    const dir = mkdtempSync(join(tmpdir(), "uw-app-"));
    const file = join(dir, "key.pem");
    writeFileSync(file, PEM);
    expect(appCredsFromEnv({ UNDERWRIGHT_GITHUB_APP_ID: "2", UNDERWRIGHT_GITHUB_APP_PRIVATE_KEY_FILE: file }))
      .toEqual({ appId: "2", privateKey: PEM.trim() });
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("evidence pack extraction", () => {
  it("github.ts re-exports the shared evidencePack", () => {
    expect(packFromAdapter).toBe(evidencePack);
  });
});

describe("auto-post evidence packs on completed check suites", () => {
  const suitePayload = (extra: Record<string, unknown> = {}) => ({
    action: "completed",
    check_suite: {
      status: "completed",
      conclusion: "success",
      head_branch: "feat/x",
      app: { name: "GitHub Actions" },
      pull_requests: [{ number: 7 }],
    },
    repository: { full_name: "org/repo" },
    ...extra,
  });

  it("publishes each linked task's pack to each PR when the delivery has an installation", async () => {
    store.createTask({ id: "pr-7", title: "PR task", ac_ids: ["checks-gate"] });
    const posted: any[] = [];
    const result = await dispatchGithubEvent(store, "check_suite", suitePayload({ installation: { id: 99 } }), {
      delivery: "d1",
      publish: async (repo, number, body, inst) => { posted.push({ repo, number, body, inst }); },
    });
    expect(result.effects).toEqual([
      { action: "evidence", task_id: "pr-7", evidence_id: expect.any(String), kind: "ci_check" },
      { action: "posted", task_id: "pr-7", pr: 7 },
    ]);
    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatchObject({ repo: "org/repo", number: 7, inst: 99 });
    expect(posted[0].body).toContain("### Evidence pack — pr-7");
    expect(posted[0].body).toContain("checks-gate");
  });

  it("does not publish without an installation, before completion, or without a publisher", async () => {
    store.createTask({ id: "pr-7", title: "PR task" });
    let calls = 0;
    const publish = async () => { calls++; };
    await dispatchGithubEvent(store, "check_suite", suitePayload(), { publish });
    await dispatchGithubEvent(store, "check_suite", suitePayload({ action: "requested", installation: { id: 1 } }), { publish });
    const r = await dispatchGithubEvent(store, "check_suite", suitePayload({ installation: { id: 1 } }));
    expect(calls).toBe(0);
    expect(r.effects.map((e) => e.action)).toEqual(["evidence"]);
  });

  it("records a skipped effect when the comment fails, without throwing", async () => {
    store.createTask({ id: "pr-7", title: "PR task" });
    const r = await dispatchGithubEvent(store, "check_suite", suitePayload({ installation: { id: 1 } }), {
      publish: async () => { throw new Error("GitHub POST → 403"); },
    });
    expect(r.effects[1]).toEqual({ action: "skipped", task_id: "pr-7", pr: 7, reason: "GitHub POST → 403" });
  });

  it("acknowledges installation events", async () => {
    const r = await dispatchGithubEvent(store, "installation", { action: "created" });
    expect(r.effects).toEqual([{ action: "ignored", reason: "installation created" }]);
  });
});

describe("one-click install routes", () => {
  let server: Server;
  let base: string;
  const conversions = stubFetch({
    "/app-manifests/good/conversions": {
      status: 201,
      body: { id: 42, slug: "uw-app", pem: "-----BEGIN KEY-----\nabc\n-----END KEY-----\n", webhook_secret: "whs", html_url: "https://github.com/apps/uw-app" },
    },
  });

  beforeEach(async () => {
    server = createServer((req, res) => {
      if (!isGithubAppRequest(req.url)) { res.writeHead(404).end(); return; }
      void handleGithubAppHttp(req, res, { env: { UNDERWRIGHT_PUBLIC_URL: "https://uw.example.com" }, fetchImpl: conversions.fetchImpl });
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterEach(() => new Promise<void>((r) => server.close(() => r())));

  it("install serves an auto-submitting manifest form to github.com", async () => {
    const res = await fetch(`${base}/github/app/install`);
    const html = await res.text();
    expect(res.status).toBe(200);
    expect(html).toContain('action="https://github.com/settings/apps/new"');
    expect(html).toContain("https://uw.example.com/github/webhook");
    expect(html).toContain(".submit()");
    const org = await (await fetch(`${base}/github/app/install?org=acme`)).text();
    expect(org).toContain('action="https://github.com/organizations/acme/settings/apps/new"');
    expect((await fetch(`${base}/github/app/install?org=a%22b`)).status).toBe(400);
  });

  it("callback converts the code and shows env lines without persisting", async () => {
    const res = await fetch(`${base}/github/app/callback?code=good`);
    const html = await res.text();
    expect(res.status).toBe(200);
    expect(html).toContain("UNDERWRIGHT_GITHUB_APP_ID=42");
    expect(html).toContain("UNDERWRIGHT_GITHUB_WEBHOOK_SECRET=&#39;whs&#39;");
    expect(html).toContain("UNDERWRIGHT_GITHUB_APP_PRIVATE_KEY=&#39;-----BEGIN KEY-----\\nabc\\n-----END KEY-----&#39;");
    expect((await fetch(`${base}/github/app/callback?code=bad`)).status).toBe(502);
    expect((await fetch(`${base}/github/app/callback`)).status).toBe(400);
    expect((await fetch(`${base}/github/app/install`, { method: "POST" })).status).toBe(405);
  });
});
