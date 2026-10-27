"use client";
// Administration → Überwachung: the live dashboard of the instance
// (/api/admin/monitoring, every 15 s while visible) – health of each part,
// live numbers, charts of requests, people, sign-ins, refusals, storage,
// deliveries and AI tokens, the queues, recent events with filters and quick
// actions – then the background workers, alerts by webhook
// (/api/admin/operations) and the switch of the usage statistics. The
// maintenance notice has its own section (#admin/maintenance).
// Anchors: #admin/monitoring/<health|traffic|people|signins|refused|storage|
// deliveries|ai|queues|events|actions|workers|instance|alerts|metrics>.
import { useEffect, useState, type ReactNode } from "react";
import {
  ArrowClockwise,
  ArrowCircleUp,
  BellRinging,
  CheckCircle,
  CloudArrowUp,
  Database,
  DownloadSimple,
  EnvelopeSimple,
  FolderSimple,
  Gear,
  Info,
  Megaphone,
  PaperPlaneTilt,
  Sparkle,
  WarningCircle,
  XCircle,
  type Icon,
} from "@phosphor-icons/react";
import type { MonitoringEvent, MonitoringOverview } from "@/lib/admin-monitoring";
import type { OpsOverview, WorkerStatus } from "@/lib/admin-ops";
import { AI_FEATURES } from "@/lib/ai/features";
import { settingsHash } from "@/lib/settings-sections";
import { useT } from "../../i18n";
import { api } from "../../ui";
import { BarChart, ChartTable, Donut, Legend, LineChart } from "../../charts";
import { Sparkline } from "../../sparkline";
import { DangerZone, EmptyState, ResponsiveTable, SaveState, SettingGroup, SettingRow, StatusBadge, Switch, UsageMeter, useSaveState, type Tone } from "../../settings-ui";
import { AlertsForm } from "../../admin-operations";
import { useAdmin, useAdminData } from "../admin-context";
import { AdminLoading } from "../shell";
import { LiveBadge, Kpi, RequestsChart, rangeLabel } from "./live";
import { useLive } from "./use-live";
import { ago, bytes, clock, compact, dateTime, dayAt, longDay, ms, num, percent, shortDay, uptime, weekday } from "./monitoring-format";
import { pushTile, relayHost } from "./push-format";

type T = (de: string, en: string) => string;
type Range = "1h" | "24h" | "7d";

export default function MonitoringSection() {
  const t = useT();
  const [range, setRange] = useState<Range>("24h");
  const live = useLive<MonitoringOverview>(`/api/admin/monitoring?range=${range}`);
  const ops = useOps();
  const d = live.data;
  return (
    <div className="mon">
      <div className="mon-toolbar">
        <LiveBadge state={live.state} label={live.updatedAt ? t(`aktualisiert ${clock(live.updatedAt)}`, `updated ${clock(live.updatedAt)}`) : undefined} />
        {live.state === "error" && <span className="muted">{live.error}</span>}
        <label className="mon-range">
          <span>{t("Zeitraum der Anfragen", "Range of requests")}</span>
          <select value={range} onChange={(e) => setRange(e.target.value as Range)}>
            <option value="1h">{t("1 Stunde", "1 hour")}</option>
            <option value="24h">{t("24 Stunden", "24 hours")}</option>
            <option value="7d">{t("7 Tage", "7 days")}</option>
          </select>
        </label>
      </div>
      {!d ? (
        live.state === "error" ? (
          <EmptyState icon={<WarningCircle size={20} />} title={t("Die Überwachung ist nicht erreichbar.", "Monitoring is not reachable.")} action={<button type="button" className="button" onClick={() => void live.reload()}>{t("Erneut versuchen", "Try again")}</button>}>
            {live.error}
          </EmptyState>
        ) : (
          <AdminLoading />
        )
      ) : (
        <>
          {!d.collecting.enabled && (
            <p className="mon-note">
              <Info size={16} aria-hidden />
              {t("Die Nutzungsstatistik ist ausgeschaltet – Anfragen, aktive Personen und KI-Tokens werden nicht gezählt.", "Usage statistics are switched off – requests, active people and AI tokens are not counted.")}{" "}
              <a href="#admin/monitoring/metrics">{t("Statistik", "Statistics")}</a>
            </p>
          )}
          <Health d={d} />
          <Kpis d={d} />
          <div className="mon-grid">
            <Traffic d={d} />
            <People d={d} />
            <Signins d={d} />
            <Refused d={d} />
            <Storage d={d} />
            <Deliveries d={d} />
            <AiUsage d={d} />
            <Queues d={d} />
          </div>
          <div className="mon-grid">
            <Events events={d.events} />
            <Actions d={d} ops={ops} reload={() => void live.reload()} />
          </div>
        </>
      )}
      <Workers ops={ops.data} />
      <InstanceNumbers />
      {ops.data && <AlertsForm id="alerts" alerts={ops.data.alerts} busy={ops.busy} note={ops.note} send={ops.send} />}
      {d && <Statistics d={d} onChange={() => void live.reload()} />}
    </div>
  );
}

/* ---------- Operations data (workers, maintenance, alerts) ---------- */

function useOps() {
  const t = useT();
  const { onError } = useAdmin();
  const [data, setData] = useState<OpsOverview | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  useEffect(() => {
    api<OpsOverview>("/api/admin/operations")
      .then(setData)
      .catch((e) => onError((e as Error).message));
  }, [onError]);
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
  return { data, busy, note, send };
}
type Ops = ReturnType<typeof useOps>;

/* ---------- Building blocks ---------- */

function Card({ id, title, description, actions, children, wide }: { id: string; title: string; description?: ReactNode; actions?: ReactNode; children: ReactNode; wide?: boolean }) {
  return (
    <section className={`setting-group mon-card${wide ? " wide" : ""}`} id={id} aria-labelledby={`${id}-title`}>
      <header>
        <div>
          <h2 id={`${id}-title`}>{title}</h2>
          {description && <p>{description}</p>}
        </div>
        {actions && <div className="setting-group-actions">{actions}</div>}
      </header>
      <div className="mon-card-body">{children}</div>
    </section>
  );
}

const workerName = (key: string, t: T) =>
  (
    ({
      backup: t("Sicherung", "Backup"),
      "markdown-export": t("Markdown-Export", "Markdown export"),
      ai: t("KI-Hintergrundarbeit", "AI background work"),
      "calendar-sync": t("Kalender-Synchronisierung", "Calendar sync"),
      "issue-sync": t("Issue-Synchronisierung", "Issue sync"),
      "ldap-sync": t("LDAP-Abgleich", "LDAP sync"),
    }) as Record<string, string>
  )[key] || key;

const TONE_ICON: Record<Tone, Icon> = { ok: CheckCircle, warn: WarningCircle, error: XCircle, info: Info, off: Info };
const TONE_WORD = (tone: Tone, t: T) =>
  ({ ok: t("in Ordnung", "fine"), warn: t("Hinweis", "notice"), error: t("Fehler", "error"), info: t("Info", "info"), off: t("aus", "off") })[tone];

/* ---------- Health ---------- */

function Health({ d }: { d: MonitoringOverview }) {
  const t = useT();
  const h = d.health;
  const diskShare = h.uploads.disk ? 1 - h.uploads.disk.free / h.uploads.disk.total : null;
  const aiName = h.ai.provider ? ({ ollama: "Ollama", openai: t("OpenAI-kompatibel", "OpenAI-compatible"), anthropic: "Anthropic", gemini: "Gemini" } as Record<string, string>)[h.ai.provider] || h.ai.provider : "";
  const backupStale = h.backup.lastAt !== null && Date.now() - h.backup.lastAt > (h.backup.hourly ? 3 : 36) * 3_600_000;
  const tiles: { key: string; title: string; tone: Tone; detail: string; href: string; icon: Icon }[] = [
    {
      key: "database",
      title: t("Datenbank", "Database"),
      tone: h.database.ok ? "ok" : "error",
      detail: h.database.ok ? bytes(h.database.bytes) : t("nicht erreichbar", "not reachable"),
      href: settingsHash({ area: "admin", section: "storage" }),
      icon: Database,
    },
    {
      key: "uploads",
      title: t("Dateispeicher", "File storage"),
      tone: !h.uploads.ok ? "error" : diskShare !== null && diskShare >= 0.9 ? "warn" : "ok",
      detail: !h.uploads.ok
        ? t("nicht beschreibbar", "not writable")
        : [bytes(h.uploads.bytes), diskShare !== null ? t(`Datenträger ${percent(diskShare)} belegt`, `disk ${percent(diskShare)} used`) : t(`${num(h.uploads.files)} Dateien`, `${num(h.uploads.files)} files`)].join(" · "),
      href: settingsHash({ area: "admin", section: "storage" }),
      icon: FolderSimple,
    },
    {
      key: "s3",
      title: t("S3-Spiegel", "S3 mirror"),
      tone: !h.s3 ? "off" : h.s3.failing ? "error" : "ok",
      detail: !h.s3 ? t("nicht eingerichtet", "not set up") : h.s3.failing ? t(`meldet Fehler · ${num(h.s3.pending)} ausstehend`, `reports errors · ${num(h.s3.pending)} pending`) : h.s3.pending ? t(`${num(h.s3.pending)} ausstehend`, `${num(h.s3.pending)} pending`) : t("auf dem Stand", "up to date"),
      href: settingsHash({ area: "admin", section: "storage" }),
      icon: CloudArrowUp,
    },
    {
      key: "backup",
      title: t("Sicherung", "Backup"),
      tone: h.backup.error ? "error" : !h.backup.enabled || backupStale ? "warn" : h.backup.lastAt ? "ok" : "info",
      detail: h.backup.error
        ? h.backup.error
        : !h.backup.enabled
          ? t("geplante Sicherung aus", "scheduled backup off")
          : h.backup.lastAt
            ? t(`letzte Sicherung ${ago(h.backup.lastAt, t)} · ${h.backup.target === "s3" ? "S3" : "lokal"}`, `last backup ${ago(h.backup.lastAt, t)} · ${h.backup.target === "s3" ? "S3" : "local"}`)
            : t("noch keine Sicherung", "no backup yet"),
      href: settingsHash({ area: "admin", section: "storage" }),
      icon: ArrowClockwise,
    },
    {
      key: "mail",
      title: t("E-Mail", "E-mail"),
      tone: !h.mail.configured ? "warn" : h.mail.failed ? "error" : "ok",
      detail: !h.mail.configured ? t("kein SMTP eingerichtet", "no SMTP set up") : h.mail.failed ? t(`${num(h.mail.failed)} aufgegeben`, `${num(h.mail.failed)} given up`) : t(`${num(h.mail.pending)} in der Warteschlange`, `${num(h.mail.pending)} queued`),
      href: settingsHash({ area: "admin", section: "mail" }),
      icon: EnvelopeSimple,
    },
    {
      key: "ai",
      title: t("KI-Anbieter", "AI provider"),
      tone: !h.ai.enabled ? "off" : !h.ai.configured ? "warn" : !h.ai.ping ? "info" : h.ai.ping.ok ? "ok" : "error",
      detail: !h.ai.enabled
        ? t("ausgeschaltet", "switched off")
        : !h.ai.configured
          ? t("kein Anbieter der Instanz", "no instance provider")
          : !h.ai.ping
            ? t(`${aiName} · wird geprüft`, `${aiName} · checking`)
            : h.ai.ping.ok
              ? `${aiName} · ${ms(h.ai.ping.ms)}`
              : `${aiName} · ${h.ai.ping.error || t("nicht erreichbar", "not reachable")}`,
      href: settingsHash({ area: "admin", section: "ai" }),
      icon: Sparkle,
    },
    {
      key: "push",
      title: t("Push-Relay", "Push relay"),
      ...(() => {
        const p = pushTile(h.push, t);
        return { tone: p.tone, detail: h.push.enabled ? `${relayHost(h.push.url)} · ${p.badge}` : p.badge };
      })(),
      href: settingsHash({ area: "admin", section: "push" }),
      icon: BellRinging,
    },
    {
      key: "workers",
      title: t("Hintergrunddienste", "Background workers"),
      tone: h.workers.failing.length ? "error" : "ok",
      detail: h.workers.failing.length ? h.workers.failing.map((k) => workerName(k, t)).join(", ") : t(`${num(h.workers.active)} aktiv, ohne Fehler`, `${num(h.workers.active)} active, no errors`),
      href: "#admin/monitoring/workers",
      icon: Gear,
    },
    {
      key: "update",
      title: t("Aktualisierung", "Update"),
      tone: h.update.latest ? "info" : "ok",
      detail: h.update.latest ? t(`${h.update.latest} verfügbar · läuft ${h.update.version || "?"}`, `${h.update.latest} available · running ${h.update.version || "?"}`) : t(`${h.update.version ? `v${h.update.version}` : "Version"} · läuft seit ${uptime(h.uptimeSeconds, t)}`, `${h.update.version ? `v${h.update.version}` : "Version"} · running for ${uptime(h.uptimeSeconds, t)}`),
      href: settingsHash({ area: "admin", section: "general" }),
      icon: ArrowCircleUp,
    },
  ];
  return (
    <section id="health" className="mon-health" aria-label={t("Zustand", "Health")}>
      <h2 className="sr-only">{t("Zustand", "Health")}</h2>
      <ul>
        {tiles.map((tile) => {
          const ToneIcon = TONE_ICON[tile.tone];
          return (
            <li key={tile.key}>
              <a className={`mon-health-tile ${tile.tone}`} href={tile.href}>
                <span className="mon-health-icon" aria-hidden>
                  {tile.tone === "ok" || tile.tone === "off" ? <tile.icon size={18} /> : <ToneIcon size={18} weight="bold" />}
                </span>
                <span className="mon-health-text">
                  <strong>
                    {tile.title}
                    <span className="sr-only">: {TONE_WORD(tile.tone, t)}</span>
                  </strong>
                  <small>{tile.detail}</small>
                </span>
              </a>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/* ---------- KPIs ---------- */

function Kpis({ d }: { d: MonitoringOverview }) {
  const t = useT();
  const k = d.kpis;
  const on = d.collecting.enabled;
  const perMinute = d.requests.bucketMs / 60_000;
  const trend = d.storage.trend.map((p) => p.bytes);
  return (
    <div className="kpi-grid cards" role="group" aria-label={t("Kennzahlen", "Key figures")}>
      <Kpi label={t("gerade aktiv", "active now")} value={num(k.activeNow)} note={t("Personen in den letzten 5 Minuten", "people in the last 5 minutes")}>
        <Sparkline values={d.active.slice(-24).map((p) => p.people)} label={t("Aktive Personen je Stunde, 24 Std.", "Active people per hour, 24 h")} />
      </Kpi>
      <Kpi
        label={t("Anfragen/Min.", "Requests/min")}
        value={on ? num(k.requestsPerMinute) : "–"}
        note={on ? t(`Fehlerquote ${percent(k.errorRate)} · p95 ${ms(k.p95)}`, `error rate ${percent(k.errorRate)} · p95 ${ms(k.p95)}`) : t("Statistik aus", "statistics off")}
      >
        <Sparkline values={d.requests.points.map((p) => (p.requests === null ? null : p.requests / perMinute))} label={t(`Anfragen pro Minute, ${rangeLabel(d.requests.range, t)}`, `Requests per minute, ${rangeLabel(d.requests.range, t)}`)} />
      </Kpi>
      <Kpi label={t("Anmeldungen heute", "Sign-ins today")} value={num(k.signinsToday)} note={t(`${num(k.failedSigninsToday)} fehlgeschlagen`, `${num(k.failedSigninsToday)} failed`)}>
        <Sparkline values={d.signins.map((s) => s.ok)} label={t("Anmeldungen je Tag, 14 Tage", "Sign-ins per day, 14 days")} />
      </Kpi>
      <Kpi
        label={t("Speicher", "Storage")}
        value={bytes(d.storage.total)}
        note={d.storage.weekDelta === null ? t("Verlauf ab heute", "history from today on") : t(`${d.storage.weekDelta >= 0 ? "+" : "−"}${bytes(Math.abs(d.storage.weekDelta))} in 7 Tagen`, `${d.storage.weekDelta >= 0 ? "+" : "−"}${bytes(Math.abs(d.storage.weekDelta))} in 7 days`)}
      >
        <Sparkline values={trend} label={t("Speicher je Tag, 30 Tage", "Storage per day, 30 days")} />
      </Kpi>
    </div>
  );
}

/* ---------- Charts ---------- */

function Traffic({ d }: { d: MonitoringOverview }) {
  const t = useT();
  const pts = d.requests.points;
  const total = pts.reduce((a, p) => a + (p.requests || 0), 0),
    errors = pts.reduce((a, p) => a + (p.errors || 0), 0);
  const long = d.requests.range === "7d";
  return (
    <Card
      id="traffic"
      wide
      title={t("Anfragen & Fehler", "Requests & errors")}
      description={t(
        `Pro Minute, ${rangeLabel(d.requests.range, t)} · ${num(total)} Anfragen, ${num(errors)} Fehler (5xx) · p50 ${ms(d.kpis.p50)}, p95 ${ms(d.kpis.p95)} in der letzten Stunde`,
        `Per minute, ${rangeLabel(d.requests.range, t)} · ${num(total)} requests, ${num(errors)} errors (5xx) · p50 ${ms(d.kpis.p50)}, p95 ${ms(d.kpis.p95)} in the last hour`,
      )}
    >
      {!d.collecting.since ? (
        <EmptyState icon={<Info size={20} />} title={t("Noch keine Anfragen gezählt.", "No requests counted yet.")}>
          {d.collecting.enabled ? t("Die Zählung beginnt mit dieser Version; die erste Minute erscheint in Kürze.", "Counting starts with this version; the first minute appears shortly.") : t("Die Statistik ist ausgeschaltet.", "Statistics are switched off.")}
        </EmptyState>
      ) : (
        <>
          <RequestsChart requests={d.requests} />
          <h3 className="mon-subhead">{t(`Fehler (5xx) je ${long ? "Stunde" : d.requests.range === "24h" ? "5 Minuten" : "Minute"}`, `Errors (5xx) per ${long ? "hour" : d.requests.range === "24h" ? "5 minutes" : "minute"}`)}</h3>
          <RequestsChart requests={d.requests} kind="errors" />
          <ChartTable
            caption={t("Anfragen und Fehler", "Requests and errors")}
            head={[t("Zeit", "Time"), t("Anfragen", "Requests"), t("Fehler (5xx)", "Errors (5xx)"), "p95"]}
            rows={pts.filter((p) => p.requests !== null).slice(-60).reverse().map((p) => [dateTime(p.at), num(p.requests || 0), num(p.errors || 0), ms(p.p95)])}
          />
        </>
      )}
    </Card>
  );
}

function People({ d }: { d: MonitoringOverview }) {
  const t = useT();
  const peak = Math.max(0, ...d.active.map((p) => p.people || 0));
  return (
    <Card id="people" title={t("Aktive Personen", "Active people")} description={t(`Je Stunde, letzte 7 Tage · Spitze ${num(peak)} · aus Sitzungen, ohne Adressen`, `Per hour, last 7 days · peak ${num(peak)} · from sessions, without addresses`)}>
      <LineChart
        title={t("Aktive Personen je Stunde", "Active people per hour")}
        description={t("Angemeldete Personen, die in der Stunde Flowplan benutzt haben.", "Signed-in people who used Flowplan in that hour.")}
        x={d.active.map((p) => p.at)}
        series={[{ key: "people", label: t("Personen", "People"), values: d.active.map((p) => p.people) }]}
        formatX={weekday}
        formatTip={dateTime}
        formatY={(n) => num(n)}
        maxY={4}
      />
      <ChartTable
        caption={t("Aktive Personen je Stunde", "Active people per hour")}
        head={[t("Stunde", "Hour"), t("Personen", "People")]}
        rows={d.active.filter((p) => p.people !== null).slice(-48).reverse().map((p) => [dateTime(p.at), num(p.people || 0)])}
      />
    </Card>
  );
}

function Signins({ d }: { d: MonitoringOverview }) {
  const t = useT();
  const ok = d.signins.reduce((a, s) => a + s.ok, 0),
    failed = d.signins.reduce((a, s) => a + s.failed, 0);
  const series = [
    { key: "ok", label: t("erfolgreich", "successful"), values: d.signins.map((s) => s.ok), color: 0 },
    { key: "failed", label: t("fehlgeschlagen", "failed"), values: d.signins.map((s) => s.failed), color: 1 },
  ];
  return (
    <Card id="signins" title={t("Anmeldungen", "Sign-ins")} description={t(`Pro Tag, 14 Tage · ${num(ok)} erfolgreich, ${num(failed)} fehlgeschlagen`, `Per day, 14 days · ${num(ok)} successful, ${num(failed)} failed`)}>
      <Legend items={series.map((s) => ({ label: s.label, color: s.color }))} />
      <BarChart title={t("Anmeldungen je Tag", "Sign-ins per day")} description={t("Erfolgreiche und fehlgeschlagene Anmeldungen der letzten 14 Tage.", "Successful and failed sign-ins of the last 14 days.")} labels={d.signins.map((s) => shortDay(s.day))} tips={d.signins.map((s) => longDay(s.day))} series={series} formatY={(n) => num(n)} />
      <ChartTable caption={t("Anmeldungen je Tag", "Sign-ins per day")} head={[t("Tag", "Day"), series[0].label, series[1].label]} rows={[...d.signins].reverse().map((s) => [longDay(s.day), num(s.ok), num(s.failed)])} />
    </Card>
  );
}

function Refused({ d }: { d: MonitoringOverview }) {
  const t = useT();
  const kinds = [
    ["login_failure", t("Anmeldungen", "Sign-ins"), t("Fehlgeschlagene Anmeldungen", "Failed sign-ins")],
    ["rate_limited", t("Limit (429)", "Limit (429)"), t("Abgewiesen wegen Limit (429)", "Refused by a limit (429)")],
    ["anonymous_refused", t("Anonyme Uploads", "Anonymous uploads"), t("Anonyme Uploads über Tagesbudget", "Anonymous uploads over the daily budget")],
  ] as const;
  const series = kinds.map(([key, label], i) => ({ key, label, values: d.refused.days.map((day) => day[key]), color: i }));
  return (
    <Card
      id="refused"
      title={t("Abgewiesene Anfragen", "Refused requests")}
      description={t("Pro Tag, 14 Tage – ein Anstieg deutet auf Angriffe oder zu knappe Grenzen.", "Per day, 14 days – a rise points to attacks or limits that are too tight.")}
    >
      <ul className="mon-totals">
        {kinds.map(([key, , long]) => (
          <li key={key}>
            <span>{long}</span>
            <strong>{t(`${num(d.refused.totals[key].day)} in 24 Std.`, `${num(d.refused.totals[key].day)} in 24 h`)}</strong>
            <small>{t(`${num(d.refused.totals[key].hour)} in der letzten Stunde · ${num(d.refused.totals[key].week)} in 7 Tagen`, `${num(d.refused.totals[key].hour)} in the last hour · ${num(d.refused.totals[key].week)} in 7 days`)}</small>
          </li>
        ))}
        <li>
          <span>{t("Anonyme Uploads heute", "Anonymous uploads today")}</span>
          <strong>{bytes(d.refused.anonymousBytesToday)}</strong>
        </li>
      </ul>
      <Legend items={series.map((s) => ({ label: s.label, color: s.color }))} />
      <BarChart title={t("Abgewiesene Anfragen je Tag", "Refused requests per day")} description={t("Fehlgeschlagene Anmeldungen, Limits und anonyme Uploads je Tag.", "Failed sign-ins, limits and anonymous uploads per day.")} labels={d.refused.days.map((x) => shortDay(x.day))} tips={d.refused.days.map((x) => longDay(x.day))} series={series} formatY={(n) => num(n)} />
      <ChartTable caption={t("Abgewiesene Anfragen je Tag", "Refused requests per day")} head={[t("Tag", "Day"), ...series.map((s) => s.label)]} rows={[...d.refused.days].reverse().map((x) => [longDay(x.day), num(x.login_failure), num(x.rate_limited), num(x.anonymous_refused)])} />
    </Card>
  );
}

function Storage({ d }: { d: MonitoringOverview }) {
  const t = useT();
  const names: Record<string, string> = {
    database: t("Datenbank", "Database"),
    images: t("Bilder", "Images"),
    documents: t("Dokumente", "Documents"),
    video: t("Videos", "Videos"),
    audio: t("Audio", "Audio"),
    other: t("Sonstige Dateien", "Other files"),
  };
  const order = ["database", "images", "documents", "video", "audio", "other"];
  const segments = [...d.storage.byType].sort((a, b) => order.indexOf(a.key) - order.indexOf(b.key)).map((s) => ({ key: s.key, label: names[s.key] || s.key, value: s.bytes, color: Math.max(0, order.indexOf(s.key)) }));
  const disk = d.storage.disk;
  return (
    <Card id="storage" title={t("Speicher", "Storage")} description={t(`${bytes(d.storage.total)} · nach Art und größte Arbeitsbereiche`, `${bytes(d.storage.total)} · by kind and largest workspaces`)} actions={<a className="button compact" href={settingsHash({ area: "admin", section: "storage" })}>{t("Details", "Details")}</a>}>
      <div className="mon-storage">
        <Donut title={t("Speicher nach Art", "Storage by kind")} segments={segments} format={bytes} center={bytes(d.storage.total)} centerLabel={t("gesamt", "total")} />
        <div className="mon-storage-side">
          {disk && <UsageMeter label={t("Datenträger", "Disk")} used={disk.total - disk.free} limit={disk.total} format={bytes} />}
          <h3 className="mon-subhead">{t("Größte Arbeitsbereiche", "Largest workspaces")}</h3>
          {d.storage.workspaces.length ? (
            d.storage.workspaces.map((w) => <UsageMeter key={w.id} label={w.name || w.id.slice(0, 8)} used={w.bytes} limit={w.quotaMb * 1024 * 1024} format={bytes} />)
          ) : (
            <p className="muted">{t("Noch keine Arbeitsbereiche.", "No workspaces yet.")}</p>
          )}
        </div>
      </div>
      <ChartTable caption={t("Speicher nach Art", "Storage by kind")} head={[t("Art", "Kind"), t("Größe", "Size")]} rows={segments.map((s) => [s.label, bytes(s.value)])} />
    </Card>
  );
}

function Deliveries({ d }: { d: MonitoringOverview }) {
  const t = useT();
  const days = d.deliveries.days;
  const series = [
    { key: "webhooks", label: t("Webhooks", "Webhooks"), values: days.map((x) => x.webhooks), color: 0 },
    { key: "push", label: t("Push", "Push"), values: days.map((x) => x.push), color: 2 },
    { key: "mail", label: t("E-Mail", "E-mail"), values: days.map((x) => x.mail), color: 3 },
  ];
  const total = days.reduce((a, x) => a + x.webhooks + x.push + x.mail, 0);
  return (
    <Card id="deliveries" title={t("Zustellungen", "Deliveries")} description={t(`Erfolgreich pro Tag, 7 Tage · ${num(total)} zugestellt · ${num(d.deliveries.failed)} aufgegeben`, `Successful per day, 7 days · ${num(total)} delivered · ${num(d.deliveries.failed)} given up`)}>
      <Legend items={series.map((s) => ({ label: s.label, color: s.color }))} />
      <BarChart title={t("Zustellungen je Tag", "Deliveries per day")} description={t("Zugestellte Webhooks, Push-Nachrichten und E-Mails je Tag.", "Delivered webhooks, push messages and e-mails per day.")} labels={days.map((x) => weekday(dayAt(x.day)))} tips={days.map((x) => longDay(x.day))} series={series} formatY={(n) => compact(n)} />
      <ChartTable caption={t("Zustellungen je Tag", "Deliveries per day")} head={[t("Tag", "Day"), ...series.map((s) => s.label)]} rows={[...days].reverse().map((x) => [longDay(x.day), num(x.webhooks), num(x.push), num(x.mail)])} />
    </Card>
  );
}

function AiUsage({ d }: { d: MonitoringOverview }) {
  const t = useT();
  const total = d.ai.days.reduce((a, x) => a + x.tokensIn + x.tokensOut, 0);
  const featureName = (id: string) => {
    if (id === "embeddings") return t("Suchindex (Embeddings)", "Search index (embeddings)");
    const f = AI_FEATURES.find((x) => x.id === id);
    return f ? t(f.label[0], f.label[1]) : id;
  };
  const series = [
    { key: "in", label: t("Eingabe", "Input"), values: d.ai.days.map((x) => x.tokensIn), color: 0 },
    { key: "out", label: t("Ausgabe", "Output"), values: d.ai.days.map((x) => x.tokensOut), color: 2 },
  ];
  const max = Math.max(1, ...d.ai.features.map((f) => f.tokens));
  return (
    <Card id="ai" title={t("KI-Nutzung", "AI usage")} description={t(`Tokens pro Tag, 14 Tage · ${compact(total)} insgesamt · geschätzt, wo der Anbieter keine Zahl meldet`, `Tokens per day, 14 days · ${compact(total)} in total · estimated where the provider reports none`)}>
      {!total ? (
        <EmptyState icon={<Sparkle size={20} />} title={t("Noch keine KI-Anfragen gezählt.", "No AI requests counted yet.")}>
          {d.health.ai.enabled ? t("Sobald jemand die KI nutzt, erscheinen hier die Tokens je Tag und Funktion.", "As soon as someone uses AI, tokens per day and feature appear here.") : t("Die KI ist ausgeschaltet.", "AI is switched off.")}
        </EmptyState>
      ) : (
        <>
          <Legend items={series.map((s) => ({ label: s.label, color: s.color }))} />
          <BarChart title={t("KI-Tokens je Tag", "AI tokens per day")} description={t("Eingabe- und Ausgabe-Tokens je Tag.", "Input and output tokens per day.")} labels={d.ai.days.map((x) => shortDay(x.day))} tips={d.ai.days.map((x) => longDay(x.day))} series={series} formatY={(n) => compact(n)} />
          <h3 className="mon-subhead">{t("Nach Funktion", "By feature")}</h3>
          <ul className="mon-bars">
            {d.ai.features.map((f) => (
              <li key={f.feature}>
                <span>{featureName(f.feature)}</span>
                <strong>{t(`${compact(f.tokens)} · ${num(f.requests)} Anfragen`, `${compact(f.tokens)} · ${num(f.requests)} requests`)}</strong>
                <i aria-hidden>
                  <b style={{ width: `${Math.max(2, (f.tokens / max) * 100)}%` }} />
                </i>
              </li>
            ))}
          </ul>
          <ChartTable caption={t("KI-Tokens je Tag", "AI tokens per day")} head={[t("Tag", "Day"), series[0].label, series[1].label, t("Anfragen", "Requests")]} rows={[...d.ai.days].reverse().map((x) => [longDay(x.day), num(x.tokensIn), num(x.tokensOut), num(x.requests)])} />
        </>
      )}
    </Card>
  );
}

function Queues({ d }: { d: MonitoringOverview }) {
  const t = useT();
  const q = d.queues;
  const rows: { key: string; label: string; value: number | null; text: string; tone?: Tone }[] = [
    { key: "search", label: t("Suchindex", "Search index"), value: q.search, text: q.search ? t(`${num(q.search)} ausstehend`, `${num(q.search)} pending`) : t("aktuell", "up to date") },
    { key: "mail", label: t("E-Mail-Warteschlange", "Mail queue"), value: q.mail, text: q.mail === null ? t("kein SMTP", "no SMTP") : t(`${num(q.mail)} wartend`, `${num(q.mail)} waiting`) },
    { key: "push", label: t("Push-Zustellung", "Push delivery"), value: q.push, text: t(`${num(q.push)} offen`, `${num(q.push)} open`) },
    { key: "aiFields", label: t("KI-Felder", "AI fields"), value: q.aiFields, text: t(`${num(q.aiFields)} Aufträge`, `${num(q.aiFields)} jobs`) },
    { key: "aiIndex", label: t("KI-Suchindex", "AI search index"), value: q.aiIndex, text: t(`${num(q.aiIndex)} Seiten`, `${num(q.aiIndex)} pages`) },
    { key: "s3", label: t("S3-Upload", "S3 upload"), value: q.s3, text: q.s3 === null ? t("nicht eingerichtet", "not set up") : t(`${num(q.s3)} Dateien`, `${num(q.s3)} files`) },
    {
      key: "webhooks",
      label: t("Webhooks in Wiederholung", "Webhooks retrying"),
      value: q.webhooksRetrying,
      text: t(`${num(q.webhooksRetrying)} · ${num(q.webhooksGivenUp)} aufgegeben`, `${num(q.webhooksRetrying)} · ${num(q.webhooksGivenUp)} given up`),
      tone: q.webhooksGivenUp ? "warn" : undefined,
    },
  ];
  const max = Math.max(10, ...rows.map((r) => r.value || 0));
  return (
    <Card id="queues" title={t("Warteschlangen", "Queues")} description={t("Was gerade auf Bearbeitung wartet.", "What is waiting to be processed right now.")}>
      <ul className="mon-bars">
        {rows.map((r) => (
          <li key={r.key}>
            <span>{r.label}</span>
            <strong>{r.tone ? <StatusBadge tone={r.tone}>{r.text}</StatusBadge> : r.text}</strong>
            <i aria-hidden>
              <b style={{ width: `${r.value ? Math.max(2, (r.value / max) * 100) : 0}%` }} />
            </i>
          </li>
        ))}
      </ul>
    </Card>
  );
}

/* ---------- Events ---------- */

const EVENT_FILTERS = ["all", "error", "warn", "info"] as const;
function eventText(e: MonitoringEvent, t: T): { title: string; detail?: string } {
  switch (e.kind) {
    case "worker_error":
      return { title: t(`${workerName(e.subject || "", t)} meldet einen Fehler`, `${workerName(e.subject || "", t)} reports an error`), detail: e.detail };
    case "backup_ok":
      return { title: t("Sicherung erstellt", "Backup created"), detail: [e.subject, e.count ? bytes(e.count) : ""].filter(Boolean).join(" · ") };
    case "backup_failed":
      return { title: t("Sicherung fehlgeschlagen", "Backup failed"), detail: e.detail };
    case "export_ok":
      return { title: t("Markdown-Export ausgeführt", "Markdown export done") };
    case "export_failed":
      return { title: t("Markdown-Export fehlgeschlagen", "Markdown export failed"), detail: e.detail };
    case "alert_sent":
      return { title: t("Warnung per Webhook gesendet", "Alert sent by webhook"), detail: [e.subject, e.detail].filter(Boolean).join(" · ") };
    case "login_spike":
      return { title: t(`Viele fehlgeschlagene Anmeldungen (${num(e.count || 0)} in einer Stunde)`, `Many failed sign-ins (${num(e.count || 0)} in one hour)`) };
    case "rate_limit_spike":
      return { title: t(`Viele Anfragen über dem Limit (${num(e.count || 0)} in einer Stunde)`, `Many requests over the limit (${num(e.count || 0)} in one hour)`) };
    case "update":
      return { title: t(`Flowplan ${e.subject} ist verfügbar`, `Flowplan ${e.subject} is available`) };
    case "mail_failed":
      return { title: t(`${num(e.count || 0)} E-Mails aufgegeben`, `${num(e.count || 0)} e-mails given up`) };
    case "webhook_failed":
      return { title: t(`Webhook an ${e.subject} aufgegeben`, `Webhook to ${e.subject} given up`), detail: e.detail };
    case "maintenance":
      return { title: t(`Wartungshinweis bis ${dateTime(e.count || 0)}`, `Maintenance notice until ${dateTime(e.count || 0)}`), detail: e.detail };
    case "restore_pending":
      return { title: t("Wiederherstellung wartet auf den Neustart", "Restore waits for a restart") };
    case "started":
      return { title: t("Flowplan gestartet", "Flowplan started"), detail: e.subject ? `v${e.subject}` : undefined };
    case "admin": {
      // The audit action as the setting's name, where it has one.
      const names: Record<string, string> = {
        "admin.settings": t("Instanz", "Instance"),
        "admin.quota": t("Kontingent", "Quota"),
        "admin.userLimits": t("Grenzen je Person", "Limits per person"),
        "admin.ai": t("KI", "AI"),
        "admin.ops.alerts": t("Warnungen per Webhook", "Alerts by webhook"),
        "admin.ops.alerts.test": t("Testwarnung", "Test alert"),
        "admin.ops.maintenance": t("Wartungshinweis", "Maintenance notice"),
        "admin.metrics": t("Statistik", "Statistics"),
        "admin.metrics.clear": t("Statistik gelöscht", "Statistics deleted"),
      };
      const name = names[e.subject || ""] || e.subject;
      return { title: t(`Einstellung geändert: ${name}`, `Setting changed: ${name}`), detail: e.detail };
    }
  }
}

function Events({ events }: { events: MonitoringEvent[] }) {
  const t = useT();
  const [filter, setFilter] = useState<(typeof EVENT_FILTERS)[number]>("all");
  const shown = events.filter((e) => filter === "all" || e.level === filter || (filter === "info" && e.level === "ok"));
  const label = { all: t("Alle", "All"), error: t("Fehler", "Errors"), warn: t("Warnungen", "Warnings"), info: t("Hinweise", "Notes") };
  const counts = { all: events.length, error: events.filter((e) => e.level === "error").length, warn: events.filter((e) => e.level === "warn").length, info: events.filter((e) => e.level === "info" || e.level === "ok").length };
  return (
    <Card id="events" title={t("Ereignisse", "Events")} description={t("Fehler, Warnungen und Wartung der letzten 14 Tage.", "Errors, warnings and maintenance of the last 14 days.")}>
      <div className="mon-filters" role="group" aria-label={t("Ereignisse filtern", "Filter events")}>
        {EVENT_FILTERS.map((f) => (
          <button key={f} type="button" className="mon-chip" aria-pressed={filter === f} onClick={() => setFilter(f)}>
            {label[f]} <span className="muted">{counts[f]}</span>
          </button>
        ))}
      </div>
      {shown.length ? (
        <ul className="mon-events">
          {shown.map((e, i) => {
            const text = eventText(e, t);
            const tone: Tone = e.level === "error" ? "error" : e.level === "warn" ? "warn" : e.level === "ok" ? "ok" : "info";
            const ToneIcon = e.kind === "maintenance" ? Megaphone : e.kind === "alert_sent" ? PaperPlaneTilt : TONE_ICON[tone];
            return (
              <li key={`${e.kind}-${e.at}-${i}`}>
                <span className={`mon-event-icon ${tone}`} aria-hidden>
                  <ToneIcon size={15} weight="bold" />
                </span>
                <div>
                  <strong>
                    <span className="sr-only">{TONE_WORD(tone, t)}: </span>
                    {text.title}
                  </strong>
                  {text.detail && <small>{text.detail}</small>}
                </div>
                <time dateTime={new Date(e.at).toISOString()} title={dateTime(e.at)}>
                  {ago(e.at, t)}
                </time>
              </li>
            );
          })}
        </ul>
      ) : (
        <EmptyState icon={<CheckCircle size={20} />} title={t("Nichts in diesem Filter.", "Nothing in this filter.")} />
      )}
    </Card>
  );
}

/* ---------- Quick actions ---------- */

function Actions({ d, ops, reload }: { d: MonitoringOverview; ops: Ops; reload: () => void }) {
  const t = useT();
  const { onError } = useAdmin();
  const [status, run] = useSaveState();
  const [busy, setBusy] = useState("");
  const act = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key);
    await run(async () => {
      try {
        await fn();
      } catch (e) {
        onError((e as Error).message);
        throw e;
      }
    });
    setBusy("");
    reload();
  };
  return (
    <Card id="actions" title={t("Schnellzugriff", "Quick actions")} description={t("Häufige Handgriffe bei einer Störung.", "Common steps when something is wrong.")}>
      <div className="mon-actions">
        <button type="button" className="button" disabled={!!busy} onClick={() => void act("backup", () => api("/api/admin/backup-run", {}))}>
          <ArrowClockwise size={16} aria-hidden />
          {t("Jetzt sichern", "Back up now")}
        </button>
        {d.health.ai.configured && (
          <button type="button" className="button" disabled={!!busy} onClick={() => void act("ai", () => api("/api/admin/monitoring", { action: "ai.ping" }))}>
            <Sparkle size={16} aria-hidden />
            {t("KI-Anbieter prüfen", "Check AI provider")}
          </button>
        )}
        {ops.data?.alerts.url && (
          <>
            <button type="button" className="button" disabled={!!busy || ops.busy} onClick={() => void ops.send({ action: "alerts.check" })}>
              <WarningCircle size={16} aria-hidden />
              {t("Warnungen prüfen", "Check alerts")}
            </button>
            <button type="button" className="button" disabled={!!busy || ops.busy} onClick={() => void ops.send({ action: "alerts.test" })}>
              <PaperPlaneTilt size={16} aria-hidden />
              {t("Testwarnung senden", "Send test alert")}
            </button>
          </>
        )}
        <a className="button" href={settingsHash({ area: "admin", section: "maintenance" })}>
          <Megaphone size={16} aria-hidden />
          {t("Wartungshinweis", "Maintenance notice")}
        </a>
        <a className="button" href="/api/admin/operations?export=audit&format=csv" download>
          <DownloadSimple size={16} aria-hidden />
          {t("Protokoll (CSV)", "Log (CSV)")}
        </a>
      </div>
      <SaveState status={status} />
      {ops.note && (
        <p className="muted" role="status">
          {ops.note}
        </p>
      )}
    </Card>
  );
}

/* ---------- Workers, numbers, statistics ---------- */

function Workers({ ops }: { ops: OpsOverview | null }) {
  const t = useT();
  const when = (at: number | null) => (at ? dateTime(at) : "–");
  return (
    <SettingGroup id="workers" title={t("Hintergrunddienste", "Background workers")} description={t("Letzter Lauf und letzter Fehler je Dienst.", "Last run and last error per worker.")}>
      {!ops ? (
        <AdminLoading />
      ) : (
        <div className="mon-table">
          <ResponsiveTable<WorkerStatus>
            label={t("Hintergrunddienste", "Background workers")}
            rows={ops.workers}
            rowKey={(w) => w.key}
            columns={[
              { key: "name", header: t("Dienst", "Worker"), primary: true, render: (w) => workerName(w.key, t) },
              {
                key: "state",
                header: t("Status", "Status"),
                render: (w) => <StatusBadge tone={!w.active ? "off" : w.error ? "error" : "ok"}>{!w.active ? t("aus", "off") : w.error ? t("Fehler", "Error") : t("in Ordnung", "fine")}</StatusBadge>,
              },
              { key: "run", header: t("Letzter Lauf", "Last run"), render: (w) => when(w.lastRun) },
              { key: "error", header: t("Fehler", "Error"), render: (w) => (w.error ? <small className="mon-error" title={when(w.errorAt)}>{w.error}</small> : "–") },
            ]}
          />
          {!!ops.webhooks.recent.length && (
            <div className="mon-sent">
              <h3>{t("Fehlgeschlagene Webhooks", "Failing webhooks")}</h3>
              <ul>
                {ops.webhooks.recent.map((w, i) => (
                  <li key={i}>
                    <StatusBadge tone={w.attempts >= 6 ? "error" : "warn"}>{t(`${w.attempts} Versuche`, `${w.attempts} attempts`)}</StatusBadge>
                    <span>
                      <strong>{w.host}</strong> · {w.workspace}
                    </span>
                    <small className="muted">
                      {when(w.at)}
                      {w.error ? ` · ${w.error}` : ""}
                    </small>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </SettingGroup>
  );
}

// The rest of the former "Betriebsmetriken": contents and settings that
// no chart shows (sizes and health are above).
function InstanceNumbers() {
  const t = useT();
  const { data } = useAdminData();
  if (!data) return null;
  const m = data.metrics;
  const rows: [string, string][] = [
    [
      t("Seiten", "Pages"),
      m.journalDays
        ? t(
            `${num(m.pages - m.journalDays)} Seiten · ${num(m.journalDays)} Journaltage aktiv · ${num(m.trashedPages)} im Papierkorb`,
            `${num(m.pages - m.journalDays)} pages · ${num(m.journalDays)} journal days active · ${num(m.trashedPages)} in trash`,
          )
        : t(`${num(m.pages)} aktiv · ${num(m.trashedPages)} im Papierkorb`, `${num(m.pages)} active · ${num(m.trashedPages)} in trash`),
    ],
    [t("Datensätze", "Records"), num(m.rows)],
    [t("Versionen", "Versions"), t(`${num(m.snapshots)} · Aufbewahrung ${m.retentionDays ? `${m.retentionDays} Tage` : "unbegrenzt"}`, `${num(m.snapshots)} · kept ${m.retentionDays ? `${m.retentionDays} days` : "forever"}`)],
    [t("Erinnerungen", "Reminders"), num(m.reminders)],
    [
      t("Demos", "Demos"),
      t(`${num(m.demosActive)} laufen · ${num(m.demosStarted)} insgesamt gestartet`, `${num(m.demosActive)} running · ${num(m.demosStarted)} started in total`) + (data.settings.publicDemo ? "" : t(" · ausgeschaltet", " · switched off")),
    ],
    [t("Standardkontingent", "Default quota"), m.defaultQuotaMb ? t(`${num(m.defaultQuotaMb)} MB je Arbeitsbereich`, `${num(m.defaultQuotaMb)} MB per workspace`) : t("unbegrenzt", "unlimited")],
    [t("Laufzeit", "Uptime"), `${uptime(m.uptimeSeconds, t)} · Node ${m.node}`],
  ];
  return (
    <SettingGroup id="instance" title={t("Instanz in Zahlen", "Instance in numbers")}>
      {rows.map(([label, value]) => (
        <SettingRow key={label} label={label}>
          <span className="mon-value">{value}</span>
        </SettingRow>
      ))}
    </SettingGroup>
  );
}

function Statistics({ d, onChange }: { d: MonitoringOverview; onChange: () => void }) {
  const t = useT();
  const { onError } = useAdmin();
  const [status, run] = useSaveState();
  const [enabled, setEnabled] = useState(d.collecting.enabled);
  useEffect(() => setEnabled(d.collecting.enabled), [d.collecting.enabled]);
  return (
    <>
      <SettingGroup
        id="metrics"
        title={t("Statistik", "Statistics")}
        description={t(
          `Flowplan zählt Anfragen, Fehler und Antwortzeiten je Minute, aktive Personen je Stunde, Speicher je Tag und KI-Tokens je Funktion – nur Zahlen, keine Adressen, Pfade oder Namen. Minuten bleiben ${d.keep.minuteHours} Stunden, Stunden ${d.keep.hourDays} Tage, Tage ${d.keep.days} Tage.`,
          `Flowplan counts requests, errors and response times per minute, active people per hour, storage per day and AI tokens per feature – numbers only, no addresses, paths or names. Minutes are kept ${d.keep.minuteHours} hours, hours ${d.keep.hourDays} days, days ${d.keep.days} days.`,
        )}
      >
        <SettingRow
          label={t("Nutzungsstatistik erfassen", "Collect usage statistics")}
          description={
            d.collecting.locked
              ? t("Mit FLOWPLAN_METRICS=off in der Umgebung ausgeschaltet.", "Switched off with FLOWPLAN_METRICS=off in the environment.")
              : d.collecting.since
                ? t(`Erfasst seit ${dateTime(d.collecting.since)}.`, `Collected since ${dateTime(d.collecting.since)}.`)
                : t("Noch nichts erfasst.", "Nothing collected yet.")
          }
        >
          <SaveState status={status} />
          <Switch
            checked={enabled}
            disabled={d.collecting.locked}
            label={t("Nutzungsstatistik erfassen", "Collect usage statistics")}
            onChange={(on) => {
              setEnabled(on);
              void run(async () => {
                try {
                  await api("/api/admin/monitoring", { action: "metrics.save", enabled: on });
                  onChange();
                } catch (e) {
                  setEnabled(!on);
                  throw e;
                }
              });
            }}
          />
        </SettingRow>
      </SettingGroup>
      <DangerZone id="metrics-clear" title={t("Statistik löschen", "Delete statistics")} description={t("Entfernt alle gezählten Anfragen, aktiven Personen, Speicherstände, KI-Tokens und erfolgreichen Anmeldungen. Abgewiesene Anfragen bleiben.", "Removes all counted requests, active people, storage history, AI tokens and successful sign-ins. Refused requests stay.")}>
        <SettingRow label={t("Gesammelte Statistik", "Collected statistics")} description={t("Lässt sich nicht rückgängig machen.", "Cannot be undone.")}>
          <button
            type="button"
            className="button danger"
            onClick={async () => {
              if (!confirm(t("Die gesamte Statistik löschen?", "Delete all statistics?"))) return;
              try {
                await api("/api/admin/monitoring", { action: "metrics.clear" });
                onChange();
              } catch (e) {
                onError((e as Error).message);
              }
            }}
          >
            {t("Statistik löschen", "Delete statistics")}
          </button>
        </SettingRow>
      </DangerZone>
    </>
  );
}
