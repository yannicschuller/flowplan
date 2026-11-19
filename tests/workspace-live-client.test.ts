// The workspace's live signal in the browser (#383,
// components/workspace-live.ts, components/use-workspace-signals.ts): one
// stream per browser shared by the tabs through a Web Lock and a
// BroadcastChannel, the fallback to the timed refresh while no signals
// arrive (no connection, an error answer, revoked) and what a signal makes
// a tab fetch.
import { test } from "node:test";
import assert from "node:assert/strict";
import { followWorkspace, openLiveSource, RETRY_MS, type LiveEnv, type LiveEvent } from "../components/workspace-live";
import { BOOT_GAP_MS, LIVE_REFRESH_MS, nextAllowed, PAGE_GAP_MS, POLL_REFRESH_MS, wantedFor } from "../components/use-workspace-signals";

type FakeSource = { url: string; onmessage: ((e: { data: string }) => void) | null; onerror: (() => void) | null; readyState: number; closed: boolean; close(): void };
// A browser: EventSource, timers, and (optionally) locks and channels shared
// with other "tabs" made from the same world.
function world() {
  const sources: FakeSource[] = [];
  const timers: { fn: () => void; ms: number; cleared: boolean }[] = [];
  const held = new Map<string, { queue: (() => void)[]; busy: boolean }>();
  const channels = new Map<string, Set<{ onmessage: ((e: { data: unknown }) => void) | null; closed: boolean }>>();
  const env = (withLocks = true): LiveEnv => ({
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
