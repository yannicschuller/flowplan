"use client";
import { useEffect, useState } from "react";
import { Wrench, X } from "@phosphor-icons/react";
import { useT } from "./i18n";
import { LOCALE_TAG } from "@/lib/locale-tag";
import { useInstanceNotices } from "./instance-notices";
import type { MaintenanceNotice } from "@/lib/admin-ops";

const dismissedKey = (n: MaintenanceNotice) => `flowplan-maintenance-dismissed:${n.start}:${n.end}`;

// The maintenance an administrator announced (Administration → Operations):
// a banner for everyone until the maintenance has ended. A new or changed
// notice reaches open tabs over the workspace's live stream, or by a slow
// poll while it is not live (components/instance-notices.ts, #515).
export function MaintenanceBanner({ initial }: { initial: MaintenanceNotice | null }) {
  const t = useT();
  const notice = useInstanceNotices({ notice: initial }).notice;
  const [now, setNow] = useState(() => Date.now());
  const [dismissed, setDismissed] = useState(false);
  // Times in the reader's time zone and language: rendered in the browser only.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  useEffect(() => {
    setNow(Date.now());
    if (!notice) return;
    try {
      setDismissed(localStorage.getItem(dismissedKey(notice)) === "1");
    } catch {}
    // "Läuft" right when the maintenance starts, hidden right when it ends.
    const timers = [notice.start, notice.end]
      .map((at) => at - Date.now())
      .filter((left) => left > 0 && left <= 2 ** 31 - 1)
      .map((left) => setTimeout(() => setNow(Date.now()), left + 500));
    return () => timers.forEach(clearTimeout);
  }, [notice]);
  if (!mounted || !notice || dismissed || notice.end <= now) return null;
  const when = (ms: number) => new Date(ms).toLocaleString(LOCALE_TAG, { weekday: "short", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
  const running = notice.start <= now;
  return (
    <div className="maintenance-banner" role="status">
      <Wrench size={16} aria-hidden />
      <span>
        <strong>{running ? t("Wartung läuft", "Maintenance in progress") : t("Geplante Wartung", "Scheduled maintenance")}</strong>{" "}
        {when(notice.start)} – {when(notice.end)}: {notice.message}
      </span>
      <button
        type="button"
        aria-label={t("Hinweis ausblenden", "Hide notice")}
        title={t("Hinweis ausblenden", "Hide notice")}
        onClick={() => {
          setDismissed(true);
          try {
            localStorage.setItem(dismissedKey(notice), "1");
          } catch {}
        }}
      >
        <X size={14} aria-hidden />
      </button>
    </div>
  );
}
