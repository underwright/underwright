import { randomUUID } from "node:crypto";
import type { IStore } from "./istore.js";

/** One sweep at startup, then every minute. Stop waits for in-flight work.
 *  When the store supports sweeperLeadership, only the lease holder sweeps —
 *  extra spawned serve instances stay inert. */
export function startLeaseSweeper(
  store: Pick<IStore, "sweepExpiredClaims"> & Partial<Pick<IStore, "sweepIdleDispatches" | "sweepExpiredNodeJobs" | "sweepSdlc" | "sweeperLeadership">>,
  intervalMs = 60_000,
  onError: (error: unknown) => void = error => console.error("[underwright] lease sweep failed:", error),
) {
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
    throw new RangeError("lease sweep interval must be positive and finite");
  }
  let stopped = false;
  let running = false;
  const instanceId = `cp-${randomUUID().slice(0, 8)}`;
  let pending = Promise.resolve();
  const tick = () => {
    if (stopped || running) return;
    running = true;
    pending = (async () => {
      try {
        if (store.sweeperLeadership && !(await store.sweeperLeadership(instanceId))) return;
        try {
          await store.sweepExpiredClaims();
        } catch (error) {
          onError(error);
        }
        try {
          await store.sweepIdleDispatches?.();
        } catch (error) {
          onError(error);
        }
        try {
          await store.sweepExpiredNodeJobs?.();
        } catch (error) {
          onError(error);
        }
        try {
          await store.sweepSdlc?.();
        } catch (error) {
          onError(error);
        }
      } finally {
        running = false;
      }
    })();
  };
  const timer = setInterval(tick, intervalMs);
  timer.unref();
  tick();
  return async () => {
    stopped = true;
    clearInterval(timer);
    await pending;
  };
}
