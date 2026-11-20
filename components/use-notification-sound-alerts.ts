"use client";
// "Ton bei neuen Benachrichtigungen" (#401, lib/notification-sound.ts): the
// open app plays the person's sound when a new notification arrives.
//
// When: the workspace's live signal says the notifications changed
// (components/use-workspace-signals.ts – it reaches hidden tabs too); without
// the signal, when the timed refresh brings an unread notification this tab
// has not had before. Then one tab asks GET /api/notifications
// (lib/notification-feed.ts, server time) and decides (soundDecision): only
// new, unread and recent ones, never the person's own rule or workflow
// right after their own change, never when the count only went down.
//
// Only one tab: the Web Lock below lets one tab at a time look, and the ids
// heard are kept for all tabs of the browser (localStorage), so a second
// tab finds them heard. Tabs that may not make a sound (setting off, the
// page never clicked – the browser's autoplay rule) do not ask at all.
//
// Elsewhere already: the Flowplan app on phones plays the push's own
// sound, so its web view stays quiet; the desktop app shows a system
// notification with its sound while its window is not in front (and none
// while it is: lib/native-app.ts, flowplan-desktop notifier.js), so its
// window plays only while focused – or always when its notifications are off.
import { useEffect, useRef, type RefObject } from "react";
import { api } from "./ui";
import { desktopApp, nativeApp } from "@/lib/native-app";
import { rememberKnown, soundDecision, type SoundItem } from "@/lib/notification-sound";
import { armAudioUnlock, audioUnlocked, notificationSound, ownActionAgo, playNotificationSound } from "@/lib/notification-sound-client";

type Feed = { now: string; notifications: SoundItem[] };
const knownKey = (userId: string) => `flowplan:notifications-heard:${userId}`;

export function useNotificationSoundAlerts(
  userId: string,
  notifications: readonly { id: string; read_at: string | null }[],
  live: boolean,
  check: RefObject<() => void>,
) {
  // Without localStorage: this tab's own memory.
  const memory = useRef<string[]>([]);
  const readKnown = (): string[] => {
    try {
      const stored = JSON.parse(localStorage.getItem(knownKey(userId)) || "[]");
      return Array.isArray(stored) ? stored.filter((v): v is string => typeof v === "string") : [];
    } catch {
      return memory.current;
    }
  };
  const writeKnown = (ids: string[]) => {
    memory.current = ids;
    try {
      localStorage.setItem(knownKey(userId), JSON.stringify(ids));
    } catch {}
  };
  const readKnownRef = useRef(readKnown);
  readKnownRef.current = readKnown;
  const writeKnownRef = useRef(writeKnown);
  writeKnownRef.current = writeKnown;

  // What the page showed when it opened is not new.
  const initial = useRef(notifications);
  useEffect(() => {
    writeKnownRef.current(rememberKnown(readKnownRef.current(), initial.current.map((n) => n.id)));
  }, [userId]);

  // The desktop app's system notifications: on or off (asked again when
  // its window comes to the front).
  const desktopOn = useRef(false);
  useEffect(() => {
    armAudioUnlock();
    const app = desktopApp();
    if (!app?.notifications) return;
    const ask = () =>
      void app.notifications!.enabled()
        .then((on) => (desktopOn.current = on))
        .catch(() => {});
    ask();
    window.addEventListener("focus", ask);
    return () => window.removeEventListener("focus", ask);
  }, []);

  useEffect(() => {
    let running = false,
      again = false,
      stopped = false;
    // Only a tab that could make a sound looks at all.
    const mayPlay = () => !stopped && !nativeApp() && notificationSound() !== "off" && audioUnlocked();
    const look = async () => {
      const feed = await api<Feed>("/api/notifications");
      const known = readKnownRef.current();
      const decision = soundDecision({
        sound: notificationSound(),
        items: feed.notifications,
        now: feed.now,
        known: new Set(known),
        ownActionAgo: ownActionAgo(),
        // The desktop app rings itself while its window is in the back.
        handledElsewhere: desktopOn.current && !document.hasFocus(),
      });
      if (decision.fresh.length) writeKnownRef.current(rememberKnown(known, decision.fresh));
      if (decision.play && mayPlay()) playNotificationSound(notificationSound());
    };
    const run = async () => {
      if (running) {
        again = true;
        return;
      }
      running = true;
      try {
        do {
          again = false;
          if (!mayPlay()) break;
          const locks = typeof navigator !== "undefined" && "locks" in navigator ? navigator.locks : null;
          if (locks)
            // Another tab looking right now: it got the same signal.
            await locks.request(`flowplan-notification-sound:${userId}`, { ifAvailable: true }, async (lock) => {
              if (lock) await look();
            });
          else await look();
        } while (again && !stopped);
      } catch {
        // No sound this time; the next signal asks again.
      } finally {
        running = false;
      }
    };
    check.current = () => void run();
    return () => {
      stopped = true;
      check.current = () => {};
    };
  }, [userId, check]);

  // Without the live signal: an unread notification the timed refresh
  // brought that this tab has not had before.
  const seen = useRef<Set<string> | null>(null);
  useEffect(() => {
    const before = seen.current;
    seen.current = new Set(notifications.map((n) => n.id));
    if (!before || live) return;
    if (notifications.some((n) => !n.read_at && !before.has(n.id))) check.current();
  }, [notifications, live, check]);
}
