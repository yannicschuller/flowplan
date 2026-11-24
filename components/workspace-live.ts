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
//
// The same lock and channel carry two more things (#515):
// - the instance's notices ("maintenance": a maintenance announced, a move)
//   for the banners (components/instance-notices.ts, onInstanceNotices);
// - the activity ping (components/activity-ping.tsx, joinActivity): the tab
//   holding the stream sends it for the browser, the others tell it over the
//   channel when they were last used.
export type LivePart = "tree" | "notifications" | "pages" | "maintenance";
export type LiveEvent = { type: "ready" } | { type: "changed"; parts: LivePart[]; pages?: string[] };
export type LiveHandlers = { message: (event: LiveEvent) => void; state: (live: boolean) => void };
const PARTS: readonly string[] = ["tree", "notifications", "pages", "maintenance"] satisfies LivePart[];

// One tab's last use, as the leading tab hears it (`tab`: a random id per tab).
export type UseReport = { tab: string; at: number; visible: boolean };
// What the activity ping says over the channel: a tab was used, a tab
// closed, the new leading tab asks for the last uses, the leading tab sent
// the ping.
export type ActivityRelay = { kind: "used"; report: UseReport } | { kind: "gone"; tab: string } | { kind: "uses" } | { kind: "pinged" };
type Relay = { kind: "event"; event: LiveEvent } | { kind: "state"; live: boolean } | { kind: "ask" } | ActivityRelay;
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
  // The tab (tests run several in one process; a browser tab has one).
  scope?: object;
};
// A closed stream (an error answer, revoked) is tried again after this,
// doubling with every failure in a row up to MAX_RETRY_MS: a tab whose
// session ended (signed out on another device, expired) must not knock at
// /api/live every 30 s, which also looked like probing to the security
// monitor (60 × 401 in 10 minutes). A "ready" starts over.
export const RETRY_MS = 30_000;
export const MAX_RETRY_MS = 10 * 60_000;
export const retryDelay = (failures: number) => Math.min(RETRY_MS * 2 ** Math.max(0, failures - 1), MAX_RETRY_MS);
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
    live = false,
    failures = 0;
  const setLive = (value: boolean) => {
    if (value === live) return;
    live = value;
    handlers.state(value);
  };
  const again = () => {
    source?.close();
    source = null;
    setLive(false);
    if (!stopped && retry === null) {
      failures++;
      retry = env.setTimeout(() => {
        retry = null;
        open();
      }, retryDelay(failures));
    }
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
        failures = 0;
        setLive(true);
        handlers.message({ type: "ready" });
        return;
      }
      if (event.type === "changed" && Array.isArray(event.parts))
        handlers.message({
          type: "changed",
          parts: event.parts.filter((p): p is LivePart => typeof p === "string" && PARTS.includes(p)),
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

/* ---------- The instance's notices (#515) ---------- */

// What the banners hear: the notices changed, the stream (re)connected
// ("ready": something may have been missed) or whether signals arrive at
// all (while not, the banners poll slowly).
export type NoticeSignal = { type: "changed" } | { type: "ready" } | { type: "state"; live: boolean };
const notices = { listeners: new Set<(signal: NoticeSignal) => void>(), live: new Set<object>() };
export function onInstanceNotices(listener: (signal: NoticeSignal) => void): () => void {
  notices.listeners.add(listener);
  return () => notices.listeners.delete(listener);
}
// Whether a stream of this tab gets signals (then the banners need not poll).
export const noticesLive = () => notices.live.size > 0;
const tellNotices = (signal: NoticeSignal) => {
  for (const listener of [...notices.listeners]) listener(signal);
};
function noticeLive(follower: object, live: boolean) {
  const before = noticesLive();
  if (live) notices.live.add(follower);
  else notices.live.delete(follower);
  if (noticesLive() !== before) tellNotices({ type: "state", live: noticesLive() });
}
// The handlers, also passing on what the banners need.
function withNotices(follower: object, handlers: LiveHandlers): LiveHandlers {
  return {
    message: (event) => {
      handlers.message(event);
      if (event.type === "ready") tellNotices({ type: "ready" });
      else if (event.parts.includes("maintenance")) tellNotices({ type: "changed" });
    },
    state: (live) => {
      handlers.state(live);
      noticeLive(follower, live);
    },
  };
}

/* ---------- The activity ping's share (#515) ---------- */

// "lead": this tab holds the stream and sends the ping for the browser;
// "follow": another tab does, this one reports its use; "alone": no Web
// Locks or BroadcastChannel – every tab pings for itself, as before.
export type ActivityRole = "lead" | "follow" | "alone";
export type ActivityHooks = { role: (role: ActivityRole) => void; message: (m: ActivityRelay) => void };
type Room = { role: ActivityRole | null; post: ((m: ActivityRelay) => void) | null; hooks: Set<ActivityHooks> };
const thisTab = {};
const tabs = new WeakMap<object, Map<string, Room>>();
const roomName = (userId: string, workspaceId: string, scope: object = thisTab) => ({ scope, name: `flowplan-live:${userId}:${workspaceId}` });
type RoomKey = ReturnType<typeof roomName>;
const roomsOf = (scope: object) => {
  let rooms = tabs.get(scope);
  if (!rooms) tabs.set(scope, (rooms = new Map()));
  return rooms;
};
const roomOf = ({ scope, name }: RoomKey) => {
  const rooms = roomsOf(scope);
  let room = rooms.get(name);
  if (!room) rooms.set(name, (room = { role: null, post: null, hooks: new Set() }));
  return room;
};
const forget = ({ scope, name }: RoomKey, room: Room) => {
  const rooms = roomsOf(scope);
  if (!room.hooks.size && !room.post && rooms.get(name) === room) rooms.delete(name);
};
function setRole(name: RoomKey, role: ActivityRole | null, post: Room["post"]) {
  const room = roomOf(name);
  room.post = post;
  if (role === room.role) return forget(name, room);
  room.role = role;
  if (role) for (const hooks of [...room.hooks]) hooks.role(role);
  forget(name, room);
}
// The activity ping of this tab joins the stream of the workspace (which
// may start before or after it). `role` is null until the stream says.
export function joinActivity(userId: string, workspaceId: string, hooks: ActivityHooks, scope?: object) {
  const name = roomName(userId, workspaceId, scope);
  const room = roomOf(name);
  room.hooks.add(hooks);
  return {
    role: () => room.role,
    post: (m: ActivityRelay) => room.post?.(m),
    stop: () => {
      room.hooks.delete(hooks);
      forget(name, room);
    },
  };
}

// Follows the workspace: one stream per browser, shared between the tabs.
export function followWorkspace(userId: string, workspaceId: string, outer: LiveHandlers, env: LiveEnv = browserEnv()): () => void {
  const self = {};
  const handlers = withNotices(self, outer);
  const name = roomName(userId, workspaceId, env.scope);
  if (!env.locks || !env.channel) {
    setRole(name, "alone", null);
    const close = openLiveSource(workspaceId, handlers, env);
    return () => {
      close();
      noticeLive(self, false);
      setRole(name, null, null);
    };
  }
  const channel = env.channel(name.name);
  const abort = new AbortController();
  // Set while this tab holds the stream.
  let leading: { live: boolean; close: () => void } | null = null;
  let stopped = false;
  const hear = (m: ActivityRelay) => {
    for (const hooks of [...roomOf(name).hooks]) hooks.message(m);
  };
  channel.onmessage = (e) => {
    const m = e.data;
    if (m.kind === "event") handlers.message(m.event);
    else if (m.kind === "state") handlers.state(m.live);
    else if (m.kind === "ask") {
      if (leading) channel.postMessage({ kind: "state", live: leading.live });
    } else if (m.kind === "used" || m.kind === "gone" || m.kind === "uses" || m.kind === "pinged") hear(m);
  };
  const post = (m: ActivityRelay) => {
    if (!stopped) channel.postMessage(m);
  };
  // Until the lock comes, another tab leads.
  setRole(name, "follow", post);
  void env.locks
    .request(name.name, { signal: abort.signal }, () => {
      if (stopped) return Promise.resolve();
      return new Promise<void>((release) => {
        const lead = { live: false, close: () => {} };
        leading = lead;
        setRole(name, "lead", post);
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
    noticeLive(self, false);
    setRole(name, null, null);
  };
}
