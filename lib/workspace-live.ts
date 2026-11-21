// The workspace's live signal (#383): instead of every open tab asking for
// the sidebar and its page every 10 s, the server says when something
// changed and what – the tab then asks for just that (with its ETag, so an
// unchanged part still costs only a 304). The timed refresh stays as a
// safety net at 60 s (components/workspace-app.tsx). Like the document
// channel (lib/document-live.ts) these are signals, not storage: a missed
// one is caught up by that refresh, by the refresh on reconnect and by the
// refresh when a hidden tab is shown again.
//
// What a signal carries, per listener (one server-sent event stream of one
// person in one workspace, /api/live):
// - "tree": the page tree, the permissions or the people of the workspace
//   changed (the versions of lib/cache-versions.ts moved) – ask for the
//   bootstrap again;
// - "notifications": this person's notifications changed;
// - "pages": ids of pages whose content changed (records, comments, …),
//   only those this person may read – nobody learns the id of a page they
//   cannot see. The tab refetches its open page when it is among them.
// No titles, no content: the answers come from the usual requests with
// their usual permission checks.
//
// Where changes come from: the versions are compared after writes (every
// write moves lib/db.ts writeGeneration(); a timer looks every TICK_MS
// whether it moved); pages and notifications are named by the code that
// changes them (a command, lib/document-live.ts documentChanged, every
// INSERT INTO notifications – lib/db.ts finds the recipient). Text comment
// threads have their own signal to the open editors. In cluster mode
// each instance publishes what it saw on the bus (lib/cluster/bus.ts) and
// delivers what the others saw to its own listeners.
import { onBus, publish } from "./cluster/bus";
import { hasPeers } from "./cluster/processes";
import { all, sql, writeGeneration } from "./db";
import { dbContext } from "./db-driver/context";
import { pageRole } from "./permissions";
import { withReadMemo } from "./read-memo";
import type { Identity, Page } from "./types";

export type LivePart = "tree" | "notifications" | "pages";
export type LiveSignal = { type: "changed"; parts: LivePart[]; pages?: string[] };

type Listener = { user: Identity; workspaceId: string; send: (event: string) => void };
// What changed since the last delivery: workspaces whose tree changed ("*":
// all), people whose notifications changed, changed pages.
type Changes = { trees: Set<string>; people: Set<string>; pages: Set<string> };
type BusMessage = { trees: string[]; people: string[]; pages: string[]; versions?: Record<string, string> };

const TICK_MS = 250;
const hub = globalThis as unknown as {
  flowplanWorkspaceLive?: {
    listeners: Set<Listener>;
    // Found here, to deliver (and, cluster mode: to publish).
    local: Changes;
    // Received from the other instances, to deliver only.
    remote: Changes;
    versions: Map<string, string> | null;
    generation: number;
    timer: ReturnType<typeof setInterval> | null;
    // The round in progress.
    running: Promise<void> | null;
    bus: boolean;
  };
};
const empty = (): Changes => ({ trees: new Set(), people: new Set(), pages: new Set() });
const state = (hub.flowplanWorkspaceLive ??= {
  listeners: new Set(),
  local: empty(),
  remote: empty(),
  versions: null,
  generation: -1,
  timer: null,
  running: null,
  bus: false,
});

// Something to look at: listeners here, or other instances to tell.
const needed = () => state.listeners.size > 0 || hasPeers();
function ensureTimer() {
  if (!state.bus) {
    state.bus = true;
    onBus("workspace", (payload) => received(payload as BusMessage));
  }
  if (state.timer || !needed()) return;
  state.timer = setInterval(() => {
    if (!state.running) void tick();
  }, TICK_MS);
  state.timer.unref?.();
}

// The content of these pages changed (records, comments, its settings).
export function pagesChanged(pageIds: Iterable<string | null | undefined>) {
  if (!needed()) return;
  for (const id of pageIds) if (id) state.local.pages.add(id);
  ensureTimer();
}
// The notifications of these people changed (new, read, deleted).
export function notificationsChanged(userIds: Iterable<string | null | undefined>) {
  if (!needed()) return;
  for (const id of userIds) if (id) state.local.people.add(id);
  ensureTimer();
}

// Every new notification, wherever it is inserted (lib/db.ts).
(globalThis as { flowplanNotificationHook?: (userId: string) => void }).flowplanNotificationHook = (userId) => notificationsChanged([userId]);

function received(message: BusMessage) {
  for (const w of message.trees ?? []) state.remote.trees.add(w);
  for (const u of message.people ?? []) state.remote.people.add(u);
  for (const p of message.pages ?? []) state.remote.pages.add(p);
  // The versions the other instance saw: the next comparison here does not
  // report the same change again.
  if (message.versions && state.versions) for (const [name, version] of Object.entries(message.versions)) state.versions.set(name, version);
}

// The versions of lib/cache-versions.ts: which of them moved since the last
// look. The first look only notes them.
async function versionChanges(changes: Changes): Promise<Record<string, string> | undefined> {
  const rows = await all<{ name: string; version: number | string }>("SELECT name,version FROM cache_versions");
  const now = new Map(rows.map((r) => [r.name, String(r.version)]));
  const before = state.versions;
  state.versions = now;
  if (!before) return undefined;
  const moved: Record<string, string> = {};
  for (const [name, version] of now) {
    if (before.get(name) === version) continue;
    moved[name] = version;
    if (name.startsWith("pages:")) changes.trees.add(name.slice(6));
    // Permissions or people anywhere: every workspace looks again.
    else if (name === "roles" || name === "people") changes.trees.add("*");
  }
  return Object.keys(moved).length ? moved : undefined;
}

// One round (every TICK_MS; the tests call it to deliver what is waiting):
// after the round in progress, if any. False when it had to wait for the
// next one.
export async function tick(): Promise<boolean> {
  while (state.running) await state.running;
  // An asynchronous SQLite transaction holds the connection: what it wrote
  // is not committed yet. The next round looks.
  if (dbContext.sqliteActive) return false;
  const done = round();
  state.running = done;
  try {
    await done;
  } finally {
    if (state.running === done) state.running = null;
  }
  return true;
}
async function round() {
  try {
    const local = state.local;
    state.local = empty();
    let versions: Record<string, string> | undefined;
    const generation = writeGeneration();
    if (generation !== state.generation || !state.versions) {
      state.generation = generation;
      versions = await versionChanges(local);
    }
    const remote = state.remote;
    state.remote = empty();
    if (hasPeers() && (local.trees.size || local.people.size || local.pages.size || versions))
      publish("workspace", { trees: [...local.trees], people: [...local.people], pages: [...local.pages], versions } satisfies BusMessage);
    const merged = { trees: new Set([...local.trees, ...remote.trees]), people: new Set([...local.people, ...remote.people]), pages: new Set([...local.pages, ...remote.pages]) };
    if (merged.trees.size || merged.people.size || merged.pages.size) await deliver(merged);
  } catch (error) {
    console.error("Workspace live signal failed", error);
  } finally {
    if (!needed() && state.timer) {
      clearInterval(state.timer);
      state.timer = null;
      // Looked at anew when someone follows again (no stale comparison).
      state.versions = null;
    }
  }
}

async function deliver(changes: Changes) {
  if (!state.listeners.size) return;
  // The changed pages with their workspace (gone ones: the tree signal
  // covers them).
  const pages = changes.pages.size
    ? await all<Page>(`SELECT * FROM pages WHERE id IN ${sql.jsonValues()}`, JSON.stringify([...changes.pages]))
    : [];
  for (const listener of [...state.listeners]) {
    const parts: LivePart[] = [];
    if (changes.trees.has("*") || changes.trees.has(listener.workspaceId)) parts.push("tree");
    if (changes.people.has(listener.user.id)) parts.push("notifications");
    const mine = pages.filter((p) => p.workspace_id === listener.workspaceId);
    const readable = mine.length ? await readablePages(listener.user, mine) : [];
    if (readable.length) parts.push("pages");
    if (!parts.length) continue;
    const signal: LiveSignal = { type: "changed", parts, ...(readable.length ? { pages: readable } : {}) };
    try {
      listener.send(`data: ${JSON.stringify(signal)}\n\n`);
    } catch {
      state.listeners.delete(listener);
    }
  }
}
// The ids of `pages` the person may read: from the roles kept for the
// workspace when they are current (lib/permissions.ts), else page by page –
// a few changed pages do not need the roles of all of them computed anew
// for every open tab.
async function readablePages(user: Identity, pages: Page[]) {
  return await withReadMemo(async () => {
    const out: string[] = [];
    for (const page of pages) if (!page.deleted_at && (await pageRole(user, page))) out.push(page.id);
    return out;
  });
}

// A tab of `user` follows `workspaceId`; returns the function that stops it.
export function watchWorkspace(user: Identity, workspaceId: string, send: (event: string) => void) {
  const listener: Listener = { user, workspaceId, send };
  state.listeners.add(listener);
  ensureTimer();
  send(`data: ${JSON.stringify({ type: "ready" })}\n\n`);
  return () => {
    state.listeners.delete(listener);
  };
}

// What this hub holds (server metrics): open workspace channels.
export function workspaceLiveCount() {
  return state.listeners.size;
}
