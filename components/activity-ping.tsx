"use client";
// Tells the server once a minute that the app is open and how long ago it
// was last used (typed, clicked, scrolled, touched) – for "who is here" in
// Administration → Users (lib/user-activity.ts). Nothing else is sent.
import { useEffect } from "react";

const EVERY_MS = 60_000;
const USE_EVENTS = [
  "pointerdown",
  "keydown",
  "wheel",
  "touchstart",
  "scroll",
] as const;

export function ActivityPing() {
  useEffect(() => {
    let usedAt = Date.now();
    let sentAt = 0;
    const send = () => {
      sentAt = Date.now();
      // A tab in the background is open, but nobody is using it.
      const idleMs =
        document.visibilityState === "visible"
          ? sentAt - usedAt
          : Math.max(sentAt - usedAt, EVERY_MS * 2);
      void fetch("/api/activity", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ idleMs }),
        keepalive: true,
      }).catch(() => {});
    };
    const used = () => {
      const quiet = Date.now() - usedAt > EVERY_MS;
      usedAt = Date.now();
      // Coming back after a pause shows up right away, not a minute later.
      if (quiet && Date.now() - sentAt > 5_000) send();
    };
    const shown = () => {
      if (document.visibilityState === "visible") used();
    };
    send();
    const timer = window.setInterval(send, EVERY_MS);
    for (const name of USE_EVENTS)
      window.addEventListener(name, used, { passive: true, capture: true });
    document.addEventListener("visibilitychange", shown);
    return () => {
      window.clearInterval(timer);
      for (const name of USE_EVENTS)
        window.removeEventListener(name, used, { capture: true });
      document.removeEventListener("visibilitychange", shown);
    };
  }, []);
  return null;
}
