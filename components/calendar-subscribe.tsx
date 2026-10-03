"use client";
import { useT } from "./i18n";
import { useEffect, useState } from "react";
import { CalendarPlus, Copy } from "@phosphor-icons/react";
import { Modal, api } from "./ui";

// "Abonnieren": a personal secret link for Apple, Google or Outlook
// calendars (lib/calendar-feed.ts). The link is shown once; a new one
// replaces it, "Abo beenden" stops it.
export function CalendarSubscribe({ pageId, viewId }: { pageId: string; viewId: string }) {
  const t = useT();
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
        <CalendarPlus size={15} /> {t("Abonnieren", "Subscribe")}
      </button>
      <Modal open={open} onClose={() => setOpen(false)} title={t("Kalender abonnieren", "Subscribe to calendar")}>
        <div className="calendar-subscribe">
          <p className="muted">
            {t("Dein persönlicher Link zeigt die Einträge dieser Ansicht in Apple Kalender, Google Kalender oder Outlook – nur, was du sehen darfst, mit Wiederholungen. Kalender-Apps holen Änderungen je nach Anbieter alle 30 Minuten bis einige Stunden.", "Your personal link shows the records of this view in Apple Calendar, Google Calendar or Outlook – only what you may see, with recurrences. Calendar apps fetch changes every 30 minutes to a few hours, depending on the provider.")}
          </p>
          {url ? (
            <>
              <label>
                {t("Abo-Link (nur jetzt sichtbar)", "Subscription link (visible only now)")}
                <input readOnly value={url} onFocus={(e) => e.currentTarget.select()} aria-label={t("Abo-Link", "Subscription link")} />
              </label>
              <div className="calendar-subscribe-actions">
                <button
                  className="button primary"
                  onClick={async () => {
                    await navigator.clipboard.writeText(url).catch(() => {});
                    setMessage(t("Link kopiert.", "Link copied."));
                  }}
                >
                  <Copy size={15} /> {t("Kopieren", "Copy")}
                </button>
                <a className="button" href={url.replace(/^https?:/, "webcal:")}>
                  {t("In Kalender-App öffnen", "Open in calendar app")}
                </a>
              </div>
              <p className="muted small">
                {t("Google Kalender: „Weitere Kalender → Per URL“ und den Link einfügen. Der Link ist geheim – wer ihn hat, sieht diese Termine.", "Google Calendar: “Other calendars → From URL” and paste the link. The link is secret – whoever has it sees these events.")}
              </p>
            </>
          ) : (
            <div className="calendar-subscribe-actions">
              <button className="button primary" disabled={busy} onClick={() => act("calendar.feed")}>
                {active ? t("Neuen Link erzeugen", "Create new link") : t("Link erzeugen", "Create link")}
              </button>
              {active && (
                <button className="button" disabled={busy} onClick={() => act("calendar.feed.revoke")}>
                  {t("Abo beenden", "End subscription")}
                </button>
              )}
            </div>
          )}
          {active && !url && (
            <p className="muted small">{t("Ein Abo ist aktiv. Ein neuer Link macht den alten ungültig.", "A subscription is active. A new link makes the old one invalid.")}</p>
          )}
          {message && <p role="status">{message}</p>}
        </div>
      </Modal>
    </>
  );
}
