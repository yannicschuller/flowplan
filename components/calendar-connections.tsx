"use client";
// Settings → Kalender & Issues → "Kalender verbinden": the person's Google,
// Microsoft 365 and CalDAV accounts for the two-way calendar sync
// (lib/calendar-sync.ts) and the database views synced with them. CalDAV
// connects with server address, username and app password (no sign-in page).
import { useCallback, useEffect, useState } from "react";
import { CalendarBlank, CalendarCheck } from "@phosphor-icons/react";
import { LOCALE_TAG } from "@/lib/locale-tag";
import { serverMessage } from "@/lib/server-message";
import { CONTROL, EmptyState, SettingGroup, SettingRow, StatusBadge } from "./settings-ui";
import { useT } from "./i18n";
import { api } from "./ui";

type Provider = "google" | "microsoft" | "caldav";
export type CalendarSyncStatus = {
  providers: { id: Provider; configured: boolean }[];
  connections: { id: string; provider: Provider; account: string; lastError: string | null; createdAt: number }[];
  mappings: {
    id: string;
    connectionId: string;
    pageId: string;
    pageTitle: string;
    viewId: string;
    calendarId: string;
    calendarName: string;
    lastSyncAt: number | null;
    lastError: string | null;
    events: number;
  }[];
};
export const providerName = (provider: string) => (provider === "google" ? "Google Calendar" : provider === "caldav" ? "CalDAV" : "Microsoft Outlook / 365");
export const syncedAt = (ms: number | null) =>
  ms ? new Date(ms).toLocaleString(LOCALE_TAG, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "–";

export function CalendarConnections({ onError }: { onError: (message: string) => void }) {
  const t = useT();
  const [status, setStatus] = useState<CalendarSyncStatus | null>(null);
  const [caldav, setCaldav] = useState<{ url: string; username: string; password: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [connected, setConnected] = useState("");
  const load = useCallback(
    () =>
      api<CalendarSyncStatus>("/api/calendar-sync/status")
        .then(setStatus)
        .catch(() => setStatus(null)),
    [],
  );
  useEffect(() => {
    void load();
  }, [load]);
  if (!status) return null;
  const configured = status.providers.filter((p) => p.configured);
  const oauth = configured.filter((p) => p.id !== "caldav");
  const caldavOn = configured.some((p) => p.id === "caldav");
  const connectCaldav = async () => {
    if (!caldav) return;
    setBusy(true);
    setConnected("");
    try {
      const result = await api<{ account: string; calendars: { name: string }[] }>("/api/calendar-sync/caldav", caldav);
      setCaldav(null);
      setConnected(
        t(
          `${result.account} verbunden (${result.calendars.length} Kalender). Welche Ansicht in welchen Kalender gehört, wählst du in der Datenbank unter „Kalender-Sync“.`,
          `${result.account} connected (${result.calendars.length} calendars). Which view goes to which calendar is chosen in the database under “Calendar sync”.`,
        ),
      );
      await load();
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const act = async (body: Record<string, unknown>) => {
    try {
      await api("/api/command", body);
      await load();
    } catch (e) {
      onError((e as Error).message);
    }
  };
  return (
    <SettingGroup
      id="calendar"
      title={t("Kalender verbinden", "Connect calendar")}
      description={t(
        "Synchronisiere Datenbankansichten in beide Richtungen mit Google Kalender, Outlook oder einem CalDAV-Server (Nextcloud, iCloud, Fastmail, mailbox.org …). Welche Ansicht zu welchem Kalender gehört, legst du in der Datenbank unter „Kalender-Sync“ fest.",
        "Sync database views both ways with Google Calendar, Outlook or a CalDAV server (Nextcloud, iCloud, Fastmail, mailbox.org …). Which view belongs to which calendar is set in the database under “Calendar sync”.",
      )}
    >
      {!configured.length && !status.connections.length && (
        <div className="setting-row wide">
          <EmptyState icon={<CalendarBlank size={20} />} title={t("Kein Kalenderanbieter eingerichtet", "No calendar provider set up")}>
            {t(
              "Die Administration richtet Google oder Microsoft ein (GOOGLE_CALENDAR_CLIENT_ID oder MS_CALENDAR_CLIENT_ID).",
              "The administrators set up Google or Microsoft (GOOGLE_CALENDAR_CLIENT_ID or MS_CALENDAR_CLIENT_ID).",
            )}
          </EmptyState>
        </div>
      )}
      {status.connections.map((c) => {
        const mappings = status.mappings.filter((m) => m.connectionId === c.id);
        const failing = !!c.lastError || mappings.some((m) => m.lastError);
        return (
          <SettingRow
            key={c.id}
            label={`${providerName(c.provider)}${c.account ? ` · ${c.account}` : ""}`}
            description={
              <>
                {mappings.length === 0 && t("Noch keine Ansicht verbunden.", "No view connected yet.")}
                {mappings.map((m) => (
                  <span key={m.id} className="calendar-sync-mapping">
                    {m.pageTitle} → {m.calendarName || m.calendarId} · {t("zuletzt", "last")} {syncedAt(m.lastSyncAt)}
                    {m.lastError && <span className="error"> · {serverMessage(m.lastError)}</span>}
                  </span>
                ))}
                {c.lastError && <span className="error">{serverMessage(c.lastError)}</span>}
              </>
            }
          >
            <StatusBadge tone={failing ? "error" : "ok"}>{failing ? t("Fehler", "Error") : t("Verbunden", "Connected")}</StatusBadge>
            <button
              type="button"
              className="button"
              onClick={() => {
                if (confirm(t("Verbindung trennen? Die Synchronisierung aller verbundenen Ansichten endet.", "Disconnect? The sync of all connected views ends.")))
                  void act({ action: "calendarSync.disconnect", connectionId: c.id });
              }}
            >
              {t("Trennen", "Disconnect")}
            </button>
          </SettingRow>
        );
      })}
      {configured.length > 0 && (
        <SettingRow
          label={t("Neues Konto", "New account")}
          description={
            caldavOn
              ? t(
                  "Bei Google und Microsoft meldest du dich beim Anbieter an; für CalDAV gibst du Server, Benutzernamen und ein App-Passwort ein.",
                  "With Google and Microsoft you sign in with the provider; for CalDAV you enter the server, username and an app password.",
                )
              : t("Du meldest dich beim Anbieter an und erlaubst den Zugriff auf deine Kalender.", "You sign in with the provider and allow access to your calendars.")
          }
        >
          {oauth.map((p) => (
            <a key={p.id} className="button" href={`/api/calendar-sync/connect/${p.id}`}>
              <CalendarCheck size={16} aria-hidden="true" /> {t(`Mit ${providerName(p.id)} verbinden`, `Connect ${providerName(p.id)}`)}
            </a>
          ))}
          {caldavOn && !caldav && (
            <button type="button" className="button" onClick={() => setCaldav({ url: "", username: "", password: "" })}>
              <CalendarCheck size={16} aria-hidden="true" /> {t("Mit CalDAV verbinden", "Connect CalDAV")}
            </button>
          )}
        </SettingRow>
      )}
      {connected && (
        <p className="save-state saved setting-row wide" role="status">
          {connected}
        </p>
      )}
      {caldav && (
        <form
          method="post"
          action="/api/auth/no-script"
          className="setting-row wide calendar-caldav-form"
          aria-label={t("CalDAV-Kalender verbinden", "Connect CalDAV calendar")}
          onSubmit={(e) => {
            e.preventDefault();
            void connectCaldav();
          }}
        >
          <label>
            {t("Server-Adresse", "Server address")}
            <input
              className={CONTROL.lg}
              type="text"
              inputMode="url"
              value={caldav.url}
              onChange={(e) => setCaldav({ ...caldav, url: e.target.value })}
              placeholder="https://cloud.example.org"
              maxLength={2000}
              disabled={busy}
              required
              autoComplete="url"
            />
            <small className="muted">
              {t(
                "Die Adresse des Servers genügt meist (z. B. caldav.icloud.com, caldav.fastmail.com, dav.mailbox.org oder deine Nextcloud) – die Kalender werden gesucht.",
                "The server's address is usually enough (e.g. caldav.icloud.com, caldav.fastmail.com, dav.mailbox.org or your Nextcloud) – the calendars are looked up.",
              )}
            </small>
          </label>
          <label>
            {t("Benutzername", "Username")}
            <input
              className={CONTROL.lg}
              value={caldav.username}
              onChange={(e) => setCaldav({ ...caldav, username: e.target.value })}
              maxLength={300}
              disabled={busy}
              required
              autoComplete="username"
            />
          </label>
          <label>
            {t("App-Passwort", "App password")}
            <input
              className={CONTROL.lg}
              type="password"
              value={caldav.password}
              onChange={(e) => setCaldav({ ...caldav, password: e.target.value })}
              maxLength={1000}
              disabled={busy}
              required
              autoComplete="new-password"
            />
            <small className="muted">
              {t(
                "Lege dafür beim Anbieter ein eigenes App-Passwort an (bei iCloud Pflicht). Flowplan speichert es verschlüsselt und nutzt es nur für die Synchronisierung.",
                "Create an app password of its own for this at your provider (required for iCloud). Flowplan stores it encrypted and only uses it for the sync.",
              )}
            </small>
          </label>
          <div className="account-form-actions">
            <button type="submit" className="button primary" disabled={busy || !caldav.url.trim() || !caldav.username.trim() || !caldav.password}>
              {busy ? t("Verbinde …", "Connecting …") : t("Verbinden", "Connect")}
            </button>
            <button type="button" className="button" disabled={busy} onClick={() => setCaldav(null)}>
              {t("Abbrechen", "Cancel")}
            </button>
          </div>
        </form>
      )}
    </SettingGroup>
  );
}
