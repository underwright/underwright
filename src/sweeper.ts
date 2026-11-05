import type { IStore } from "./istore.js";

/** One sweep at startup, then every minute. Stop waits for in-flight work. */
export function startLeaseSweeper(
  store: Pick<IStore, "sweepExpiredClaims">,
  intervalMs = 60_000,
  onError: (error: unknown) => void = error => console.error("[underwright] lease sweep failed:", error),
) {
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
    throw new RangeError("lease sweep interval must be positive and finite");
  }
  let stopped = false;
  let running = false;
  let pending = Promise.resolve();
  const tick = () => {
    if (stopped || running) return;
    running = true;
    pending = (async () => {
      try {
        await store.sweepExpiredClaims();
      } catch (error) {
        onError(error);
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
