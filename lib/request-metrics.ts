// Counts the HTTP requests of the server for the monitoring (lib/metrics.ts)
// without touching any request: Node's built-in diagnostics channels report
// when a request starts and when its response is finished – for every
// request of the Node.js server (pages, API, uploads), whatever the proxy
// (proxy.ts) or route handler did with it. The edge runtime is not involved.
//
// Left out: build files, fonts and icons (cached by the browser, they would
// only add noise), the health check and the Prometheus endpoint (polled by
// machines). Event streams count as a request, not with their duration.
import diagnosticsChannel from "node:diagnostics_channel";
import type { IncomingMessage, ServerResponse } from "node:http";
import { noteRequest } from "./metrics";

const SKIP = /^\/(?:_next\/(?:static|image|webpack-hmr)|__nextjs|fonts\/|icons\/|favicon\.ico|sw\.js|manifest\.webmanifest|icon\.svg|fonts\.css|api\/health(?:[/?]|$)|api\/metrics(?:[/?]|$))/;

export function countedPath(url: string | undefined) {
  return !SKIP.test(url || "/");
}

const holder = globalThis as unknown as { flowplanRequestMetrics?: boolean };
type Message = { request: IncomingMessage; response: ServerResponse };

export function startRequestMetrics() {
  if (holder.flowplanRequestMetrics) return;
  holder.flowplanRequestMetrics = true;
  const started = new WeakMap<object, number>();
  diagnosticsChannel.subscribe("http.server.request.start", (message) => {
    const { request, response } = message as Message;
    if (countedPath(request?.url)) started.set(response, performance.now());
  });
  diagnosticsChannel.subscribe("http.server.response.finish", (message) => {
    const { response } = message as Message;
    const start = started.get(response);
    if (start === undefined) return;
    started.delete(response);
    try {
      const type = String(response.getHeader("content-type") || "");
      noteRequest(response.statusCode, type.startsWith("text/event-stream") ? null : performance.now() - start);
    } catch {
      // Counting never disturbs a request.
    }
  });
}
