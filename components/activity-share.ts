// The activity ping, once per browser (#515; components/activity-ping.tsx
// wires it to the page). The app tells the server once a minute that it is
// open and how long ago it was last used – for "who is here" in
// Administration → Users (lib/user-activity.ts) and the workspace's sign of
// life (#282). With every tab pinging that was one request per minute per
// open tab; now the tab holding the workspace's live stream (Web Lock,
// components/workspace-live.ts) pings for all tabs of the browser, and the
// others report over the stream's BroadcastChannel when they were last used:
// the ping carries the idle time of the most recently used tab.
//
// - A follower reports at once when it is used after a quiet minute (so
//   coming back after a pause still shows up right away: the leading tab
//   pings then), otherwise at most every REPORT_MS, and when it is shown or
//   hidden.
// - A new leading tab asks the others for their last use and pings shortly
//   after.
// - The leading tab says "pinged" with every ping. A follower that hears
//   nothing for SILENT_MS (a frozen leading tab, an older version of the app
//   leading) pings for itself until it hears one again.
// - Without Web Locks or BroadcastChannel ("alone") every tab pings, as
//   before.
// - A 401 ends the pinging for good (#513).
import { joinActivity, type ActivityRelay, type ActivityRole, type UseReport } from "./workspace-live";

export const EVERY_MS = 60_000;
export const REPORT_MS = 20_000;
export const SILENT_MS = 90_000;
// How long a new leading tab waits for the others' last uses.
export const GATHER_MS = 500;
// Without word from the live stream (it has not started): ping alone.
export const ROLE_WAIT_MS = 2_000;
// A hidden tab is open, but nobody is using it.
const HIDDEN_IDLE_MS = EVERY_MS * 2;

export type ActivityEnv = {
  now: () => number;
  visible: () => boolean;
  // Sends the ping; resolves with the answer's status (null: no answer).
  ping: (idleMs: number) => Promise<number | null>;
  // The session ended (401).
  ended: () => void;
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (t: unknown) => void;
  tab?: string;
  // The tab's scope for the live stream (tests: LiveEnv.scope).
  scope?: object;
};

export function startActivityPing(userId: string, workspaceId: string, env: ActivityEnv) {
  const tab = env.tab ?? Math.random().toString(36).slice(2);
  let usedAt = env.now(),
    sentAt = -Infinity,
    reportedAt = -Infinity,
    heardAt = env.now(),
    ended = false,
    role: ActivityRole | null = null,
    loop: unknown = null,
    soon: unknown = null;
  // The other tabs' last uses (leading tab only).
  const others = new Map<string, { at: number; visible: boolean }>();
  const idleOf = (at: number, visible: boolean, now: number) => (visible ? now - at : Math.max(now - at, HIDDEN_IDLE_MS));
  const idle = (now: number) => {
    let best = idleOf(usedAt, env.visible(), now);
    for (const o of others.values()) best = Math.min(best, idleOf(o.at, o.visible, now));
    return Math.max(0, best);
  };
  // The most recent use this tab knows of.
  const lastUse = () => Math.max(usedAt, ...[...others.values()].map((o) => o.at));
  // Whether this tab pings: leading, alone, or the leading tab went silent.
  const pings = () => role !== "follow" || env.now() - heardAt > SILENT_MS;

  const send = () => {
    if (ended) return;
    const now = env.now();
    sentAt = now;
    if (role === "lead") link.post({ kind: "pinged" });
    void env
      .ping(idle(now))
      .then((status) => {
        if (status !== 401 || ended) return;
        ended = true;
        stopTimers();
        env.ended();
      })
      .catch(() => {});
  };
  const report = () => {
    if (ended || role !== "follow") return;
    reportedAt = env.now();
    link.post({ kind: "used", report: { tab, at: usedAt, visible: env.visible() } satisfies UseReport });
  };
  // Every EVERY_MS: the ping, if this tab sends it.
  const every = () => {
    loop = env.setTimeout(every, EVERY_MS);
    if (pings()) send();
  };
  const stopTimers = () => {
    if (loop !== null) env.clearTimeout(loop);
    if (soon !== null) env.clearTimeout(soon);
    loop = soon = null;
  };
  const restart = (delay: number) => {
    stopTimers();
    if (ended) return;
    soon = env.setTimeout(() => {
      soon = null;
      every();
    }, delay);
  };
  // Someone used a tab at `at`; after a quiet minute the ping goes at once.
  const noted = (quiet: boolean) => {
    if (quiet && env.now() - sentAt > 5_000 && pings()) send();
  };
  const becomes = (next: ActivityRole) => {
    if (ended || next === role) return;
    role = next;
    others.clear();
    if (next === "follow") {
      heardAt = env.now();
      report();
      // Still ticking: the check whether the leading tab went silent.
      restart(EVERY_MS);
    } else if (next === "lead") {
      // The others' last uses first.
      link.post({ kind: "uses" });
      restart(GATHER_MS);
    } else restart(0);
  };
  const link = joinActivity(userId, workspaceId, {
    role: becomes,
    message: (m: ActivityRelay) => {
      if (ended) return;
      if (m.kind === "pinged") heardAt = env.now();
      else if (m.kind === "uses") report();
      else if (role !== "lead") return;
      else if (m.kind === "gone") others.delete(m.tab);
      else if (m.kind === "used") {
        const quiet = env.now() - lastUse() > EVERY_MS;
        others.set(m.report.tab, { at: m.report.at, visible: m.report.visible });
        if (others.size > 100) others.delete(others.keys().next().value!);
        noted(quiet && env.now() - m.report.at < EVERY_MS);
      }
    },
  }, env.scope);
  const current = link.role();
  if (current) becomes(current);
  // No live stream (yet): alone after a moment.
  const wait = env.setTimeout(() => {
    if (role === null) becomes("alone");
  }, ROLE_WAIT_MS);

  return {
    // The person typed, clicked, scrolled or touched this tab.
    used() {
      const now = env.now();
      const quiet = now - usedAt > EVERY_MS;
      usedAt = now;
      if (role === "follow") {
        if (quiet || now - reportedAt > REPORT_MS) report();
        if (!pings()) return;
      }
      noted(quiet);
    },
    // The tab was shown or hidden.
    visibility() {
      if (env.visible()) this.used();
      else report();
    },
    stop() {
      env.clearTimeout(wait);
      stopTimers();
      if (role === "follow") link.post({ kind: "gone", tab });
      link.stop();
      ended = true;
    },
    // For tests.
    get role() {
      return role;
    },
  };
}
