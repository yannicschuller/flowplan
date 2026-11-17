// What the server knows about the request it is working on, for the error
// details of the monitoring (lib/error-details.ts): a request id, its route
// pattern, the command it runs and the kind of caller – and the exception
// that made it answer with a 5xx.
//
// The context starts with the request (lib/request-metrics.ts, from Node's
// diagnostics channel "http.server.request.start") and travels with the
// async work of that request (AsyncLocalStorage), so a route handler's
// `catch` (serverError below), the command handler (lib/api.ts) and Next's
// onRequestError (instrumentation.ts) can add to it without knowing the
// request. Outside a request (tests, workers) there is no context and every
// function here does nothing.
//
// Privacy: an id, a route pattern (lib/metrics.ts routeKey – never a path as
// typed, no query string), a command name and a role. No address, no body,
// no person.
import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";

export type CallerRole = "admin" | "member" | "demo" | "guest" | "anonymous" | "token" | "mcp";
export type RequestContext = {
  id: string;
  method: string;
  // routeKey() of the request: "GET /api/pages/:id".
  route: string;
  // A command of /api/command (lib/api.ts): "row.update".
  action?: string;
  role?: CallerRole;
  // The first exception that turned into a 5xx (serverError, onRequestError).
  error?: unknown;
};

const holder = globalThis as unknown as { flowplanRequestContext?: AsyncLocalStorage<RequestContext | undefined> };
const storage = (holder.flowplanRequestContext ??= new AsyncLocalStorage<RequestContext | undefined>());

// The id a person can quote: 12 characters, letters and digits.
export const newRequestId = () => randomBytes(9).toString("base64url").replace(/[-_]/g, "x").slice(0, 12);
export const REQUEST_ID_HEADER = "X-Request-Id";

// From the start of a request on (lib/request-metrics.ts): the rest of this
// synchronous turn – Node emits "request" right after the channel – and all
// async work started from it carry the context.
// Requests that are not followed (build files, the health check) start
// with none, so nothing of an earlier request on the connection sticks.
export function enterRequest(context: RequestContext | undefined) {
  storage.enterWith(context);
}
// For tests and code that starts a request by itself.
export function withRequestContext<T>(context: RequestContext | undefined, work: () => T): T {
  return storage.run(context, work);
}
export const requestContext = (): RequestContext | undefined => storage.getStore();
export const currentRequestId = (): string | undefined => storage.getStore()?.id;

// Who asked, when the request never said (lib/request-context.ts): MCP by
// its endpoint, visitors of shared links and forms as guests.
export function roleOf(context: RequestContext): CallerRole {
  if (/^[A-Z]+ \/api\/mcp\b/.test(context.route)) return "mcp";
  if (context.role) return context.role;
  if (/^[A-Z]+ \/api\/(?:share|forms|tickets|public-templates)\b/.test(context.route)) return "guest";
  return "anonymous";
}

// The command /api/command runs (the first one: a command may run others).
export function noteRequestAction(action: string) {
  const context = storage.getStore();
  if (context && !context.action && action) context.action = action;
}
// Who asked, as a role only (lib/auth.ts).
export function noteRequestCaller(identity: { isAdmin?: boolean; apiScope?: string; demo?: boolean } | null | undefined) {
  const context = storage.getStore();
  if (!context || !identity) return;
  context.role = identity.apiScope ? "token" : identity.demo ? "demo" : identity.isAdmin ? "admin" : "member";
}
// The exception behind a 5xx; the first one wins (the original, not a
// wrapper thrown later). Never throws.
export function noteRequestError(error: unknown) {
  try {
    const context = storage.getStore();
    if (context && context.error === undefined) context.error = error ?? new Error("(no error value)");
  } catch {}
}

// For the `catch` of a route handler that answers unexpected errors with
// 500: `status: e instanceof HttpError ? e.status : serverError(e)`.
// Remembers the exception for the error details and returns 500.
export function serverError(error: unknown): 500 {
  noteRequestError(error);
  return 500;
}
