// Seat/account-aware quota marks (gh-191): quota is per-account but providers
// run multiple accounts ("seats"). Pure helpers shared by SqliteStore and
// PgStore — seat identity rides in a job spec's env, the roster in policy.
//
// Seat env contract (generic, not codex-specific):
//   UW_SEAT            explicit seat/account name for any harness
//   CODEX_HOME         codex seat dir; the basename is the seat name
//   UW_SEATS_TRIED     comma list of seats proven dead (written by failover)
//   UW_CODEX_SEATS_TRIED legacy alias, read and written for interop with the
//                      wip watch's failover format
// Policy roster: watch.seats[harness] (generic) or watch.codex_seats (codex).

/** Last path segment of a seat dir, trailing slashes stripped. Fleet
 *  convention is dotdirs like ~/.codex-seat-gmail — normalize to the bare
 *  seat name ("gmail") so env-carried names, roster paths and quota row keys
 *  all compare equal. UW_SEAT values pass through untouched (no prefix). */
export function seatNameOf(seat: string): string {
  const base = seat.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? seat;
  if (!base) return seat;
  const stripped = base.replace(/^\.+/, "").replace(/^(?:codex[-_])?seat[-_]/i, "");
  return stripped || base;
}

/** Seat identity carried by a job spec's env, or null when unnamed. */
export function seatKeyOfEnv(env: Record<string, unknown> | undefined | null): string | null {
  const explicit = env?.UW_SEAT;
  if (typeof explicit === "string" && explicit.trim()) return explicit.trim();
  const home = env?.CODEX_HOME;
  if (typeof home === "string" && home.trim()) return seatNameOf(home.trim());
  return null;
}

/** Seats proven dead so far, by name (paths normalized). */
export function triedSeatsOfEnv(env: Record<string, unknown> | undefined | null): Set<string> {
  const out = new Set<string>();
  for (const key of ["UW_SEATS_TRIED", "UW_CODEX_SEATS_TRIED"]) {
    const raw = env?.[key];
    if (typeof raw !== "string") continue;
    for (const part of raw.split(",")) if (part.trim()) out.add(seatNameOf(part.trim()));
  }
  return out;
}

export interface SeatPolicy {
  watch?: {
    seats?: Record<string, string[]>;
    codex_seats?: string[];
  };
}

/** Seat roster (full dirs) for a harness from policy; empty when none.
 *  Accepts the parsed policy JSON untyped — the watch block is optional. */
export function seatRosterFor(harness: string, policy: unknown): string[] {
  const watch = (policy as SeatPolicy | undefined | null)?.watch;
  const generic = watch?.seats?.[harness];
  if (Array.isArray(generic) && generic.length) return generic.filter(s => typeof s === "string" && s.trim());
  if (harness === "codex" && Array.isArray(watch?.codex_seats)) return watch.codex_seats.filter(s => typeof s === "string" && s.trim());
  return [];
}

/** First roster seat not in the tried set, or null when the roster is spent. */
export function nextUntriedSeat(env: Record<string, unknown> | undefined | null, roster: readonly string[]): string | null {
  const tried = triedSeatsOfEnv(env);
  return roster.find(s => !tried.has(seatNameOf(s))) ?? null;
}

/** provider_quota row key: seat-keyed marks never equal a bare provider id,
 *  so dispatch only overlays provider-level marks onto node capabilities. */
export function quotaRowKey(provider: string, seat: string): string {
  return `${provider}:${seat}`;
}

/** LIKE pattern matching every seat-keyed row of a provider. */
export function seatRowsLike(provider: string): string {
  return `${provider}:%`;
}

/** Env update for a failover resubmit: try the next seat and record the dead
 *  seats (including the one about to be tried, so its failure advances the
 *  roster instead of re-proving it). */
export function failoverEnv(env: Record<string, unknown> | undefined, deadSeat: string | null, nextSeat: string): Record<string, string> {
  const tried = triedSeatsOfEnv(env);
  if (deadSeat) tried.add(deadSeat);
  tried.add(seatNameOf(nextSeat));
  const list = [...tried].join(",");
  const out: Record<string, string> = { ...(env as Record<string, string> ?? {}), UW_SEATS_TRIED: list, UW_CODEX_SEATS_TRIED: list, CODEX_HOME: nextSeat };
  return out;
}
