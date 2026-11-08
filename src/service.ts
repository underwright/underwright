// Autostart on reboot: render and install systemd units for the control plane,
// node daemon, and local job runner. User units are the default (no sudo);
// --system installs under /etc/systemd/system. Lingering is enabled for user
// units so they start at boot before any login session exists.

import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, platform, userInfo } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export type ServiceTarget = 'serve' | 'node' | 'run' | 'runner';

export interface ServiceOptions {
  target: ServiceTarget;
  http?: string;          // serve --http bind address (default 127.0.0.1:8741)
  config?: string;        // node: --config path (required for target 'node')
  url?: string;           // runner: control-plane MCP URL
  host?: string;          // runner: --host NAME (default machine hostname)
  agentId?: string;       // runner: --agent-id ID
  name?: string;          // unit name (default underwright[-node|-run])
  system?: boolean;       // install into /etc/systemd/system instead of the user manager
  runAs?: string;         // system units only: User=/Group= to run as
  envFile?: string;       // EnvironmentFile path for secrets (UNDERWRIGHT_TOKEN, ...)
  environment?: Record<string, string>; // Environment= lines, e.g. UNDERWRIGHT_DB
  entrypoint?: string;    // path to cli.js (runner uses the sibling uw-runner.js)
  cwd?: string;           // WorkingDirectory (default process.cwd())
  start?: boolean;        // start the unit after enabling (default true)
}

export interface ServiceDeps {
  exec?: (cmd: string, args: string[]) => string;        // systemctl/loginctl calls
  unitDir?: string;                                      // override ~/.config/systemd/user
  configDir?: string;                                    // override ~/.config/underwright
  platform?: string;                                     // override process.platform
  env?: NodeJS.ProcessEnv;                               // secrets source for auto env file
}

const SECRET_ENV_KEYS = ['UNDERWRIGHT_TOKEN', 'UNDERWRIGHT_GITHUB_WEBHOOK_SECRET', 'GITHUB_WEBHOOK_SECRET'];

export function defaultServiceName(target: ServiceTarget) {
  return target === 'serve' ? 'underwright' : `underwright-${target}`;
}

export function validateServiceName(name: string) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.@-]{0,63}$/.test(name)) throw new Error(`invalid unit name "${name}"`);
  return name;
}

/** Quote one argument for a systemd Exec line (double quotes survive spawn parsing). */
export function systemdQuote(arg: string) {
  return /[\s"'\\]/.test(arg) ? `"${arg.replace(/(["\\])/g, '\\$1')}"` : arg;
}

/** EnvironmentFile quoting: same as Exec args plus '#' (comment start). */
const envQuote = (value: string) =>
  /[\s"'#\\]/.test(value) ? `"${value.replace(/(["\\])/g, '\\$1')}"` : value;

function cliEntrypoint() {
  return fileURLToPath(new URL('./cli.js', import.meta.url));
}

function execLine(opts: ServiceOptions) {
  const node = systemdQuote(process.execPath);
  const cli = systemdQuote(opts.entrypoint ? resolve(opts.entrypoint) : cliEntrypoint());
  if (opts.target === 'node') {
    if (!opts.config) throw new Error('service install node requires --config FILE');
    return `${node} ${cli} node run --config ${systemdQuote(opts.config)}`;
  }
  if (opts.target === 'run') return `${node} ${cli} run`;
  if (opts.target === 'runner') {
    const url = opts.url ?? process.env.UNDERWRIGHT_URL;
    if (!url) throw new Error('service install runner requires --url URL or UNDERWRIGHT_URL');
    const runner = systemdQuote(opts.entrypoint ? join(dirname(resolve(opts.entrypoint)), 'uw-runner.js') : fileURLToPath(new URL('./uw-runner.js', import.meta.url)));
    const extras = [opts.host ? `--host ${systemdQuote(opts.host)}` : '', opts.agentId ? `--agent-id ${systemdQuote(opts.agentId)}` : ''].filter(Boolean).join(' ');
    return `${node} ${runner} --url ${systemdQuote(url)}${extras ? ' ' + extras : ''}`;
  }
  return `${node} ${cli} serve --http ${opts.http ?? '127.0.0.1:8741'}`;
}

function writePaths(opts: ServiceOptions) {
  const paths = new Set<string>([resolve(opts.cwd ?? process.cwd())]);
  for (const value of Object.values(opts.environment ?? {})) {
    if (value.startsWith('/') && /\.(db|sqlite3?)$/i.test(value)) paths.add(dirname(value));
  }
  return [...paths];
}

/** Render the unit file. Pure — tests assert on this string. */
export function renderUnit(opts: ServiceOptions): string {
  const name = validateServiceName(opts.name ?? defaultServiceName(opts.target));
  const lines: string[] = [
    '[Unit]',
    `Description=Underwright ${{ serve: 'MCP control plane', node: 'node agent daemon', run: 'local job runner', runner: 'fleet job runner' }[opts.target]} (${name})`,
    'Documentation=https://github.com/underwright/underwright',
    'After=network-online.target',
    'Wants=network-online.target',
    '',
    '[Service]',
    'Type=simple',
  ];
  if (opts.system && opts.runAs) lines.push(`User=${opts.runAs}`, `Group=${opts.runAs}`);
  lines.push(`WorkingDirectory=${resolve(opts.cwd ?? process.cwd())}`);
  for (const [key, value] of Object.entries(opts.environment ?? {})) {
    if (!/^[A-Z_][A-Z0-9_]*$/i.test(key)) throw new Error(`invalid environment variable name "${key}"`);
    lines.push(`Environment=${key}=${envQuote(value)}`);
  }
  if (opts.envFile) lines.push(`EnvironmentFile=${resolve(opts.envFile)}`);
  lines.push(
    `ExecStart=${execLine(opts)}`,
    `Restart=${opts.target === 'run' || opts.target === 'runner' ? 'always' : 'on-failure'}`,
    'RestartSec=5',
  );
  if (opts.target === 'node') lines.push('KillMode=control-group', 'TimeoutStopSec=10');
  else lines.push(`TimeoutStopSec=${opts.target === 'run' ? 30 : 15}`);
  if (opts.system && opts.target === 'serve') {
    lines.push(
      'NoNewPrivileges=true',
      'PrivateTmp=true',
      'ProtectSystem=strict',
      'ProtectHome=true',
      `ReadWritePaths=${writePaths(opts).join(' ')}`,
      'ProtectKernelTunables=true',
      'ProtectControlGroups=true',
      'RestrictSUIDSGID=true',
    );
  }
  lines.push('', '[Install]', `WantedBy=${opts.system ? 'multi-user.target' : 'default.target'}`, '');
  return lines.join('\n');
}

/** EnvironmentFile syntax: KEY=value, double-quoted when the value needs it. */
export function renderEnvFile(vars: Record<string, string>) {
  return Object.entries(vars)
    .map(([key, value]) => `${key}=${envQuote(value)}`)
    .join('\n') + '\n';
}

export interface ServiceResult {
  ok: boolean;
  unitPath?: string;
  envFile?: string;
  actions: string[];
  warnings: string[];
  unit?: string;
}

type Exec = (cmd: string, args: string[]) => string;

const defaultExec: Exec = (cmd, args) =>
  execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

function run(exec: Exec, steps: string[], cmd: string, args: string[]) {
  exec(cmd, args);
  steps.push([cmd, ...args].join(' '));
}

export function installService(opts: ServiceOptions, deps: ServiceDeps = {}): ServiceResult {
  const exec = deps.exec ?? defaultExec;
  const os = deps.platform ?? platform();
  const name = opts.name ?? defaultServiceName(opts.target);
  const warnings: string[] = [];
  const actions: string[] = [];
  if (os !== 'linux') {
    return { ok: false, actions, warnings: [`systemd is not available on ${os}; supervise the command with launchd or another init. Unit rendered for reference.`], unit: renderUnit(opts) };
  }

  // Secrets go in a 0600 EnvironmentFile, never inline in the world-readable unit.
  let envFile = opts.envFile ? resolve(opts.envFile) : undefined;
  if (!envFile) {
    const env = deps.env ?? process.env;
    const secrets = Object.fromEntries(SECRET_ENV_KEYS.filter(k => env[k]).map(k => [k, env[k] as string]));
    if (Object.keys(secrets).length) {
      const configDir = deps.configDir ?? join(homedir(), '.config', 'underwright');
      mkdirSync(configDir, { recursive: true, mode: 0o700 });
      envFile = join(configDir, `${name}.env`);
      writeFileSync(envFile, renderEnvFile(secrets), { mode: 0o600 });
      chmodSync(envFile, 0o600);
      actions.push(`wrote ${envFile}`);
      if (opts.system) warnings.push(`env file ${envFile} must stay readable by the service user${opts.runAs ? ` (${opts.runAs})` : ''}`);
    }
  }
  return finalize(opts, exec, deps.unitDir, name, renderUnit({ ...opts, envFile }), envFile, actions, warnings);
}

function finalize(opts: ServiceOptions, exec: Exec, unitDirOverride: string | undefined, name: string, unit: string, envFile: string | undefined, actions: string[], warnings: string[]): ServiceResult {
  const unitDir = unitDirOverride ?? (opts.system ? '/etc/systemd/system' : join(homedir(), '.config', 'systemd', 'user'));
  mkdirSync(unitDir, { recursive: true });
  const unitPath = join(unitDir, `${name}.service`);
  writeFileSync(unitPath, unit);
  actions.push(`wrote ${unitPath}`);
  const scope = opts.system ? [] : ['--user'];
  try {
    run(exec, actions, 'systemctl', [...scope, 'daemon-reload']);
    run(exec, actions, 'systemctl', [...scope, 'enable', `${name}.service`]);
    if (opts.start !== false) run(exec, actions, 'systemctl', [...scope, 'start', `${name}.service`]);
  } catch (e: any) {
    if (e.code === 'ENOENT') {
      warnings.push(`systemctl not found; unit written to ${unitPath}. Load it with your init or run: systemctl ${scope.join(' ')} daemon-reload && systemctl ${scope.join(' ')} enable --now ${name}`);
      return { ok: false, unitPath, envFile, actions, warnings, unit };
    }
    if (!opts.system && /(bus|DBUS|XDG_RUNTIME)/i.test(e.message ?? String(e.stderr ?? ''))) {
      warnings.push(`systemd user manager unavailable (${e.message}); is this session under systemd? Try --system for a system unit.`);
      return { ok: false, unitPath, envFile, actions, warnings, unit };
    }
    throw e;
  }
  if (!opts.system) {
    // Linger lets the user manager start at boot without an interactive login.
    try { run(exec, actions, 'loginctl', ['enable-linger']); }
    catch {
      try { run(exec, actions, 'loginctl', ['enable-linger', userInfo().username]); }
      catch { warnings.push(`could not enable lingering; run \`sudo loginctl enable-linger ${userInfo().username}\` so the service starts at boot without login`); }
    }
  }
  return { ok: true, unitPath, envFile, actions, warnings, unit };
}

export function uninstallService(opts: Pick<ServiceOptions, 'target' | 'name' | 'system'>, deps: ServiceDeps = {}): ServiceResult {
  const exec = deps.exec ?? defaultExec;
  const name = validateServiceName(opts.name ?? defaultServiceName(opts.target));
  const actions: string[] = [];
  const warnings: string[] = [];
  const scope = opts.system ? [] : ['--user'];
  for (const step of ['stop', 'disable']) {
    try { run(exec, actions, 'systemctl', [...scope, step, `${name}.service`]); }
    catch { warnings.push(`systemctl ${step} failed (service may not be loaded)`); }
  }
  const unitDir = deps.unitDir ?? (opts.system ? '/etc/systemd/system' : join(homedir(), '.config', 'systemd', 'user'));
  const unitPath = join(unitDir, `${name}.service`);
  if (existsSync(unitPath)) { rmSync(unitPath); actions.push(`removed ${unitPath}`); }
  try { run(exec, actions, 'systemctl', [...scope, 'daemon-reload']); } catch { warnings.push('daemon-reload failed'); }
  return { ok: true, unitPath, actions, warnings };
}

export function serviceStatus(opts: Pick<ServiceOptions, 'target' | 'name' | 'system'>, deps: ServiceDeps = {}) {
  const exec = deps.exec ?? defaultExec;
  const name = validateServiceName(opts.name ?? defaultServiceName(opts.target));
  const scope = opts.system ? [] : ['--user'];
  const probe = (args: string[]) => { try { return exec('systemctl', [...scope, ...args]).trim(); } catch { return 'unknown'; } };
  let linger: string | undefined;
  if (!opts.system) {
    try { linger = exec('loginctl', ['show-user', userInfo().username, '-p', 'Linger', '--value']).trim(); }
    catch { linger = 'unknown'; }
  }
  return {
    name,
    scope: opts.system ? 'system' : 'user',
    enabled: probe(['is-enabled', `${name}.service`]),
    active: probe(['is-active', `${name}.service`]),
    linger,
  };
}
