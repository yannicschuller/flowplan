// Starts the usage statistics (lib/metrics.ts) in the Node.js server
// process (instrumentation.ts): the request counter and, once a minute, the
// writing of what was counted.
import { flushMetrics, metricsTimer, refreshMetricsEnabled } from "./metrics";
import { instanceMetrics } from "./instance-ops";
import { startRequestMetrics } from "./request-metrics";

export function startMetricsWorker() {
  startRequestMetrics();
  if (metricsTimer()) return;
  const tick = () => {
    try {
      refreshMetricsEnabled();
      flushMetrics(Date.now(), instanceMetrics);
    } catch (error) {
      console.error("Metrics flush failed", error);
    }
  };
  const timer = setInterval(tick, 60_000);
  timer.unref?.();
  metricsTimer(timer);
  setTimeout(tick, 5_000).unref?.();
}
