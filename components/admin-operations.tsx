"use client";
import { useEffect, useState } from "react";
import { DownloadSimple } from "@phosphor-icons/react";
import { useT } from "./i18n";
import { LOCALE_TAG } from "@/lib/locale-tag";
import { api } from "./ui";
import { SettingGroup, SettingRow, UsageMeter } from "./settings-ui";
import { ChartGraphic } from "./database-chart";
import { defaultChart } from "@/lib/database-chart";
import type { AlertEvent, OpsOverview, WorkerStatus } from "@/lib/admin-ops";

const mb = (bytes: number) => `${(bytes / 1024 / 1024).toLocaleString(LOCALE_TAG, { maximumFractionDigits: 1 })} MB`;
const when = (ms: number | null) =>
  ms ? new Date(ms).toLocaleString(LOCALE_TAG, { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" }) : "–";
// "2026-10-22T14:30" for datetime-local fields, in local time.
const localInput = (ms: number) => {
  const d = new Date(ms - new Date(ms).getTimezoneOffset() * 60_000);
  return d.toISOString().slice(0, 16);
};

// Administration → Operations (lib/admin-ops.ts): refused requests,
// storage per workspace, mail queue, webhook failures, background workers,
// the maintenance notice and health alerts.
export function AdminOperations({ onError }: { onError: (message: string) => void }) {
  const t = useT();
  const [data, setData] = useState<OpsOverview | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const load = async () => {
    try {
      setData(await api<OpsOverview>("/api/admin/operations"));
    } catch (e) {
      onError((e as Error).message);
    }
  };
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const send = async (body: Record<string, unknown>) => {
    setBusy(true);
    setNote("");
    try {
      const answer = await api<OpsOverview & { test?: { status: number | null; error: string | null }; sent?: unknown[] }>("/api/admin/operations", body);
      setData(answer);
      if (answer.test)
        setNote(answer.test.error ? t(`Test fehlgeschlagen: ${answer.test.error}`, `Test failed: ${answer.test.error}`) : t("Test-Benachrichtigung gesendet.", "Test notification sent."));
      if (answer.sent) setNote(t(`${answer.sent.length} Warnungen gesendet.`, `${answer.sent.length} alerts sent.`));
      return true;
    } catch (e) {
      onError((e as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  };
  if (!data) return <p className="muted">{t("Wird geladen …", "Loading …")}</p>;
  const kinds = [
    ["login_failure", t("Fehlgeschlagene Anmeldungen", "Failed sign-ins")],
    ["rate_limited", t("Abgewiesen wegen Limit (429)", "Refused by a limit (429)")],
    ["anonymous_refused", t("Anonyme Uploads über Tagesbudget", "Anonymous uploads over the daily budget")],
  ] as const;
  const workerNames: Record<WorkerStatus["key"], string> = {
    backup: t("Sicherung", "Backup"),
    "markdown-export": t("Markdown-Export", "Markdown export"),
    ai: t("KI-Hintergrundarbeit", "AI background work"),
    "calendar-sync": t("Kalender-Synchronisierung", "Calendar sync"),
    "issue-sync": t("Issue-Synchronisierung", "Issue sync"),
    "ldap-sync": t("LDAP-Abgleich", "LDAP sync"),
  };
  const day = (key: string) => new Date(`${key}T12:00:00`).toLocaleDateString(LOCALE_TAG, { day: "2-digit", month: "2-digit" });
  return (
    <>
      <SettingGroup
        title={t("Abgewiesene Anfragen", "Refused requests")}
        description={t("Was Grenzen der Instanz in letzter Zeit abgewiesen haben – ein Anstieg deutet auf Angriffe oder zu knappe Grenzen.", "What the instance's limits refused recently – a rise points to attacks or limits that are too tight.")}
      >
        <div className="admin-metrics ops-metrics">
          {kinds.map(([kind, label]) => (
            <div key={kind}>
              <span>{label}</span>
              <strong>{t(`${data.events.totals[kind].day} in 24 Std.`, `${data.events.totals[kind].day} in 24 h`)}</strong>
              <small>{t(`${data.events.totals[kind].hour} in der letzten Stunde · ${data.events.totals[kind].week} in 7 Tagen`, `${data.events.totals[kind].hour} in the last hour · ${data.events.totals[kind].week} in 7 days`)}</small>
            </div>
          ))}
          <div>
            <span>{t("Anonyme Uploads heute", "Anonymous uploads today")}</span>
            <strong>{mb(data.events.anonymousBytesToday)}</strong>
          </div>
        </div>
        <div className="ops-chart">
          <ChartGraphic
            points={data.events.days.map((d) => ({
              key: d.day,
              label: day(d.day),
              value: d.login_failure + d.rate_limited + d.anonymous_refused,
              rows: [],
              numericCount: 1,
            }))}
            config={{ ...defaultChart([]), kind: "bar", valueAxisLabel: t("Abweisungen", "Refusals") }}
            onSelect={() => {}}
            describe={(p) => {
              const d = data.events.days.find((x) => x.day === p.key)!;
              return t(
                `${p.label}: ${d.login_failure} Anmeldungen, ${d.rate_limited} Limits, ${d.anonymous_refused} Uploads`,
                `${p.label}: ${d.login_failure} sign-ins, ${d.rate_limited} limits, ${d.anonymous_refused} uploads`,
              );
            }}
          />
        </div>
      </SettingGroup>

      <SettingGroup title={t("Hintergrunddienste", "Background workers")} description={t("Letzter Lauf und letzter Fehler je Dienst.", "Last run and last error per worker.")}>
        <div className="data-table-scroll">
          <table className="data-table ops-workers">
            <thead>
              <tr>
                <th>{t("Dienst", "Worker")}</th>
                <th>{t("Status", "Status")}</th>
                <th>{t("Letzter Lauf", "Last run")}</th>
                <th>{t("Fehler", "Error")}</th>
              </tr>
            </thead>
            <tbody>
              {data.workers.map((w) => (
                <tr key={w.key} className={w.error ? "ops-failing" : ""}>
                  <td>{workerNames[w.key]}</td>
                  <td>{!w.active ? t("aus", "off") : w.error ? t("Fehler", "Error") : t("in Ordnung", "fine")}</td>
                  <td>{when(w.lastRun)}</td>
                  <td>{w.error ? <small title={when(w.errorAt)}>{w.error}</small> : "–"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </SettingGroup>

      <SettingGroup title={t("Speicher je Arbeitsbereich", "Storage per workspace")} description={t(`Datenbank ${mb(data.storage.databaseBytes)} · Uploads ${mb(data.storage.uploadBytes)}`, `Database ${mb(data.storage.databaseBytes)} · uploads ${mb(data.storage.uploadBytes)}`)}>
        <div className="ops-storage">
          {data.storage.workspaces.slice(0, 50).map((w) => (
            <UsageMeter key={w.id} label={w.name || w.id.slice(0, 8)} used={w.bytes} limit={w.quotaMb * 1024 * 1024} format={mb} />
          ))}
        </div>
      </SettingGroup>

      <SettingGroup title={t("Zustellung", "Delivery")}>
        <SettingRow label={t("E-Mail-Warteschlange", "Mail queue")} description={data.mail.lastError ? t(`Letzter Fehler: ${data.mail.lastError}`, `Last error: ${data.mail.lastError}`) : undefined}>
          <span>
            {data.mail.configured
              ? t(`${data.mail.pending} wartend · ${data.mail.failed} aufgegeben · ${data.mail.sentWeek} gesendet`, `${data.mail.pending} waiting · ${data.mail.failed} given up · ${data.mail.sentWeek} sent`)
              : t("Kein SMTP-Server eingerichtet", "No SMTP server set up")}
          </span>
        </SettingRow>
        <SettingRow label={t("Webhooks", "Webhooks")}>
          <span>{t(`${data.webhooks.retrying} in Wiederholung · ${data.webhooks.givenUp} aufgegeben`, `${data.webhooks.retrying} retrying · ${data.webhooks.givenUp} given up`)}</span>
        </SettingRow>
        {!!data.webhooks.recent.length && (
          <ul className="ops-webhook-failures">
            {data.webhooks.recent.map((w, i) => (
              <li key={i}>
                <strong>{w.host}</strong> · {w.workspace} · {when(w.at)} · {t(`${w.attempts} Versuche`, `${w.attempts} attempts`)}
                {w.error && <small> – {w.error}</small>}
              </li>
            ))}
          </ul>
        )}
      </SettingGroup>

      <MaintenanceForm notice={data.maintenance} busy={busy} onSave={(notice) => send({ action: "maintenance.save", notice })} />
      <AlertsForm alerts={data.alerts} busy={busy} note={note} send={send} />
    </>
  );
}

function MaintenanceForm({
  notice,
  busy,
  onSave,
}: {
  notice: OpsOverview["maintenance"];
  busy: boolean;
  onSave: (notice: { message: string; start: number; end: number } | null) => Promise<boolean>;
}) {
  const t = useT();
  const [message, setMessage] = useState(notice?.message || "");
  const [start, setStart] = useState(notice ? localInput(notice.start) : "");
  const [end, setEnd] = useState(notice ? localInput(notice.end) : "");
  const past = !!notice && notice.end <= Date.now();
  return (
    <SettingGroup
      title={t("Wartungshinweis", "Maintenance notice")}
      description={t("Ein Hinweis mit Beginn und Ende, den alle angemeldeten Personen ab dem Speichern als Banner sehen – nach dem Ende verschwindet er von selbst.", "A notice with start and end that everyone signed in sees as a banner from saving on – it disappears by itself after the end.")}
    >
      <form
        className="ops-form"
        onSubmit={(e) => {
          e.preventDefault();
          void onSave({ message, start: new Date(start).getTime(), end: new Date(end).getTime() });
        }}
      >
        <label>
          {t("Text", "Text")}
          <input required maxLength={300} value={message} placeholder={t("z. B. Update auf die neue Version", "e.g. Update to the new version")} onChange={(e) => setMessage(e.target.value)} />
        </label>
        <label>
          {t("Beginn", "Start")}
          <input type="datetime-local" required value={start} onChange={(e) => setStart(e.target.value)} />
        </label>
        <label>
          {t("Ende", "End")}
          <input type="datetime-local" required value={end} onChange={(e) => setEnd(e.target.value)} />
        </label>
        <div className="ops-form-actions">
          <button className="button primary" disabled={busy}>
            {t("Hinweis speichern", "Save notice")}
          </button>
          {notice && (
            <button
              type="button"
              className="button"
              disabled={busy}
              onClick={async () => {
                if (await onSave(null)) {
                  setMessage("");
                  setStart("");
                  setEnd("");
                }
              }}
            >
              {t("Hinweis entfernen", "Remove notice")}
            </button>
          )}
          {notice && <small className="muted">{past ? t("Abgelaufen – wird nicht mehr angezeigt.", "Expired – no longer shown.") : t("Wird angezeigt.", "Shown.")}</small>}
        </div>
      </form>
    </SettingGroup>
  );
}

function AlertsForm({
  alerts,
  busy,
  note,
  send,
}: {
  alerts: OpsOverview["alerts"];
  busy: boolean;
  note: string;
  send: (body: Record<string, unknown>) => Promise<boolean>;
}) {
  const t = useT();
  const [url, setUrl] = useState(alerts.url);
  const [events, setEvents] = useState<AlertEvent[]>(alerts.events);
  const labels: [AlertEvent, string][] = [
    ["backup_failed", t("Backup fehlgeschlagen", "Backup failed")],
    ["storage_high", t("Speicher > 90 % des Kontingents", "Storage > 90 % of the quota")],
    ["worker_error", t("Worker-Fehler", "Worker error")],
    ["login_failures", t("Viele fehlgeschlagene Anmeldungen (50 in einer Stunde)", "Many failed sign-ins (50 in one hour)")],
  ];
  return (
    <SettingGroup
      title={t("Warnungen per Webhook", "Alerts by webhook")}
      description={t(
        "Flowplan sendet eine signierte JSON-Nachricht (X-Flowplan-Signature: sha256=HMAC des Inhalts), sobald ein Ereignis eintritt – je Ereignis höchstens einmal am Tag. Leere Adresse schaltet die Warnungen aus.",
        "Flowplan sends a signed JSON message (X-Flowplan-Signature: sha256=HMAC of the body) when an event occurs – at most once a day per event. An empty address turns alerts off.",
      )}
    >
      <form
        className="ops-form"
        onSubmit={(e) => {
          e.preventDefault();
          void send({ action: "alerts.save", url, events });
        }}
      >
        <label>
          {t("Webhook-Adresse", "Webhook address")}
          <input type="url" value={url} placeholder="https://" onChange={(e) => setUrl(e.target.value)} />
        </label>
        <fieldset className="ops-events">
          <legend>{t("Ereignisse", "Events")}</legend>
          {labels.map(([event, label]) => (
            <label key={event} className="checkbox-row">
              <input
                type="checkbox"
                checked={events.includes(event)}
                onChange={(e) => setEvents((list) => (e.target.checked ? [...list, event] : list.filter((x) => x !== event)))}
              />
              {label}
            </label>
          ))}
        </fieldset>
        {alerts.secret && (
          <label>
            {t("Signaturschlüssel", "Signing secret")}
            <input readOnly value={alerts.secret} onFocus={(e) => e.target.select()} />
          </label>
        )}
        <div className="ops-form-actions">
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
        </div>
        {note && (
          <p className="muted" role="status">
            {note}
          </p>
        )}
      </form>
      {!!alerts.sent.length && (
        <ul className="ops-alerts-sent">
          {alerts.sent.map((s) => (
            <li key={`${s.event}:${s.day}`}>
              {labels.find(([e]) => e === s.event)?.[1] || s.event} · {when(s.sent_at)} · {s.error ? s.error : `HTTP ${s.status}`}
            </li>
          ))}
        </ul>
      )}
    </SettingGroup>
  );
}

// Activity log export with a date range, as CSV (semicolons, for Excel)
// or JSON.
export function AuditExport() {
  const t = useT();
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const href = (format: "csv" | "json") => {
    const params = new URLSearchParams({ export: "audit", format });
    if (from) params.set("from", from);
    if (to) params.set("to", to);
    return `/api/admin/operations?${params}`;
  };
  return (
    <div className="ops-audit-export" role="group" aria-label={t("Protokoll exportieren", "Export the log")}>
      <input type="date" aria-label={t("Von (UTC)", "From (UTC)")} value={from} onChange={(e) => setFrom(e.target.value)} />
      <input type="date" aria-label={t("Bis (UTC)", "To (UTC)")} value={to} onChange={(e) => setTo(e.target.value)} />
      <a className="button compact" href={href("csv")} download>
        <DownloadSimple aria-hidden /> CSV
      </a>
      <a className="button compact" href={href("json")} download>
        <DownloadSimple aria-hidden /> JSON
      </a>
    </div>
  );
}
