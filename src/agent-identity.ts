// Agent identity & attestation (gh-20). Leaf module: node builtins only, so the
// store, server, and CLI can all depend on it.
//
// Model:
//  - An agent registers an Ed25519 public key for its agent_id. The first key
//    wins (trust on first use). The registration records the credential binding
//    that was presented (bearer-token fingerprint, platform principal, or
//    "local" for stdio).
//  - Rotation needs the same credential binding plus an attestation signed by
//    the current active key over the new key id. The old key is retired.
//  - Once an agent has an active key, signed actions (claim, lease renewal,
//    release, evidence, completion) must carry an attestation from that key.
//    Policy `identity.require_signatures` extends that to every agent.
//  - An attestation signs action, agent_id, task_id, a timestamp, and a digest
//    of the tool arguments. Timestamps must be within the skew window and
//    strictly increase per key, which blocks replay.
//  - Verified actions stamp {key_id, sig_hash, sig, ts, args_digest} onto every
//    audit event they cause, so evidence stays attributable and re-verifiable.

import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const ATTESTATION_VERSION = "underwright-attest/v1";

/** Tool actions that carry an attestation once an agent has a key. */
export const SIGNED_ACTIONS = ["claim_task", "renew_lease", "release_task", "report_evidence", "complete_task"] as const;
export type SignedAction = (typeof SIGNED_ACTIONS)[number] | "rotate_key";

/** Default clock skew between signer and server. */
export const DEFAULT_SKEW_MS = 5 * 60_000;

export interface Attestation {
  key_id: string;
  /** Signing time, epoch milliseconds. */
  ts: number;
  /** Base64 Ed25519 signature over attestationMessage(). */
  sig: string;
}

export interface AgentKeyRow {
  key_id: string;
  agent_id: string;
  public_key: string;
  status: "active" | "retired";
  binding: string;
  last_ts: number;
  created_at: string;
  retired_at: string | null;
}

/** What a verified action stamps onto its audit events. */
export interface AuditAttestation {
  key_id: string;
  sig_hash: string;
  sig: string;
  ts: number;
  args_digest: string;
}

export type IdentityError = { error: string };

const sha256 = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");

/** Stable JSON: object keys sorted, undefined members dropped. */
export function canonicalJson(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v === undefined ? null : v)).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

/** Digest of the tool arguments a signature covers. agent_id, task_id, and the
 *  attestation itself are excluded: the first two are signed as fields. */
export function argsDigest(args: Record<string, unknown> = {}): string {
  const { agent_id: _a, task_id: _t, attestation: _s, ...rest } = args;
  return sha256(canonicalJson(rest));
}

export function attestationMessage(action: string, agentId: string, taskId: string, args: Record<string, unknown> | undefined, ts: number): string {
  return [ATTESTATION_VERSION, action, agentId, taskId, String(ts), argsDigest(args)].join("\n");
}

/** Parse a PEM (SPKI) Ed25519 public key. Returns the normalized PEM and key id. */
export function parsePublicKey(pem: string): { public_key: string; key_id: string } | IdentityError {
  let key;
  try { key = createPublicKey(pem); } catch { return { error: "public_key is not a valid PEM public key" }; }
  if (key.asymmetricKeyType !== "ed25519") return { error: `public_key must be ed25519, got ${key.asymmetricKeyType}` };
  const der = key.export({ type: "spki", format: "der" });
  return {
    public_key: key.export({ type: "spki", format: "pem" }).toString(),
    key_id: `ed25519:${sha256(der).slice(0, 32)}`,
  };
}

export function generateAgentKeyPair(): { public_key: string; private_key: string; key_id: string } {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const pub = publicKey.export({ type: "spki", format: "pem" }).toString();
  const parsed = parsePublicKey(pub) as { public_key: string; key_id: string };
  return { public_key: parsed.public_key, private_key: privateKey.export({ type: "pkcs8", format: "pem" }).toString(), key_id: parsed.key_id };
}

/** Sign an action with a PEM private key. Used by the CLI and tests. */
export function signAction(privateKeyPem: string, action: string, agentId: string, taskId: string,
  args: Record<string, unknown> = {}, ts = Date.now()): Attestation {
  const priv = createPrivateKey(privateKeyPem);
  const pubPem = createPublicKey(priv).export({ type: "spki", format: "pem" }).toString();
  const parsed = parsePublicKey(pubPem);
  if ("error" in parsed) throw new Error(parsed.error);
  const sig = sign(null, Buffer.from(attestationMessage(action, agentId, taskId, args, ts)), priv).toString("base64");
  return { key_id: parsed.key_id, ts, sig };
}

/** Verify an attestation against a key row. Pure: replay (last_ts) is checked
 *  here and the caller persists `ts` with a conditional update. */
export function verifyAttestation(key: AgentKeyRow, action: string, agentId: string, taskId: string,
  args: Record<string, unknown> | undefined, att: Attestation, now = Date.now(), skewMs = DEFAULT_SKEW_MS): AuditAttestation | IdentityError {
  if (key.status !== "active") return { error: `key ${key.key_id} is retired` };
  if (key.agent_id !== agentId) return { error: `key ${key.key_id} is not registered to ${agentId}` };
  if (!Number.isSafeInteger(att.ts)) return { error: "attestation.ts must be epoch milliseconds" };
  if (Math.abs(now - att.ts) > skewMs) return { error: `attestation timestamp outside the ${Math.round(skewMs / 1000)}s window` };
  if (att.ts <= Number(key.last_ts ?? 0)) return { error: "attestation replayed: ts must increase per key" };
  let ok = false;
  try {
    ok = verify(null, Buffer.from(attestationMessage(action, agentId, taskId, args, att.ts)),
      createPublicKey(key.public_key), Buffer.from(att.sig, "base64"));
  } catch { ok = false; }
  if (!ok) return { error: "attestation signature does not verify" };
  return { key_id: key.key_id, sig_hash: sha256(Buffer.from(att.sig, "base64")), sig: att.sig, ts: att.ts, args_digest: argsDigest(args) };
}

// ── Local key files (CLI). One PEM per agent_id under UNDERWRIGHT_KEY_DIR or ~/.underwright/keys. ──

export function agentKeyDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.UNDERWRIGHT_KEY_DIR || join(homedir(), ".underwright", "keys");
}

export function agentKeyPath(agentId: string, dir = agentKeyDir()): string {
  if (!agentId) throw new Error("--agent is required");
  return join(dir, `${agentId.replace(/[^\w.@-]/g, "_")}.pem`);
}

function publicOf(privatePem: string) {
  const parsed = parsePublicKey(createPublicKey(createPrivateKey(privatePem)).export({ type: "spki", format: "pem" }).toString());
  if ("error" in parsed) throw new Error(parsed.error);
  return parsed;
}

/** Generate and store a private key (0600). Refuses to overwrite unless forced. */
export function createAgentKeyFile(agentId: string, dir = agentKeyDir(), force = false): { path: string; key_id: string; public_key: string } {
  const path = agentKeyPath(agentId, dir);
  if (existsSync(path) && !force) throw new Error(`${path} exists; use --force to replace it (or agent-key rotate)`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const k = generateAgentKeyPair();
  writeFileSync(path, k.private_key, { mode: 0o600 });
  chmodSync(path, 0o600);
  return { path, key_id: k.key_id, public_key: k.public_key };
}

export function readAgentKeyFile(agentId: string, dir = agentKeyDir()): { path: string; private_key: string; key_id: string; public_key: string } {
  const path = agentKeyPath(agentId, dir);
  if (!existsSync(path)) throw new Error(`no key for ${agentId} at ${path}; run: underwright agent-key gen --agent ${agentId}`);
  const private_key = readFileSync(path, "utf8");
  return { path, private_key, ...publicOf(private_key) };
}

/** Rotate locally: sign rotate_key with the current key, install the new key,
 *  keep the old one at <path>.old. Returns register_agent_key arguments. */
export function rotateAgentKeyFile(agentId: string, dir = agentKeyDir(), now = Date.now()) {
  const old = readAgentKeyFile(agentId, dir);
  const next = generateAgentKeyPair();
  const rotation = signAction(old.private_key, "rotate_key", agentId, "", { new_key_id: next.key_id }, now);
  renameSync(old.path, `${old.path}.old`);
  writeFileSync(old.path, next.private_key, { mode: 0o600 });
  chmodSync(old.path, 0o600);
  return { agent_id: agentId, public_key: next.public_key, rotation, retired_key_id: old.key_id, backup: `${old.path}.old` };
}

/** Fingerprint of the credential a request arrived with. Never stores the token. */
export function credentialBinding(opts: { token?: string; principal?: string } = {}): string {
  if (opts.principal) return `principal:${opts.principal}`;
  if (opts.token) return `token:${sha256(opts.token).slice(0, 16)}`;
  return "local";
}

export interface RegisterKeyInput {
  agent_id: string;
  public_key: string;
  binding: string;
  /** Required to rotate: signed by the current active key, action "rotate_key",
   *  task_id "", args { new_key_id }. */
  rotation?: Attestation;
}

export type RegistrationPlan =
  | { kind: "noop"; key_id: string }
  | { kind: "register"; row: Omit<AgentKeyRow, "created_at" | "retired_at"> }
  | { kind: "rotate"; row: Omit<AgentKeyRow, "created_at" | "retired_at">; retire: string; proof: AuditAttestation };

/** Decide what a registration request does, given the agent's existing keys. */
export function planRegistration(existing: AgentKeyRow[], input: RegisterKeyInput, now = Date.now()): RegistrationPlan | IdentityError {
  if (!input.agent_id) return { error: "agent_id is required" };
  const parsed = parsePublicKey(input.public_key);
  if ("error" in parsed) return parsed;
  const row = { key_id: parsed.key_id, agent_id: input.agent_id, public_key: parsed.public_key, status: "active" as const, binding: input.binding, last_ts: 0 };
  if (existing.some((k) => k.key_id === parsed.key_id && k.status === "retired")) return { error: `key ${parsed.key_id} was retired and cannot be reused` };
  const active = existing.find((k) => k.status === "active");
  if (!active) return { kind: "register", row };
  if (active.key_id === parsed.key_id) return { kind: "noop", key_id: active.key_id };
  if (active.binding !== input.binding) return { error: `${input.agent_id} is bound to a different credential; rotation must use the original credential` };
  if (!input.rotation) return { error: `${input.agent_id} already has an active key; rotation needs an attestation from ${active.key_id}` };
  if (input.rotation.key_id !== active.key_id) return { error: `rotation must be signed by the active key ${active.key_id}` };
  const proof = verifyAttestation(active, "rotate_key", input.agent_id, "", { new_key_id: parsed.key_id }, input.rotation, now);
  if ("error" in proof) return { error: `rotation rejected: ${proof.error}` };
  return { kind: "rotate", row, retire: active.key_id, proof };
}

export type VerificationPlan =
  | { kind: "unsigned" }
  | { kind: "verified"; attestation: AuditAttestation }
  | IdentityError;

/** Decide whether an action may proceed. An agent with an active key must sign;
 *  with `required`, unkeyed agents are refused too. */
export function planVerification(active: AgentKeyRow | undefined, required: boolean, action: string, agentId: string,
  taskId: string, args: Record<string, unknown>, att: Attestation | undefined, now = Date.now()): VerificationPlan {
  if (!active) {
    if (required) return { error: `${action} requires a signed attestation: register a key for ${agentId} first (register_agent_key)` };
    if (att) return { error: `${agentId} has no registered key; register one before signing` };
    return { kind: "unsigned" };
  }
  if (!att) return { error: `${agentId} has a registered key (${active.key_id}); ${action} must carry an attestation` };
  if (att.key_id !== active.key_id) return { error: `attestation key ${att.key_id} is not ${agentId}'s active key` };
  const v = verifyAttestation(active, action, agentId, taskId, args, att, now);
  return "error" in v ? v : { kind: "verified", attestation: v };
}
