"use client";
// Health alerts to a webhook of the operator (lib/admin-ops.ts), a card of
// Administration → Überwachung.
import { useId, useState } from "react";
import { useT } from "./i18n";
import { LOCALE_TAG } from "@/lib/locale-tag";
import { CONTROL, SettingGroup, SettingRow, StatusBadge } from "./settings-ui";
import type { AlertEvent, OpsOverview } from "@/lib/admin-ops";

const when = (ms: number | null) =>
  ms ? new Date(ms).toLocaleString(LOCALE_TAG, { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" }) : "–";

export function AlertsForm({
  alerts,
  busy,
  note,
  send,
  id,
}: {
  alerts: OpsOverview["alerts"];
  busy: boolean;
  note: string;
  send: (body: Record<string, unknown>) => Promise<boolean>;
  id?: string;
}) {
  const t = useT();
  const own = useId();
  const [url, setUrl] = useState(alerts.url);
  const [events, setEvents] = useState<AlertEvent[]>(alerts.events);
  const labels: [AlertEvent, string][] = [
    ["backup_failed", t("Backup fehlgeschlagen", "Backup failed")],
    ["storage_high", t("Speicher > 90 % des Kontingents", "Storage > 90 % of the quota")],
    ["worker_error", t("Worker-Fehler", "Worker error")],
    ["login_failures", t("Viele fehlgeschlagene Anmeldungen (50 in einer Stunde)", "Many failed sign-ins (50 in one hour)")],
    ["security", t("Sicherheitsvorfälle (sofort, siehe Sicherheit)", "Security incidents (right away, see Security)")],
  ];
  return (
    <SettingGroup
      id={id}
      title={t("Warnungen per Webhook", "Alerts by webhook")}
      description={t(
        "Flowplan sendet eine signierte JSON-Nachricht (X-Flowplan-Signature: sha256=HMAC des Inhalts), sobald ein Ereignis eintritt – je Ereignis höchstens einmal am Tag. Leere Adresse schaltet die Warnungen aus.",
        "Flowplan sends a signed JSON message (X-Flowplan-Signature: sha256=HMAC of the body) when an event occurs – at most once a day per event. An empty address turns alerts off.",
      )}
      actions={<StatusBadge tone={alerts.url ? "ok" : "off"}>{alerts.url ? t("Eingerichtet", "Set up") : t("Aus", "Off")}</StatusBadge>}
    >
      <form
        className="mon-form"
        onSubmit={(e) => {
          e.preventDefault();
          void send({ action: "alerts.save", url, events });
        }}
      >
        <SettingRow label={t("Webhook-Adresse", "Webhook address")} description={t("https:// – z. B. ein Kanal in Slack, Teams oder ntfy.", "https:// – e.g. a channel in Slack, Teams or ntfy.")} id={`${own}-url`}>
          <input id={`${own}-url`} className={CONTROL.lg} type="url" value={url} placeholder="https://" onChange={(e) => setUrl(e.target.value)} />
        </SettingRow>
        <SettingRow label={t("Ereignisse", "Events")} description={t("Wofür eine Warnung gesendet wird.", "What sends an alert.")} wide>
          <fieldset className="mon-checks">
            <legend className="sr-only">{t("Ereignisse", "Events")}</legend>
            {labels.map(([event, label]) => (
              <label key={event} className="mon-check">
                <input
                  type="checkbox"
                  checked={events.includes(event)}
                  onChange={(e) => setEvents((list) => (e.target.checked ? [...list, event] : list.filter((x) => x !== event)))}
                />
                <span>{label}</span>
              </label>
            ))}
          </fieldset>
        </SettingRow>
        {alerts.secret && (
          <SettingRow label={t("Signaturschlüssel", "Signing key")} description={t("Damit prüft der Empfänger die Signatur.", "The receiver checks the signature with it.")} id={`${own}-secret`}>
            <input id={`${own}-secret`} className={`${CONTROL.lg} font-mono`} readOnly value={alerts.secret} onFocus={(e) => e.target.select()} />
          </SettingRow>
        )}
        <div className="mon-form-actions">
          <button className="button primary" disabled={busy}>
            {t("Speichern", "Save")}
          </button>
          {alerts.url && (
            <>
              <button type="button" className="button" disabled={busy} onClick={() => void send({ action: "alerts.test" })}>
                {t("Test senden", "Send test")}
              </button>
              <button type="button" className="button" disabled={busy} onClick={() => void send({ action: "alerts.check" })}>
                {t("Jetzt prüfen", "Check now")}
              </button>
              <button
                type="button"
                className="button"
                disabled={busy}
                onClick={() => {
                  if (confirm(t("Neuen Signaturschlüssel erzeugen? Der Empfänger braucht ihn dann ebenfalls.", "Create a new signing secret? The receiver then needs it as well.")))
                    void send({ action: "alerts.save", url, events, newSecret: true });
                }}
              >
                {t("Neuer Schlüssel", "New secret")}
              </button>
            </>
          )}
          {note && (
            <span className="muted" role="status">
              {note}
            </span>
          )}
        </div>
      </form>
      {!!alerts.sent.length && (
        <div className="mon-sent">
          <h3>{t("Zuletzt gesendet", "Last sent")}</h3>
          <ul>
            {alerts.sent.map((s) => (
              <li key={`${s.event}:${s.day}`}>
                <StatusBadge tone={s.error ? "error" : "ok"}>{s.error ? t("Fehler", "Error") : `HTTP ${s.status}`}</StatusBadge>
                <span>{labels.find(([e]) => e === s.event)?.[1] || s.event}</span>
                <small className="muted">
                  {when(s.sent_at)}
                  {s.error ? ` · ${s.error}` : ""}
                </small>
              </li>
            ))}
          </ul>
        </div>
      )}
    </SettingGroup>
  );
}
