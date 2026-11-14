import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { SqliteStore } from "../src/store.js";
import { createServer } from "../src/server.js";
import { runWithCredential } from "../src/principal.js";
import {
  argsDigest, canonicalJson, createAgentKeyFile, credentialBinding, generateAgentKeyPair, parsePublicKey,
  planRegistration, planVerification, readAgentKeyFile, rotateAgentKeyFile, signAction, verifyAttestation,
  type AgentKeyRow,
} from "../src/agent-identity.js";

// gh-20: agent identity & attestation.
//  agent-keys     — register a public key; signed claim/evidence actions are verified
//  key-bootstrap  — TOFU registration bound to the presenting credential; rotation
//  audit-binding  — audit events written by a signed action carry the signature hash

const DB = "/tmp/uw-test-agent-identity.db";
const NO_POLICY = "/tmp/uw-no-policy.json";
const REQUIRE_POLICY = "/tmp/uw-identity-require.json";
const AGENT = "claude@test";
let store: SqliteStore;

const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const row = (k: { key_id: string; public_key: string }, extra: Partial<AgentKeyRow> = {}): AgentKeyRow => ({
  key_id: k.key_id, agent_id: AGENT, public_key: k.public_key, status: "active", binding: "local", last_ts: 0,
  created_at: "", retired_at: null, ...extra,
});

beforeEach(() => {
  for (const s of ["", "-wal", "-shm"]) rmSync(`${DB}${s}`, { force: true });
  process.env.UNDERWRIGHT_POLICY = NO_POLICY;
  store = new SqliteStore(DB);
});
afterEach(() => {
  store.close();
  process.env.UNDERWRIGHT_POLICY = NO_POLICY;
});

describe("agent-identity primitives", () => {
  it("canonicalJson sorts keys and drops undefined, so digests are order independent", () => {
    expect(canonicalJson({ b: 1, a: [1, undefined], c: undefined })).toBe('{"a":[1,null],"b":1}');
    expect(argsDigest({ ttl_seconds: 60, scope: { paths: ["x"] } })).toBe(argsDigest({ scope: { paths: ["x"] }, ttl_seconds: 60 }));
    // agent_id, task_id and the attestation itself are signed as fields, not in the digest
    expect(argsDigest({ agent_id: "a", task_id: "t", attestation: { x: 1 } })).toBe(argsDigest({}));
  });

  it("parsePublicKey accepts ed25519 only and derives a stable key id", () => {
    const k = generateAgentKeyPair();
    const p = parsePublicKey(k.public_key);
    expect(p).toEqual({ public_key: k.public_key, key_id: k.key_id });
    expect(k.key_id).toMatch(/^ed25519:[0-9a-f]{32}$/);
    const rsa = generateKeyPairSync("rsa", { modulusLength: 1024 }).publicKey.export({ type: "spki", format: "pem" }).toString();
    expect(parsePublicKey(rsa)).toEqual({ error: "public_key must be ed25519, got rsa" });
    expect(parsePublicKey("garbage")).toHaveProperty("error");
  });

  it("verifyAttestation accepts a good signature and rejects tamper, skew, replay, wrong agent, retired key", () => {
    const k = generateAgentKeyPair();
    const now = Date.now();
    const args = { ttl_seconds: 60 };
    const att = signAction(k.private_key, "claim_task", AGENT, "t1", args, now);
    const ok = verifyAttestation(row(k), "claim_task", AGENT, "t1", args, att, now);
    expect(ok).toMatchObject({ key_id: k.key_id, ts: now, sig: att.sig, args_digest: argsDigest(args) });
    expect((ok as any).sig_hash).toBe(sha(Buffer.from(att.sig, "base64")));

    expect(verifyAttestation(row(k), "claim_task", AGENT, "t2", args, att, now)).toEqual({ error: "attestation signature does not verify" });
    expect(verifyAttestation(row(k), "complete_task", AGENT, "t1", args, att, now)).toEqual({ error: "attestation signature does not verify" });
    expect(verifyAttestation(row(k), "claim_task", AGENT, "t1", { ttl_seconds: 7200 }, att, now)).toEqual({ error: "attestation signature does not verify" });
    expect(verifyAttestation(row(k), "claim_task", AGENT, "t1", args, att, now + 10 * 60_000)).toHaveProperty("error", expect.stringContaining("outside"));
    expect(verifyAttestation(row(k, { last_ts: now }), "claim_task", AGENT, "t1", args, att, now)).toHaveProperty("error", expect.stringContaining("replayed"));
    expect(verifyAttestation(row(k, { agent_id: "other@x" }), "claim_task", AGENT, "t1", args, att, now)).toHaveProperty("error", expect.stringContaining("not registered"));
    expect(verifyAttestation(row(k, { status: "retired" }), "claim_task", AGENT, "t1", args, att, now)).toHaveProperty("error", expect.stringContaining("retired"));
  });

  it("planVerification: unkeyed agents pass unsigned unless policy requires signatures; keyed agents must sign", () => {
    const k = generateAgentKeyPair();
    const att = signAction(k.private_key, "claim_task", AGENT, "t1");
    expect(planVerification(undefined, false, "claim_task", AGENT, "t1", {}, undefined)).toEqual({ kind: "unsigned" });
    expect(planVerification(undefined, true, "claim_task", AGENT, "t1", {}, undefined)).toHaveProperty("error", expect.stringContaining("requires a signed attestation"));
    expect(planVerification(undefined, false, "claim_task", AGENT, "t1", {}, att)).toHaveProperty("error", expect.stringContaining("no registered key"));
    expect(planVerification(row(k), false, "claim_task", AGENT, "t1", {}, undefined)).toHaveProperty("error", expect.stringContaining("must carry an attestation"));
    const other = generateAgentKeyPair();
    expect(planVerification(row(k), false, "claim_task", AGENT, "t1", {}, signAction(other.private_key, "claim_task", AGENT, "t1")))
      .toHaveProperty("error", expect.stringContaining("not claude@test's active key"));
    expect(planVerification(row(k), false, "claim_task", AGENT, "t1", {}, att)).toMatchObject({ kind: "verified" });
  });

  it("planRegistration: TOFU, idempotent re-register, rotation needs same binding and a proof from the active key", () => {
    const a = generateAgentKeyPair();
    const b = generateAgentKeyPair();
    expect(planRegistration([], { agent_id: AGENT, public_key: a.public_key, binding: "token:abc" })).toMatchObject({ kind: "register" });
    const existing = [row(a, { binding: "token:abc" })];
    expect(planRegistration(existing, { agent_id: AGENT, public_key: a.public_key, binding: "token:abc" })).toEqual({ kind: "noop", key_id: a.key_id });
    expect(planRegistration(existing, { agent_id: AGENT, public_key: b.public_key, binding: "token:abc" })).toHaveProperty("error", expect.stringContaining("rotation needs"));
    const rotation = signAction(a.private_key, "rotate_key", AGENT, "", { new_key_id: b.key_id });
    expect(planRegistration(existing, { agent_id: AGENT, public_key: b.public_key, binding: "token:zzz", rotation })).toHaveProperty("error", expect.stringContaining("different credential"));
    const forged = signAction(b.private_key, "rotate_key", AGENT, "", { new_key_id: b.key_id });
    expect(planRegistration(existing, { agent_id: AGENT, public_key: b.public_key, binding: "token:abc", rotation: forged })).toHaveProperty("error", expect.stringContaining("signed by the active key"));
    expect(planRegistration(existing, { agent_id: AGENT, public_key: b.public_key, binding: "token:abc", rotation })).toMatchObject({ kind: "rotate", retire: a.key_id });
    expect(planRegistration([row(a, { status: "retired" })], { agent_id: AGENT, public_key: a.public_key, binding: "local" })).toHaveProperty("error", expect.stringContaining("cannot be reused"));
  });

  it("credentialBinding fingerprints the token and never stores it", () => {
    expect(credentialBinding()).toBe("local");
    expect(credentialBinding({ principal: "alan@x" })).toBe("principal:alan@x");
    const b = credentialBinding({ token: "s3cret-token" });
    expect(b).toMatch(/^token:[0-9a-f]{16}$/);
    expect(b).not.toContain("s3cret");
  });

  it("key files: 0600, refuse overwrite, rotation keeps a backup and signs with the old key", () => {
    const dir = mkdtempSync(join(tmpdir(), "uw-keys-"));
    try {
      const k = createAgentKeyFile(AGENT, dir);
      expect(statSync(k.path).mode & 0o777).toBe(0o600);
      expect(() => createAgentKeyFile(AGENT, dir)).toThrow(/exists/);
      const r = rotateAgentKeyFile(AGENT, dir);
      expect(r.retired_key_id).toBe(k.key_id);
      expect(r.rotation.key_id).toBe(k.key_id);
      const next = readAgentKeyFile(AGENT, dir);
      expect(parsePublicKey(r.public_key)).toMatchObject({ key_id: next.key_id });
      expect(statSync(r.backup).isFile()).toBe(true);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe("store: key bootstrap and verification", () => {
  it("first key wins (TOFU); a second key without rotation is refused and audited", () => {
    const a = generateAgentKeyPair();
    const b = generateAgentKeyPair();
    expect(store.registerAgentKey({ agent_id: AGENT, public_key: a.public_key, binding: "token:aaa" })).toMatchObject({ status: "registered", key_id: a.key_id });
    expect(store.registerAgentKey({ agent_id: AGENT, public_key: a.public_key, binding: "token:aaa" })).toMatchObject({ status: "unchanged" });
    expect(store.registerAgentKey({ agent_id: AGENT, public_key: b.public_key, binding: "token:bbb" })).toHaveProperty("error");
    const events = (store.auditLog(100) as any[]).filter(e => e.entity_id === AGENT).map(e => e.action);
    expect(events).toContain("key_registered");
    expect(events).toContain("key_rejected");
    expect(store.listAgentKeys(AGENT)).toHaveLength(1);
  });

  it("rotation retires the old key; the old key can no longer sign", () => {
    const a = generateAgentKeyPair();
    const b = generateAgentKeyPair();
    store.registerAgentKey({ agent_id: AGENT, public_key: a.public_key, binding: "local" });
    const rotation = signAction(a.private_key, "rotate_key", AGENT, "", { new_key_id: b.key_id });
    expect(store.registerAgentKey({ agent_id: AGENT, public_key: b.public_key, binding: "local", rotation })).toMatchObject({ status: "rotated", retired: a.key_id });
    const keys = store.listAgentKeys(AGENT) as any[];
    expect(keys.map(k => [k.key_id, k.status])).toEqual(expect.arrayContaining([[a.key_id, "retired"], [b.key_id, "active"]]));
    const t = store.createTask({ title: "x" }) as any;
    const stale = signAction(a.private_key, "claim_task", AGENT, t.id);
    expect(store.verifyAgentAction({ action: "claim_task", agent_id: AGENT, task_id: t.id, args: {}, attestation: stale })).toHaveProperty("error");
    const fresh = signAction(b.private_key, "claim_task", AGENT, t.id);
    expect(store.verifyAgentAction({ action: "claim_task", agent_id: AGENT, task_id: t.id, args: {}, attestation: fresh })).toMatchObject({ ok: true });
  });

  it("revoke resets TOFU so a lost key can be replaced", () => {
    const a = generateAgentKeyPair();
    const b = generateAgentKeyPair();
    store.registerAgentKey({ agent_id: AGENT, public_key: a.public_key, binding: "local" });
    expect(store.revokeAgentKeys(AGENT, "admin")).toEqual({ agent_id: AGENT, retired: 1 });
    expect(store.registerAgentKey({ agent_id: AGENT, public_key: b.public_key, binding: "local" })).toMatchObject({ status: "registered" });
  });

  it("the same attestation cannot be used twice (replay guard persists last_ts)", () => {
    const a = generateAgentKeyPair();
    store.registerAgentKey({ agent_id: AGENT, public_key: a.public_key, binding: "local" });
    const att = signAction(a.private_key, "renew_lease", AGENT, "t1");
    expect(store.verifyAgentAction({ action: "renew_lease", agent_id: AGENT, task_id: "t1", args: {}, attestation: att })).toMatchObject({ ok: true });
    expect(store.verifyAgentAction({ action: "renew_lease", agent_id: AGENT, task_id: "t1", args: {}, attestation: att })).toHaveProperty("error", expect.stringContaining("replayed"));
  });

  it("policy identity.require_signatures refuses unkeyed agents", () => {
    writeFileSync(REQUIRE_POLICY, JSON.stringify({ identity: { require_signatures: true } }));
    process.env.UNDERWRIGHT_POLICY = REQUIRE_POLICY;
    expect(store.verifyAgentAction({ action: "claim_task", agent_id: "nokey@x", task_id: "t1", args: {} })).toHaveProperty("error", expect.stringContaining("requires a signed attestation"));
    process.env.UNDERWRIGHT_POLICY = NO_POLICY;
    expect(store.verifyAgentAction({ action: "claim_task", agent_id: "nokey@x", task_id: "t1", args: {} })).toEqual({ ok: true });
  });
});

describe("MCP surface: signed claim/evidence and audit binding", () => {
  let client: Client;

  beforeEach(async () => {
    const { server } = createServer(store);
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    client = new Client({ name: "test", version: "0" });
    await client.connect(ct);
  });
  afterEach(async () => { await client.close(); });

  const call = async (name: string, args: Record<string, unknown>) => {
    const r = await client.callTool({ name, arguments: args }) as any;
    return JSON.parse(r.content[0].text);
  };

  it("an agent impersonating a keyed agent_id cannot claim; the key holder can, and its audit events carry the sig hash", async () => {
    const k = generateAgentKeyPair();
    expect(await call("register_agent_key", { agent_id: AGENT, public_key: k.public_key })).toMatchObject({ status: "registered", key_id: k.key_id });
    const keys = await call("list_agent_keys", { agent_id: AGENT });
    expect(keys[0]).toMatchObject({ key_id: k.key_id, binding: "local", status: "active" });

    const t = store.createTask({ title: "signed work", ac_ids: ["ac1"] }) as any;

    // Impersonator: same agent_id, no signature or someone else's key.
    expect(await call("claim_task", { task_id: t.id, agent_id: AGENT })).toHaveProperty("error", expect.stringContaining("must carry an attestation"));
    const mallory = generateAgentKeyPair();
    expect(await call("claim_task", { task_id: t.id, agent_id: AGENT, attestation: signAction(mallory.private_key, "claim_task", AGENT, t.id, { ttl_seconds: 600 }) }))
      .toHaveProperty("error");
    // Signature over different args (ttl tampered) is refused.
    expect(await call("claim_task", { task_id: t.id, agent_id: AGENT, ttl_seconds: 9999, attestation: signAction(k.private_key, "claim_task", AGENT, t.id, { ttl_seconds: 600 }) }))
      .toHaveProperty("error", expect.stringContaining("does not verify"));
    expect((store.getTask(t.id) as any).claim).toBeNull();

    const claimAtt = signAction(k.private_key, "claim_task", AGENT, t.id, { ttl_seconds: 600 });
    expect(await call("claim_task", { task_id: t.id, agent_id: AGENT, ttl_seconds: 600, attestation: claimAtt })).toMatchObject({ task_id: t.id, agent_id: AGENT });

    const ev = { ac_ids: ["ac1"], kind: "test_run", command: "npm test", exit_code: 0, output: "ok" };
    const evAtt = signAction(k.private_key, "report_evidence", AGENT, t.id, ev, claimAtt.ts + 1);
    const evRes = await call("report_evidence", { task_id: t.id, agent_id: AGENT, ...ev, attestation: evAtt });
    expect(evRes).not.toHaveProperty("error");

    // audit-binding: every event the signed actions wrote carries the attestation.
    const events = store.auditLog(200) as any[];
    const signedEvents = events.filter(e => e.actor === AGENT).map(e => ({ action: e.action, data: JSON.parse(e.data ?? "null") }));
    expect(signedEvents.length).toBeGreaterThan(0);
    const claimEv = signedEvents.find(e => e.data?.attestation?.sig === claimAtt.sig);
    const evidenceEv = signedEvents.find(e => e.data?.attestation?.sig === evAtt.sig);
    expect(claimEv?.data.attestation).toMatchObject({ key_id: k.key_id, sig_hash: sha(Buffer.from(claimAtt.sig, "base64")), ts: claimAtt.ts });
    expect(evidenceEv?.action).toBe("reported");
    expect(evidenceEv?.data.attestation).toMatchObject({ key_id: k.key_id, sig_hash: sha(Buffer.from(evAtt.sig, "base64")), args_digest: argsDigest(ev) });

    // The rejected attempts are audited too.
    expect(events.some(e => e.action === "attestation_rejected" && e.entity_id === AGENT)).toBe(true);
  });

  it("registration binds to the request credential; another credential cannot rotate", async () => {
    const a = generateAgentKeyPair();
    const b = generateAgentKeyPair();
    // Stdio registration binds as "local"; simulate an HTTP rotation from a different bearer token.
    await call("register_agent_key", { agent_id: AGENT, public_key: a.public_key });
    const rotation = signAction(a.private_key, "rotate_key", AGENT, "", { new_key_id: b.key_id });
    const res = await runWithCredential(credentialBinding({ token: "other" }),
      () => store.registerAgentKey({ agent_id: AGENT, public_key: b.public_key, binding: credentialBinding({ token: "other" }), rotation }));
    expect(res).toHaveProperty("error", expect.stringContaining("different credential"));
    expect(await call("register_agent_key", { agent_id: AGENT, public_key: b.public_key, rotation })).toMatchObject({ status: "rotated" });
  });

  it("unkeyed agents keep working unsigned (backward compatible)", async () => {
    const t = store.createTask({ title: "legacy" }) as any;
    expect(await call("claim_task", { task_id: t.id, agent_id: "legacy@x" })).toMatchObject({ agent_id: "legacy@x" });
  });
});
