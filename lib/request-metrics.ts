// Counts the HTTP requests of the server for the monitoring (lib/metrics.ts)
// without touching any request: Node's built-in diagnostics channels report
// when a request starts and when its response is finished – for every
// request of the Node.js server (pages, API, uploads), whatever the proxy
// (proxy.ts) or route handler did with it. The edge runtime is not involved.
//
// Left out: build files, fonts and icons (cached by the browser, they would
// only add noise), the health check and the Prometheus endpoint (polled by
// machines). Event streams count as a request, not with their duration.
//
// Each counted request is also a span of the CPU per area
// (lib/server-metrics.ts): "pages" or "api", "live" for cursor and presence
// requests – except event streams (Accept: text/event-stream), which wait
// most of their life and are only counted as open streams.
import diagnosticsChannel from "node:diagnostics_channel";
import type { IncomingMessage, ServerResponse } from "node:http";
import { COMMAND_ROUTE, noteRequest, routeKey } from "./metrics";
import { enterArea, noteStream, type CpuArea } from "./server-metrics";
import { clientAddress } from "./client-address";
import { noteRefusal } from "./security-detect";
import { securityEvent } from "./security-events";
import { enterRequest, newRequestId, roleOf, REQUEST_ID_HEADER, type RequestContext } from "./request-context";
import { captureError } from "./error-details";

const SKIP = /^\/(?:_next\/(?:static|image|webpack-hmr)|__nextjs|fonts\/|icons\/|favicon\.ico|sw\.js|manifest\.webmanifest|icon\.svg|fonts\.css|api\/health(?:[/?]|$)|api\/metrics(?:[/?]|$))/;

export function countedPath(url: string | undefined) {
  return !SKIP.test(url || "/");
}
// The CPU area of a request by its address (the command handler moves
// live-sync and AI work on, lib/api.ts and lib/ai/run.ts).
export function requestArea(url: string | undefined): CpuArea {
  const path = (url || "/").split("?")[0];
  if (!path.startsWith("/api/")) return "pages";
  if (/\/(?:cursors|presence)(?:\/|$)/.test(path)) return "live";
  return "api";
}

const holder = globalThis as unknown as { flowplanRequestMetrics?: boolean };
type Message = { request: IncomingMessage; response: ServerResponse };
type Started = { at: number; route: string | null; done?: () => void; stream?: boolean; context?: RequestContext };

export function startRequestMetrics() {
  if (holder.flowplanRequestMetrics) return;
  holder.flowplanRequestMetrics = true;
  const started = new WeakMap<object, Started>();
  diagnosticsChannel.subscribe("http.server.request.start", (message) => {
    const { request, response } = message as Message;
    if (!countedPath(request?.url)) {
      enterRequest(undefined);
      return;
    }
    try {
      const stream = String(request.headers?.accept || "").includes("text/event-stream");
      if (stream) noteStream(1);
      const route = routeKey(request.method, request.url);
      // The request's id and context for the error details (lib/error-details.ts):
      // carried by everything this request runs, and named in the answer.
      const context: RequestContext = { id: newRequestId(), method: route.split(" ")[0], route };
      enterRequest(context);
      if (!response.headersSent) response.setHeader(REQUEST_ID_HEADER, context.id);
      started.set(response, {
        context,
        at: performance.now(),
        // /api/command is listed per action (noteCommand in lib/api.ts).
        route: route === COMMAND_ROUTE ? null : route,
        done: stream ? undefined : enterArea(requestArea(request.url)),
        stream,
      });
    } catch {
      // Counting never disturbs a request.
    }
  });
  const finish = (response: ServerResponse) => {
    const entry = started.get(response);
    if (!entry) return null;
    started.delete(response);
    entry.done?.();
    if (entry.stream) noteStream(-1);
    return entry;
  };
  diagnosticsChannel.subscribe("http.server.response.finish", async (message) => {
    const { response } = message as Message;
    const entry = finish(response);
    await noteProbe(response);
    if (!entry) return;
    try {
      const type = String(response.getHeader("content-type") || "");
      noteRequest(response.statusCode, type.startsWith("text/event-stream") ? null : performance.now() - entry.at, Date.now(), entry.route);
    } catch {
      // Counting never disturbs a request.
    }
    noteFailure(response.statusCode, entry.context);
  });
  // A connection that closes before its response ends (an event stream the
  // browser left) never finishes: its span and stream end here.
  diagnosticsChannel.subscribe("http.server.request.start", (message) => {
    const { response } = message as Message;
    if (!started.has(response)) return;
    response.once("close", () => {
      if (!response.writableFinished) finish(response);
    });
  });
}

// An answer with status ≥ 500 is kept in detail (lib/error-details.ts) with
// the exception the request noted, if any – and so is an exception Next.js
// reported for a request that still answered below 500 (server rendering
// that showed an error boundary).
export function noteFailure(status: number, context: RequestContext | undefined) {
  if (!context || !(status >= 500 || context.error !== undefined)) return;
  captureError({ method: context.method, route: context.route, action: context.action, status, requestId: context.id, role: roleOf(context), error: context.error });
}

// Refused API requests per address (lib/security-detect.ts): many of them in
// a short time are someone probing for addresses and ids.
async function noteProbe(response: ServerResponse) {
  try {
    const status = response.statusCode;
    if (status !== 401 && status !== 403 && status !== 404) return;
    const request = (response as ServerResponse & { req?: IncomingMessage }).req;
    const path = request?.url || "";
    if (!path.startsWith("/api/")) return;
    const headers = new Headers();
    for (const name of ["x-forwarded-for", "x-real-ip", "user-agent"]) {
      const value = request?.headers[name];
      if (typeof value === "string") headers.set(name, value);
    }
    const address = clientAddress(headers);
    await noteRefusal(address, status, path, Date.now(), (detail) => securityEvent("request.probing", { headers, detail }));
  } catch {
    // Counting never disturbs a request.
  }
}
