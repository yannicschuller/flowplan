"use client";
// Tells the server once a minute that the app is open and how long ago it
// was last used (typed, clicked, scrolled, touched) – for "who is here" in
// Administration → Users (lib/user-activity.ts) – and which workspace is
// open, for the inactivity message "only this workspace" (#282). Nothing
// else is sent. One ping per browser and workspace: the tab holding the
// live stream sends it for all of them (#515, components/activity-share.ts).
import { useEffect } from "react";
import { endedSession } from "./ui";
import { startActivityPing } from "./activity-share";

const USE_EVENTS = [
  "pointerdown",
  "keydown",
  "wheel",
  "touchstart",
  "scroll",
] as const;

export function ActivityPing({ userId, workspaceId }: { userId: string; workspaceId: string }) {
  useEffect(() => {
    const share = startActivityPing(userId, workspaceId, {
      now: () => Date.now(),
      visible: () => document.visibilityState === "visible",
      ping: async (idleMs) => {
        const res = await fetch("/api/activity", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ idleMs, workspaceId }),
          keepalive: true,
        });
        return res.status;
      },
      // A session that ended (signed out elsewhere, expired): no more pings –
      // a tab left open would otherwise send a 401 every minute for ever
      // (#513; startActivityPing stops its timers on a 401).
      ended: () => endedSession("/api/activity", 401),
      setTimeout: (fn, ms) => window.setTimeout(fn, ms),
      clearTimeout: (t) => window.clearTimeout(t as number),
    });
    const used = () => share.used();
    const shown = () => share.visibility();
    for (const name of USE_EVENTS)
      window.addEventListener(name, used, { passive: true, capture: true });
    document.addEventListener("visibilitychange", shown);
    return () => {
      share.stop();
      for (const name of USE_EVENTS)
        window.removeEventListener(name, used, { capture: true });
      document.removeEventListener("visibilitychange", shown);
    };
  }, [userId, workspaceId]);
  return null;
}
