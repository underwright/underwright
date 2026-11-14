#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { enrollNode, nodeStatus } from "./node-client.js";
import {
  installService,
  renderUnit,
  serviceStatus,
  uninstallService,
  type ServiceOptions,
  type ServiceResult,
  type ServiceTarget,
} from "./service.js";
import { runNode } from "./node-run.js";
import { prepareHarnessWorkspace } from "./harness-permissions.js";
import { hostname } from "node:os";
import { executeLeasedJob } from "./runner.js";
import { openStore, serve, serveHttp } from "./server.js";
import { formatInitResult, initWorkspace } from "./init.js";
import { exportToPath, importFromPath, snapshotTargetFromEnv } from "./snapshot.js";
import {
  syncIssues,
  syncPRs,
  checkPRGate,
  linkPR,
  postEvidenceComment,
  ghIssuePoster,
} from "./github.js";
import { appCredsFromEnv, appIssuePoster, githubAppManifest } from "./github-app.js";
import { postIssueDigests, publishStatusChanges } from "./github-status.js";
import { getGithubStatusPolicy } from "./policy.js";
import { parseHttpAddr } from "./platform-auth.js";
import { formatFindings, installPreCommitHook, scanFiles, scanStaged } from "./secret-scan.js";
import { agentKeyDir, createAgentKeyFile, readAgentKeyFile, rotateAgentKeyFile, signAction } from "./agent-identity.js";

const [cmd, ...args] = process.argv.slice(2);
const dbPath = process.env.UNDERWRIGHT_DB ?? "underwright.db";

/** Value of `--name value`, or undefined when the flag is absent. */
const flag = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? undefined : args[i + 1];
};

switch (cmd) {
  case "--version":
  case "-v":
  case "version": {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    console.log(pkg.version);
    break;
  }

  case "init": {
    // underwright init [--remote http://host:8741] [--force] [--no-seed]
    const remote = flag("remote");
    if (remote !== undefined && !remote) {
      console.error("usage: underwright init [--remote http://host:8741] [--force] [--no-seed]");
      process.exit(1);
    }
    const store = await openStore(dbPath);
    try {
      const result = await initWorkspace(store, {
        cwd: process.cwd(),
        remote,
        force: args.includes("--force"),
        seed: !args.includes("--no-seed"),
      });
      console.log(formatInitResult(result));
    } finally {
      await store.close();
    }
    break;
  }

  case "serve": {
    const httpIdx = args.indexOf("--http");
    if (httpIdx !== -1) {
      const next = args[httpIdx + 1];
      const { host, port } = parseHttpAddr(next?.startsWith("--") ? undefined : next);
      await serveHttp(dbPath, host, port, process.env.UNDERWRIGHT_TOKEN);
    } else {
      await serve(dbPath);
    }
    break;
  }

  case "node": {
    try {
      if (args[0] === "enroll") {
        await enrollNode(flag("url") ?? "", flag("name") ?? hostname(), args.includes("--allow-insecure"));
      } else if (args[0] === "status") console.log(JSON.stringify(nodeStatus(), null, 2));
      else if (args[0] === "approve") {
        const id = args[1], code = args[2];
        if (!id || !code) throw new Error("usage: underwright node approve ENROLL_ID CODE [--url ORIGIN] [--policy JSON]");
        const url = flag("url") ?? "http://127.0.0.1:8741";
        const token = process.env.UNDERWRIGHT_TOKEN;
        const policy = flag("policy") ? JSON.parse(flag("policy")!)
          : { allowed_task_types: ["launch-agent", "provision", "install-harness", "run-script"], workspace_ids: ["underwright", "kraftina", "aura4"], repository_ids: [] };
        const res = await fetch(url + "/mcp", {
          method: "POST",
          headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...(token ? { authorization: "Bearer " + token } : {}) },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "approve_node_enrollment", arguments: { enrollment_id: id, code, policy } } }),
        });
        const text = await res.text();
        const data = [...text.matchAll(/^data: (.+)$/gm)].map(m => JSON.parse(m[1])).pop()
          ?? JSON.parse(text);
        console.log(JSON.stringify(data?.result ?? data, null, 2));
      } else if (args[0] === "enrollments") {
        const url = flag("url") ?? "http://127.0.0.1:8741";
        const token = process.env.UNDERWRIGHT_TOKEN;
        const res = await fetch(url + "/mcp", {
          method: "POST",
          headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...(token ? { authorization: "Bearer " + token } : {}) },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "list_node_enrollments", arguments: {} } }),
        });
        const text = await res.text();
        const data = [...text.matchAll(/^data: (.+)$/gm)].map(m => JSON.parse(m[1])).pop()
          ?? JSON.parse(text);
        console.log(JSON.stringify(data?.result ?? data, null, 2));
      } else if (args[0] === "run") {
        const shutdown = new AbortController();
        process.once("SIGINT", () => shutdown.abort());
        process.once("SIGTERM", () => shutdown.abort());
        const configPath = flag('config');
        if (!configPath) throw new Error('node run requires --config FILE with locally approved resources');
        const config = JSON.parse(readFileSync(configPath, 'utf8'));
        await runNode({ signal: shutdown.signal, config });
      } else throw new Error("usage: underwright node enroll --url ORIGIN --name NAME [--allow-insecure] | node status | node run");
    } catch (error) { console.error(error instanceof Error ? error.message : "node command failed"); process.exitCode = 1; }
    break;
  }

  case "harness": {
    // underwright harness prepare [--harness claude] [--workspace DIR] [--allow a,b,c] [--claude-json PATH] [--shared]
    if (args[0] !== "prepare") {
      console.error("usage: underwright harness prepare [--harness claude] [--workspace DIR] [--allow Tool,Tool] [--claude-json PATH] [--shared]");
      process.exit(1);
    }
    try {
      const result = prepareHarnessWorkspace(flag("harness") ?? "claude", resolve(flag("workspace") ?? process.cwd()), {
        allow: flag("allow")?.split(",").map((s) => s.trim()).filter(Boolean),
        claudeJson: flag("claude-json"),
        settingsFile: args.includes("--shared") ? "settings.json" : "settings.local.json",
      });
      console.log(JSON.stringify(result, null, 2));
      if (!result.supported) console.error(`[underwright] no permission prep needed/known for harness ${result.harness}`);
    } catch (error) { console.error(error instanceof Error ? error.message : "harness prepare failed"); process.exitCode = 1; }
    break;
  }

  case "agent-key": {
    // gh-20: underwright agent-key gen|show|sign|rotate --agent ID [...]
    const usage = "usage: underwright agent-key gen --agent ID [--force] | show --agent ID | sign --agent ID --action ACTION --task TASK [--args JSON] | rotate --agent ID";
    try {
      const agent = flag("agent") ?? "";
      const dir = agentKeyDir();
      if (args[0] === "gen") {
        const k = createAgentKeyFile(agent, dir, args.includes("--force"));
        console.log(JSON.stringify({ ...k, next: "call register_agent_key with agent_id and public_key" }, null, 2));
      } else if (args[0] === "show") {
        const { private_key: _p, ...k } = readAgentKeyFile(agent, dir);
        console.log(JSON.stringify(k, null, 2));
      } else if (args[0] === "sign") {
        const action = flag("action");
        if (!action) throw new Error(usage);
        const toolArgs = flag("args") ? JSON.parse(flag("args")!) : {};
        const { private_key } = readAgentKeyFile(agent, dir);
        console.log(JSON.stringify(signAction(private_key, action, agent, flag("task") ?? "", toolArgs)));
      } else if (args[0] === "rotate") {
        console.log(JSON.stringify(rotateAgentKeyFile(agent, dir), null, 2));
      } else throw new Error(usage);
    } catch (error) { console.error(error instanceof Error ? error.message : "agent-key failed"); process.exitCode = 1; }
    break;
  }

  case "secret-scan": {
    // underwright secret-scan [--staged] [FILE...] | secret-scan install-hook [--force]
    try {
      if (args[0] === "install-hook") {
        const r = installPreCommitHook(process.cwd(), process.argv[1], { force: args.includes("--force") });
        console.log(r.installed ? `installed ${r.path}` : `not installed: ${r.reason} (${r.path})`);
        if (!r.installed) process.exitCode = 1;
        break;
      }
      const files = args.filter((a) => !a.startsWith("--"));
      if (!args.includes("--staged") && !files.length) {
        console.error("usage: underwright secret-scan --staged | secret-scan FILE... | secret-scan install-hook [--force]");
        process.exit(1);
      }
      const findings = [...(args.includes("--staged") ? scanStaged() : []), ...scanFiles(files)];
      (findings.length ? console.error : console.log)(formatFindings(findings));
      if (findings.length) process.exitCode = 1;
    } catch (error) { console.error(error instanceof Error ? error.message : "secret-scan failed"); process.exitCode = 2; }
    break;
  }

  case "service": {
    // underwright service install [serve|node|run|runner] [--http H:P] [--config FILE]
    //   [--url URL] [--host NAME] [--agent-id ID]
    //   [--name N] [--system] [--run-as USER] [--env-file PATH] [--no-start]
    // underwright service status|uninstall|print [target] [--name N] [--system]
    const sub = args[0];
    const target = (args[1] && !args[1].startsWith("--") ? args[1] : "serve") as ServiceTarget;
    if (!["install", "uninstall", "status", "print"].includes(sub ?? "") || !["serve", "node", "run", "runner"].includes(target)) {
      console.error("usage: underwright service install [serve|node|run|runner] [--http H:P] [--config FILE] [--url URL] [--host NAME] [--agent-id ID] [--name N] [--system] [--run-as USER] [--env-file PATH] [--entrypoint CLI_JS] [--no-start]\n       underwright service status|uninstall|print [serve|node|run|runner] [--name N] [--system]");
      process.exit(1);
    }
    const report = (r: ServiceResult) => {
      for (const a of r.actions) console.log(a);
      for (const w of r.warnings) console.error(`warning: ${w}`);
      if (!r.ok) process.exitCode = 1;
    };
    try {
      const base = { target, name: flag("name"), system: args.includes("--system") };
      if (sub === "status") console.log(JSON.stringify(serviceStatus(base), null, 2));
      else if (sub === "uninstall") report(uninstallService(base));
      else {
        const config = flag("config");
        const entrypoint = flag("entrypoint");
        if (target === "node" && config && !existsSync(config)) throw new Error(`node config not found: ${config}`);
        if (entrypoint && !existsSync(entrypoint)) throw new Error(`entrypoint not found: ${entrypoint}`);
        const opts: ServiceOptions = {
          ...base,
          http: flag("http"),
          config: config ? resolve(config) : undefined,
          url: flag("url"),
          host: flag("host"),
          agentId: flag("agent-id"),
          runAs: flag("run-as"),
          envFile: flag("env-file"),
          entrypoint,
          start: !args.includes("--no-start"),
          environment: target === "node" || target === "runner" ? undefined : { UNDERWRIGHT_DB: resolve(dbPath) },
        };
        if (sub === "print") process.stdout.write(renderUnit(opts));
        else report(installService(opts));
      }
    } catch (error) { console.error(error instanceof Error ? error.message : "service command failed"); process.exitCode = 1; }
    break;
  }

  case "export": {
    // underwright export [--out FILE]   (NDJSON snapshot; stdout by default)
    const counts = await exportToPath(snapshotTargetFromEnv(dbPath), flag("out"));
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    console.error(`exported ${total} rows from ${Object.keys(counts).length} tables`);
    break;
  }

  case "import": {
    // underwright import FILE|-   (into a fresh store; ids preserved)
    const file = args[0];
    if (!file) {
      console.error("usage: underwright import FILE|-   (target: UNDERWRIGHT_DB or DATABASE_URL; must be empty)");
      process.exit(1);
    }
    try {
      const result = await importFromPath(snapshotTargetFromEnv(dbPath), file);
      const total = Object.values(result.counts).reduce((a, b) => a + b, 0);
      for (const [table, cols] of Object.entries(result.dropped_columns)) {
        console.error(`warning: ${table}: columns not in target schema were dropped: ${cols.join(", ")}`);
      }
      console.error(`imported ${total} rows into ${Object.keys(result.counts).length} tables`);
    } catch (e) {
      console.error((e as Error).message);
      process.exit(1);
    }
    break;
  }

  case "board": {
    const store = await openStore(dbPath);
    console.log(JSON.stringify(await store.board(), null, 2));
    await store.close();
    break;
  }

  case "digest": {
    // underwright digest [--since TIMESTAMP] [--to AGENT] [--from AGENT] [--text]
    const store = await openStore(dbPath);
    const result = await store.digest({
      since: flag("since"),
      to_agent: flag("to") ?? flag("to-agent"),
      from_agent: flag("from") ?? flag("from-agent"),
    });
    console.log(args.includes("--text") ? result.summary : JSON.stringify(result, null, 2));
    await store.close();
    break;
  }

  case "create": {
    // underwright create --template feature --title ... [--type T] [--ac a,b] [--spec REF]
    const title = flag("title");
    if (!title) {
      console.error("usage: underwright create --title TITLE [--template ID] [--type TYPE] [--ac id,id] [--spec REF] [--description TEXT]");
      process.exit(1);
    }
    const ac = flag("ac");
    const store = await openStore(dbPath);
    console.log(JSON.stringify(await store.createTask({
      title,
      template: flag("template"),
      type: flag("type"),
      spec_ref: flag("spec"),
      description: flag("description"),
      ac_ids: ac ? ac.split(",").map((s) => s.trim()).filter(Boolean) : undefined,
      created_by: flag("by") ?? "cli",
    }), null, 2));
    await store.close();
    break;
  }

  case "templates": {
    const store = await openStore(dbPath);
    console.log(JSON.stringify(await store.listTemplates(), null, 2));
    await store.close();
    break;
  }

  case "speckit": {
    // underwright speckit [import] --path DIR_OR_FILE [--task ID] [--create-tasks] [--by AGENT]
    const path = flag("path") ?? (args[0] && !args[0].startsWith("--") && args[0] !== "import" ? args[0] : undefined);
    if (!path) {
      console.error("usage: underwright speckit import --path DIR_OR_FILE [--task ID] [--create-tasks] [--by AGENT]");
      process.exit(1);
    }
    const store = await openStore(dbPath);
    console.log(JSON.stringify(await store.importSpecKit({
      path,
      task_id: flag("task"),
      agent_id: flag("by") ?? "cli",
      create_tasks: args.includes("--create-tasks"),
    }), null, 2));
    await store.close();
    break;
  }

  case "run": {
    // Local job runner: executes queued jobs one at a time, records results.
    // This is the "agents wait on processes" half of the loop.
    const store = await openStore(dbPath);
    const shutdown = new AbortController();
    const stop = () => shutdown.abort();
    process.once("SIGTERM", stop);
    process.once("SIGINT", stop);
    let ran = 0;
    try {
      let job;
      while (!shutdown.signal.aborted && (job = await store.nextJob("local-runner", hostname()))) {
        ran++;
        console.log(`[underwright] running ${job.id}: ${job.command}`);
        const finished = await executeLeasedJob(job, async (name, a) => name === "renew_job"
          ? store.renewJob(a.job_id as string, a.agent_id as string, a.lease_token as string, a.ttl_seconds as number, a.result as string)
          : store.finishJob(a.job_id as string, a.status as "done" | "failed", a.result as string, a.agent_id as string, a.lease_token as string),
          { agentId: "local-runner", host: hostname(), signal: shutdown.signal, output: chunk => process.stdout.write(chunk) });
        console.log(`[underwright] ${job.id} ${finished?.status ?? "interrupted"}`);
      }
      if (!ran) console.log("[underwright] no queued jobs");
    } finally {
      process.off("SIGTERM", stop);
      process.off("SIGINT", stop);
      await store.close();
    }
    break;
  }

  case "github": {
    const sub = args[0];
    if (sub === "app-manifest") {
      const urlIdx = args.indexOf("--url");
      const base = urlIdx !== -1 ? args[urlIdx + 1] : process.env.UNDERWRIGHT_PUBLIC_URL;
      if (!base) {
        console.error("usage: underwright github app-manifest --url https://host[:port] [--name NAME]");
        process.exit(1);
      }
      const nameIdx = args.indexOf("--name");
      console.log(JSON.stringify(githubAppManifest({ baseUrl: base, name: nameIdx !== -1 ? args[nameIdx + 1] : undefined }), null, 2));
      break;
    }
    if (sub === "status" || sub === "digest") {
      // Board→GitHub mirror, one pass. GitHub App when creds are exported, else gh CLI.
      const gp = getGithubStatusPolicy();
      const repoArg = args.includes("--repo") ? args[args.indexOf("--repo") + 1] : gp.repo;
      const creds = appCredsFromEnv();
      const post = args.includes("--dry-run")
        ? async (r: string, n: number, body: string) => { console.error(`--- ${r}#${n}\n${body}\n`); }
        : creds ? appIssuePoster(creds) : ghIssuePoster();
      const s = await openStore(dbPath);
      try {
        const out = sub === "status"
          ? await publishStatusChanges(s, { post, defaultRepo: repoArg })
          : await postIssueDigests(s, {
              post, defaultRepo: repoArg, force: args.includes("--force"),
              everyHours: args.includes("--due") ? gp.digest_hours : 0,
              only: args.includes("--task") ? [args[args.indexOf("--task") + 1]] : undefined,
            });
        console.log(JSON.stringify(out, null, 2));
      } finally {
        await s.close();
      }
      break;
    }
    const repo = args.includes("--repo") ? args[args.indexOf("--repo") + 1] : undefined;
    if (!repo) {
      console.error("usage: underwright github sync|sync-prs|gate|post-evidence|link-pr --repo owner/name [--task ID] [--pr NUM]");
      console.error("       underwright github status|digest [--repo owner/name] [--dry-run] [--task ID] [--force] [--due]");
      process.exit(1);
    }
    const store = await openStore(dbPath);
    if (sub === "sync") {
      const wIdx = args.indexOf("--watch");
      const prsFlag = args.includes("--prs");
      if (wIdx !== -1) {
        const interval = Number(args[wIdx + 1] ?? 60) * 1000;
        console.error(`[underwright] watching ${repo} every ${interval / 1000}s`);
        for (;;) {
          try {
            console.error(new Date().toISOString(), JSON.stringify(await syncIssues(store, repo)));
            if (prsFlag) {
              console.error(new Date().toISOString(), JSON.stringify(await syncPRs(store, repo)));
            }
          } catch (e: any) {
            console.error("sync error:", e.message);
          }
          await new Promise((r) => setTimeout(r, interval));
        }
      }
      const issueRes = await syncIssues(store, repo);
      const prRes = prsFlag ? await syncPRs(store, repo) : null;
      console.log(JSON.stringify(prsFlag ? { issues: issueRes, prs: prRes } : issueRes, null, 2));
    } else if (sub === "sync-prs") {
      console.log(JSON.stringify(await syncPRs(store, repo), null, 2));
    } else if (sub === "gate" || sub === "check-gate") {
      const task = args[args.indexOf("--task") + 1];
      console.log(JSON.stringify(await checkPRGate(store, repo, task), null, 2));
    } else if (sub === "post-evidence") {
      const task = args[args.indexOf("--task") + 1];
      console.log(JSON.stringify(await postEvidenceComment(store, repo, task)));
    } else if (sub === "link-pr") {
      const task = args[args.indexOf("--task") + 1];
      const pr = args[args.indexOf("--pr") + 1];
      console.log(JSON.stringify(await linkPR(store, task, pr, repo)));
    }
    await store.close();
    break;
  }

  default:
    console.log(`underwright — control plane for agentic software development

Usage:
  underwright init               Scaffold AGENTS.md, .mcp.json, policy, .gitignore and the triage task.
                                 [--remote http://host:8741] writes the http client variant; [--force] overwrites.
  underwright serve              MCP server over stdio (local agent config).
  underwright serve --http H:P   MCP over HTTP at host:port (/mcp, POST /github/webhook, GET /board) — shared across machines.
  underwright run                Execute queued jobs locally (including agent jobs).
  underwright node enroll        Enroll this machine with a scoped credential; --url ORIGIN --name NAME.
  underwright node status        Show local credential identity/expiry without secrets.
  underwright node run           Outbound daemon: session, poll, heartbeat and capability inventory.
  underwright harness prepare    Pre-accept Claude trust + MCP server + tool allowlist for --workspace DIR (default cwd).
  underwright service install    Install a systemd unit for autostart on reboot:
                                 [serve|node|run|runner] [--http H:P] [--config FILE]
                                 [--url URL] [--system] [--no-start].
                                 status/uninstall/print too.
  underwright secret-scan        Block secrets: --staged (pre-commit) or FILE...; exit 1 on findings.
                                 install-hook [--force] writes .git/hooks/pre-commit.
  underwright agent-key          Agent signing keys (gh-20): gen --agent ID | show | rotate |
                                 sign --agent ID --action claim_task --task T [--args JSON].
  underwright export            NDJSON snapshot of every table, ids preserved; [--out FILE] (default stdout).
  underwright import FILE|-      Load a snapshot into a fresh store (UNDERWRIGHT_DB or DATABASE_URL).
  underwright board              Print the task board.
  underwright digest             Summarize board delta since --since TS [--to AGENT] [--text].
  underwright create             Create a task, optionally from a template (--template feature).
  underwright templates          List task templates (builtin + policy-defined).
  underwright speckit import     Import Spec Kit markdown (constitution/spec/plan/tasks) and link ac_ids.

Env:
  UNDERWRIGHT_DB      Path to workspace DB (default: ./underwright.db)
  UNDERWRIGHT_KEY_DIR Agent private keys (default: ~/.underwright/keys)
  UNDERWRIGHT_GITHUB_WEBHOOK_SECRET
                      HMAC secret for POST /github/webhook.
                      GITHUB_WEBHOOK_SECRET is the fallback. See docs/webhook.md.
  UNDERWRIGHT_GITHUB_APP_ID, UNDERWRIGHT_GITHUB_APP_PRIVATE_KEY (\\n-escaped PEM)
  or UNDERWRIGHT_GITHUB_APP_PRIVATE_KEY_FILE
                      GitHub App credentials. When set, completed check suites
                      post evidence packs on their PRs. Create the app in one
                      click at GET /github/app/install[?org=ORG].
  UNDERWRIGHT_PUBLIC_URL
                      Public base URL used in the app manifest.`);
}
