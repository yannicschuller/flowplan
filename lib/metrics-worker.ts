// Starts the usage statistics (lib/metrics.ts) in the Node.js server
// process (instrumentation.ts): the request counter and, once a minute, the
// writing of what was counted – and the server sample (lib/server-metrics.ts),
// which runs with the usage statistics off too.
import { flushMetrics, metricsTimer, refreshMetricsEnabled } from "./metrics";
import { instanceMetrics } from "./instance-ops";
import { startRequestMetrics } from "./request-metrics";
import { recordServerSample, refreshSizes } from "./server-metrics";

export function startMetricsWorker() {
  startRequestMetrics();
  if (metricsTimer()) return;
  const tick = async () => {
    try {
      await refreshSizes(instanceMetrics);
      await recordServerSample();
    } catch (error) {
      console.error("Server metrics sample failed", error);
    }
    try {
      await refreshMetricsEnabled();
      await flushMetrics(Date.now(), instanceMetrics);
    } catch (error) {
      console.error("Metrics flush failed", error);
    }
  };
  const timer = setInterval(tick, 60_000);
  timer.unref?.();
  metricsTimer(timer);
  setTimeout(tick, 5_000).unref?.();
}
