"use client";
// Administration → Überwachung → Neustarts (#settings/instance/monitoring/restarts):
// every restart of the last 30 days – when, how long the run before was up,
// why it ended (clean, crash, likely out of memory, without trace) and the
// memory at its last heartbeat. Opened, an unexpected one shows its error
// and its last log lines (redacted on the server, shown as plain text) and
// offers them as a .txt file. Data: /api/admin/monitoring?view=restarts
// when the section opens, ?view=restart&id=… when a row is opened
// (lib/restarts/history.ts). Newest first, 20 a page with "Weitere laden"
// and the filter "Nur unerwartete" (the server pages and counts, like the
// incidents in security-center.tsx). Its code loads only when the card comes into
// view (monitoring.tsx, RestartsWhenVisible): the dashboard's JavaScript
// budget is tight.
import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowClockwise, CheckCircle, DownloadSimple } from "@phosphor-icons/react";
import type { RestartDetail, RestartFilter, RestartHistory, RestartRow } from "@/lib/restarts/history";
import { useT } from "../../i18n";
import { api, downloadBlob } from "../../ui";
import { EmptyState, StatusBadge, type Tone } from "../../settings-ui";
import { bytes, dateTime, num, percent, uptime } from "./monitoring-format";
import { reasonLabel } from "./restart-labels";

type T = (de: string, en: string) => string;

const reasonTone = (reason: string): Tone => (reason === "crash" ? "error" : reason === "oom" || reason === "killed" ? "warn" : "ok");

const memoryText = (r: RestartRow, t: T) => {
  const m = r.memory;
  if (!m) return "–";
  const used = bytes(Math.max(m.rss, m.workingSet ?? 0));
  if (m.limit) return t(`${used} von ${bytes(m.limit)}${m.share !== null ? ` (${percent(m.share)})` : ""}`, `${used} of ${bytes(m.limit)}${m.share !== null ? ` (${percent(m.share)})` : ""}`);
  return t(`${used} (keine Grenze)`, `${used} (no limit)`);
};

const PAGE = 20;

export function RestartsCard() {
  const t = useT();
  const [data, setData] = useState<RestartHistory | null>(null);
  const [only, setOnly] = useState<RestartFilter>("all");
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState("");
  const asked = useRef(0);
  // offset 0 replaces the list (filter, reload), a later one adds a page.
  const load = useCallback(async (filter: RestartFilter, offset: number, limit: number) => {
    const ask = ++asked.current;
    setLoading(true);
    try {
      const query = new URLSearchParams({ view: "restarts", offset: String(offset), limit: String(limit), only: filter });
      const answer = await api<RestartHistory>(`/api/admin/monitoring?${query}`);
      if (ask !== asked.current) return;
      setData((before) => (offset && before ? { ...answer, restarts: [...before.restarts, ...answer.restarts] } : answer));
      setFailed("");
    } catch (e) {
      if (ask === asked.current) setFailed((e as Error).message);
    } finally {
      if (ask === asked.current) setLoading(false);
    }
  }, []);
  useEffect(() => {
    void load("all", 0, PAGE);
  }, [load]);
  const choose = (filter: RestartFilter) => {
    if (filter === only) return;
    setOnly(filter);
    void load(filter, 0, PAGE);
  };
  // Reload keeps as many rows as are shown (at most the server's 100).
  const reload = () => void load(only, 0, Math.min(100, Math.max(PAGE, data?.restarts.length ?? 0)));
  const segments = [
    ["all", t("Alle", "All"), data?.counts.all ?? null],
    ["unexpected", t("Nur unerwartete", "Unexpected only"), data?.counts.unexpected ?? null],
  ] as const;
  const rows = data?.restarts ?? [];
  return (
    <section className="setting-group mon-card mon-errors-card" id="restarts" aria-labelledby="restarts-title" data-testid="restarts-card">
      <header>
        <div>
          <h2 id="restarts-title">{t("Neustarts", "Restarts")}</h2>
          <p>
            {t(
              "Jeder Neustart mit dem Grund und dem Speicher beim letzten Lebenszeichen; bei unerwarteten die letzten Zeilen des Server-Logs (Geheimnisse und Adressen geschwärzt).",
              "Every restart with its reason and the memory at the last heartbeat; for unexpected ones the last lines of the server log (secrets and addresses redacted).",
            )}
            {data ? ` ${t(`Aufbewahrt ${data.keepDays} Tage.`, `Kept ${data.keepDays} days.`)}` : ""}
          </p>
        </div>
        <div className="setting-group-actions">
          <button type="button" className="button compact" onClick={reload} aria-label={t("Neu laden", "Reload")} title={t("Neu laden", "Reload")}>
            <ArrowClockwise size={16} aria-hidden />
          </button>
        </div>
      </header>
      <div className="mon-card-body">
        {!data ? (
          failed ? <p className="muted">{failed}</p> : <p className="muted">{t("Lädt …", "Loading …")}</p>
        ) : !data.counts.all ? (
          <EmptyState icon={<CheckCircle size={20} />} title={t("Keine Neustarts in den letzten 30 Tagen.", "No restarts in the last 30 days.")}>
            {t("Startet Flowplan neu, steht hier, wann und warum.", "When Flowplan restarts, this shows when and why.")}
          </EmptyState>
        ) : (
          <>
            <div className="security-filters mon-restart-filters">
              <div className="segmented" role="group" aria-label={t("Neustarts filtern", "Filter restarts")}>
                {segments.map(([value, label, n]) => (
                  <button key={value} type="button" aria-pressed={only === value} onClick={() => choose(value)} data-testid={`restarts-${value}`}>
                    {label}
                    {n !== null && <span className="security-segment-count"> {num(n)}</span>}
                  </button>
                ))}
              </div>
              <p className="security-incident-count muted" role="status" aria-live="polite" data-testid="restarts-count">
                {data.total ? t(`${num(rows.length)} von ${num(data.total)}`, `${num(rows.length)} of ${num(data.total)}`) : ""}
              </p>
            </div>
            {failed && <p className="muted">{failed}</p>}
            {!rows.length ? (
              <EmptyState icon={<CheckCircle size={20} />} title={t("Keine unerwarteten Neustarts in den letzten 30 Tagen.", "No unexpected restarts in the last 30 days.")}>
                {t("Alle Neustarts dieser Zeit waren sauber beendet: Updates, Neustarts oder docker stop.", "Every restart of this time ended cleanly: updates, restarts or docker stop.")}
              </EmptyState>
            ) : (
              <ul className="mon-errors" aria-label={t("Neustarts", "Restarts")}>
                {rows.map((r) => (
                  <Restart key={r.id} r={r} t={t} />
                ))}
              </ul>
            )}
            {data.more && (
              <button type="button" className="button security-more" disabled={loading} onClick={() => void load(only, rows.length, PAGE)} data-testid="restarts-more">
                {loading ? t("Wird geladen …", "Loading …") : t("Weitere laden", "Load more")}
              </button>
            )}
          </>
        )}
      </div>
    </section>
  );
}

function Restart({ r, t }: { r: RestartRow; t: T }) {
  const [detail, setDetail] = useState<RestartDetail | null>(null);
  const [failed, setFailed] = useState("");
  const open = async () => {
    if (detail) return;
    try {
      setDetail(await api<RestartDetail>(`/api/admin/monitoring?view=restart&id=${encodeURIComponent(r.id)}`));
    } catch (e) {
      setFailed((e as Error).message);
    }
  };
  const unexpected = r.reason !== "clean";
  const download = () => {
    if (!detail) return;
    const head = [
      `Flowplan ${t("Neustart", "restart")} ${new Date(r.at).toISOString()}`,
      `${t("Grund", "Reason")}: ${reasonLabel(r.reason, t)}`,
      `${t("Instanz", "Instance")}: ${r.instance || "–"}${r.version ? ` · v${r.version}` : ""}`,
      `${t("Gestartet", "Started")}: ${new Date(r.previousStart).toISOString()} · ${t("Laufzeit", "Uptime")}: ${uptime(r.uptimeMs / 1000, t)}`,
      `${t("Speicher", "Memory")}: ${memoryText(r, t)}`,
      ...(detail.errorText ? ["", detail.errorText] : []),
      "",
    ];
    const stamp = new Date(r.at).toISOString().slice(0, 19).replace(/[:T]/g, "-");
    downloadBlob(`flowplan-restart-${stamp}.txt`, new Blob([[...head, ...detail.logLines].join("\n") + "\n"], { type: "text/plain;charset=utf-8" }));
  };
  return (
    <li className="mon-errgroup" data-testid="restart-row">
      <details onToggle={(e) => (e.currentTarget.open ? void open() : undefined)}>
        <summary>
          <span className="mon-error-main">
            <span className="mon-error-what">
              <strong className="mon-restart-when">{dateTime(r.at)}</strong>
              <span> · {t(`lief ${uptime(r.uptimeMs / 1000, t)}`, `up ${uptime(r.uptimeMs / 1000, t)}`)}</span>
            </span>
            <small className="muted">
              {t("Speicher zuletzt", "Memory last")}: {memoryText(r, t)}
              {r.instance ? ` · ${r.instance}` : ""}
              {r.signal ? ` · ${r.signal}` : r.code !== null && r.reason !== "clean" ? ` · ${t(`Exit-Code ${r.code}`, `exit code ${r.code}`)}` : ""}
            </small>
            {r.error && <code className="mon-error-where">{r.error}</code>}
          </span>
          <StatusBadge tone={reasonTone(r.reason)}>{reasonLabel(r.reason, t)}</StatusBadge>
        </summary>
        <div className="mon-error-body">
          {failed ? (
            <p className="muted">{failed}</p>
          ) : !detail ? (
            <p className="muted">{t("Lädt …", "Loading …")}</p>
          ) : (
            <>
              {r.reason === "oom" && (
                <p className="muted mon-error-hint">
                  {t(
                    "Vermutet: beim letzten Lebenszeichen war der Speicher fast an seiner Grenze, oder der Container meldet einen OOM-Kill. Sicher sagt es docker inspect (OOMKilled) bzw. kubectl describe pod.",
                    "A guess: at the last heartbeat memory was close to its limit, or the container reports an OOM kill. docker inspect (OOMKilled) or kubectl describe pod tells for sure.",
                  )}
                </p>
              )}
              {r.reason === "killed" && (
                <p className="muted mon-error-hint">
                  {t(
                    "Der Prozess endete ohne Signal an Flowplan und ohne Fehler: etwa SIGKILL nach einem fehlgeschlagenen Healthcheck, durch den Host oder kill -9, oder ein OOM-Kill ohne Spur.",
                    "The process ended without a signal to Flowplan and without an error: e.g. SIGKILL after a failed healthcheck, by the host or kill -9, or an OOM kill that left no trace.",
                  )}
                </p>
              )}
              {detail.errorText && (
                <>
                  <h3 className="mon-subhead">{t("Fehler", "Error")}</h3>
                  <pre className="mon-error-stack" tabIndex={0} aria-label={t("Fehler", "Error")}>
                    {detail.errorText}
                  </pre>
                </>
              )}
              {unexpected &&
                (detail.logLines.length ? (
                  <>
                    <h3 className="mon-subhead">{t(`Letzte ${detail.logLines.length} Zeilen des Logs`, `Last ${detail.logLines.length} lines of the log`)}</h3>
                    <pre className="mon-error-stack mon-restart-log" tabIndex={0} aria-label={t("Log-Zeilen", "Log lines")} data-testid="restart-log">
                      {detail.logLines.join("\n")}
                    </pre>
                    <div className="mon-error-actions">
                      <button type="button" className="button compact" onClick={download}>
                        <DownloadSimple size={15} aria-hidden /> {t("Als .txt herunterladen", "Download as .txt")}
                      </button>
                    </div>
                  </>
                ) : (
                  <p className="muted">{t("Keine Log-Zeilen gespeichert (FLOWPLAN_LOG_FILE=off, oder der Ordner logs war nicht beschreibbar).", "No log lines saved (FLOWPLAN_LOG_FILE=off, or the logs folder was not writable).")}</p>
                ))}
              {!unexpected && <p className="muted">{t(`Sauber beendet${r.signal ? ` (${r.signal})` : ""}: Update, Neustart oder docker stop.`, `Ended cleanly${r.signal ? ` (${r.signal})` : ""}: an update, a restart or docker stop.`)}</p>}
            </>
          )}
        </div>
      </details>
    </li>
  );
}
