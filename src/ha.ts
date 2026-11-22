import postgres from "postgres";
import { PgStore } from "./pstore.js";

export type HaState = "standby" | "acquiring" | "active" | "draining";

export interface HaReadiness {
  ready: boolean;
  state: HaState;
  domain_id: string;
  instance_id: string;
  holder_id: string | null;
  generation: number;
  epoch: number;
  lease_expires_at: string | null;
  reason: string | null;
}

export interface HaConfig {
  domainId: string;
  instanceId: string;
  adminUrl: string;
  ttlMs?: number;
  heartbeatMs?: number;
  admissionMarginMs?: number;
  onStateChange?: (state: HaState, readiness: HaReadiness) => void;
}

export class FencedWriteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FencedWriteError";
  }
}

const NAME = /^[A-Za-z0-9_-]{1,32}$/;

function checkName(value: string, label: string): string {
  if (!NAME.test(value)) throw new Error(`invalid ${label}: ${value}`);
  return value;
}

export function roleName(instanceId: string): string {
  return `uw_cp_${checkName(instanceId, "instance id").toLowerCase().replace(/[^a-z0-9_]/g, "_")}`;
}

export function roleUrl(adminUrl: string, instanceId: string, password: string): string {
  const url = new URL(adminUrl);
  url.username = roleName(instanceId);
  url.password = password;
  return url.toString();
}

export function epochOf(value: string | null | undefined): number | null {
  if (value == null || !/^\d+$/.test(value)) return null;
  return Number(value);
}

export function isFenced(epoch: number | null, generation: number): boolean {
  return epoch == null || epoch !== generation;
}

export interface MigrateOptions {
  domainId: string;
  instanceIds: string[];
  rolePassword: string;
}

export async function migrateHa(adminUrl: string, options: MigrateOptions): Promise<void> {
  const domain = checkName(options.domainId, "domain id");
  const instances = options.instanceIds.map(id => checkName(id, "instance id"));
  const sql = postgres(adminUrl, { max: 3, onnotice: () => {} });
  try {
    await sql`SELECT pg_advisory_lock(hashtext(${`uw-ha:${domain}`}))`;
    const core = await PgStore.connect(adminUrl);
    await core.close();
    const group = `uw_cp_${domain}_group`;
    await sql.unsafe(`
      CREATE TABLE IF NOT EXISTS uw_cp_leader (
        domain_id text PRIMARY KEY,
        holder_id text,
        role_name text,
        generation bigint NOT NULL DEFAULT 0,
        lease_expires_at timestamptz,
        updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
      );
      CREATE TABLE IF NOT EXISTS uw_cp_members (
        domain_id text NOT NULL,
        instance_id text NOT NULL,
        role_name text NOT NULL,
        epoch bigint NOT NULL DEFAULT 0,
        PRIMARY KEY (domain_id, instance_id)
      );
      CREATE TABLE IF NOT EXISTS uw_ha_events (
        id bigserial PRIMARY KEY,
        domain_id text NOT NULL,
        kind text NOT NULL,
        instance_id text NOT NULL,
        generation bigint,
        detail text,
        at timestamptz NOT NULL DEFAULT clock_timestamp()
      );
      CREATE OR REPLACE FUNCTION uw_fenced_write() RETURNS trigger LANGUAGE plpgsql AS $fn$
      DECLARE
        claim text := current_setting('uw.epoch', true);
        dom text := current_setting('uw.domain', true);
        gen bigint;
      BEGIN
        SELECT generation INTO gen FROM uw_cp_leader WHERE domain_id = dom;
        IF gen IS NULL THEN
          RAISE EXCEPTION 'fenced: no leader for domain %', dom;
        END IF;
        IF claim IS NULL OR claim !~ '^[0-9]+$' OR claim::bigint <> gen THEN
          RAISE EXCEPTION 'fenced: epoch % != generation %', coalesce(claim, '<missing>'), gen;
        END IF;
        RETURN NEW;
      END $fn$;
      CREATE OR REPLACE FUNCTION uw_fenced_delete() RETURNS trigger LANGUAGE plpgsql AS $fn$
      DECLARE
        claim text := current_setting('uw.epoch', true);
        dom text := current_setting('uw.domain', true);
        gen bigint;
      BEGIN
        SELECT generation INTO gen FROM uw_cp_leader WHERE domain_id = dom;
        IF gen IS NULL THEN
          RAISE EXCEPTION 'fenced: no leader for domain %', dom;
        END IF;
        IF claim IS NULL OR claim !~ '^[0-9]+$' OR claim::bigint <> gen THEN
          RAISE EXCEPTION 'fenced: epoch % != generation %', coalesce(claim, '<missing>'), gen;
        END IF;
        RETURN OLD;
      END $fn$;
    `);
    await sql`
      INSERT INTO uw_cp_leader (domain_id, generation) VALUES (${domain}, 0)
      ON CONFLICT (domain_id) DO NOTHING
    `;
    const groupExists = await sql`SELECT 1 FROM pg_roles WHERE rolname = ${group}`;
    if (groupExists.length === 0) await sql.unsafe(`CREATE ROLE "${group}"`);
    for (const id of instances) {
      const role = roleName(id);
      const password = options.rolePassword.replace(/'/g, "''");
      const existing = await sql`SELECT 1 FROM pg_roles WHERE rolname = ${role}`;
      if (existing.length === 0) {
        await sql.unsafe(`CREATE ROLE "${role}" LOGIN PASSWORD '${password}'`);
      }
      await sql.unsafe(`ALTER ROLE "${role}" WITH LOGIN PASSWORD '${password}'`);
      await sql.unsafe(`ALTER ROLE "${role}" SET uw.domain = '${domain}'`);
      await sql.unsafe(`GRANT "${group}" TO "${role}"`);
      await sql.unsafe(`GRANT USAGE, CREATE ON SCHEMA public TO "${role}"`);
      await sql.unsafe(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO "${role}"`);
      await sql.unsafe(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO "${role}"`);
      await sql.unsafe(`REVOKE INSERT, UPDATE, DELETE ON uw_cp_leader, uw_cp_members, uw_ha_events FROM "${role}"`);
      await sql`
        INSERT INTO uw_cp_members (domain_id, instance_id, role_name, epoch)
        VALUES (${domain}, ${id}, ${role}, 0)
        ON CONFLICT (domain_id, instance_id) DO NOTHING
      `;
    }
    await sql.unsafe(`
      DO $do$
      DECLARE t record;
      BEGIN
        FOR t IN SELECT tablename FROM pg_tables
                 WHERE schemaname = current_schema() AND tablename NOT LIKE 'uw_%' LOOP
          EXECUTE format('ALTER TABLE %I OWNER TO "${group}"', t.tablename);
          EXECUTE format('DROP TRIGGER IF EXISTS uw_fence_write ON %I', t.tablename);
          EXECUTE format('DROP TRIGGER IF EXISTS uw_fence_delete ON %I', t.tablename);
          EXECUTE format('CREATE TRIGGER uw_fence_write BEFORE INSERT OR UPDATE ON %I
                          FOR EACH ROW EXECUTE FUNCTION uw_fenced_write()', t.tablename);
          EXECUTE format('CREATE TRIGGER uw_fence_delete BEFORE DELETE ON %I
                          FOR EACH ROW EXECUTE FUNCTION uw_fenced_delete()', t.tablename);
        END LOOP;
      END $do$;
    `);
  } finally {
    await sql`SELECT pg_advisory_unlock(hashtext(${`uw-ha:${domain}`}))`;
    await sql.end();
  }
}

interface LeaderRow {
  holder_id: string | null;
  role_name: string | null;
  generation: string | number;
  lease_expires_at: string | null;
}

export class HaController {
  private sql: postgres.Sql | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private currentState: HaState = "standby";
  private currentGeneration = 0;
  private currentEpoch = 0;
  private leader: LeaderRow | null = null;
  private ticking: Promise<void> | null = null;
  private readonly domain: string;
  private readonly instance: string;
  private readonly adminUrl: string;
  private readonly ttlMs: number;
  private readonly heartbeatMs: number;
  private readonly marginMs: number;
  private readonly onStateChange?: HaConfig["onStateChange"];

  constructor(config: HaConfig) {
    this.domain = checkName(config.domainId, "domain id");
    this.instance = checkName(config.instanceId, "instance id");
    this.adminUrl = config.adminUrl;
    this.ttlMs = config.ttlMs ?? 30_000;
    this.heartbeatMs = config.heartbeatMs ?? 5_000;
    this.marginMs = config.admissionMarginMs ?? 5_000;
    if (this.marginMs >= this.ttlMs) throw new Error("admission margin must be shorter than ttl");
    this.onStateChange = config.onStateChange;
  }

  get state(): HaState {
    return this.currentState;
  }

  get generation(): number {
    return this.currentGeneration;
  }

  async start(): Promise<void> {
    if (this.sql) return;
    this.sql = postgres(this.adminUrl, { max: 3, onnotice: () => {} });
    const members = await this.sql`
      SELECT epoch FROM uw_cp_members WHERE domain_id = ${this.domain} AND instance_id = ${this.instance}
    `;
    this.currentEpoch = members.length ? Number(members[0].epoch) : 0;
    await this.refreshLeader();
    const generation = Number(this.leader?.generation ?? 0);
    this.currentGeneration = generation;
    if (this.leader?.holder_id === this.instance && generation === this.currentEpoch && this.leaseAlive()) {
      this.transition("active");
    } else {
      this.transition("standby");
    }
    this.timer = setInterval(() => void this.tick(), this.heartbeatMs);
    this.timer.unref?.();
    await this.tick();
  }

  async stop(release = true): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.tickPromise) await this.tickPromise;
    if (this.sql && release && this.currentState === "active") await this.release();
    if (this.sql) await this.sql.end();
    this.sql = null;
    this.currentState = "standby";
  }

  readiness(): HaReadiness {
    const holder = this.leader?.holder_id ?? null;
    const stale = holder !== this.instance || (Number(this.leader?.generation ?? 0) > this.currentGeneration);
    const expiring = !this.leaseAlive();
    let reason: string | null = null;
    if (this.currentState !== "active") reason = `state=${this.currentState}`;
    else if (stale) reason = "leader changed";
    else if (expiring) reason = "lease expired";
    return {
      ready: this.currentState === "active" && !stale && !expiring,
      state: this.currentState,
      domain_id: this.domain,
      instance_id: this.instance,
      holder_id: holder,
      generation: Number(this.leader?.generation ?? this.currentGeneration),
      epoch: this.currentEpoch,
      lease_expires_at: this.leader?.lease_expires_at ?? null,
      reason,
    };
  }

  assertWritable(): void {
    const r = this.readiness();
    if (!r.ready) throw new FencedWriteError(r.reason ?? "not leader");
    if (this.leaseMsLeft() <= this.marginMs) throw new FencedWriteError("lease within admission margin");
  }

  leaderState(): LeaderRow | null {
    return this.leader;
  }

  private leaseAlive(): boolean {
    return this.leaseMsLeft() > 0;
  }

  private leaseMsLeft(): number {
    if (!this.leader?.lease_expires_at) return -1;
    return new Date(this.leader.lease_expires_at).getTime() - Date.now();
  }

  private transition(state: HaState): void {
    if (this.currentState === state) return;
    this.currentState = state;
    this.onStateChange?.(state, this.readiness());
  }

  private async refreshLeader(): Promise<void> {
    if (!this.sql) return;
    const rows = await this.sql`
      SELECT holder_id, role_name, generation, lease_expires_at
      FROM uw_cp_leader WHERE domain_id = ${this.domain}
    `;
    this.leader = rows[0] as LeaderRow | undefined ?? null;
  }

  private get tickPromise(): Promise<void> | null {
    return this.ticking;
  }

  private async tick(): Promise<void> {
    if (this.ticking) return this.ticking;
    this.ticking = this.runTick().finally(() => { this.ticking = null; });
    return this.ticking;
  }

  private async runTick(): Promise<void> {
    if (!this.sql) return;
    try {
      await this.refreshLeader();
      const generation = Number(this.leader?.generation ?? 0);
      if (this.currentState === "active") {
        if (this.leader?.holder_id !== this.instance || generation !== this.currentGeneration) {
          await this.demote("lost leadership");
          return;
        }
        await this.renew();
        return;
      }
      if (this.leader?.holder_id === this.instance && generation === this.currentEpoch && this.leaseAlive()) {
        this.currentGeneration = generation;
        this.transition("active");
        return;
      }
      if (generation > this.currentGeneration) this.currentGeneration = generation;
      if (!this.leaseAlive()) await this.acquire();
    } catch (error) {
      if (this.currentState === "active") await this.demote(error instanceof Error ? error.message : "renewal failed");
    }
  }

  private async acquire(): Promise<void> {
    if (!this.sql) return;
    this.transition("acquiring");
    const sql = this.sql;
    const acquired = await sql.begin(async tx => {
      const rows = await tx`
        SELECT holder_id, generation, lease_expires_at
        FROM uw_cp_leader WHERE domain_id = ${this.domain} FOR UPDATE
      `;
      const row = rows[0] as LeaderRow | undefined;
      const generation = Number(row?.generation ?? 0);
      if (row?.holder_id && row.lease_expires_at && new Date(row.lease_expires_at).getTime() > Date.now()) {
        return null;
      }
      const next = generation + 1;
      const role = roleName(this.instance);
      await tx.unsafe(`ALTER ROLE "${role}" SET uw.epoch = '${next}'`);
      await tx`
        UPDATE uw_cp_leader
        SET holder_id = ${this.instance}, role_name = ${role}, generation = ${next},
            lease_expires_at = clock_timestamp() + ${this.ttlMs} * interval '1 millisecond',
            updated_at = clock_timestamp()
        WHERE domain_id = ${this.domain}
      `;
      await tx`
        UPDATE uw_cp_members SET epoch = ${next}
        WHERE domain_id = ${this.domain} AND instance_id = ${this.instance}
      `;
      await tx`
        SELECT pg_terminate_backend(pid) FROM pg_stat_activity
        WHERE usename IN (SELECT role_name FROM uw_cp_members WHERE domain_id = ${this.domain})
          AND pid <> pg_backend_pid()
      `;
      await tx`
        INSERT INTO uw_ha_events (domain_id, kind, instance_id, generation, detail)
        VALUES (${this.domain}, 'acquire', ${this.instance}, ${next}, ${`ttl_ms=${this.ttlMs}`})
      `;
      return next;
    });
    if (acquired == null) {
      this.transition("standby");
      await this.refreshLeader();
      return;
    }
    this.currentGeneration = acquired;
    this.currentEpoch = acquired;
    await this.refreshLeader();
    this.transition("active");
  }

  private async renew(): Promise<void> {
    if (!this.sql) return;
    const rows = await this.sql`
      UPDATE uw_cp_leader
      SET lease_expires_at = clock_timestamp() + ${this.ttlMs} * interval '1 millisecond',
          updated_at = clock_timestamp()
      WHERE domain_id = ${this.domain} AND holder_id = ${this.instance}
        AND generation = ${this.currentGeneration}
      RETURNING lease_expires_at
    `;
    if (!rows.length) {
      await this.demote("lease renewal rejected");
      return;
    }
    this.leader = { ...(this.leader as LeaderRow), lease_expires_at: (rows[0] as any).lease_expires_at };
  }

  private async demote(reason: string): Promise<void> {
    this.transition("draining");
    if (this.sql) {
      await this.sql`
        INSERT INTO uw_ha_events (domain_id, kind, instance_id, generation, detail)
        VALUES (${this.domain}, 'demote', ${this.instance}, ${this.currentGeneration}, ${reason})
      `;
    }
    await this.refreshLeader();
    this.currentGeneration = Number(this.leader?.generation ?? this.currentGeneration);
    this.transition("standby");
  }

  private async release(): Promise<void> {
    if (!this.sql) return;
    await this.sql`
      UPDATE uw_cp_leader
      SET holder_id = NULL, role_name = NULL, lease_expires_at = NULL, updated_at = clock_timestamp()
      WHERE domain_id = ${this.domain} AND holder_id = ${this.instance}
        AND generation = ${this.currentGeneration}
    `;
    await this.sql`
      INSERT INTO uw_ha_events (domain_id, kind, instance_id, generation, detail)
      VALUES (${this.domain}, 'release', ${this.instance}, ${this.currentGeneration}, 'shutdown')
    `;
  }
}
