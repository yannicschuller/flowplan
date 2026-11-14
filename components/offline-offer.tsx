"use client";
// Offering offline use on this device (#295, lib/offline-offer.ts): the
// panel of the introduction's step and the one-time card on other devices.
// "Offline nutzen" does what Settings → Offline & devices does
// (components/offline-settings.tsx, enableOffline), with its progress.
import { useEffect, useState } from "react";
import { CloudArrowDown, X } from "@phosphor-icons/react";
import { nativeApp } from "@/lib/native-app";
import { offlineOfferPossible, readOfferAnswer, saveOfferAnswer, shouldOfferOffline } from "@/lib/offline-offer";
import { settingsHash } from "@/lib/settings-sections";
import { enableOffline, offlineMarker, offlineSupported } from "./offline";
import { useT } from "./i18n";

// Whether this device may be asked; null while it is being found out.
export function useOfflineOffer(userId: string, guest: boolean, demo: boolean, respectAnswer: boolean) {
  const [show, setShow] = useState<boolean | null>(null);
  useEffect(() => {
    let live = true;
    void (async () => {
      const supported = offlineSupported();
      const marker = supported ? await offlineMarker().catch(() => null) : null;
      const facts = { supported, nativeApp: !!nativeApp(), guest, demo, enabled: marker?.user === userId };
      const answer = respectAnswer ? shouldOfferOffline({ ...facts, stored: readOfferAnswer(), now: Date.now() }) : offlineOfferPossible(facts);
      if (live) setShow(answer);
    })();
    return () => {
      live = false;
    };
  }, [userId, guest, demo, respectAnswer]);
  return show;
}

export function OfflineOfferPanel({
  userId,
  workspaceId,
  onAnswered,
  headingId,
}: {
  userId: string;
  workspaceId: string;
  onAnswered?: (answer: "enabled" | "later" | "never") => void;
  headingId?: string;
}) {
  const t = useT();
  const [progress, setProgress] = useState<[number, number] | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [done, setDone] = useState(false);
  const answer = (value: "enabled" | "later" | "never") => {
    saveOfferAnswer(value);
    onAnswered?.(value);
  };
  const enable = async () => {
    setBusy(true);
    setMessage("");
    try {
      const result = await enableOffline(userId, workspaceId, (n, total) => setProgress([n, total]));
      const pages = (await offlineMarker())?.pages ?? result.fetched;
      setMessage(
        result.status === "signed-out"
          ? t("Du wurdest abgemeldet – melde dich erneut an, um die Offline-Kopie zu aktualisieren.", "You were signed out – sign in again to update the offline copy.")
          : result.status === "incomplete"
            ? t("Nicht alle Seiten konnten gespeichert werden – sie werden beim nächsten Aktualisieren nachgeholt.", "Not every page could be stored – they follow with the next update.")
            : t(`${pages} Seiten auf diesem Gerät offline verfügbar.`, `${pages} pages available offline on this device.`),
      );
      setDone(true);
      answer("enabled");
    } catch (error) {
      setMessage((error as Error).message || t("Offline-Nutzung konnte nicht eingeschaltet werden.", "Offline use could not be switched on."));
    } finally {
      setBusy(false);
      setProgress(null);
    }
  };
  return (
    <div className="offline-offer-panel">
      <p id={headingId ? `${headingId}-text` : undefined}>
        {t(
          "Offline-Nutzung ist auf jedem Gerät zuerst aus. Eingeschaltet speichert Flowplan die App (einmal je Version, etwa 15–20 MB) und die Seiten dieses Arbeitsbereichs auf diesem Gerät, damit du sie ohne Verbindung öffnen kannst; Einträge in Datenbanken lassen sich auch offline ändern und werden nachgereicht, sobald du wieder online bist. Solange Flowplan geöffnet ist, bleibt die Kopie aktuell.",
          "Offline use starts switched off on every device. Switched on, Flowplan stores the app (once per version, about 15–20 MB) and this workspace's pages on this device, so you can open them without a connection; database records can be changed offline too and are sent once you are back online. While Flowplan is open, the copy stays current.",
        )}
      </p>
      <p className="muted small">
        {t(
          "Nur auf eigenen Geräten einschalten: Die Kopie bleibt bis zum Abmelden oder Ausschalten. Ändern kannst du das jederzeit unter Einstellungen → Offline & Geräte.",
          "Only switch it on for your own devices: the copy stays until you sign out or turn it off. You can change this at any time under Settings → Offline & devices.",
        )}{" "}
        <a href={settingsHash({ area: "settings", section: "devices", anchor: "offline" })}>{t("Zu den Einstellungen", "To the settings")}</a>
      </p>
      {progress && (
        <div className="import-sources-progress" role="status">
          <progress max={progress[1] || 1} value={progress[0]} />
          <span>{`${t("Wird gespeichert …", "Saving …")} ${progress[0]} ${t("von", "of")} ${progress[1]}`}</span>
        </div>
      )}
      {message && (
        <p className="offline-offer-message" role="status">
          {message}
        </p>
      )}
      {!done && (
        <div className="offline-offer-actions">
          <button type="button" className="button primary" disabled={busy} onClick={() => void enable()}>
            <CloudArrowDown size={16} aria-hidden /> {t("Offline nutzen", "Use offline")}
          </button>
          <button type="button" className="button" disabled={busy} onClick={() => answer("later")}>
            {t("Später", "Later")}
          </button>
          <button type="button" className="text-button" disabled={busy} onClick={() => answer("never")}>
            {t("Nicht mehr fragen", "Don't ask again")}
          </button>
        </div>
      )}
    </div>
  );
}

// The card on a device that was not asked yet (not while the introduction
// runs: it has the question as a step).
export default function OfflineOfferPrompt({ userId, workspaceId, guest, demo }: { userId: string; workspaceId: string; guest: boolean; demo: boolean }) {
  const t = useT();
  const show = useOfflineOffer(userId, guest, demo, true);
  const [ready, setReady] = useState(false);
  const [closed, setClosed] = useState(false);
  // A moment after the workspace is there, not over its first paint.
  useEffect(() => {
    const timer = window.setTimeout(() => setReady(true), 2500);
    return () => window.clearTimeout(timer);
  }, []);
  if (!show || !ready || closed) return null;
  return (
    <section className="offline-offer" aria-labelledby="offline-offer-title">
      <div className="offline-offer-head">
        <CloudArrowDown size={20} weight="duotone" aria-hidden />
        <h2 id="offline-offer-title">{t("Auf diesem Gerät auch offline arbeiten?", "Work offline on this device too?")}</h2>
        <button
          type="button"
          className="icon-button"
          aria-label={t("Später fragen", "Ask later")}
          title={t("Später fragen", "Ask later")}
          onClick={() => {
            saveOfferAnswer("later");
            setClosed(true);
          }}
        >
          <X size={16} />
        </button>
      </div>
      <OfflineOfferPanel
        userId={userId}
        workspaceId={workspaceId}
        onAnswered={(answer) => {
          // After switching on the outcome stays a moment.
          if (answer === "enabled") window.setTimeout(() => setClosed(true), 5000);
          else setClosed(true);
        }}
      />
    </section>
  );
}
