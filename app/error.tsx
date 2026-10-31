"use client";
// The last resort inside the root layout: an error no part of the app
// caught (components/view-fallback.tsx) shows this instead of an empty
// page (#47). Without a connection "Try again" only renders anew – there
// is no server to ask; online it fetches the page again as well.
import { useEffect, useState } from "react";
import { CloudSlash, WarningCircle } from "@phosphor-icons/react";
import { useT } from "@/components/i18n";
import { STALE_CHUNK_EVENT } from "@/lib/stale-copy";

export default function AppError({ error, retry, reset }: { error: unknown; retry: () => void; reset: () => void }) {
  const t = useT();
  const [offline, setOffline] = useState(false);
  useEffect(() => {
    console.error(error);
    // A script of the page that is gone from the server: the page may be of
    // an older build (lib/stale-copy.ts loads the live one then, #61).
    if ((error as { name?: unknown } | null)?.name === "ChunkLoadError") window.dispatchEvent(new Event(STALE_CHUNK_EVENT));
  }, [error]);
  useEffect(() => {
    const update = () => setOffline(!navigator.onLine);
    update();
    const back = () => {
      update();
      retry();
    };
    window.addEventListener("online", back);
    window.addEventListener("offline", update);
    return () => {
      window.removeEventListener("online", back);
      window.removeEventListener("offline", update);
    };
  }, [retry]);
  return (
    <main className="empty-state app-error" role="alert">
      {offline ? <CloudSlash size={32} aria-hidden /> : <WarningCircle size={32} aria-hidden />}
      <h3>
        {offline
          ? t("Nicht offline verfügbar – versuche es wieder, wenn du online bist.", "Not available offline – try again when you're online.")
          : t("Etwas ist schiefgelaufen.", "Something went wrong.")}
      </h3>
      <button type="button" className="button primary" onClick={() => (navigator.onLine ? retry() : reset())}>
        {t("Erneut versuchen", "Try again")}
      </button>
    </main>
  );
}
