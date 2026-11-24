"use client";
// The instance's notices for the banners (#515): the maintenance an
// administrator announced (components/maintenance-banner.tsx) and the
// read-only state of a move (components/move-banner.tsx), both from
// /api/maintenance. One store per tab for both banners.
//
// They used to be polled – the move every minute, the maintenance every
// five – by every open tab. Now the server says when they changed over the
// workspace's live stream (part "maintenance", components/workspace-live.ts),
// and the banners ask again then and after the stream (re)connected
// ("ready": something may have been missed). Polling stays as a slow
// fallback while the stream is not live: every FALLBACK_POLL_MS, every
// MOVE_POLL_MS while a move is under way (read-only, not moved yet) – the
// new address should reach open tabs soon. A hidden tab polls when it is
// shown again. After a 401 (signed out) it stops until the stream is back.
import { useEffect, useState } from "react";
import { onInstanceNotices, noticesLive, type NoticeSignal } from "./workspace-live";
import type { MaintenanceNotice } from "@/lib/admin-ops";
import type { ReadOnlyState } from "@/lib/instance-read-only";

export type Notices = { notice: MaintenanceNotice | null; move: ReadOnlyState };
export const FALLBACK_POLL_MS = 10 * 60_000;
export const MOVE_POLL_MS = 60_000;
// A "ready" this soon after the last answer asks nothing (the page has just
// been rendered with the current notices).
export const READY_FRESH_MS = 30_000;
// A change reaches every open tab at once: they ask within this spread.
export const SPREAD_MS = 3_000;

export const pollDelay = (n: Notices) => (n.move.readOnly && !n.move.movedTo ? MOVE_POLL_MS : FALLBACK_POLL_MS);
const NO_MOVE: ReadOnlyState = { readOnly: false, movedTo: null, redirect: false };

export type NoticeEnv = {
  now: () => number;
  random: () => number;
  visible: () => boolean;
  // GET /api/maintenance: the status and, when ok, the answer.
  load: () => Promise<{ status: number; body?: { notice?: MaintenanceNotice | null; move?: ReadOnlyState } }>;
  live: () => boolean;
  subscribe: (listener: (signal: NoticeSignal) => void) => () => void;
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (t: unknown) => void;
};

export function createNoticeStore(initial: Partial<Notices>, env: NoticeEnv) {
  let state: Notices = { notice: initial.notice ?? null, move: initial.move ?? NO_MOVE };
  let fetchedAt = env.now(),
    fetched = false,
    loading = false,
    signedOut = false,
    timer: unknown = null,
    // The timer is the spread ask after a signal (not replaced by a poll).
    asking = false,
    disposed = false;
  const listeners = new Set<(n: Notices) => void>();
  const clear = () => {
    if (timer !== null) env.clearTimeout(timer);
    timer = null;
    asking = false;
  };
  // The next poll, unless the stream is live (or signed out).
  const schedule = () => {
    if (asking) return;
    clear();
    if (disposed || signedOut || env.live()) return;
    timer = env.setTimeout(
      () => {
        timer = null;
        // Hidden: asked when shown again.
        if (env.visible()) void refresh();
      },
      Math.max(0, fetchedAt + pollDelay(state) - env.now()),
    );
  };
  const refresh = async () => {
    if (loading || disposed) return;
    loading = true;
    clear();
    try {
      const answer = await env.load();
      if (answer.status === 401) signedOut = true;
      else if (answer.status >= 200 && answer.status < 300 && answer.body) {
        signedOut = false;
        fetched = true;
        state = { notice: answer.body.notice ?? null, move: answer.body.move ?? state.move };
        for (const listener of [...listeners]) listener(state);
      }
    } catch {}
    fetchedAt = env.now();
    loading = false;
    schedule();
  };
  const soon = () => {
    if (asking) return;
    clear();
    asking = true;
    timer = env.setTimeout(() => {
      timer = null;
      asking = false;
      void refresh();
    }, env.random() * SPREAD_MS);
  };
  const unsubscribe = env.subscribe((signal) => {
    if (disposed) return;
    if (signal.type === "changed") {
      signedOut = false;
      soon();
    } else if (signal.type === "ready") {
      signedOut = false;
      if (env.now() - fetchedAt > READY_FRESH_MS) soon();
    } else schedule();
  });
  schedule();
  return {
    get: () => state,
    // What the other banner was rendered with (until the first answer).
    seed(more: Partial<Notices>) {
      if (fetched) return;
      state = { notice: more.notice !== undefined ? more.notice : state.notice, move: more.move ?? state.move };
    },
    listen(listener: (n: Notices) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    // The tab was shown: a poll that came due meanwhile goes now.
    shown() {
      if (!disposed && !signedOut && !env.live() && env.now() - fetchedAt >= pollDelay(state)) void refresh();
    },
    dispose() {
      disposed = true;
      clear();
      unsubscribe();
    },
  };
}
export type NoticeStore = ReturnType<typeof createNoticeStore>;

// One store per tab, for as long as a banner uses it.
let shared: { store: NoticeStore; users: number; shown: () => void } | null = null;
function acquire(initial: Partial<Notices>) {
  if (shared) {
    shared.store.seed(initial);
    shared.users++;
    return shared.store;
  }
  const store = createNoticeStore(initial, {
    now: () => Date.now(),
    random: Math.random,
    visible: () => document.visibilityState === "visible",
    load: async () => {
      const answer = await fetch("/api/maintenance", { cache: "no-store" });
      return { status: answer.status, body: answer.ok ? await answer.json() : undefined };
    },
    live: noticesLive,
    subscribe: onInstanceNotices,
    setTimeout: (fn, ms) => window.setTimeout(fn, ms),
    clearTimeout: (t) => window.clearTimeout(t as number),
  });
  const shown = () => {
    if (document.visibilityState === "visible") store.shown();
  };
  document.addEventListener("visibilitychange", shown);
  shared = { store, users: 1, shown };
  return store;
}
function release(store: NoticeStore) {
  if (!shared || shared.store !== store || --shared.users > 0) return;
  document.removeEventListener("visibilitychange", shared.shown);
  store.dispose();
  shared = null;
}

// The notices, kept current (`enabled` false: just `initial`, e.g. for
// visitors who are not signed in – /api/maintenance needs a session).
export function useInstanceNotices(initial: Partial<Notices>, enabled = true): Notices {
  const [notices, setNotices] = useState<Notices>(() => ({ notice: initial.notice ?? null, move: initial.move ?? NO_MOVE }));
  useEffect(() => {
    if (!enabled) return;
    const store = acquire(initial);
    setNotices(store.get());
    const stop = store.listen(setNotices);
    return () => {
      stop();
      release(store);
    };
    // The initial values only seed the store.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled]);
  return notices;
}
