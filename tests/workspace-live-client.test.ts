// The workspace's live signal in the browser (#383,
// components/workspace-live.ts, components/use-workspace-signals.ts): one
// stream per browser shared by the tabs through a Web Lock and a
// BroadcastChannel, the fallback to the timed refresh while no signals
// arrive (no connection, an error answer, revoked) and what a signal makes
// a tab fetch.
import { test } from "node:test";
import assert from "node:assert/strict";
import { followWorkspace, noticesLive, onInstanceNotices, openLiveSource, MAX_RETRY_MS, RETRY_MS, retryDelay, type LiveEnv, type LiveEvent } from "../components/workspace-live";
import { startActivityPing, EVERY_MS, GATHER_MS, ROLE_WAIT_MS, SILENT_MS } from "../components/activity-share";
import { createNoticeStore, FALLBACK_POLL_MS, MOVE_POLL_MS, READY_FRESH_MS, type NoticeEnv } from "../components/instance-notices";
import type { NoticeSignal } from "../components/workspace-live";
import { BOOT_GAP_MS, LIVE_REFRESH_MS, nextAllowed, PAGE_GAP_MS, POLL_REFRESH_MS, wantedFor } from "../components/use-workspace-signals";

type FakeSource = { url: string; onmessage: ((e: { data: string }) => void) | null; onerror: (() => void) | null; readyState: number; closed: boolean; close(): void };
// A browser: EventSource, timers, and (optionally) locks and channels shared
// with other "tabs" made from the same world.
function world() {
  const sources: FakeSource[] = [];
  const timers: { fn: () => void; ms: number; cleared: boolean }[] = [];
  const held = new Map<string, { queue: (() => void)[]; busy: boolean }>();
  const channels = new Map<string, Set<{ onmessage: ((e: { data: unknown }) => void) | null; closed: boolean }>>();
  const env = (withLocks = true, scope?: object): LiveEnv => ({
    scope,
    source: (url) => {
      const s: FakeSource = { url, onmessage: null, onerror: null, readyState: 0, closed: false, close: () => ((s.closed = true), (s.readyState = 2)) };
      sources.push(s);
      return s;
    },
    setTimeout: (fn, ms) => {
      const t = { fn, ms, cleared: false };
      timers.push(t);
      return t;
    },
    clearTimeout: (t) => {
      (t as { cleared: boolean }).cleared = true;
    },
    locks: withLocks
      ? {
          request(name, { signal }, fn) {
            const lock = held.get(name) ?? held.set(name, { queue: [], busy: false }).get(name)!;
            return new Promise((resolve, reject) => {
              const start = () => {
                lock.busy = true;
                void fn().then(() => {
                  lock.busy = false;
                  resolve(undefined);
                  lock.queue.shift()?.();
                });
              };
              signal.addEventListener("abort", () => {
                const i = lock.queue.indexOf(start);
                if (i >= 0) lock.queue.splice(i, 1);
                reject(new Error("AbortError"));
              });
              if (lock.busy) lock.queue.push(start);
              else start();
            });
          },
        }
      : null,
    channel: withLocks
      ? (name) => {
          const set = channels.get(name) ?? channels.set(name, new Set()).get(name)!;
          const me = {
            onmessage: null as ((e: { data: unknown }) => void) | null,
            closed: false,
            postMessage(m: unknown) {
              // Like BroadcastChannel: to the others, not to itself, later.
              for (const other of set) if (other !== me && !other.closed) queueMicrotask(() => other.onmessage?.({ data: m }));
            },
            close() {
              me.closed = true;
              set.delete(me);
            },
          };
          set.add(me);
          return me;
        }
      : null,
  });
  return { env, sources, timers };
}
const send = (s: FakeSource, data: unknown) => s.onmessage?.({ data: JSON.stringify(data) });
const flush = () => new Promise((r) => setTimeout(r, 0));
function recorder() {
  const events: LiveEvent[] = [];
  const states: boolean[] = [];
  return { events, states, handlers: { message: (e: LiveEvent) => events.push(e), state: (live: boolean) => states.push(live) } };
}

test("one stream for the tabs of a browser; the others hear it over the channel", async () => {
  const w = world();
  const a = recorder(),
    b = recorder();
  const stopA = followWorkspace("u", "w1", a.handlers, w.env());
  const stopB = followWorkspace("u", "w1", b.handlers, w.env());
  await flush();
  assert.equal(w.sources.length, 1, "one stream");
  assert.equal(w.sources[0].url, "/api/live?workspace=w1");
  send(w.sources[0], { type: "ready" });
  send(w.sources[0], { type: "changed", parts: ["pages"], pages: ["p1"] });
  await flush();
  assert.deepEqual(a.events, [{ type: "ready" }, { type: "changed", parts: ["pages"], pages: ["p1"] }]);
  assert.deepEqual(b.events, a.events, "relayed");
  assert.deepEqual([a.states, b.states.at(-1)], [[true], true]);
  // The leading tab closes: the other one opens its own stream.
  stopA();
  await flush();
  await flush();
  assert.equal(w.sources[0].closed, true);
  assert.equal(w.sources.length, 2, "the next tab leads");
  assert.equal(b.states.at(-1), false, "no signals until it is connected");
  send(w.sources[1], { type: "ready" });
  assert.equal(b.states.at(-1), true);
  stopB();
  assert.equal(w.sources[1].closed, true);
});

test("a tab joining later asks whether signals arrive", async () => {
  const w = world();
  const a = recorder(),
    b = recorder();
  const stopA = followWorkspace("u", "w1", a.handlers, w.env());
  await flush();
  send(w.sources[0], { type: "ready" });
  const stopB = followWorkspace("u", "w1", b.handlers, w.env());
  await flush();
  await flush();
  assert.deepEqual(b.states, [true]);
  stopA();
  stopB();
});

test("other workspaces and people have streams of their own", async () => {
  const w = world();
  const stops = [followWorkspace("u", "w1", recorder().handlers, w.env()), followWorkspace("u", "w2", recorder().handlers, w.env()), followWorkspace("v", "w1", recorder().handlers, w.env())];
  await flush();
  assert.equal(w.sources.length, 3);
  for (const stop of stops) stop();
});

test("without Web Locks each tab has its own stream", () => {
  const w = world();
  const stops = [followWorkspace("u", "w1", recorder().handlers, w.env(false)), followWorkspace("u", "w1", recorder().handlers, w.env(false))];
  assert.equal(w.sources.length, 2);
  for (const stop of stops) stop();
});

test("an error answer, revoked: no signals, tried again later; reconnecting: not live meanwhile", () => {
  const w = world();
  const r = recorder();
  const stop = openLiveSource("w1", r.handlers, w.env(false));
  const s = w.sources[0];
  send(s, { type: "ready" });
  // The browser reconnects by itself (CONNECTING).
  s.readyState = 0;
  s.onerror?.();
  assert.deepEqual(r.states, [true, false]);
  assert.equal(w.timers.length, 0, "the browser retries itself");
  send(s, { type: "ready" });
  // Given up (an error answer such as 401): a new stream after RETRY_MS.
  s.readyState = 2;
  s.onerror?.();
  assert.deepEqual(r.states, [true, false, true, false]);
  assert.equal(w.timers.length, 1);
  assert.equal(w.timers[0].ms, RETRY_MS);
  w.timers[0].fn();
  assert.equal(w.sources.length, 2);
  send(w.sources[1], { type: "revoked" });
  assert.equal(w.sources[1].closed, true);
  assert.equal(w.timers.length, 2, "revoked: tried again later as well");
  // Unknown and broken messages are ignored; parts are filtered.
  w.timers[1].fn();
  const t = w.sources[2];
  t.onmessage?.({ data: "{broken" });
  send(t, { type: "changed", parts: ["tree", "evil"], pages: ["p", 3] });
  assert.deepEqual(r.events.at(-1), { type: "changed", parts: ["tree"], pages: ["p"] });
  stop();
  assert.equal(t.closed, true);
});

test("failures in a row wait longer and longer (up to 10 minutes); a ready starts over", () => {
  assert.deepEqual([1, 2, 3, 4, 5, 6, 9].map(retryDelay), [30_000, 60_000, 120_000, 240_000, 480_000, MAX_RETRY_MS, MAX_RETRY_MS]);
  const w = world();
  const stop = openLiveSource("w1", recorder().handlers, w.env(false));
  // A session that ended: every stream is answered with an error (CLOSED).
  for (let i = 0; i < 4; i++) {
    const s = w.sources.at(-1)!;
    s.readyState = 2;
    s.onerror?.();
    assert.equal(w.timers.at(-1)!.ms, retryDelay(i + 1));
    w.timers.at(-1)!.fn();
  }
  // Signed in again: ready resets the delay.
  send(w.sources.at(-1)!, { type: "ready" });
  const s = w.sources.at(-1)!;
  s.readyState = 2;
  s.onerror?.();
  assert.equal(w.timers.at(-1)!.ms, RETRY_MS);
  stop();
});

test("what a signal makes a tab fetch", () => {
  assert.deepEqual(wantedFor({ type: "ready" }, "p1"), { boot: true, page: true }, "reconnected: both");
  assert.deepEqual(wantedFor({ type: "changed", parts: ["tree"] }, "p1"), { boot: true, page: false });
  assert.deepEqual(wantedFor({ type: "changed", parts: ["notifications"] }, null), { boot: true, page: false });
  assert.deepEqual(wantedFor({ type: "changed", parts: ["pages"], pages: ["p1", "p2"] }, "p1"), { boot: false, page: true });
  assert.equal(wantedFor({ type: "changed", parts: ["pages"], pages: ["p2"] }, "p1"), null, "another page");
  assert.equal(wantedFor({ type: "changed", parts: ["pages"], pages: ["p1"] }, null), null, "no page open");
  // Busy workspaces: at most one bootstrap per BOOT_GAP_MS, one page per PAGE_GAP_MS.
  const last = { boot: 1000, page: 5000 };
  assert.equal(nextAllowed({ boot: true, page: false }, last), 1000 + BOOT_GAP_MS);
  assert.equal(nextAllowed({ boot: false, page: true }, last), 5000 + PAGE_GAP_MS);
  assert.equal(nextAllowed({ boot: true, page: true }, last), Math.min(1000 + BOOT_GAP_MS, 5000 + PAGE_GAP_MS));
  assert.ok(BOOT_GAP_MS >= POLL_REFRESH_MS, "never more often than the timed refresh before");
  // The timed refresh: a safety net of at least 60 s with signals, 10 s without.
  assert.ok(LIVE_REFRESH_MS >= 60_000);
  assert.equal(POLL_REFRESH_MS, 10_000);
});

test("a signed-out tab stops its background requests (#513)", async () => {
  const { readFileSync } = await import("node:fs");
  const ping = readFileSync(new URL("../components/activity-share.ts", import.meta.url), "utf8");
  assert.match(ping, /status !== 401/, "the activity ping notices a 401");
  assert.match(ping, /stopTimers\(\)/, "and stops its timers");
  const app = readFileSync(new URL("../components/workspace-app.tsx", import.meta.url), "utf8");
  assert.match(app, /\{!signedOut && <ActivityPing /, "no ping behind the signed-out banner");
  assert.match(app, /useWorkspaceSignals\([^)]*!signedOut\)/, "no live stream behind the banner");
});

// A clock with timers that run when the test moves it on.
function clock(start = 1_000_000) {
  let now = start;
  const timers = new Set<{ at: number; fn: () => void }>();
  return {
    now: () => now,
    setTimeout: (fn: () => void, ms: number) => {
      const t = { at: now + ms, fn };
      timers.add(t);
      return t;
    },
    clearTimeout: (t: unknown) => void timers.delete(t as { at: number; fn: () => void }),
    async advance(ms: number) {
      const end = now + ms;
      for (;;) {
        const next = [...timers].filter((t) => t.at <= end).sort((a, b) => a.at - b.at)[0];
        if (!next) break;
        timers.delete(next);
        now = Math.max(now, next.at);
        next.fn();
        await flush();
      }
      now = end;
      await flush();
    },
  };
}
// A tab of the activity ping: what it sent (the idle times).
function pingTab(c: ReturnType<typeof clock>, workspaceId = "w1", status = 204, scope: object = {}) {
  const sent: number[] = [];
  let visible = true,
    endedCalls = 0;
  const share = startActivityPing("u", workspaceId, {
    now: c.now,
    visible: () => visible,
    ping: async (idleMs) => (sent.push(idleMs), status),
    ended: () => void endedCalls++,
    setTimeout: c.setTimeout,
    clearTimeout: c.clearTimeout,
    scope,
  });
  return {
    scope,
    sent,
    share,
    hide: () => ((visible = false), share.visibility()),
    show: () => ((visible = true), share.visibility()),
    ended: () => endedCalls,
  };
}

test("the activity ping: one per browser, sent by the tab holding the stream (#515)", async () => {
  const w = world();
  const c = clock();
  const tabs = [0, 1, 2].map(() => {
    const t = pingTab(c);
    // The ping mounts first, then the stream starts (effects run child first).
    const stop = followWorkspace("u", "w1", recorder().handlers, w.env(true, t.scope));
    return { ...t, stop };
  });
  await flush();
  assert.deepEqual(tabs.map((t) => t.share.role), ["lead", "follow", "follow"]);
  // The new leading tab asks for the last uses, then pings.
  await c.advance(GATHER_MS);
  assert.deepEqual(tabs.map((t) => t.sent.length), [1, 0, 0]);
  // An hour: one ping a minute in all, not three.
  await c.advance(60 * EVERY_MS);
  assert.deepEqual(tabs.map((t) => t.sent.length), [61, 0, 0]);
  for (const t of tabs) t.stop(), t.share.stop();
});

test("the activity ping carries the idle time of the most recently used tab (#515)", async () => {
  const w = world();
  const c = clock();
  const a = pingTab(c),
    stopA = followWorkspace("u", "w1", recorder().handlers, w.env(true, a.scope));
  const b = pingTab(c),
    stopB = followWorkspace("u", "w1", recorder().handlers, w.env(true, b.scope));
  await flush();
  await c.advance(GATHER_MS);
  // The leading tab is in the background; the other one is in use.
  a.hide();
  await c.advance(30_000);
  b.share.used();
  await flush();
  await c.advance(EVERY_MS - 30_000);
  assert.ok(a.sent.at(-1)! <= 31_000, `idle of the used tab, not of the hidden one: ${a.sent.at(-1)}`);
  // Nobody uses anything for a few minutes: idle grows.
  await c.advance(5 * EVERY_MS);
  assert.ok(a.sent.at(-1)! >= 5 * EVERY_MS);
  // Coming back after a pause in the other tab: the ping goes right away.
  await c.advance(10_000);
  const before = a.sent.length;
  b.share.used();
  await flush();
  await flush();
  assert.equal(a.sent.length, before + 1, "at once");
  assert.equal(a.sent.at(-1), 0);
  assert.equal(b.sent.length, 0, "the other tab never pings");
  // The leading tab closes: the other one leads and pings.
  stopA();
  a.share.stop();
  await flush();
  await flush();
  assert.equal(b.share.role, "lead");
  await c.advance(GATHER_MS);
  assert.equal(b.sent.length, 1);
  stopB();
  b.share.stop();
});

test("the activity ping without Web Locks, without a stream, with a silent leader, after a 401 (#515, #513)", async () => {
  const w = world();
  const c = clock();
  // No Web Locks: every tab pings, as before.
  const alone = [0, 1].map(() => {
    const t = pingTab(c, "w2");
    return { ...t, stop: followWorkspace("u", "w2", recorder().handlers, w.env(false, t.scope)) };
  });
  await c.advance(EVERY_MS);
  assert.deepEqual(alone.map((t) => [t.share.role, t.sent.length]), [["alone", 2], ["alone", 2]]);
  for (const t of alone) t.stop(), t.share.stop();
  // No stream at all (it never started): alone after a moment.
  const lonely = pingTab(c, "w3");
  await c.advance(ROLE_WAIT_MS);
  assert.equal(lonely.share.role, "alone");
  assert.equal(lonely.sent.length, 1);
  lonely.share.stop();
  // The leading tab goes silent (frozen, an older app): the follower pings itself.
  const leaderStop = followWorkspace("u", "w4", recorder().handlers, w.env());
  const follower = pingTab(c, "w4"),
    followerStop = followWorkspace("u", "w4", recorder().handlers, w.env(true, follower.scope));
  await flush();
  assert.equal(follower.share.role, "follow");
  await c.advance(SILENT_MS + EVERY_MS);
  assert.ok(follower.sent.length >= 1, "pings once the leading tab is silent");
  leaderStop();
  followerStop();
  follower.share.stop();
  // A 401: no more pings, ever (#513).
  const out = pingTab(c, "w5", 401);
  await c.advance(ROLE_WAIT_MS);
  await flush();
  assert.equal(out.ended(), 1);
  await c.advance(10 * EVERY_MS);
  assert.equal(out.sent.length, 1);
  out.share.stop();
});

test("the instance's notices arrive over the stream: part maintenance, ready, live state (#515)", async () => {
  const w = world();
  const heard: NoticeSignal[] = [];
  const off = onInstanceNotices((s) => heard.push(s));
  const r = recorder();
  const stopA = followWorkspace("u", "w1", r.handlers, w.env());
  const b = recorder();
  const stopB = followWorkspace("u", "w1", b.handlers, w.env());
  await flush();
  assert.equal(noticesLive(), false);
  send(w.sources[0], { type: "ready" });
  send(w.sources[0], { type: "changed", parts: ["maintenance"] });
  await flush();
  assert.equal(noticesLive(), true);
  assert.deepEqual(r.events.at(-1), { type: "changed", parts: ["maintenance"] }, "the part passes the filter");
  assert.equal(wantedFor({ type: "changed", parts: ["maintenance"] }, "p1"), null, "and makes the workspace fetch nothing");
  // Both tabs (the leading one and the one listening) hear it.
  assert.deepEqual(heard.filter((s) => s.type !== "state").map((s) => s.type).sort(), ["changed", "changed", "ready", "ready"]);
  assert.deepEqual(heard[0], { type: "state", live: true });
  stopA();
  stopB();
  assert.equal(noticesLive(), false);
  assert.deepEqual(heard.at(-1), { type: "state", live: false });
  off();
});

function noticeWorld(start: Partial<{ live: boolean; status: number; move: { readOnly: boolean; movedTo: string | null; redirect: boolean } }> = {}) {
  const c = clock();
  let live = start.live ?? false;
  let listener: ((s: NoticeSignal) => void) | null = null;
  const loads: number[] = [];
  let visible = true;
  const answer = { status: start.status ?? 200, move: start.move ?? { readOnly: false, movedTo: null, redirect: false } };
  const env: NoticeEnv = {
    now: c.now,
    random: () => 0.5,
    visible: () => visible,
    load: async () => (loads.push(c.now()), { status: answer.status, body: { notice: null, move: answer.move } }),
    live: () => live,
    subscribe: (l) => ((listener = l), () => (listener = null)),
    setTimeout: c.setTimeout,
    clearTimeout: c.clearTimeout,
  };
  const store = createNoticeStore({}, env);
  return {
    c,
    store,
    loads,
    answer,
    signal: (s: NoticeSignal) => {
      if (s.type === "state") live = s.live;
      listener?.(s);
    },
    setVisible: (v: boolean) => (visible = v),
  };
}

test("the banners: asked on a signal, polled slowly only while the stream is not live (#515)", async () => {
  // Live: no polling at all; a change and a late ready ask once.
  const n = noticeWorld({ live: true });
  await n.c.advance(60 * 60_000);
  assert.equal(n.loads.length, 0, "an hour live: no request");
  n.signal({ type: "changed" });
  await n.c.advance(3_000);
  assert.equal(n.loads.length, 1);
  n.signal({ type: "ready" });
  await n.c.advance(3_000);
  assert.equal(n.loads.length, 1, "a ready right after an answer asks nothing");
  await n.c.advance(READY_FRESH_MS);
  n.signal({ type: "ready" });
  await n.c.advance(3_000);
  assert.equal(n.loads.length, 2, "a later ready asks (something may have been missed)");
  // The stream goes down: the slow poll.
  n.signal({ type: "state", live: false });
  await n.c.advance(60 * 60_000);
  assert.equal(n.loads.length, 2 + 6, "every 10 minutes");
  n.store.dispose();

  // A move under way: every minute while not live; moved: slow again.
  const m = noticeWorld({ move: { readOnly: true, movedTo: null, redirect: false } });
  await m.c.advance(FALLBACK_POLL_MS);
  assert.equal(m.loads.length, 1);
  await m.c.advance(5 * MOVE_POLL_MS);
  assert.equal(m.loads.length, 6);
  m.answer.move = { readOnly: true, movedTo: "https://new.example", redirect: false };
  await m.c.advance(MOVE_POLL_MS);
  assert.equal(m.store.get().move.movedTo, "https://new.example");
  await m.c.advance(5 * MOVE_POLL_MS);
  assert.equal(m.loads.length, 7);
  m.store.dispose();

  // Hidden: asked when shown again. Signed out (401): no more polls until the stream is back.
  const h = noticeWorld();
  h.setVisible(false);
  await h.c.advance(3 * FALLBACK_POLL_MS);
  assert.equal(h.loads.length, 0);
  h.setVisible(true);
  h.store.shown();
  await flush();
  assert.equal(h.loads.length, 1);
  h.answer.status = 401;
  await h.c.advance(FALLBACK_POLL_MS);
  assert.equal(h.loads.length, 2);
  await h.c.advance(5 * FALLBACK_POLL_MS);
  assert.equal(h.loads.length, 2, "after a 401: quiet");
  h.store.dispose();
});

test("the banners use the stream: no more polling every minute (#515)", async () => {
  const { readFileSync } = await import("node:fs");
  for (const file of ["move-banner.tsx", "maintenance-banner.tsx"]) {
    const src = readFileSync(new URL(`../components/${file}`, import.meta.url), "utf8");
    assert.match(src, /useInstanceNotices\(/, file);
    assert.doesNotMatch(src, /setInterval|fetch\(/, file);
  }
});

// The harness of #515: background requests per hour of N open tabs of one
// person in one workspace (all visible, nobody typing), before and after.
// Before: every tab pinged /api/activity every minute and asked
// /api/maintenance every minute (move banner) and every 5 minutes
// (maintenance banner). After: the real code – one ping per browser, the
// banners on the stream (here with one maintenance announced in the hour),
// and the slow fallback when the stream is down.
async function trafficPerHour(n: number, streamLive: boolean) {
  const w = world();
  const c = clock();
  const count = { activity: 0, maintenance: 0, live: 0 };
  const tabs = [];
  for (let i = 0; i < n; i++) {
    const scope = {};
    const share = startActivityPing("u", "w1", {
      now: c.now,
      visible: () => true,
      ping: async () => (count.activity++, 204),
      ended: () => {},
      setTimeout: c.setTimeout,
      clearTimeout: c.clearTimeout,
      scope,
    });
    // The tab's banners, wired to its stream like onInstanceNotices does.
    let live = false;
    let hear: ((s: NoticeSignal) => void) | null = null;
    const store = createNoticeStore({}, {
      now: c.now,
      random: Math.random,
      visible: () => true,
      load: async () => (count.maintenance++, { status: 200, body: { notice: null, move: { readOnly: false, movedTo: null, redirect: false } } }),
      live: () => live,
      subscribe: (l) => ((hear = l), () => (hear = null)),
      setTimeout: c.setTimeout,
      clearTimeout: c.clearTimeout,
    });
    const stop = followWorkspace("u", "w1", {
      message: (e) => {
        if (e.type === "ready") hear?.({ type: "ready" });
        else if (e.parts.includes("maintenance")) hear?.({ type: "changed" });
      },
      state: (l) => {
        live = l;
        hear?.({ type: "state", live: l });
      },
    }, w.env(true, scope));
    tabs.push({ share, store, stop });
  }
  await flush();
  if (streamLive) send(w.sources[0], { type: "ready" });
  await c.advance(30 * 60_000);
  if (streamLive) send(w.sources[0], { type: "changed", parts: ["maintenance"] });
  await c.advance(30 * 60_000);
  count.live = w.sources.length;
  for (const t of tabs) t.stop(), t.share.stop(), t.store.dispose();
  return count;
}
const before = (n: number) => ({ activity: 60 * n, maintenance: (60 + 12) * n });

test("background traffic per hour, before and after (#515)", async () => {
  const rows: string[] = [];
  for (const n of [1, 3, 10]) {
    const b = before(n);
    const live = await trafficPerHour(n, true);
    const down = await trafficPerHour(n, false);
    rows.push(
      `${String(n).padStart(3)} tabs | before: activity ${b.activity}, maintenance ${b.maintenance}, total ${b.activity + b.maintenance}` +
        ` | after (live): activity ${live.activity}, maintenance ${live.maintenance}, total ${live.activity + live.maintenance}` +
        ` | after (stream down): activity ${down.activity}, maintenance ${down.maintenance}, total ${down.activity + down.maintenance}`,
    );
    assert.ok(live.activity <= 62, "one ping a minute per browser");
    assert.ok(live.maintenance <= n, "one ask per tab for the one change");
    assert.ok(down.maintenance <= 6 * n + n, "every 10 minutes without the stream");
  }
  console.log(rows.join("\n"));
});
