"use client";
// What the workspace's live signal (components/workspace-live.ts) means for
// an open tab (#383): the bootstrap again when the tree, the permissions or
// the notifications changed, the open page again when it changed, both
// after (re)connecting – something may have been missed meanwhile. A tab
// that is hidden only notes what it missed and fetches it when shown.
// Returns whether signals arrive (then the timed refresh is a safety net).
// `notified` hears of every change of the notifications at once, hidden
// or not (the sound for new ones, components/use-notification-sound-alerts.ts).
import { useEffect, useRef, useState, type RefObject } from "react";
import { followWorkspace, type LiveEvent } from "./workspace-live";

// The timed refresh with the live signal, and without it (as before).
export const LIVE_REFRESH_MS = 60_000;
export const POLL_REFRESH_MS = 10_000;
// With the live signal the open page alone is asked for this often: it
// keeps the person among those who have the page open (45 s,
// lib/page-presence.ts) and is a kept 304 while nothing changed
// (lib/kept-answers.ts).
export const PRESENCE_REFRESH_MS = 30_000;

export type Wanted = { boot: boolean; page: boolean };
// What a message asks this tab to fetch (null: nothing). Exported for tests.
export function wantedFor(event: LiveEvent, openPageId: string | null): Wanted | null {
  if (event.type === "ready") return { boot: true, page: true };
  const boot = event.parts.includes("tree") || event.parts.includes("notifications");
  const page = !!openPageId && event.parts.includes("pages") && !!event.pages?.includes(openPageId);
  return boot || page ? { boot, page } : null;
}
// Many tabs get the same signal at once: the sidebar is fetched after a
// short random wait, so they do not all ask in the same instant; a change
// of the open page comes quicker.
const spread = (wanted: Wanted) => Math.random() * (wanted.boot ? 1000 : 250);
// While a workspace is busy (records edited every second), signals come
// all the time: the bootstrap is fetched at most every BOOT_GAP_MS – never
// more often than the timed refresh did before – and the open page at most
// every PAGE_GAP_MS (half the timed refresh before: a busy database is
// built anew for every viewer). The first change after a quiet time comes
// at once.
export const BOOT_GAP_MS = 10_000;
export const PAGE_GAP_MS = 5_000;
// When the first part of `wanted` may be fetched, given when each part was
// fetched last.
export function nextAllowed(wanted: Wanted, last: { boot: number; page: number }) {
  return Math.min(wanted.boot ? last.boot + BOOT_GAP_MS : Infinity, wanted.page ? last.page + PAGE_GAP_MS : Infinity);
}

export function useWorkspaceSignals(
  userId: string,
  workspaceId: string,
  openPage: RefObject<string | null>,
  refresh: (only: { boot?: boolean; page?: boolean }) => Promise<unknown>,
  notified?: RefObject<() => void>,
  // false while the tab is signed out (the banner): no stream then.
  enabled = true,
) {
  const [live, setLive] = useState(false);
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;
  useEffect(() => {
    if (!enabled) return;
    // What waits: for the timer below, or for the tab to be shown.
    let pending: Wanted | null = null,
      timer: number | null = null,
      running = false;
    const last = { boot: -Infinity, page: -Infinity };
    const schedule = (delay: number) => {
      if (timer === null) timer = window.setTimeout(run, Math.max(0, delay));
    };
    const run = () => {
      timer = null;
      if (!pending || document.visibilityState === "hidden") return;
      if (running) return schedule(200);
      const now = Date.now();
      // What may go now; the rest waits for its gap.
      const boot = pending.boot && now >= last.boot + BOOT_GAP_MS,
        page = pending.page && now >= last.page + PAGE_GAP_MS;
      if (!boot && !page) return schedule(nextAllowed(pending, last) - now);
      const wanted = { boot, page };
      pending = pending.boot && !boot ? { boot: true, page: false } : pending.page && !page ? { boot: false, page: true } : null;
      running = true;
      if (boot) last.boot = now;
      if (page) last.page = now;
      if (pending) schedule(nextAllowed(pending, last) - now);
      void refreshRef
        .current(wanted)
        .catch(() => {})
        .finally(() => {
          running = false;
        });
    };
    const want = (wanted: Wanted) => {
      pending = pending ? { boot: pending.boot || wanted.boot, page: pending.page || wanted.page } : wanted;
      if (document.visibilityState === "hidden") return;
      schedule(Math.max(spread(wanted), nextAllowed(pending, last) - Date.now()));
    };
    const shown = () => {
      if (document.visibilityState !== "hidden" && pending && timer === null) run();
    };
    document.addEventListener("visibilitychange", shown);
    let first = true;
    const stop = followWorkspace(userId, workspaceId, {
      message: (event) => {
        // The first "ready" is the start: the tab has just loaded everything.
        if (event.type === "ready" && first) {
          first = false;
          return;
        }
        if (event.type === "ready" || event.parts.includes("notifications")) notified?.current?.();
        const wanted = wantedFor(event, openPage.current);
        if (wanted) want(wanted);
      },
      state: setLive,
    });
    return () => {
      stop();
      document.removeEventListener("visibilitychange", shown);
      if (timer !== null) window.clearTimeout(timer);
      setLive(false);
    };
  }, [userId, workspaceId, openPage, notified, enabled]);
  return live;
}
