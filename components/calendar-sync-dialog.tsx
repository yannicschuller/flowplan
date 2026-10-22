"use client";
// "Kalender-Sync" of a database: which of the person's Google or Microsoft
// 365 calendars a view with a date property is synced with (lib/calendar-
// sync.ts). Personal: everyone maps their own calendar.
import { useCallback, useEffect, useState } from "react";
import { CalendarCheck } from "@phosphor-icons/react";
import { serverMessage } from "@/lib/i18n-errors";
import type { Field, View } from "@/lib/types";
import { providerName, syncedAt, type CalendarSyncStatus } from "./calendar-connections";
import { useT } from "./i18n";
import { Modal, api } from "./ui";
import { Select } from "./select";

type ExternalCalendar = { id: string; name: string; primary: boolean };

export function CalendarSyncButton({ pageId, fields, views, editable }: { pageId: string; fields: Field[]; views: View[]; editable: boolean }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  if (!editable || !fields.some((f) => f.type === "date")) return null;
  return (
    <>
      <button title={t("Kalender-Sync", "Calendar sync")} aria-label={t("Kalender-Sync", "Calendar sync")} onClick={() => setOpen(true)}>
        <CalendarCheck size={18} />
      </button>
      <Modal open={open} onClose={() => setOpen(false)} title={t("Kalender-Sync", "Calendar sync")}>
        {open && <CalendarSyncDialog pageId={pageId} fields={fields} views={views} />}
      </Modal>
    </>
  );
}

function CalendarSyncDialog({ pageId, fields, views }: { pageId: string; fields: Field[]; views: View[] }) {
  const t = useT();
  // Views that have a date: their own date property or the first one.
  const dated = views.filter((v) => (v.dateField ? fields.some((f) => f.id === v.dateField && f.type === "date") : fields.some((f) => f.type === "date")));
  const [status, setStatus] = useState<CalendarSyncStatus | null>(null);
  const [viewId, setViewId] = useState(dated.find((v) => v.type === "calendar")?.id || dated[0]?.id || "");
  const [connectionId, setConnectionId] = useState("");
  const [calendars, setCalendars] = useState<ExternalCalendar[] | null>(null);
  const [calendarId, setCalendarId] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const load = useCallback(
    () =>
      api<CalendarSyncStatus>(`/api/calendar-sync/status?page=${pageId}`)
        .then((s) => {
          setStatus(s);
          setConnectionId((current) => current || s.connections[0]?.id || "");
        })
        .catch((e) => setMessage((e as Error).message)),
    [pageId],
  );
  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    if (!connectionId) return;
    setCalendars(null);
    api<{ calendars: ExternalCalendar[] }>(`/api/calendar-sync/calendars?connection=${connectionId}`)
      .then((r) => {
        setCalendars(r.calendars);
        setCalendarId((current) => (r.calendars.some((c) => c.id === current) ? current : r.calendars.find((c) => c.primary)?.id || r.calendars[0]?.id || ""));
      })
      .catch((e) => {
        setCalendars([]);
        setMessage((e as Error).message);
      });
  }, [connectionId]);
  const run = async (fn: () => Promise<unknown>, done: string) => {
    setBusy(true);
    setMessage("");
    try {
      await fn();
      setMessage(done);
      await load();
    } catch (e) {
      setMessage((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  if (!status) return <p className="muted">{message || t("Lädt …", "Loading …")}</p>;
  const mapping = status.mappings.find((m) => m.viewId === viewId);
  const viewName = (id: string) => views.find((v) => v.id === id)?.name || id;
  if (!status.connections.length)
    return (
      <div className="calendar-subscribe">
        <p className="muted">
          {t(
            "Verbinde zuerst dein Google- oder Microsoft-Konto unter Einstellungen → Konto → Kalender verbinden.",
            "First connect your Google or Microsoft account under Settings → Account → Connect calendar.",
          )}
        </p>
        <a className="button" href="/#settings">
          {t("Zu den Einstellungen", "Go to settings")}
        </a>
      </div>
    );
  return (
    <div className="calendar-subscribe">
      <p className="muted">
        {t(
          "Termine dieser Ansicht erscheinen in deinem Kalender, und was du dort anlegst, verschiebst, umbenennst oder löschst, landet hier – alle zehn Minuten. Die Beschreibung des Termins ist das Dokument des Eintrags (als Text). Ändern beide Seiten denselben Termin, gewinnt die spätere Änderung. Nur Einträge, die du bearbeiten darfst, werden synchronisiert.",
          "Records of this view appear in your calendar, and what you add, move, rename or delete there lands here – every ten minutes. The event description is the record's document (as text). When both sides change the same event, the later change wins. Only records you may edit are synced.",
        )}
      </p>
      {status.mappings.map((m) => (
        <p key={m.id} className="small">
          <strong>{viewName(m.viewId)}</strong> → {m.calendarName || m.calendarId} · {m.events} {t("Termine", "events")} · {t("zuletzt", "last")} {syncedAt(m.lastSyncAt)}
          {m.lastError && <span className="error"> · {serverMessage(m.lastError)}</span>}
        </p>
      ))}
      <label>
        {t("Ansicht", "View")}
        <Select value={viewId} onChange={(e) => setViewId(e.target.value)} aria-label={t("Ansicht", "View")}>
          {dated.map((v) => (
            <option key={v.id} value={v.id}>
              {v.name}
            </option>
          ))}
        </Select>
      </label>
      <label>
        {t("Konto", "Account")}
        <Select value={connectionId} onChange={(e) => setConnectionId(e.target.value)} aria-label={t("Konto", "Account")}>
          {status.connections.map((c) => (
            <option key={c.id} value={c.id}>
              {`${providerName(c.provider)}${c.account ? ` · ${c.account}` : ""}`}
            </option>
          ))}
        </Select>
      </label>
      <label>
        {t("Kalender", "Calendar")}
        <Select value={calendarId} disabled={!calendars?.length} onChange={(e) => setCalendarId(e.target.value)} aria-label={t("Kalender", "Calendar")}>
          {(calendars || []).map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </Select>
      </label>
      <div className="calendar-subscribe-actions">
        <button
          className="button primary"
          disabled={busy || !viewId || !calendarId}
          onClick={() =>
            void run(async () => {
              const saved = await api<{ id: string }>("/api/command", {
                action: "calendarSync.map",
                connectionId,
                pageId,
                viewId,
                calendarId,
                calendarName: calendars?.find((c) => c.id === calendarId)?.name || "",
              });
              await api("/api/calendar-sync/run", { id: saved.id });
            }, t("Verbunden und synchronisiert.", "Connected and synced."))
          }
        >
          {mapping ? t("Speichern und synchronisieren", "Save and sync") : t("Verbinden", "Connect")}
        </button>
        {mapping && (
          <>
            <button className="button" disabled={busy} onClick={() => void run(() => api("/api/calendar-sync/run", { id: mapping.id }), t("Synchronisiert.", "Synced."))}>
              {t("Jetzt synchronisieren", "Sync now")}
            </button>
            <button className="button" disabled={busy} onClick={() => void run(() => api("/api/command", { action: "calendarSync.unmap", id: mapping.id }), t("Synchronisierung beendet.", "Sync ended."))}>
              {t("Synchronisierung beenden", "Stop syncing")}
            </button>
          </>
        )}
      </div>
      {message && <p role="status">{message}</p>}
    </div>
  );
}
