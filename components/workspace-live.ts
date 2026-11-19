// The workspace's live signal in the browser (#383, lib/workspace-live.ts):
// the server says when the tree, the notifications or a page changed, and
// the tab fetches just that instead of everything every 10 s.
//
// One stream per browser, person and workspace: every tab would otherwise
// hold one more connection, and browsers allow only six per server over
// HTTP/1.1 (the editor and boards hold theirs too). The tab holding the Web
// Lock of the workspace opens the stream and passes every message on over a
// BroadcastChannel; the others listen there. When that tab closes, the lock
// goes to the next one, which opens the stream anew. Without Web Locks or
// BroadcastChannel each tab has its own.
//
// `state(live)` says whether signals arrive: while they do, the timed
// refresh is only a safety net; while not (no connection, signed out,
// revoked), the tab refreshes as before.
export type LivePart = "tree" | "notifications" | "pages";
export type LiveEvent = { type: "ready" } | { type: "changed"; parts: LivePart[]; pages?: string[] };
export type LiveHandlers = { message: (event: LiveEvent) => void; state: (live: boolean) => void };

type Relay = { kind: "event"; event: LiveEvent } | { kind: "state"; live: boolean } | { kind: "ask" };
type SourceLike = {
  onmessage: ((e: { data: string }) => void) | null;
  onerror: (() => void) | null;
  readyState: number;
  close(): void;
};
export type LiveEnv = {
  source: (url: string) => SourceLike;
  locks?: { request(name: string, options: { signal: AbortSignal }, fn: () => Promise<void>): Promise<unknown> } | null;
  channel?: ((name: string) => { postMessage(m: Relay): void; onmessage: ((e: { data: Relay }) => void) | null; close(): void }) | null;
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (t: unknown) => void;
};
// A closed stream (an error answer, revoked) is tried again after this.
export const RETRY_MS = 30_000;
const CLOSED = 2;

function browserEnv(): LiveEnv {
  return {
    source: (url) => new EventSource(url) as unknown as SourceLike,
    locks: typeof navigator !== "undefined" && "locks" in navigator ? (navigator.locks as unknown as LiveEnv["locks"]) : null,
    channel: typeof BroadcastChannel === "undefined" ? null : (name) => new BroadcastChannel(name) as unknown as ReturnType<NonNullable<LiveEnv["channel"]>>,
    setTimeout: (fn, ms) => window.setTimeout(fn, ms),
    clearTimeout: (t) => window.clearTimeout(t as number),
  };
}

// The stream itself: parsed messages, the live state, reopened after
// RETRY_MS when the browser gave up on it.
export function openLiveSource(workspaceId: string, handlers: LiveHandlers, env: LiveEnv): () => void {
  let source: SourceLike | null = null,
    retry: unknown = null,
    stopped = false,
    live = false;
  const setLive = (value: boolean) => {
    if (value === live) return;
    live = value;
    handlers.state(value);
  };
  const again = () => {
    source?.close();
    source = null;
    setLive(false);
    if (!stopped && retry === null)
      retry = env.setTimeout(() => {
        retry = null;
        open();
      }, RETRY_MS);
  };
  const open = () => {
    if (stopped) return;
    const s = env.source(`/api/live?workspace=${encodeURIComponent(workspaceId)}`);
    source = s;
    s.onmessage = (e) => {
      let event: { type?: string; parts?: unknown; pages?: unknown };
      try {
        event = JSON.parse(e.data);
      } catch {
        return;
      }
      if (event.type === "revoked") return again();
      if (event.type === "ready") {
        setLive(true);
        handlers.message({ type: "ready" });
        return;
      }
      if (event.type === "changed" && Array.isArray(event.parts))
        handlers.message({
          type: "changed",
          parts: event.parts.filter((p): p is LivePart => p === "tree" || p === "notifications" || p === "pages"),
          ...(Array.isArray(event.pages) ? { pages: event.pages.filter((p): p is string => typeof p === "string") } : {}),
        });
    };
    // Reconnecting (the browser does that itself) or given up (CLOSED: an
    // error answer such as 401) – either way no signals for now.
    s.onerror = () => {
      if (s !== source) return;
      if (s.readyState === CLOSED) again();
      else setLive(false);
    };
  };
  open();
  return () => {
    stopped = true;
    if (retry !== null) env.clearTimeout(retry);
    source?.close();
    source = null;
  };
}

// Follows the workspace: one stream per browser, shared between the tabs.
export function followWorkspace(userId: string, workspaceId: string, handlers: LiveHandlers, env: LiveEnv = browserEnv()): () => void {
  if (!env.locks || !env.channel) return openLiveSource(workspaceId, handlers, env);
  const name = `flowplan-live:${userId}:${workspaceId}`;
  const channel = env.channel(name);
  const abort = new AbortController();
  // Set while this tab holds the stream.
  let leading: { live: boolean; close: () => void } | null = null;
  let stopped = false;
  channel.onmessage = (e) => {
    const m = e.data;
    if (m.kind === "event") handlers.message(m.event);
    else if (m.kind === "state") handlers.state(m.live);
    else if (m.kind === "ask" && leading) channel.postMessage({ kind: "state", live: leading.live });
  };
  void env.locks
    .request(name, { signal: abort.signal }, () => {
      if (stopped) return Promise.resolve();
      return new Promise<void>((release) => {
        const lead = { live: false, close: () => {} };
        leading = lead;
        const close = openLiveSource(
          workspaceId,
          {
            message: (event) => {
              handlers.message(event);
              channel.postMessage({ kind: "event", event });
            },
            state: (live) => {
              lead.live = live;
              handlers.state(live);
              channel.postMessage({ kind: "state", live });
            },
          },
          env,
        );
        lead.close = () => {
          close();
          // The others fall back to the timed refresh until the next tab leads.
          channel.postMessage({ kind: "state", live: false });
          release();
        };
      });
    })
    .catch(() => {});
  // Whether the tab holding the stream (if any) gets signals.
  channel.postMessage({ kind: "ask" });
  return () => {
    stopped = true;
    abort.abort();
    const lead = leading;
    leading = null;
    lead?.close();
    channel.close();
  };
}
