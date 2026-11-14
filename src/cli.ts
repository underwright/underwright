#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { enrollNode, nodeStatus } from "./node-client.js";
import { attestHarnesses, DEFAULT_NODE_CONFIG_PATH, initConfig, validateConfig, which } from "./node-config.js";
import type { ExecutorConfig } from "./node-executors.js";
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
import { hostname } from "node:os";
import { executeLeasedJob } from "./runner.js";
import { openStore, serve, serveHttp } from "./server.js";
import { formatInitResult, initWorkspace } from "./init.js";
import {
  syncIssues,
  syncPRs,
  checkPRGate,
  linkPR,
  postEvidenceComment,
} from "./github.js";

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
      const [host, port] = (args[httpIdx + 1] ?? "127.0.0.1:8741").split(":");
      await serveHttp(dbPath, host, Number(port), process.env.UNDERWRIGHT_TOKEN);
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
      else if (args[0] === "run") {
        const shutdown = new AbortController();
        process.once("SIGINT", () => shutdown.abort());
        process.once("SIGTERM", () => shutdown.abort());
        const configPath = flag('config');
        if (!configPath) throw new Error('node run requires --config FILE with locally approved resources');
        const config = JSON.parse(readFileSync(configPath, 'utf8'));
        const report = validateConfig(config);
        for (const issue of report.issues) {
          console.error(`[node config ${issue.level}] ${issue.section}${issue.id ? ':' + issue.id : ''} ${issue.message}`);
        }
        if (!report.ok) throw new Error(`node config invalid: ${report.issues.filter(i => i.level === 'error').length} error(s) — fix ${configPath} or run 'underwright node config validate --config ${configPath}'`);
        await runNode({ signal: shutdown.signal, config });
      } else if (args[0] === "config") {
        const sub = args[1];
        const configPath = resolve(flag("config") ?? DEFAULT_NODE_CONFIG_PATH);
        const load = () => JSON.parse(readFileSync(configPath, 'utf8')) as ExecutorConfig;
        const save = (c: ExecutorConfig) => { mkdirSync(dirname(configPath), { recursive: true }); writeFileSync(configPath, JSON.stringify(c, null, 2) + "\n"); };
        if (sub === "validate") {
          const report = validateConfig(load());
          for (const issue of report.issues) {
            console.log(`${issue.level.padEnd(7)} ${issue.section}${issue.id ? ':' + issue.id : ''} ${issue.message}`);
          }
          console.log(report.ok ? "ok: no errors" : `failed: ${report.issues.filter(i => i.level === "error").length} error(s)`);
          if (!report.ok) process.exitCode = 1;
        } else if (sub === "init") {
          if (existsSync(configPath) && !args.includes("--force")) throw new Error(`config already exists: ${configPath} (use --force to overwrite)`);
          const workspaces: Record<string, string> = {};
          for (const w of args.slice(2)) {
            const m = w.match(/^--workspace=(.+)=(.+)$/);
            if (m) workspaces[m[1]] = m[2];
          }
          const config = initConfig({ workspaces: Object.keys(workspaces).length ? workspaces : undefined });
          save(config);
          console.log(`wrote ${configPath}`);
          const report = validateConfig(config);
          for (const issue of report.issues) console.log(`${issue.level.padEnd(7)} ${issue.section}${issue.id ? ':' + issue.id : ''} ${issue.message}`);
        } else if (sub === "set") {
          const [key, value] = args.slice(2);
          if (!["concurrency", "timeoutMs", "maxOutput"].includes(key)) throw new Error("settable keys: concurrency, timeoutMs, maxOutput");
          const config = load();
          (config as unknown as Record<string, unknown>)[key] = Number(value);
          save(config);
          console.log(`${key} = ${value}`);
        } else if (sub === "add" || sub === "remove") {
          const [section, id, ...rest] = args.slice(2);
          const config = load() as Record<string, any>;
          if (sub === "remove") {
            if (!["workspaces", "repositories", "harnesses", "installers", "scripts"].includes(section)) throw new Error("removable sections: workspaces, repositories, harnesses, installers, scripts");
            if (config[section]?.[id] === undefined) throw new Error(`${section}.${id} not present`);
            delete config[section][id];
            save(config as ExecutorConfig);
            console.log(`removed ${section}.${id}`);
          } else {
            if (section === "workspace" || section === "workspaces") {
              const path = rest[0];
              if (!path || !isAbsolute(path)) throw new Error("add workspace ID ABSOLUTE_PATH");
              (config.workspaces ??= {})[id] = path;
            } else if (section === "repository" || section === "repositories") {
              if (!rest[0]) throw new Error("add repository ID CLONE_URL");
              (config.repositories ??= {})[id] = rest[0];
            } else if (section === "harness" || section === "harnesses") {
              const exe = flag("exec") ?? rest[0];
              if (!exe || !which(exe)) throw new Error(`executable not found: ${exe ?? "(none given)"} — pass --exec PATH`);
              (config.harnesses ??= {})[id] = { executable: which(exe)!, args: rest.slice(exe === rest[0] ? 1 : 0) };
            } else if (section === "script" || section === "scripts") {
              const exe = rest[0];
              if (!exe || !which(exe)) throw new Error(`executable not found: ${exe ?? "(none given)"}`);
              (config.scripts ??= {})[id] = { executable: which(exe)!, args: rest.slice(1) };
            } else if (section === "installer" || section === "installers") {
              (config.installers ??= {})[id] = { executable: rest[0] ?? "packaged-install-agents" };
            } else throw new Error("addable sections: workspace, repository, harness, script, installer");
            save(config as ExecutorConfig);
            console.log(`added ${section}.${id}`);
          }
        } else if (sub === "attest") {
          save(attestHarnesses(load()));
          console.log(`attested harnesses in ${configPath} (auth_status stays operator-set)`);
        } else if (sub === "set-auth") {
          const [id, status] = args.slice(2);
          if (!id || !["ready", "missing", "unknown"].includes(status)) throw new Error("set-auth HARNESS_ID ready|missing|unknown [--quota available|exhausted|unknown] [--resets ISO|+Nm|+Nh|+Nd]");
          const quota = flag("quota");
          if (quota && !["available", "exhausted", "unknown"].includes(quota)) throw new Error("--quota must be available|exhausted|unknown");
          const resets = flag("resets");
          let resetsAt: string | undefined;
          if (resets) {
            const rel = resets.match(/^\+(\d+)(m|h|d)$/);
            const ts = rel
              ? Date.now() + Number(rel[1]) * ({ m: 60_000, h: 3_600_000, d: 86_400_000 } as const)[rel[2] as "m" | "h" | "d"]
              : Date.parse(resets);
            if (!Number.isFinite(ts)) throw new Error("--resets must be an ISO timestamp or relative like +9h, +30m, +2d");
            resetsAt = new Date(ts).toISOString();
          }
          const config = attestHarnesses(load());
          const hs = ((config as any).inventory?.harnesses ?? []) as any[];
          const h = hs.find((x) => x.id === id);
          if (!h) throw new Error(`harness ${id} not configured — 'node config add harness ${id} --exec PATH' first`);
          if (status === "ready" && !h.installed) throw new Error(`harness ${id} does not resolve — fix its executable before marking ready`);
          h.auth_status = status;
          if (quota || resetsAt) h.quota = { ...(h.quota ?? {}), ...(quota ? { state: quota } : {}), ...(resetsAt ? { resets_at: resetsAt } : {}), observed_at: new Date().toISOString() };
          save(config);
          console.log(`${id} auth_status = ${status}${quota ? ` quota = ${quota}` : ""}${resetsAt ? ` resets_at = ${resetsAt}` : ""}`);
        } else throw new Error("usage: underwright node config validate|init|set|add|remove|attest|set-auth [--config FILE]");
      } else throw new Error("usage: underwright node enroll --url ORIGIN --name NAME [--allow-insecure] | node status | node run | node config <cmd>");
    } catch (error) { console.error(error instanceof Error ? error.message : "node command failed"); process.exitCode = 1; }
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
    const repo = args[args.indexOf("--repo") + 1];
    if (!repo) {
      console.error("usage: underwright github sync|sync-prs|gate|post-evidence|link-pr --repo owner/name [--task ID] [--pr NUM]");
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
  underwright node config        Manage node-executors.json: validate|init|set|add|remove|attest|set-auth
                                 [--config FILE] (default ~/.config/underwright/node-executors.json).
  underwright service install    Install a systemd unit for autostart on reboot:
                                 [serve|node|run|runner] [--http H:P] [--config FILE]
                                 [--url URL] [--system] [--no-start].
                                 status/uninstall/print too.
  underwright board              Print the task board.
  underwright digest             Summarize board delta since --since TS [--to AGENT] [--text].
  underwright create             Create a task, optionally from a template (--template feature).
  underwright templates          List task templates (builtin + policy-defined).
  underwright speckit import     Import Spec Kit markdown (constitution/spec/plan/tasks) and link ac_ids.

Env:
  UNDERWRIGHT_DB      Path to workspace DB (default: ./underwright.db)
  UNDERWRIGHT_GITHUB_WEBHOOK_SECRET
                      HMAC secret for POST /github/webhook.
                      GITHUB_WEBHOOK_SECRET is the fallback. See docs/webhook.md.`);
}
