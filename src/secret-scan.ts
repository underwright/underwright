import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

/** One secret-looking match. `match` is masked so findings are safe to log. */
export interface SecretFinding {
  path: string;
  line: number;
  rule: string;
  match: string;
}

interface Rule {
  id: string;
  re: RegExp;
}

/**
 * High-signal token shapes. Each regex is global; group 1 (when present) is the
 * secret itself, otherwise the whole match is. Keep these specific — a noisy
 * guard gets bypassed with --no-verify.
 */
export const SECRET_RULES: readonly Rule[] = [
  { id: "private-key", re: /-----BEGIN (?:[A-Z]+ )*PRIVATE KEY(?: BLOCK)?-----/g },
  { id: "aws-access-key-id", re: /\b((?:AKIA|ASIA)[0-9A-Z]{16})\b/g },
  { id: "github-token", re: /\b(gh[pousr]_[A-Za-z0-9]{36,255})\b/g },
  { id: "github-pat", re: /\b(github_pat_[A-Za-z0-9_]{60,255})\b/g },
  { id: "anthropic-key", re: /\b(sk-ant-[A-Za-z0-9_-]{20,})/g },
  { id: "openai-key", re: /\b(sk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,}T3BlbkFJ[A-Za-z0-9_-]{20,})/g },
  { id: "slack-token", re: /\b(xox[abposr]-[A-Za-z0-9-]{10,})/g },
  { id: "google-api-key", re: /\b(AIza[0-9A-Za-z_-]{35})\b/g },
  { id: "stripe-live-key", re: /\b((?:sk|rk)_live_[0-9A-Za-z]{20,})\b/g },
  { id: "underwright-credential", re: /\b(uw_(?:node|worker)_[a-f0-9]{32,})\b/g },
  {
    // Quoted value assigned to a secret-ish name, including SNAKE/camel names
    // that merely contain the keyword (DB_PASSWORD, githubToken, SECRET_KEY).
    id: "generic-assignment",
    re: /\b[\w-]*?(?:api[_-]?key|secret|token|passw(?:or)?d)[\w-]*["']?\s*(?::=|[:=])\s*["']([A-Za-z0-9+/_.~-]{24,})["']/gi,
  },
  {
    // Unquoted dotenv/shell line: `[export ]NAME=value` and nothing else, so
    // code like `token = getToken()` or `x = a.token;` never matches.
    id: "env-assignment",
    re: /^\s*(?:export\s+)?[\w-]*?(?:api[_-]?key|secret|token|passw(?:or)?d)\w*\s*=\s*([A-Za-z0-9+/_.~-]{24,})\s*$/gi,
  },
];

/** Inline opt-out for intentional fixtures: put this marker on the same line. */
export const ALLOW_MARKER = "secret-scan:allow";

const PLACEHOLDER = /^(?:x+|\*+|0+|your[_-]|example|changeme|placeholder|dummy|test|fake|redacted)/i;

const mask = (s: string) => (s.length <= 8 ? "****" : `${s.slice(0, 4)}…${s.slice(-2)} (${s.length} chars)`);

/** Low-entropy strings (aaaa…, 1234…) are almost always placeholders. */
function entropy(s: string): number {
  const counts = new Map<string, number>();
  for (const c of s) counts.set(c, (counts.get(c) ?? 0) + 1);
  let h = 0;
  for (const n of counts.values()) h -= (n / s.length) * Math.log2(n / s.length);
  return h;
}

/** Scan text content. Pure; safe to call on staged blobs or tool input. */
export function scanText(text: string, path = "<input>"): SecretFinding[] {
  const findings: SecretFinding[] = [];
  const lines = text.split(/\r?\n/);
  lines.forEach((line, i) => {
    if (line.includes(ALLOW_MARKER)) return;
    for (const rule of SECRET_RULES) {
      rule.re.lastIndex = 0;
      for (const m of line.matchAll(rule.re)) {
        const secret = m[1] ?? m[0];
        if (rule.id === "private-key") {
          // A bare header (docs, detection code) is not a key: require base64 body
          // after it, inline (\n-escaped env var) or on the next line.
          const after = line.slice((m.index ?? 0) + m[0].length) + "\n" + (lines[i + 1] ?? "");
          if (!/[A-Za-z0-9+/=]{40,}/.test(after)) continue;
        }
        const generic = rule.id === "generic-assignment" || rule.id === "env-assignment";
        if (generic && (PLACEHOLDER.test(secret) || entropy(secret) < 3.5)) continue;
        // Values that are identifiers or env-var names (SECRET_ENV = "GITHUB_WEBHOOK_SECRET",
        // TOKEN=some_long_variable_name) have no digits; random secrets of 24+ chars
        // almost always mix letters and digits.
        if (generic && !(/\d/.test(secret) && /[A-Za-z]/.test(secret))) continue;
        if (rule.id !== "private-key" && entropy(secret) < 3) continue;
        findings.push({ path, line: i + 1, rule: rule.id, match: rule.id === "private-key" ? m[0] : mask(secret) });
      }
    }
  });
  return findings;
}

const MAX_BYTES = 1024 * 1024;
const isBinary = (buf: Buffer) => buf.subarray(0, 8000).includes(0);

/** Scan files on disk. Skips binaries, directories and files over 1 MiB. */
export function scanFiles(paths: string[], cwd = process.cwd()): SecretFinding[] {
  const out: SecretFinding[] = [];
  for (const p of paths) {
    const abs = resolve(cwd, p);
    if (!existsSync(abs)) continue;
    const st = statSync(abs);
    if (!st.isFile() || st.size > MAX_BYTES) continue;
    const buf = readFileSync(abs);
    if (isBinary(buf)) continue;
    out.push(...scanText(buf.toString("utf8"), p));
  }
  return out;
}

/** Scan the staged (index) version of every added/copied/modified file. */
export function scanStaged(cwd = process.cwd()): SecretFinding[] {
  const names = execFileSync("git", ["diff", "--cached", "--name-only", "--diff-filter=ACMR", "-z"], {
    cwd,
    encoding: "utf8",
  })
    .split("\0")
    .filter(Boolean);
  const out: SecretFinding[] = [];
  for (const name of names) {
    const buf = execFileSync("git", ["show", `:${name}`], { cwd, maxBuffer: 64 * MAX_BYTES });
    if (buf.length > MAX_BYTES || isBinary(buf)) continue;
    out.push(...scanText(buf.toString("utf8"), name));
  }
  return out;
}

export function formatFindings(findings: SecretFinding[]): string {
  if (!findings.length) return "secret-scan: no secrets found";
  return [
    `secret-scan: ${findings.length} potential secret(s) found — commit blocked`,
    ...findings.map((f) => `  ${f.path}:${f.line}  ${f.rule}  ${f.match}`),
    `Remove the secret (and rotate it if it was ever pushed). For an intentional`,
    `fixture, add "${ALLOW_MARKER}" on that line.`,
  ].join("\n");
}

/**
 * Install a git pre-commit hook that runs `secret-scan --staged`. Refuses to
 * overwrite a foreign hook unless `force` is set.
 */
export function installPreCommitHook(
  repoDir: string,
  cliPath: string,
  opts: { force?: boolean; node?: string } = {},
): { path: string; installed: boolean; reason?: string } {
  const hooksDir = String(
    execFileSync("git", ["rev-parse", "--git-path", "hooks"], { cwd: repoDir, encoding: "utf8" }),
  ).trim();
  const path = resolve(repoDir, hooksDir, "pre-commit");
  const marker = "# underwright secret-scan";
  if (existsSync(path) && !opts.force && !readFileSync(path, "utf8").includes(marker)) {
    return { path, installed: false, reason: "existing pre-commit hook; re-run with --force to replace it" };
  }
  const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
  writeFileSync(
    path,
    `#!/bin/sh\n${marker}\nexec ${q(opts.node ?? process.execPath)} ${q(resolve(cliPath))} secret-scan --staged\n`,
  );
  chmodSync(path, 0o755);
  return { path, installed: true };
}
