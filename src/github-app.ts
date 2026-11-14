// GitHub App support: manifest (one-click install), app JWT, installation
// tokens, and PR comments over the REST API. Only node:crypto, node:fs and
// fetch. No store and no gh CLI, so server.ts and webhook.ts can use it
// without pulling in the github.ts adapter.
//
// Flow:
//   GET /github/app/install[?org=X]  auto-submits the manifest to GitHub
//   GET /github/app/callback?code=   converts the code and prints the env lines
// Nothing is persisted, so the HTTP server stays stateless. The operator
// exports UNDERWRIGHT_GITHUB_APP_ID / _PRIVATE_KEY(_FILE) and the webhook
// secret, then restarts `serve --http`.

import { createSign } from "node:crypto";
import { readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { WEBHOOK_PATH } from "./webhook.js";

export const APP_INSTALL_PATH = "/github/app/install";
export const APP_CALLBACK_PATH = "/github/app/callback";
export const APP_ID_ENV = "UNDERWRIGHT_GITHUB_APP_ID";
export const APP_KEY_ENV = "UNDERWRIGHT_GITHUB_APP_PRIVATE_KEY";
export const APP_KEY_FILE_ENV = "UNDERWRIGHT_GITHUB_APP_PRIVATE_KEY_FILE";
export const PUBLIC_URL_ENV = "UNDERWRIGHT_PUBLIC_URL";

const API = "https://api.github.com";
const UA = "underwright-github-app";

export type FetchLike = (url: string, init?: any) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<any>;
  text(): Promise<string>;
}>;

export type AppCreds = { appId: string; privateKey: string };

export type GithubAppManifest = {
  name: string;
  url: string;
  hook_attributes: { url: string; active: boolean };
  redirect_url: string;
  public: boolean;
  default_permissions: Record<string, "read" | "write">;
  default_events: string[];
};

/** Scoped permissions: read metadata/checks, write issues and PR comments. Nothing else. */
export const APP_PERMISSIONS: GithubAppManifest["default_permissions"] = {
  metadata: "read",
  issues: "write",
  pull_requests: "write",
  checks: "read",
};

export const APP_EVENTS = ["issues", "check_run", "check_suite", "pull_request_review"];

export function githubAppManifest(opts: { baseUrl: string; name?: string }): GithubAppManifest {
  const base = opts.baseUrl.replace(/\/+$/, "");
  return {
    name: opts.name ?? "underwright",
    url: base,
    hook_attributes: { url: `${base}${WEBHOOK_PATH}`, active: true },
    redirect_url: `${base}${APP_CALLBACK_PATH}`,
    public: false,
    default_permissions: { ...APP_PERMISSIONS },
    default_events: [...APP_EVENTS],
  };
}

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

/** RS256 app JWT, valid from now-60s (clock skew) to now+9m (GitHub max is 10m). */
export function appJwt(appId: string, privateKeyPem: string, nowSec = Math.floor(Date.now() / 1000)): string {
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = b64url(JSON.stringify({ iat: nowSec - 60, exp: nowSec + 540, iss: appId }));
  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${payload}`);
  return `${header}.${payload}.${b64url(signer.sign(privateKeyPem))}`;
}

async function call(fetchImpl: FetchLike, method: string, path: string, auth: string | null, body?: unknown) {
  const headers: Record<string, string> = {
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
    "user-agent": UA,
  };
  if (auth) headers.authorization = auth;
  if (body !== undefined) headers["content-type"] = "application/json";
  const res = await fetchImpl(`${API}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`GitHub ${method} ${path} → ${res.status}${text ? `: ${text.slice(0, 300)}` : ""}`);
  }
  return res.json();
}

export async function installationToken(
  creds: AppCreds,
  installationId: number,
  fetchImpl: FetchLike = globalThis.fetch as any,
  nowSec?: number,
): Promise<string> {
  const jwt = appJwt(creds.appId, creds.privateKey, nowSec);
  const out = await call(fetchImpl, "POST", `/app/installations/${installationId}/access_tokens`, `Bearer ${jwt}`);
  if (typeof out?.token !== "string") throw new Error("installation token missing from response");
  return out.token;
}

export async function commentOnIssue(
  token: string,
  repo: string,
  number: number,
  body: string,
  fetchImpl: FetchLike = globalThis.fetch as any,
): Promise<{ id?: number; html_url?: string }> {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error(`invalid repo ${repo}`);
  const out = await call(fetchImpl, "POST", `/repos/${repo}/issues/${number}/comments`, `Bearer ${token}`, { body });
  return { id: out?.id, html_url: out?.html_url };
}

export type ConvertedApp = { id: number; slug: string; pem: string; webhook_secret: string; html_url: string };

/** Exchange the one-time manifest code for the new app's credentials. */
export async function convertManifestCode(code: string, fetchImpl: FetchLike = globalThis.fetch as any): Promise<ConvertedApp> {
  if (!/^[\w-]+$/.test(code)) throw new Error("invalid manifest code");
  const out = await call(fetchImpl, "POST", `/app-manifests/${code}/conversions`, null);
  return { id: out.id, slug: out.slug, pem: out.pem, webhook_secret: out.webhook_secret, html_url: out.html_url };
}

export function appCredsFromEnv(env: NodeJS.ProcessEnv = process.env): AppCreds | null {
  const appId = env[APP_ID_ENV]?.trim();
  if (!appId) return null;
  let key = env[APP_KEY_ENV]?.trim() ?? "";
  if (!key && env[APP_KEY_FILE_ENV]?.trim()) key = readFileSync(env[APP_KEY_FILE_ENV]!.trim(), "utf8");
  key = key.replace(/\\n/g, "\n").trim();
  if (!key) return null;
  return { appId, privateKey: key };
}

/** Publisher for webhook.ts: mint an installation token, comment on the PR. */
export function appPublisher(creds: AppCreds, fetchImpl: FetchLike = globalThis.fetch as any) {
  return async (repo: string, number: number, body: string, installationId: number) => {
    const token = await installationToken(creds, installationId, fetchImpl);
    await commentOnIssue(token, repo, number, body, fetchImpl);
  };
}

/** Installation id of the app on a repo (GET /repos/{repo}/installation, app JWT). */
export async function repoInstallationId(
  creds: AppCreds,
  repo: string,
  fetchImpl: FetchLike = globalThis.fetch as any,
  nowSec?: number,
): Promise<number> {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error(`invalid repo ${repo}`);
  const out = await call(fetchImpl, "GET", `/repos/${repo}/installation`, `Bearer ${appJwt(creds.appId, creds.privateKey, nowSec)}`);
  if (typeof out?.id !== "number") throw new Error(`no app installation on ${repo}`);
  return out.id;
}

/** Issue commenter for the status mirror: resolves the repo's installation,
 *  caches the installation token for 50 minutes (GitHub issues 60-minute tokens). */
export function appIssuePoster(creds: AppCreds, fetchImpl: FetchLike = globalThis.fetch as any, nowMs: () => number = Date.now) {
  const tokens = new Map<string, { token: string; expires: number }>();
  return async (repo: string, number: number, body: string) => {
    let cached = tokens.get(repo);
    if (!cached || cached.expires <= nowMs()) {
      const installation = await repoInstallationId(creds, repo, fetchImpl);
      cached = { token: await installationToken(creds, installation, fetchImpl), expires: nowMs() + 50 * 60_000 };
      tokens.set(repo, cached);
    }
    return commentOnIssue(cached.token, repo, number, body, fetchImpl);
  };
}

export function isGithubAppRequest(url: string | undefined): boolean {
  const path = (url ?? "").split("?")[0].replace(/\/+$/, "");
  return path === APP_INSTALL_PATH || path === APP_CALLBACK_PATH;
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

function html(res: ServerResponse, status: number, body: string) {
  res.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
  res.end(`<!doctype html><meta charset="utf-8"><title>underwright GitHub App</title><body style="font-family:sans-serif;max-width:48rem;margin:2rem auto">${body}</body>`);
}

function baseUrl(req: IncomingMessage, env: NodeJS.ProcessEnv): string {
  const configured = env[PUBLIC_URL_ENV]?.trim();
  if (configured) return configured.replace(/\/+$/, "");
  const proto = String(req.headers["x-forwarded-proto"] ?? "http").split(",")[0].trim();
  return `${proto}://${req.headers.host ?? "localhost"}`;
}

export async function handleGithubAppHttp(
  req: IncomingMessage,
  res: ServerResponse,
  opts: { env?: NodeJS.ProcessEnv; fetchImpl?: FetchLike } = {},
): Promise<void> {
  const env = opts.env ?? process.env;
  if (req.method !== "GET") {
    res.writeHead(405, { allow: "GET" }).end();
    return;
  }
  const url = new URL(req.url ?? "/", "http://underwright.local");
  const path = url.pathname.replace(/\/+$/, "");

  if (path === APP_INSTALL_PATH) {
    const manifest = githubAppManifest({ baseUrl: baseUrl(req, env), name: url.searchParams.get("name") ?? undefined });
    const org = url.searchParams.get("org");
    if (org && !/^[A-Za-z0-9-]+$/.test(org)) {
      html(res, 400, "<p>invalid org</p>");
      return;
    }
    const action = org
      ? `https://github.com/organizations/${org}/settings/apps/new`
      : "https://github.com/settings/apps/new";
    html(res, 200, `<h1>Create the underwright GitHub App</h1>
<p>Submitting the app manifest to GitHub…</p>
<form id="m" method="post" action="${esc(action)}">
<input type="hidden" name="manifest" value="${esc(JSON.stringify(manifest))}">
<button type="submit">Create GitHub App</button>
</form>
<script>document.getElementById("m").submit()</script>`);
    return;
  }

  const code = url.searchParams.get("code");
  if (!code) {
    html(res, 400, "<p>missing code</p>");
    return;
  }
  try {
    const app = await convertManifestCode(code, opts.fetchImpl ?? (globalThis.fetch as any));
    const pemLine = app.pem.trim().replace(/\n/g, "\\n");
    html(res, 200, `<h1>GitHub App created: ${esc(app.slug)}</h1>
<p>Nothing was stored on the server. Export these, then restart <code>underwright serve --http</code>:</p>
<pre>${esc(`export ${APP_ID_ENV}=${app.id}
export UNDERWRIGHT_GITHUB_WEBHOOK_SECRET='${app.webhook_secret}'
export ${APP_KEY_ENV}='${pemLine}'`)}</pre>
<p>Then install the app on your repositories: <a href="${esc(app.html_url)}/installations/new">${esc(app.html_url)}/installations/new</a></p>`);
  } catch (err) {
    html(res, 502, `<p>manifest conversion failed: ${esc(err instanceof Error ? err.message : String(err))}</p>`);
  }
}
