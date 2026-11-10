"use client";
// Presenting a notebook to the others who have it open, over the channel
// of the whiteboards' live cursors (lib/whiteboard-presence.ts: in memory,
// server-sent events, the cluster bus) – no service of its own. The
// presenter sends the sheet shown, the pointer on it (sheet points), whether
// the laser or the fading marker is on, and since when they present; the
// others see "Folgen" and, following, that sheet and that pointer. Readers
// follow too. Only cursors that present are taken; everyone else's pointer
// never leaves their device.
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../ui";

export type LivePoint = { x: number; y: number; laser?: boolean; mark?: boolean };
export type Presenter = { userId: string; name: string; sheet: string; since: number; point: LivePoint | null; at: number };
type Cursor = { userId: string; name: string; x: number; y: number; laser?: boolean; mark?: boolean; sheet?: string; present?: number };

// A pointer that does not point (the presenter's hand left the sheet).
const AWAY = -1;

export function useNotebookLive(pageId: string, enabled = true) {
  const [presenters, setPresenters] = useState<Presenter[]>([]);
  // Points of the presenters as they come (laser trails, the marker).
  const listeners = useRef(new Set<(p: Presenter) => void>());
  useEffect(() => {
    if (!enabled) return;
    const known = new Map<string, Presenter>();
    const publish = () => setPresenters([...known.values()].sort((a, b) => b.since - a.since));
    const take = (c: Cursor) => {
      if (!c.present || !c.sheet) {
        if (known.delete(c.userId)) publish();
        return;
      }
      const away = c.x === AWAY && c.y === AWAY;
      const point = away ? null : { x: c.x, y: c.y, laser: !!c.laser, mark: !!c.mark };
      const before = known.get(c.userId);
      const next = { userId: c.userId, name: c.name, sheet: c.sheet, since: c.present, point, at: Date.now() };
      known.set(c.userId, next);
      for (const l of listeners.current) l(next);
      if (!before || before.sheet !== next.sheet || before.since !== next.since || !!before.point !== !!next.point) publish();
    };
    let source: EventSource | null = null,
      poll: ReturnType<typeof setInterval> | null = null,
      failures = 0;
    const url = `/api/whiteboards/${pageId}/cursors`;
    const startPolling = () => {
      if (poll) return;
      poll = setInterval(async () => {
        if (document.visibilityState !== "visible") return;
        try {
          const list = await api<Cursor[]>(url);
          const ids = new Set(list.map((c) => c.userId));
          for (const key of [...known.keys()]) if (!ids.has(key)) known.delete(key);
          list.forEach(take);
          publish();
        } catch {}
      }, 1500);
    };
    if (typeof EventSource === "undefined") startPolling();
    else {
      source = new EventSource(url);
      source.onmessage = (event) => {
        failures = 0;
        let data: { type?: string; cursors?: Cursor[]; userId?: string } & Partial<Cursor>;
        try {
          data = JSON.parse(event.data);
        } catch {
          return;
        }
        if (data.type === "snapshot") {
          known.clear();
          (data.cursors || []).forEach(take);
          publish();
        } else if (data.type === "cursor") take(data as Cursor);
        else if (data.type === "leave" && data.userId && known.delete(data.userId)) publish();
      };
      source.onerror = () => {
        if (++failures >= 3) {
          source?.close();
          startPolling();
        }
      };
    }
    // A presenter who stopped sending (closed the lid) goes after a while.
    const sweep = setInterval(() => {
      const now = Date.now();
      let changed = false;
      for (const [key, p] of known)
        if (now - p.at > 20_000) {
          known.delete(key);
          changed = true;
        }
      if (changed) publish();
    }, 5000);
    return () => {
      source?.close();
      if (poll) clearInterval(poll);
      clearInterval(sweep);
    };
  }, [pageId, enabled]);
  const onPoint = useCallback((listener: (p: Presenter) => void) => {
    listeners.current.add(listener);
    return () => void listeners.current.delete(listener);
  }, []);
  return { presenters, onPoint };
}

// The presenter's side: the state goes out up to ~15 times a second, and
// every few seconds while nothing changes (those who open the notebook
// later, the server forgetting quiet cursors after 15 s).
export function usePresenting(pageId: string, state: { sheet: string; since: number } | null) {
  const pending = useRef<Record<string, unknown> | null | undefined>(undefined);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const last = useRef(0);
  const point = useRef<LivePoint | null>(null);
  const live = useRef(state);
  live.current = state;
  const flush = useCallback(() => {
    timer.current = null;
    const body = pending.current;
    if (body === undefined) return;
    pending.current = undefined;
    last.current = Date.now();
    void fetch(`/api/whiteboards/${pageId}/cursor`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      keepalive: body === null,
    }).catch(() => {});
  }, [pageId]);
  const queue = useCallback(
    (body: Record<string, unknown> | null) => {
      pending.current = body;
      if (timer.current) return;
      timer.current = setTimeout(flush, body === null ? 0 : Math.max(0, 66 - (Date.now() - last.current)));
    },
    [flush],
  );
  const sendNow = useCallback(() => {
    const s = live.current;
    if (!s) return queue(null);
    const p = point.current;
    queue({ x: p ? Math.round(p.x) : AWAY, y: p ? Math.round(p.y) : AWAY, ...(p?.laser ? { laser: true } : {}), ...(p?.mark ? { mark: true } : {}), sheet: s.sheet, present: s.since });
  }, [queue]);
  const move = useCallback(
    (next: LivePoint | null) => {
      point.current = next;
      sendNow();
    },
    [sendNow],
  );
  useEffect(() => {
    if (!state) return;
    sendNow();
    const beat = setInterval(sendNow, 4000);
    return () => clearInterval(beat);
  }, [state?.sheet, state?.since, sendNow]); // eslint-disable-line react-hooks/exhaustive-deps
  const presenting = !!state;
  useEffect(() => {
    if (!presenting) return;
    const leave = () => {
      pending.current = null;
      flush();
    };
    window.addEventListener("pagehide", leave);
    return () => {
      window.removeEventListener("pagehide", leave);
      if (timer.current) clearTimeout(timer.current);
      leave();
    };
  }, [presenting, flush]);
  return { move };
}
