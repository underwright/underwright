import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ALLOW_MARKER, formatFindings, installPreCommitHook, scanFiles, scanStaged, scanText } from "../src/secret-scan.js";

// Fixtures are assembled at runtime so this file never contains a literal secret.
const rand = (n: number, alphabet = "aB3dE5fG7hJ9kLmN2pQ4rS6tU8vWxYz") =>
  Array.from({ length: n }, (_, i) => alphabet[(i * 7 + 3) % alphabet.length]).join("");
const FAKE = {
  github: "gh" + "p_" + rand(36),
  aws: "AK" + "IA" + "QWERTY7ASDFG5ZXC",
  anthropic: "sk-" + "ant-api03-" + rand(40),
  pem: "-----BEGIN " + "RSA PRIVATE KEY-----\\n" + rand(64),
  uw: "uw_" + "node_" + rand(40, "0123456789abcdef"),
  generic: `api_key = "${rand(32)}"`,
};

describe("scanText", () => {
  it.each(Object.entries({
    github: "github-token",
    aws: "aws-access-key-id",
    anthropic: "anthropic-key",
    pem: "private-key",
    uw: "underwright-credential",
    generic: "generic-assignment",
  }))("flags %s", (key, rule) => {
    const findings = scanText(`line one\nconst x = ${FAKE[key as keyof typeof FAKE]};\n`, "a.ts");
    expect(findings.map((f) => f.rule)).toContain(rule);
    expect(findings[0]).toMatchObject({ path: "a.ts", line: 2 });
  });

  it("masks the secret in findings", () => {
    const [f] = scanText(FAKE.github);
    expect(f.match).not.toContain(FAKE.github);
    expect(formatFindings([f])).not.toContain(FAKE.github);
  });

  it("ignores placeholders, low-entropy strings and env lookups", () => {
    const clean = [
      `api_key = "your_api_key_goes_here_please"`,
      `token: "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"`,
      `password = process.env.DB_PASSWORD`,
      "gh" + "p_" + "a".repeat(36),
      `const secret = flag("secret");`,
      `export KEY='-----BEGIN ` + `RSA PRIVATE KEY-----\\n…'`,
    ].join("\n");
    expect(scanText(clean)).toEqual([]);
  });

  it.each([
    [`DB_PASSWORD="${rand(32)}"`, "generic-assignment"],
    [`GITHUB_TOKEN: "${rand(32)}"`, "generic-assignment"],
    [`SECRET_KEY = "${rand(32)}"`, "generic-assignment"],
    [`const githubToken = '${rand(32)}';`, "generic-assignment"],
    [`token := "${rand(32)}"`, "generic-assignment"],
    [`AWS_SECRET_ACCESS_KEY=${rand(40)}`, "env-assignment"],
    [`export API_KEY=${rand(32)}`, "env-assignment"],
  ])("flags env-style name in %s", (line, rule) => {
    expect(scanText(line).map((f) => f.rule)).toEqual([rule]);
  });

  it("ignores unquoted code-like assignments and identifiers", () => {
    const clean = [
      `token = getTokenFromEnvironment()`,
      `const x = cfg.token;`,
      `TOKEN=some_long_variable_name_without_digits`,
      `DB_PASSWORD=process.env.DB_PASSWORD`,
      `SECRET_KEY=changeme_changeme_changeme_42`,
      `GITHUB_TOKEN=\${{ secrets.GITHUB_TOKEN }}`,
      `const tokenizer = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";`,
      `export const WEBHOOK_SECRET_ENV = "UNDERWRIGHT_GITHUB_WEBHOOK_SECRET";`,
    ].join("\n");
    expect(scanText(clean)).toEqual([]);
  });

  it(`honours the ${ALLOW_MARKER} marker`, () => {
    expect(scanText(`${FAKE.github} // ${ALLOW_MARKER}`)).toEqual([]);
  });
});

describe("git integration", () => {
  let dir = "";
  afterEach(() => dir && rmSync(dir, { recursive: true, force: true }));
  const git = (...a: string[]) => execFileSync("git", a, { cwd: dir, encoding: "utf8" });
  const repo = () => {
    dir = mkdtempSync(join(tmpdir(), "uw-secret-"));
    git("init", "-q");
    git("config", "user.email", "t@example.com");
    git("config", "user.name", "t");
    git("config", "commit.gpgsign", "false");
  };

  it("scanStaged reads the index, not the working tree", () => {
    repo();
    writeFileSync(join(dir, "leak.ts"), `export const k = "${FAKE.aws}";\n`);
    git("add", "leak.ts");
    writeFileSync(join(dir, "leak.ts"), "export const k = process.env.K;\n");
    expect(scanStaged(dir).map((f) => f.rule)).toEqual(["aws-access-key-id"]);
    expect(scanFiles(["leak.ts"], dir)).toEqual([]);
  });

  it("installed pre-commit hook blocks a commit containing a secret and allows a clean one", () => {
    repo();
    const cli = join(process.cwd(), "dist", "cli.js");
    const r = installPreCommitHook(dir, cli);
    expect(r.installed).toBe(true);
    expect(statSync(r.path).mode & 0o111).toBeTruthy();
    expect(readFileSync(r.path, "utf8")).toContain("secret-scan --staged");

    writeFileSync(join(dir, "leak.ts"), `const t = "${FAKE.github}";\n`);
    git("add", "leak.ts");
    const blocked = spawnSync("git", ["commit", "-qm", "leak"], { cwd: dir, encoding: "utf8" });
    expect(blocked.status).not.toBe(0);
    expect(blocked.stderr).toContain("github-token");
    expect(blocked.stderr).not.toContain(FAKE.github);

    writeFileSync(join(dir, "leak.ts"), "const t = process.env.GH_TOKEN;\n");
    git("add", "leak.ts");
    const ok = spawnSync("git", ["commit", "-qm", "clean"], { cwd: dir, encoding: "utf8" });
    expect(ok.status).toBe(0);
  });

  it("refuses to overwrite a foreign hook without force", () => {
    repo();
    const hook = join(dir, ".git", "hooks", "pre-commit");
    writeFileSync(hook, "#!/bin/sh\necho mine\n");
    expect(installPreCommitHook(dir, "cli.js").installed).toBe(false);
    expect(readFileSync(hook, "utf8")).toContain("mine");
    expect(installPreCommitHook(dir, "cli.js", { force: true }).installed).toBe(true);
  });
});
