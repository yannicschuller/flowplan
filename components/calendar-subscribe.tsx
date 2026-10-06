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
    [message, setMessage] = useState(""),
    [caldav, setCaldav] = useState(false);
  useEffect(() => {
    if (!open) return;
    setUrl("");
    setMessage("");
    void api<{ active: boolean; caldav?: boolean }>(`/api/calendar-feed?page=${pageId}&view=${encodeURIComponent(viewId)}`)
      .then((r) => {
        setActive(r.active);
        setCaldav(!!r.caldav);
      })
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
          <CalDavSync pageId={pageId} viewId={viewId} active={caldav} onChange={setCaldav} />
        </div>
      </Modal>
    </>
  );
}

// Two-way sync (CalDAV): an account for Apple Calendar, Thunderbird or
// DAVx⁵. The password is shown once; a new one replaces the old access.
function CalDavSync({ pageId, viewId, active, onChange }: { pageId: string; viewId: string; active: boolean; onChange: (on: boolean) => void }) {
  const t = useT();
  const [access, setAccess] = useState<{ server: string; calendar: string; username: string; password: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const run = async (action: string) => {
    setBusy(true);
    setError("");
    try {
      const r = await api<{ server: string; calendar: string; username: string; password: string }>("/api/command", { action, pageId, viewId });
      setAccess(action === "calendar.caldav" ? r : null);
      onChange(action === "calendar.caldav");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const field = (label: string, value: string) => (
    <label>
      {label}
      <span className="copy-field">
        <input readOnly value={value} onFocus={(e) => e.currentTarget.select()} />
        <button type="button" className="button compact" onClick={() => void navigator.clipboard.writeText(value).catch(() => {})}>
          <Copy size={14} /> {t("Kopieren", "Copy")}
        </button>
      </span>
    </label>
  );
  return (
    <section className="caldav-sync">
      <h3>{t("In beide Richtungen synchronisieren (CalDAV)", "Sync both ways (CalDAV)")}</h3>
      <p className="muted small">
        {t(
          "Termine erscheinen in Apple Kalender, Thunderbird oder DAVx⁵ (Android) – und was du dort verschiebst, umbenennst, anlegst oder löschst, landet in dieser Datenbank. Google Kalender unterstützt CalDAV-Konten nicht; dafür bleibt das Abo oben.",
          "Events appear in Apple Calendar, Thunderbird or DAVx⁵ (Android) – and what you move, rename, add or delete there lands in this database. Google Calendar does not support CalDAV accounts; use the subscription above for it.",
        )}
      </p>
      {access ? (
        <>
          {field(t("Server", "Server"), access.server)}
          {field(t("Benutzername", "Username"), access.username)}
          {field(t("Passwort (nur jetzt sichtbar)", "Password (visible only now)"), access.password)}
          {field(t("Kalender-Adresse (Thunderbird, DAVx⁵)", "Calendar address (Thunderbird, DAVx⁵)"), access.calendar)}
          <p className="muted small">
            {t(
              "Apple: Einstellungen → Kalender → Accounts → Account hinzufügen → Andere → CalDAV-Account, Typ „Manuell“.",
              "Apple: Settings → Calendar → Accounts → Add account → Other → CalDAV account, type “Manual”.",
            )}
          </p>
        </>
      ) : (
        <div className="calendar-subscribe-actions">
          <button className="button" disabled={busy} onClick={() => void run("calendar.caldav")}>
            {active ? t("Neues Passwort erzeugen", "Create new password") : t("Zugang einrichten", "Set up access")}
          </button>
          {active && (
            <button className="button" disabled={busy} onClick={() => void run("calendar.caldav.revoke")}>
              {t("Zugang beenden", "End access")}
            </button>
          )}
        </div>
      )}
      {error && <p role="alert" className="error">{error}</p>}
    </section>
  );
}
