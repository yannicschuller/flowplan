"use client";
// Settings → Account → "Kalender verbinden": the person's Google and
// Microsoft 365 accounts for the two-way calendar sync (lib/calendar-sync.ts)
// and the database views synced with them.
import { useCallback, useEffect, useState } from "react";
import { CalendarCheck } from "@phosphor-icons/react";
import { LOCALE_TAG } from "@/lib/locale-tag";
import { serverMessage } from "@/lib/i18n-errors";
import { SettingGroup, SettingRow } from "./settings-ui";
import { useT } from "./i18n";
import { api } from "./ui";

export type CalendarSyncStatus = {
  providers: { id: "google" | "microsoft"; configured: boolean }[];
  connections: { id: string; provider: "google" | "microsoft"; account: string; lastError: string | null; createdAt: number }[];
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
export const providerName = (provider: string) => (provider === "google" ? "Google Calendar" : "Microsoft Outlook / 365");
export const syncedAt = (ms: number | null) =>
  ms ? new Date(ms).toLocaleString(LOCALE_TAG, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "–";

export function CalendarConnections({ onError }: { onError: (message: string) => void }) {
  const t = useT();
  const [status, setStatus] = useState<CalendarSyncStatus | null>(null);
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
      title={t("Kalender verbinden", "Connect calendar")}
      description={t(
        "Synchronisiere Datenbankansichten in beide Richtungen mit Google Kalender oder Outlook. Welche Ansicht zu welchem Kalender gehört, legst du in der Datenbank unter „Kalender-Sync“ fest.",
        "Sync database views both ways with Google Calendar or Outlook. Which view belongs to which calendar is set in the database under “Calendar sync”.",
      )}
    >
      {!configured.length && (
        <p className="muted small">
          {t(
            "Auf dieser Instanz ist noch kein Kalenderanbieter eingerichtet (GOOGLE_CALENDAR_CLIENT_ID oder MS_CALENDAR_CLIENT_ID).",
            "No calendar provider is set up on this instance yet (GOOGLE_CALENDAR_CLIENT_ID or MS_CALENDAR_CLIENT_ID).",
          )}
        </p>
      )}
      {status.connections.map((c) => (
        <SettingRow
          key={c.id}
          label={`${providerName(c.provider)}${c.account ? ` · ${c.account}` : ""}`}
          description={
            <>
              {status.mappings
                .filter((m) => m.connectionId === c.id)
                .map((m) => (
                  <span key={m.id} className="calendar-sync-mapping">
                    {m.pageTitle} → {m.calendarName || m.calendarId} · {t("zuletzt", "last")} {syncedAt(m.lastSyncAt)}
                    {m.lastError && <span className="error"> · {serverMessage(m.lastError)}</span>}
                    <br />
                  </span>
                ))}
              {c.lastError && <span className="error">{serverMessage(c.lastError)}</span>}
            </>
          }
        >
          <button
            type="button"
            className="button compact"
            onClick={() => {
              if (confirm(t("Verbindung trennen? Die Synchronisierung aller verbundenen Ansichten endet.", "Disconnect? The sync of all connected views ends.")))
                void act({ action: "calendarSync.disconnect", connectionId: c.id });
            }}
          >
            {t("Trennen", "Disconnect")}
          </button>
        </SettingRow>
      ))}
      {configured.length > 0 && (
        <div className="setting-row">
          <div className="calendar-subscribe-actions">
            {configured.map((p) => (
              <a key={p.id} className="button" href={`/api/calendar-sync/connect/${p.id}`}>
                <CalendarCheck size={16} aria-hidden="true" /> {t(`Mit ${providerName(p.id)} verbinden`, `Connect ${providerName(p.id)}`)}
              </a>
            ))}
          </div>
        </div>
      )}
    </SettingGroup>
  );
}
