import { chmodSync, closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir, platform, arch } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { nodeCredentialSchema, nodeHash, nodeSecret, type NodeCredential } from './node-protocol.js';

export const nodeStateDirectory = () => join(homedir(), '.local', 'state', 'underwright', 'node');
export function secureDirectory(dir: string) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stat = lstatSync(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(dir) !== resolve(dir)) throw new Error('node state directory must be a real user directory');
  if (process.getuid && stat.uid !== process.getuid()) throw new Error('node state directory belongs to another user');
  chmodSync(dir, 0o700);
}
export function saveNodeCredential(credential: NodeCredential, dir = nodeStateDirectory()) {
  secureDirectory(dir);
  const data = nodeCredentialSchema.parse(credential);
  const temp = join(dir, '.credential-' + nodeSecret());
  let fd: number | undefined;
  try {
    fd = openSync(temp, 'wx', 0o600);
    writeFileSync(fd, JSON.stringify(data) + '\n'); fsyncSync(fd); closeSync(fd); fd = undefined;
    renameSync(temp, join(dir, 'credential.json'));
    const directory = openSync(dir, 'r'); try { fsyncSync(directory); } finally { closeSync(directory); }
  } finally { if (fd !== undefined) closeSync(fd); try { unlinkSync(temp); } catch {} }
}
export function readNodeCredential(dir = nodeStateDirectory()): NodeCredential {
  secureDirectory(dir);
  const path = join(dir, 'credential.json');
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) || (process.getuid && stat.uid !== process.getuid())) throw new Error('node credential requires a user-owned 0600 regular file');
  return nodeCredentialSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
}
export function nodeOrigin(value: string, insecure = false) {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/' || !['http:', 'https:'].includes(url.protocol)) throw new Error('node URL must be a control-plane origin without credentials');
  if (url.protocol !== 'https:' && !insecure) throw new Error('HTTPS required; --allow-insecure explicitly enables local/tailnet development');
  return url.origin;
}
export async function nodeRequest(url: string, path: string, body: unknown, token?: string) {
  const res = await fetch(url + path, { method: 'POST', redirect: 'error', headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) }, body: JSON.stringify(body), signal: AbortSignal.timeout(35000) });
  const result = await res.json() as any;
  if (!res.ok || result.error) throw new Error(`node request denied (${res.status}); check approval/expiry; revoke and reenroll after a lost exchange`);
  return result;
}
export async function enrollNode(url: string, name: string, insecure = false, dir?: string, display: (s: string) => void = console.log) {
  url = nodeOrigin(url, insecure);
  // Never print/persist the device proof; losing an exchange requires revoke + reenroll.
  const secret = nodeSecret();
  const e = await nodeRequest(url, '/nodes/v1/enrollments', { version: 1, name, platform: platform(), arch: arch(), device_secret_hash: nodeHash(secret), insecure_transport: insecure });
  display(`Enrollment ${e.id}\nCompare code ${e.code} on the administrator board, then approve_node_enrollment. Expires ${e.expires_at}.`);
  while (Date.now() < Date.parse(e.expires_at)) {
    const result = await nodeRequest(url, `/nodes/v1/enrollments/${e.id}/exchange`, { device_secret: secret });
    if (result.token) {
      saveNodeCredential({ version: 1, url, node_id: result.node_id, token: result.token, expires_at: result.expires_at, insecure_transport: insecure }, dir);
      display(`Enrolled ${result.node_id}; credential expires ${result.expires_at}`); return;
    }
    await delay(Math.max(1, Math.min(30, result.retry_after ?? 3)) * 1000);
  }
  throw new Error('enrollment expired; enroll again');
}
export function nodeStatus(dir?: string) {
  const { token: _token, ...status } = readNodeCredential(dir);
  return { ...status, expired: Date.now() >= Date.parse(status.expires_at) };
}
