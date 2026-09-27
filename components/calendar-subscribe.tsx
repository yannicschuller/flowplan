"use client";
import { useEffect, useState } from "react";
import { CalendarPlus, Copy } from "@phosphor-icons/react";
import { Modal, api } from "./ui";

// "Abonnieren": a personal secret link for Apple, Google or Outlook
// calendars (lib/calendar-feed.ts). The link is shown once; a new one
// replaces it, "Abo beenden" stops it.
export function CalendarSubscribe({ pageId, viewId }: { pageId: string; viewId: string }) {
  const [open, setOpen] = useState(false),
    [active, setActive] = useState(false),
    [url, setUrl] = useState(""),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState("");
  useEffect(() => {
    if (!open) return;
    setUrl("");
    setMessage("");
    void api<{ active: boolean }>(`/api/calendar-feed?page=${pageId}&view=${encodeURIComponent(viewId)}`)
      .then((r) => setActive(r.active))
      .catch(() => {});
  }, [open, pageId, viewId]);
  const act = async (action: string) => {
    setBusy(true);
    setMessage("");
    try {
      const r = await api<{ url?: string }>("/api/command", { action, pageId, viewId });
      setUrl(r.url || "");
      setActive(action === "calendar.feed");
    } catch (e) {
      setMessage((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <button className="button compact" onClick={() => setOpen(true)}>
        <CalendarPlus size={15} /> Abonnieren
      </button>
      <Modal open={open} onClose={() => setOpen(false)} title="Kalender abonnieren">
        <div className="calendar-subscribe">
          <p className="muted">
            Dein persönlicher Link zeigt die Einträge dieser Ansicht in Apple
            Kalender, Google Kalender oder Outlook – nur, was du sehen darfst,
            mit Wiederholungen. Kalender-Apps holen Änderungen je nach Anbieter
            alle 30 Minuten bis einige Stunden.
          </p>
          {url ? (
            <>
              <label>
                Abo-Link (nur jetzt sichtbar)
                <input readOnly value={url} onFocus={(e) => e.currentTarget.select()} aria-label="Abo-Link" />
              </label>
              <div className="calendar-subscribe-actions">
                <button
                  className="button primary"
                  onClick={async () => {
                    await navigator.clipboard.writeText(url).catch(() => {});
                    setMessage("Link kopiert.");
                  }}
                >
                  <Copy size={15} /> Kopieren
                </button>
                <a className="button" href={url.replace(/^https?:/, "webcal:")}>
                  In Kalender-App öffnen
                </a>
              </div>
              <p className="muted small">
                Google Kalender: „Weitere Kalender → Per URL“ und den Link einfügen.
                Der Link ist geheim – wer ihn hat, sieht diese Termine.
              </p>
            </>
          ) : (
            <div className="calendar-subscribe-actions">
              <button className="button primary" disabled={busy} onClick={() => act("calendar.feed")}>
                {active ? "Neuen Link erzeugen" : "Link erzeugen"}
              </button>
              {active && (
                <button className="button" disabled={busy} onClick={() => act("calendar.feed.revoke")}>
                  Abo beenden
                </button>
              )}
            </div>
          )}
          {active && !url && (
            <p className="muted small">Ein Abo ist aktiv. Ein neuer Link macht den alten ungültig.</p>
          )}
          {message && <p role="status">{message}</p>}
        </div>
      </Modal>
    </>
  );
}
