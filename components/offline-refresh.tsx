"use client";
// Keeps the offline copy of this device up to date while the app is open:
// after the start, when the connection comes back, when the app returns to
// the foreground and every 6 hours while it is visible. Each run asks the
// server what changed and fetches only that (components/offline.ts).
import { useEffect, useRef, useState } from "react";
import { LOCALE_TAG } from "@/lib/locale-tag";
import { useT } from "./i18n";
import {
  OFFLINE_CHANGED,
  offlineMarker,
  offlineSupported,
  refreshOffline,
  registerPeriodicSync,
  type OfflineMarker,
} from "./offline";

const MINUTE = 60_000,
  HOUR = 60 * MINUTE;
const INTERVAL = 6 * HOUR;
// A copy older than this gets a hint while offline.
const OLD_COPY = 7 * 24 * HOUR;

export function useOfflineRefresh(userId: string, online: boolean, quiet: boolean) {
  const t = useT();
  const [marker, setMarker] = useState<OfflineMarker | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const lastAttempt = useRef(0);
  useEffect(() => {
    if (!offlineSupported()) return;
    let stopped = false;
    const load = () =>
      void offlineMarker().then((m) => {
        if (!stopped) setMarker(m?.user === userId ? m : null);
      });
    // Runs when the copy is older than minAge; one attempt per minute at most.
    const run = async (minAge: number) => {
      const current = await offlineMarker();
      if (stopped || current?.user !== userId || !navigator.onLine) return;
      if (Date.now() - (current.lastRefresh || 0) < minAge || Date.now() - lastAttempt.current < MINUTE) return;
      lastAttempt.current = Date.now();
      // Shown only for runs that take a moment.
      const shown = setTimeout(() => !stopped && setRefreshing(true), 1500);
      try {
        await refreshOffline();
      } catch {
      } finally {
        clearTimeout(shown);
        if (!stopped) setRefreshing(false);
        load();
      }
    };
    load();
    // After the first render, so the start stays fast.
    const start = setTimeout(() => {
      void run(5 * MINUTE);
      void registerPeriodicSync();
    }, 3000);
    const back = () => void run(0);
    const visible = () => {
      if (document.visibilityState === "visible") void run(30 * MINUTE);
    };
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void run(INTERVAL);
    }, 10 * MINUTE);
    // Periodic Background Sync with the app open: this window refreshes.
    const message = (e: MessageEvent) => {
      if (e.data?.type === "flowplan-offline-refresh") void run(MINUTE);
    };
    window.addEventListener("online", back);
    window.addEventListener(OFFLINE_CHANGED, load);
    document.addEventListener("visibilitychange", visible);
    navigator.serviceWorker?.addEventListener("message", message);
    return () => {
      stopped = true;
      clearTimeout(start);
      clearInterval(timer);
      window.removeEventListener("online", back);
      window.removeEventListener(OFFLINE_CHANGED, load);
      document.removeEventListener("visibilitychange", visible);
      navigator.serviceWorker?.removeEventListener("message", message);
    };
  }, [userId]);
  const age = marker ? marker.lastRefresh || marker.since : 0;
  if (!online && marker && age && Date.now() - age > OLD_COPY)
    return (
      <div className="offline-copy-age" role="note">
        {t("Offline-Kopie vom", "Offline copy from")}{" "}
        {new Date(age).toLocaleDateString(LOCALE_TAG, { day: "numeric", month: "short" })}
      </div>
    );
  if (online && refreshing && quiet)
    return (
      <div className="offline-refresh-status" role="status">
        {t("Offline-Kopie wird aktualisiert …", "Updating offline copy …")}
      </div>
    );
  return null;
}
