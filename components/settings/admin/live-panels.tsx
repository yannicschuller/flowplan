"use client";
// The top of "Instanz auf einen Blick" on the settings' start page (#532):
// the state of the instance in one line (problems and notices of the
// sections, linked) and a grid of live panels: first, across the whole
// width, active people with CPU and RAM over them ("Aktive Personen und
// Serverlast": does the load follow the people?), then requests, AI,
// storage, errors, the server's disk, accounts, sign-ins, backups and the
// background work. Each panel has its key number, a small chart of real data and a
// link into its section; a panel only appears when its data exists or its
// feature is on. Phones show the first four, "Alle Diagramme" the rest
// (remembered on this device). Refreshed every 15 seconds while visible
// (/api/admin/monitoring?view=live, lib/admin-monitoring.ts monitoringStart;
// the slower facts are cached a minute on the server).
import { useEffect, useState, type ReactNode } from "react";
import {
  CaretDown,
  CaretRight,
  CaretUp,
  CheckCircle,
  ClockCounterClockwise,
  Cpu,
  Database,
  Info,
  Pulse,
  ShieldCheck,
  Sparkle,
  Stack,
  UserPlus,
  UsersThree,
  WarningCircle,
  XCircle,
  type Icon,
} from "@phosphor-icons/react";
import type { MonitoringStart } from "@/lib/admin-monitoring";
import { AI_FEATURES } from "@/lib/ai/features";
import { settingsHash } from "@/lib/settings-sections";
import { useT } from "../../i18n";
import { BarChart, Legend, LineChart } from "../../charts";
import { LiveBadge, rangeLabel, RequestsChart } from "./live";
import { useLive } from "./use-live";
import { bytes, clock, compact, dateTime, dayAt, longDay, ms, num, percent, shortDay, uptime } from "./monitoring-format";
import { LOCALE_TAG } from "@/lib/locale-tag";
import { markOpenedFromHome } from "../shell";

type T = (de: string, en: string) => string;
export type StripItem = { id: string; title: string; badge?: string; href?: string };
type Panel = { id: string; section: string; anchor?: string; Icon: Icon; title: string; value?: string; unit?: string; line?: string; alert?: boolean; wide?: boolean; body: ReactNode };

const EXPANDED_KEY = "flowplan-admin-live-expanded";
// Phones: how many panels show before "Alle Diagramme".
export const PHONE_PANELS = 4;
const CHART = 96;

const last = <V,>(values: (V | null)[]) => {
  for (let i = values.length - 1; i >= 0; i--) if (values[i] !== null && values[i] !== undefined) return values[i];
  return null;
};
const known = (values: (number | null)[]) => values.filter((v) => typeof v === "number").length;
const featureName = (id: string, t: T) => {
  if (id === "embeddings") return t("Suchindex (Embeddings)", "Search index (embeddings)");
  const f = AI_FEATURES.find((x) => x.id === id);
  return f ? t(f.label[0], f.label[1]) : id;
};
const shortAt = (at: number) => new Date(at).toLocaleDateString(LOCALE_TAG, { day: "numeric", month: "numeric" });
const longAt = (at: number) => new Date(at).toLocaleDateString(LOCALE_TAG, { weekday: "long", day: "numeric", month: "long" });
const when = (at: number) => (Date.now() - at < 86_400_000 ? clock(at) : dateTime(at));

function Off({ children }: { children: ReactNode }) {
  return (
    <p className="sv-glance-off">
      <Info size={15} aria-hidden /> {children}
    </p>
  );
}

// Names with a bar each (largest workspaces, AI features).
function Bars({ label, rows }: { label: string; rows: { name: string; value: number; text: string }[] }) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  return (
    <div className="sv-glance-bars">
      <strong>{label}</strong>
      {rows.map((r, i) => (
        <div key={i} className="sv-hbar">
          <span>{r.name}</span>
          <progress max={1000} value={Math.round((r.value / max) * 1000)} aria-label={`${r.name}: ${r.text}`} />
          <strong>{r.text}</strong>
        </div>
      ))}
    </div>
  );
}

export function livePanels(d: MonitoringStart, t: T): Panel[] {
  const on = d.collecting.enabled;
  const k = d.kpis;
  const g = d.glance;
  const p = d.server.points;
  const panels: Panel[] = [];

  // Active people and the server's load in one chart across the grid: the
  // people (left axis, with the statistics) and CPU and RAM in % of the
  // limit (right axis), per 5 minutes, 24 hours; the legend has the values
  // now. Without the statistics CPU and RAM only, and why.
  const people = p.map((x) => x.active);
  const cpuLine = p.map((x) => x.cpu),
    ramLine = p.map((x) => x.memory);
  const hasPeople = on && known(people) > 0;
  const rss = last(p.map((x) => x.rss));
  const lastPct = (values: (number | null)[]) => {
    const v = last(values);
    return v === null ? "–" : percent(v);
  };
  panels.push({
    id: "people",
    section: "monitoring",
    anchor: "people",
    Icon: UsersThree,
    title: t("Aktive Personen und Serverlast", "Active people and server load"),
    wide: true,
    line: [
      on ? t(`${num(k.activeToday)} heute · ${num(k.active24h)} in 24 Std.`, `${num(k.activeToday)} today · ${num(k.active24h)} in 24 h`) : "",
      rss !== null ? t(`Flowplan belegt ${bytes(rss)} Arbeitsspeicher`, `Flowplan uses ${bytes(rss)} of memory`) : "",
    ]
      .filter(Boolean)
      .join(" · "),
    body: (
      <>
        <Legend
          items={[
            ...(on ? [{ label: t("Aktive Personen", "Active people"), color: 0, value: num(k.activeNow) }] : []),
            { label: "CPU", color: 1, value: lastPct(cpuLine), line: true },
            { label: "RAM", color: 2, value: lastPct(ramLine), line: true },
          ]}
        />
        {p.length > 1 && (
          <LineChart
            title={t("Aktive Personen und Serverlast", "Active people and server load")}
            description={
              hasPeople
                ? t(
                    "Personen der letzten 5 Minuten (links) und CPU und Arbeitsspeicher in % des Limits (rechts), je 5 Minuten, 24 Stunden.",
                    "People of the last 5 minutes (left) and CPU and memory in % of the limit (right), per 5 minutes, 24 hours.",
                  )
                : t("CPU und Arbeitsspeicher in % des Limits, je 5 Minuten, 24 Stunden.", "CPU and memory in % of the limit, per 5 minutes, 24 hours.")
            }
            x={p.map((x) => x.at)}
            series={hasPeople ? [{ key: "people", label: t("Aktive Personen", "Active people"), values: people, color: 0 }] : []}
            right={{
              series: [
                { key: "cpu", label: "CPU", values: cpuLine, color: 1 },
                { key: "ram", label: "RAM", values: ramLine, color: 2 },
              ],
              format: percent,
              max: 1,
            }}
            formatX={clock}
            formatTip={dateTime}
            formatY={(n) => num(n, n < 10 && n % 1 ? 1 : 0)}
            height={150}
          />
        )}
        {!on && <Off>{t("Aktive Personen nur mit eingeschalteter Statistik (Überwachung → Statistik).", "Active people only with statistics on (Monitoring → Statistics).")}</Off>}
      </>
    ),
  });

  if (on)
    panels.push({
      id: "requests",
      section: "monitoring",
      anchor: "traffic",
      Icon: Pulse,
      title: t("Anfragen pro Minute", "Requests per minute"),
      value: num(k.requestsPerMinute),
      unit: t("Anfragen/Min.", "Requests/min"),
      line: t(`${num(k.requestsHour)} in der letzten Stunde · p95 ${ms(k.p95)}`, `${num(k.requestsHour)} in the last hour · p95 ${ms(k.p95)}`),
      body: <RequestsChart requests={d.requests} height={CHART} />,
    });

  if (d.ai) {
    const ai = d.ai;
    const series = [
      { key: "in", label: t("Eingabe", "Input"), values: ai.perDay.map((x) => x.tokensIn), color: 0 },
      { key: "out", label: t("Ausgabe", "Output"), values: ai.perDay.map((x) => x.tokensOut), color: 2 },
    ];
    const money = (n: number) => n.toLocaleString(undefined, { style: "currency", currency: ai.currency, maximumFractionDigits: n < 10 ? 2 : 0 });
    const failed = ai.total.errors + ai.total.timeouts;
    panels.push({
      id: "ai",
      section: "ai",
      anchor: "ai-statistics",
      Icon: Sparkle,
      title: t("KI-Nutzung", "AI usage"),
      value: compact(ai.total.tokensIn + ai.total.tokensOut),
      unit: t("Tokens in 14 Tagen", "tokens in 14 days"),
      line: [
        t(`${num(ai.total.requests)} Anfragen`, `${num(ai.total.requests)} requests`),
        ai.people === 1 ? t("1 Person", "1 person") : t(`${num(ai.people)} Personen`, `${num(ai.people)} people`),
        ai.total.cost !== null ? t(`≈ ${money(ai.total.cost)} (geschätzt)`, `≈ ${money(ai.total.cost)} (estimated)`) : "",
        failed ? t(`${num(failed)} fehlgeschlagen`, `${num(failed)} failed`) : "",
      ]
        .filter(Boolean)
        .join(" · "),
      body: (
        <>
          <BarChart
            title={t("KI-Tokens je Tag", "AI tokens per day")}
            description={t("Eingabe- und Ausgabe-Tokens je Tag, 14 Tage.", "Input and output tokens per day, 14 days.")}
            labels={ai.perDay.map((x) => shortDay(x.day))}
            tips={ai.perDay.map((x) => longDay(x.day))}
            series={series}
            formatY={(n) => compact(n)}
            height={CHART}
          />
          {ai.features.length > 0 && <Bars label={t("Nach Funktion", "By feature")} rows={ai.features.slice(0, 3).map((f) => ({ name: featureName(f.feature, t), value: f.tokens, text: compact(f.tokens) }))} />}
        </>
      ),
    });
  }

  // Storage: the total per day where the statistics kept it, the largest workspaces.
  const s = g.storage;
  const trend = s.trend.map((x) => x.bytes);
  if (s.total > 0)
    panels.push({
      id: "storage",
      section: "storage",
      Icon: Database,
      title: t("Speicher", "Storage"),
      value: bytes(s.total),
      unit: t("Datenbank und Dateien", "database and files"),
      line:
        s.weekDelta !== null
          ? t(`${s.weekDelta >= 0 ? "+" : "−"}${bytes(Math.abs(s.weekDelta))} in 7 Tagen`, `${s.weekDelta >= 0 ? "+" : "−"}${bytes(Math.abs(s.weekDelta))} in 7 days`)
          : t(`Datenbank ${bytes(s.databaseBytes)} · Dateien ${bytes(s.uploadBytes)}`, `Database ${bytes(s.databaseBytes)} · files ${bytes(s.uploadBytes)}`),
      body: (
        <>
          {known(trend) >= 2 && (
            <LineChart
              title={t("Speicher je Tag", "Storage per day")}
              description={t("Datenbank und Dateien zusammen, je Tag, 30 Tage.", "Database and files together, per day, 30 days.")}
              x={s.trend.map((x) => dayAt(x.day))}
              series={[{ key: "bytes", label: t("Speicher", "Storage"), values: trend, color: 3 }]}
              formatX={shortAt}
              formatTip={longAt}
              formatY={bytes}
              height={CHART}
            />
          )}
          {s.workspaces.some((w) => w.bytes > 0) && <Bars label={t("Größte Arbeitsbereiche", "Largest workspaces")} rows={s.workspaces.filter((w) => w.bytes > 0).map((w) => ({ name: w.name || "–", value: w.bytes, text: bytes(w.bytes) }))} />}
        </>
      ),
    });

  if (on) {
    const rp = d.requests.points;
    const rate = (n: number | null, of: number | null) => (n === null || of === null ? null : of ? n / of : 0);
    panels.push({
      id: "errors",
      section: "monitoring",
      anchor: "errors",
      Icon: WarningCircle,
      title: t("Fehler und langsame Endpunkte", "Errors and slow endpoints"),
      value: percent(k.errorRate),
      unit: t("Fehlerquote (1 Std.)", "Error rate (1 h)"),
      line: k.errorsHour === 1 ? t("1 Fehler in der letzten Stunde", "1 error in the last hour") : t(`${num(k.errorsHour)} Fehler in der letzten Stunde`, `${num(k.errorsHour)} errors in the last hour`),
      body: (
        <>
          <Legend
            items={[
              { label: t("Serverfehler (5xx)", "Server errors (5xx)"), color: 1, line: true },
              { label: t("Abgewiesen (4xx)", "Refused (4xx)"), color: 4, line: true },
            ]}
          />
          <LineChart
            title={t("Fehlerquote", "Error rate")}
            description={t("Anteil der Antworten mit Status 500–599 und 400–499 je 5 Minuten, 24 Stunden.", "Share of answers with status 500–599 and 400–499 per 5 minutes, 24 hours.")}
            x={rp.map((x) => x.at)}
            series={[
              { key: "5xx", label: "5xx", values: rp.map((x) => rate(x.errors, x.requests)), color: 1 },
              { key: "4xx", label: "4xx", values: rp.map((x) => rate(x.clientErrors, x.requests)), color: 4 },
            ]}
            area={false}
            formatX={clock}
            formatTip={dateTime}
            formatY={percent}
            height={CHART - 8}
          />
          {d.slowRoutes.length > 0 && (
            <>
              <h4 className="sv-glance-sub">{t("Langsamste Endpunkte (p95, 24 Std.)", "Slowest endpoints (p95, 24 h)")}</h4>
              <ol className="sv-glance-routes">
                {d.slowRoutes.slice(0, 3).map((r) => (
                  <li key={r.route}>
                    <code>{r.route}</code>
                    <span>{ms(r.p95)}</span>
                  </li>
                ))}
              </ol>
            </>
          )}
        </>
      ),
    });
  }

  // The server's disk (CPU and RAM are in the chart on top).
  const disk = p.map((x) => x.disk);
  panels.push({
    id: "server",
    section: "monitoring",
    anchor: "server",
    Icon: Cpu,
    title: t("Server: Speicherplatz", "Server: disk"),
    value: lastPct(disk),
    unit: t("des Speicherplatzes belegt", "of the disk used"),
    line: g.storage.disk ? t(`${bytes(g.storage.disk.free)} frei von ${bytes(g.storage.disk.total)}`, `${bytes(g.storage.disk.free)} free of ${bytes(g.storage.disk.total)}`) : undefined,
    body:
      known(disk) >= 2 ? (
        <LineChart
          title={t("Server: Speicherplatz", "Server: disk")}
          description={t("Belegter Anteil des Datenträgers, je 5 Minuten, 24 Stunden.", "Used share of the disk, per 5 minutes, 24 hours.")}
          x={p.map((x) => x.at)}
          series={[{ key: "disk", label: t("Speicherplatz", "Disk"), values: disk, color: 3 }]}
          area={false}
          maxY={1}
          formatX={clock}
          formatTip={dateTime}
          formatY={percent}
          height={CHART}
        />
      ) : null,
  });

  // Accounts: new ones per day (the accounts that still exist).
  const a = g.accounts;
  const created = a.perDay.reduce((sum, x) => sum + x.created, 0);
  panels.push({
    id: "accounts",
    section: "users",
    Icon: UserPlus,
    title: t("Neue Konten", "New accounts"),
    value: num(created),
    unit: t("in 30 Tagen", "in 30 days"),
    line: [t(`${num(a.total)} Konten`, `${num(a.total)} accounts`), a.disabled ? t(`${num(a.disabled)} gesperrt`, `${num(a.disabled)} disabled`) : "", a.sessions === 1 ? t("1 aktive Sitzung", "1 active session") : t(`${num(a.sessions)} aktive Sitzungen`, `${num(a.sessions)} active sessions`)]
      .filter(Boolean)
      .join(" · "),
    body: (
      <BarChart
        title={t("Neue Konten je Tag", "New accounts per day")}
        description={t("Konten, die an diesem Tag angelegt wurden und noch bestehen, 30 Tage.", "Accounts created on that day that still exist, 30 days.")}
        labels={a.perDay.map((x) => shortDay(x.day))}
        tips={a.perDay.map((x) => longDay(x.day))}
        series={[{ key: "created", label: t("Neue Konten", "New accounts"), values: a.perDay.map((x) => x.created), color: 0 }]}
        formatY={(n) => num(n)}
        height={CHART}
      />
    ),
  });

  // Sign-ins per hour: failed ones always, successful ones with the statistics.
  const si = g.signins;
  panels.push({
    id: "signins",
    section: "monitoring",
    anchor: "signins",
    Icon: ShieldCheck,
    title: t("Anmeldungen", "Sign-ins"),
    value: num(si.ok ?? si.failed),
    unit: si.ok === null ? t("fehlgeschlagen in 24 Std.", "failed in 24 h") : t("in 24 Std.", "in 24 h"),
    line: si.ok === null ? t("Erfolgreiche Anmeldungen nur mit eingeschalteter Statistik.", "Successful sign-ins only with statistics on.") : si.failed === 1 ? t("1 fehlgeschlagen", "1 failed") : t(`${num(si.failed)} fehlgeschlagen`, `${num(si.failed)} failed`),
    body: (
      <>
        {si.ok !== null && (
          <Legend
            items={[
              { label: t("Erfolgreich", "Successful"), color: 0 },
              { label: t("Fehlgeschlagen", "Failed"), color: 4 },
            ]}
          />
        )}
        <BarChart
          title={t("Anmeldungen je Stunde", "Sign-ins per hour")}
          description={t("Erfolgreiche und fehlgeschlagene Anmeldungen je Stunde, 24 Stunden.", "Successful and failed sign-ins per hour, 24 hours.")}
          labels={si.points.map((x) => clock(x.at))}
          tips={si.points.map((x) => dateTime(x.at))}
          series={[
            ...(si.ok !== null ? [{ key: "ok", label: t("Erfolgreich", "Successful"), values: si.points.map((x) => x.ok), color: 0 }] : []),
            { key: "failed", label: t("Fehlgeschlagen", "Failed"), values: si.points.map((x) => x.failed), color: 4 },
          ]}
          formatY={(n) => num(n)}
          height={CHART}
        />
      </>
    ),
  });

  // Backups: only when the scheduled backup is on or has run.
  const b = g.backups;
  const lastRun = b.runs[b.runs.length - 1];
  if (b.enabled || lastRun) {
    const failed = b.runs.filter((r) => r.failed).length;
    panels.push({
      id: "backups",
      section: "storage",
      anchor: "backup",
      Icon: ClockCounterClockwise,
      title: t("Sicherungen", "Backups"),
      value: lastRun ? when(lastRun.at) : t("Noch keine", "None yet"),
      unit: lastRun ? (lastRun.failed ? t("letzte Sicherung fehlgeschlagen", "last backup failed") : t("letzte Sicherung", "last backup")) : t("Sicherung", "backup"),
      line: [
        !b.enabled ? t("Geplante Sicherung aus", "Scheduled backup off") : b.hourly ? t("stündlich", "hourly") : t("täglich", "daily"),
        b.target === "s3" ? "S3" : t("lokal", "local"),
        lastRun && !lastRun.failed ? bytes(lastRun.bytes) : "",
        failed ? (failed === 1 ? t("1 Lauf fehlgeschlagen", "1 run failed") : t(`${num(failed)} Läufe fehlgeschlagen`, `${num(failed)} runs failed`)) : "",
      ]
        .filter(Boolean)
        .join(" · "),
      alert: !!lastRun?.failed,
      body:
        b.runs.length >= 2 ? (
          <BarChart
            title={t("Größe der Sicherungen", "Size of the backups")}
            description={t(`Die letzten ${b.runs.length} Läufe; ein fehlgeschlagener Lauf hat keine Größe.`, `The last ${b.runs.length} runs; a failed run has no size.`)}
            labels={b.runs.map((r) => shortAt(r.at))}
            tips={b.runs.map((r) => (r.failed ? t(`${dateTime(r.at)} – fehlgeschlagen`, `${dateTime(r.at)} – failed`) : dateTime(r.at)))}
            series={[{ key: "bytes", label: t("Größe", "Size"), values: b.runs.map((r) => (r.failed ? null : r.bytes)), color: 2 }]}
            formatY={bytes}
            total={false}
            height={CHART}
          />
        ) : null,
    });
  }

  // Background work: deliveries per day, what waits and the services.
  const bg = g.background;
  const q = bg.queues;
  const waiting = q.search + (q.mail ?? 0) + q.push + q.aiFields + q.aiIndex + (q.s3 ?? 0) + q.webhooksRetrying;
  const delivered = bg.deliveries.days.reduce((sum, x) => sum + x.webhooks + x.push + x.mail, 0);
  const dseries = [
    { key: "webhooks", label: "Webhooks", values: bg.deliveries.days.map((x) => x.webhooks), color: 0 },
    { key: "push", label: "Push", values: bg.deliveries.days.map((x) => x.push), color: 1 },
    { key: "mail", label: t("E-Mail", "Email"), values: bg.deliveries.days.map((x) => x.mail), color: 2 },
  ];
  panels.push({
    id: "background",
    section: "monitoring",
    anchor: "queues",
    Icon: Stack,
    title: t("Hintergrund & Zustellungen", "Background & deliveries"),
    value: num(waiting),
    unit: t("warten auf Bearbeitung", "waiting to be processed"),
    line: [
      t(`${num(delivered)} zugestellt in 7 Tagen`, `${num(delivered)} delivered in 7 days`),
      bg.deliveries.failed ? t(`${num(bg.deliveries.failed)} aufgegeben`, `${num(bg.deliveries.failed)} given up`) : "",
      bg.workers.failing.length
        ? bg.workers.failing.length === 1
          ? t("1 Hintergrunddienst mit Fehler", "1 background service failing")
          : t(`${bg.workers.failing.length} Hintergrunddienste mit Fehler`, `${bg.workers.failing.length} background services failing`)
        : t(`${num(bg.workers.active)} Hintergrunddienste ohne Fehler`, `${num(bg.workers.active)} background services without errors`),
    ]
      .filter(Boolean)
      .join(" · "),
    alert: bg.workers.failing.length > 0,
    body:
      delivered > 0 ? (
        <>
          <Legend items={dseries.map((x) => ({ label: x.label, color: x.color }))} />
          <BarChart
            title={t("Zustellungen je Tag", "Deliveries per day")}
            description={t("Erfolgreich zugestellte Webhooks, Push-Nachrichten und E-Mails je Tag, 7 Tage.", "Successfully delivered webhooks, push messages and emails per day, 7 days.")}
            labels={bg.deliveries.days.map((x) => shortDay(x.day))}
            tips={bg.deliveries.days.map((x) => longDay(x.day))}
            series={dseries}
            formatY={(n) => compact(n)}
            height={CHART}
          />
        </>
      ) : null,
  });
  return panels;
}

const storedExpanded = () => {
  try {
    return localStorage.getItem(EXPANDED_KEY) === "1";
  } catch {
    return false;
  }
};

export function InstanceLive({ problems, notices: tileNotices, version, uptimeSeconds, loaded }: { problems: StripItem[]; notices: StripItem[]; version?: string; uptimeSeconds?: number; loaded: boolean }) {
  const t = useT();
  const live = useLive<MonitoringStart>("/api/admin/monitoring?view=live&range=24h");
  const [expanded, setExpanded] = useState(false);
  useEffect(() => setExpanded(storedExpanded()), []);
  const toggle = () => {
    const next = !expanded;
    setExpanded(next);
    try {
      localStorage.setItem(EXPANDED_KEY, next ? "1" : "0");
    } catch {}
  };
  // Recommendations from the measurements count as notices (lib/recommendations.ts).
  const notices: StripItem[] = [
    ...tileNotices,
    ...(live.data?.recommendations ?? []).map((r) => ({ id: `rec-${r.id}`, title: t(r.title[0], r.title[1]), href: settingsHash({ area: "admin", section: "monitoring", anchor: "recommendations" }) })),
  ];
  const tone = problems.length ? "error" : notices.length ? "warn" : "ok";
  const StateIcon = tone === "error" ? XCircle : tone === "warn" ? WarningCircle : CheckCircle;
  const headline = !loaded
    ? t("Zustand wird geladen …", "Loading state …")
    : problems.length || notices.length
      ? [
          problems.length === 1 ? t("1 Störung", "1 problem") : problems.length ? t(`${problems.length} Störungen`, `${problems.length} problems`) : "",
          notices.length === 1 ? t("1 Hinweis", "1 notice") : notices.length ? t(`${notices.length} Hinweise`, `${notices.length} notices`) : "",
        ]
          .filter(Boolean)
          .join(" · ")
      : t("Alles in Ordnung", "All fine");
  const items = [...problems, ...notices];
  const panels = live.data ? livePanels(live.data, t) : [];
  return (
    <section className="sv-glance" aria-label={t("Zustand der Instanz", "State of the instance")}>
      <div className="sv-glance-state">
        <div className={`live-strip-head ${tone}`}>
          <span className="live-strip-icon" aria-hidden>
            <StateIcon size={20} weight="bold" />
          </span>
          <div>
            <strong role="status">{headline}</strong>
            {items.length ? (
              <ul className="live-strip-items">
                {items.slice(0, 4).map((item) => (
                  <li key={item.id}>
                    <a href={item.href ?? settingsHash({ area: "admin", section: item.id })}>{item.badge ? `${item.title}: ${item.badge}` : item.title}</a>
                  </li>
                ))}
              </ul>
            ) : (
              <small className="muted">
                {[version && `v${version}`, uptimeSeconds !== undefined && t(`läuft seit ${uptime(uptimeSeconds, t)}`, `running for ${uptime(uptimeSeconds, t)}`)].filter(Boolean).join(" · ") || " "}
              </small>
            )}
          </div>
        </div>
        <LiveBadge state={live.state} label={rangeLabel("24h", t)} />
      </div>
      {live.data ? (
        <>
          <div className={`sv-glance-grid${expanded ? " expanded" : ""}`} id="sv-glance-panels">
            {panels.map((panel) => (
              <div key={panel.id} className={`sv-glance-panel${panel.alert ? " alert" : ""}${panel.wide ? " wide" : ""}`} data-panel={panel.id} role="group" aria-labelledby={`sv-glance-${panel.id}`}>
                <h3 id={`sv-glance-${panel.id}`}>
                  <a href={settingsHash({ area: "admin", section: panel.section, anchor: panel.anchor })} onClick={markOpenedFromHome}>
                    <span className="sv-start-icon" aria-hidden>
                      <panel.Icon size={17} />
                    </span>
                    <span className="sv-glance-title">{panel.title}</span>
                    <CaretRight size={14} className="sv-start-caret" aria-hidden />
                  </a>
                </h3>
                {panel.value !== undefined && (
                  <p className="sv-glance-value">
                    <strong>{panel.value}</strong> <span>{panel.unit}</span>
                  </p>
                )}
                {panel.line && <p className="sv-glance-line">{panel.line}</p>}
                {panel.body && <div className="sv-glance-body">{panel.body}</div>}
              </div>
            ))}
          </div>
          {panels.length > PHONE_PANELS && (
            <button type="button" className="button sv-glance-more" aria-expanded={expanded} aria-controls="sv-glance-panels" onClick={toggle}>
              {expanded ? <CaretUp size={15} aria-hidden /> : <CaretDown size={15} aria-hidden />}
              {expanded ? t("Weniger Diagramme", "Fewer charts") : t(`Alle ${panels.length} Diagramme`, `All ${panels.length} charts`)}
            </button>
          )}
        </>
      ) : (
        <div className="sv-glance-grid placeholder" aria-hidden />
      )}
    </section>
  );
}
