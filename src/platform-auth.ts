import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";
import type { AuthRule } from "./policy.js";

/** Databricks Apps platform auth (gh-51). The Apps proxy authenticates every
 *  request against the workspace and forwards the user as X-Forwarded-Email /
 *  X-Forwarded-Preferred-Username / X-Forwarded-User. Those headers are only
 *  trustworthy because nothing can reach the app except through that proxy,
 *  so this mode is opt-in via policy `auth.mode` or UNDERWRIGHT_AUTH_MODE. */

export type PlatformAuth =
  | { ok: true; via: "databricks"; principal: string }
  | { ok: true; via: "bearer" }
  | { ok: false; status: 401 | 403; error: string };

const MAX_IDENTITY = 200;

function header(headers: IncomingHttpHeaders, name: string): string | undefined {
  const v = headers[name];
  const s = (Array.isArray(v) ? v[0] : v)?.trim();
  // Reject control characters and absurd lengths rather than writing them into the audit log.
  if (!s || s.length > MAX_IDENTITY || /[\u0000-\u001f\u007f]/.test(s)) return undefined;
  return s;
}

/** The forwarded workspace identity, preferring email (stable, human-readable). */
export function forwardedPrincipal(headers: IncomingHttpHeaders): string | undefined {
  return header(headers, "x-forwarded-email")
    ?? header(headers, "x-forwarded-preferred-username")
    ?? header(headers, "x-forwarded-user");
}

/** Exact email or `@domain` suffix match, case-insensitive. Empty list allows everyone. */
export function principalAllowed(principal: string, allowed: string[]): boolean {
  if (!allowed.length) return true;
  const p = principal.toLowerCase();
  return allowed.some(rule => rule.startsWith("@") ? p.endsWith(rule) : p === rule);
}

const sameSecret = (a: string | undefined, b: string): boolean => {
  if (typeof a !== "string") return false;
  return timingSafeEqual(createHash("sha256").update(a).digest(), createHash("sha256").update(b).digest());
};

/** Gate for /mcp and dashboard routes in databricks mode. A configured
 *  UNDERWRIGHT_TOKEN bearer still works as the machine path (no principal). */
export function databricksAuth(rule: Required<AuthRule>, token: string | undefined, headers: IncomingHttpHeaders): PlatformAuth {
  if (token && sameSecret(headers.authorization, `Bearer ${token}`)) return { ok: true, via: "bearer" };
  const principal = forwardedPrincipal(headers);
  if (!principal) return { ok: false, status: 401, error: "no Databricks user identity on request" };
  if (!principalAllowed(principal, rule.allowed_users)) return { ok: false, status: 403, error: "user not allowed" };
  return { ok: true, via: "databricks", principal };
}

/** `--http host[:port]`. Databricks Apps injects DATABRICKS_APP_PORT, so a bare host listens there. */
export function parseHttpAddr(arg: string | undefined, env: NodeJS.ProcessEnv = process.env): { host: string; port: number } {
  const [host, port] = (arg ?? "127.0.0.1:8741").split(":");
  const resolved = Number(port || env.DATABRICKS_APP_PORT || 8741);
  if (!Number.isInteger(resolved) || resolved < 0 || resolved > 65535) throw new Error(`invalid port: ${port}`);
  return { host: host || "127.0.0.1", port: resolved };
}
