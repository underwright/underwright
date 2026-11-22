import type { IStore } from "./istore.js";

/** Close-out drain: in_review is the parking lot for delivered work (gh-224
 *  showed nothing exits it on its own). Each tick attempts completeTask on a
 *  bounded slice — evidence-satisfied tasks close; the rest are left for
 *  humans/agents. `scoped` skips dispatchNext so sweep closes don't send
 *  next-task mail to a non-agent actor. */
const IN_REVIEW_SWEEP_BATCH = 5;

async function sweepInReview(store: Partial<Pick<IStore, "listTasks" | "completeTask">>, onError: (e: unknown) => void) {
  if (!store.listTasks || !store.completeTask) return;
  const parked = await store.listTasks("in_review");
  for (const t of (parked ?? []).slice(0, IN_REVIEW_SWEEP_BATCH)) {
    try {
      // Error objects (unproven ac_ids, foreign claim) mean "not closable
      // yet" — the store already logs completions, nothing else to do.
      await store.completeTask(t.id, "sweeper", true);
    } catch (error) {
      onError(error);
    }
  }
}

/** One sweep at startup, then every minute. Stop waits for in-flight work. */
export function startLeaseSweeper(
  store: Pick<IStore, "sweepExpiredClaims"> & Partial<Pick<IStore, "sweepIdleDispatches" | "sweepExpiredNodeJobs" | "listTasks" | "completeTask">>,
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
          await sweepInReview(store, onError);
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
