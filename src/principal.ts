import { AsyncLocalStorage } from "node:async_hooks";

/** The authenticated human behind the current request (platform auth, e.g. a
 *  Databricks App forwarded user). Stores stamp it onto every audit event so
 *  agent-supplied agent_id values stay attributable to a real identity.
 *  Leaf module: no src imports, so store/pstore can depend on it. */
const context = new AsyncLocalStorage<string>();

export function runAsPrincipal<T>(principal: string | undefined, work: () => T): T {
  return principal ? context.run(principal, work) : work();
}

export function currentPrincipal(): string | undefined {
  return context.getStore();
}

/** Credential binding of the current request (gh-20): bearer-token fingerprint
 *  or platform principal. Unset on stdio, which binds as "local". */
const credential = new AsyncLocalStorage<string>();

export function runWithCredential<T>(binding: string | undefined, work: () => T): T {
  return binding ? credential.run(binding, work) : work();
}

export function currentCredential(): string | undefined {
  return credential.getStore();
}

/** Verified agent attestation for the action in flight (gh-20). Every audit
 *  event logged inside carries it, so evidence is attributable to a key. */
const attestation = new AsyncLocalStorage<object>();

export function runWithAttestation<T>(att: object | undefined, work: () => T): T {
  return att ? attestation.run(att, work) : work();
}

/** Audit payload with the request principal and attestation attached (unchanged when neither). */
export function withPrincipal(data: unknown): unknown {
  const principal = currentPrincipal();
  const att = attestation.getStore();
  if (!principal && !att) return data;
  const extra: Record<string, unknown> = {};
  if (principal) extra.principal = principal;
  if (att) extra.attestation = att;
  if (data && typeof data === "object" && !Array.isArray(data)) return { ...(data as Record<string, unknown>), ...extra };
  return { value: data, ...extra };
}
