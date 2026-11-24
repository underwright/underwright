import { monitorEventLoopDelay } from "node:perf_hooks";

/** Event-loop stall watchdog (gh-253). The SQLite store executes queries
 *  synchronously, so one long query or busy-wait freezes every HTTP request
 *  including /health while the process still looks "active". This monitor
 *  logs stalls so a wedge can be tied to the window in which it happened
 *  instead of being discovered by timeouts. */
export function startLoopWatch(thresholdMs = 2000, checkMs = 5000): () => void {
  const histogram = monitorEventLoopDelay({ resolution: 20 });
  histogram.enable();
  let last = process.hrtime.bigint();
  let reported = false;
  const timer = setInterval(() => {
    const now = process.hrtime.bigint();
    const driftMs = Number(now - last) / 1e6 - checkMs;
    last = now;
    // percentile(99) covers the interval since the previous reset.
    const p99 = histogram.percentile(99) / 1e6;
    if (driftMs > thresholdMs || p99 > thresholdMs) {
      reported = true;
      console.error(
        `[underwright] event-loop stall: drift=${Math.round(driftMs)}ms ` +
        `p99=${Math.round(p99)}ms max=${Math.round(histogram.max / 1e6)}ms ` +
        `(threshold ${thresholdMs}ms)`,
      );
    } else if (reported) {
      reported = false;
      console.error(`[underwright] event-loop recovered: p99=${Math.round(p99)}ms`);
    }
    histogram.reset();
  }, checkMs);
  timer.unref();
  return () => { clearInterval(timer); histogram.disable(); };
}
