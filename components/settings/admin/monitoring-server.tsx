"use client";
// Administration → Überwachung → Server (#settings/instance/monitoring/server): CPU,
// memory and disk of the Flowplan process over the chosen range, and for
// debugging what uses the most – memory by part (V8 heap, buffers, live
// documents and connections, SQLite's cache), CPU time by area, the routes
// that take the most time – with a sentence that names the biggest part
// ("RAM … – 40 documents are open live with 120 connections").
// Data: lib/server-metrics.ts and lib/metrics.ts routeStats (with the
// dashboard's answer, /api/admin/monitoring).
import type { MonitoringServer } from "@/lib/admin-monitoring";
import type { CpuArea } from "@/lib/server-metrics";
import { useT } from "../../i18n";
import { ChartTable, Legend, LineChart } from "../../charts";
import { ResponsiveTable } from "../../settings-ui";
import { rangeLabel } from "./live";
import { bytes, clock, dateTime, ms, num, percent, weekday } from "./monitoring-format";

type T = (de: string, en: string) => string;
type Area = CpuArea | "other";

export const areaName = (area: Area, t: T) =>
  ({
    api: t("API-Anfragen", "API requests"),
    pages: t("Seitenaufrufe", "Page loads"),
    live: t("Live-Synchronisation", "Live sync"),
    ai: t("KI", "AI"),
    workflows: t("Workflows", "Workflows"),
    search: t("Suchindex", "Search index"),
    jobs: t("Hintergrundaufträge", "Background jobs"),
    other: t("Sonstiges (Next.js, Timer, Speicherbereinigung)", "Other (Next.js, timers, garbage collection)"),
  })[area];

// A bar without a style attribute (strict CSP): an SVG rect of the share.
function Bar({ share }: { share: number }) {
  return (
    // Real pixels with percentage widths: a viewBox stretched with
    // preserveAspectRatio="none" stretched the rounded ends into points.
    <svg className="mon-share" width="100%" height="6" aria-hidden>
      <rect width="100%" height="6" rx="3" className="mon-share-track" />
      <rect width={`${Math.max(1.5, Math.min(100, share * 100))}%`} height="6" rx="3" className="mon-share-fill" />
    </svg>
  );
}
function Shares({ label, items }: { label: string; items: { key: string; label: string; value: string; share: number; note?: string }[] }) {
  return (
    <ul className="mon-shares" aria-label={label}>
      {items.map((i) => (
        <li key={i.key}>
          <span>
            {i.label}
            {i.note && <small>{i.note}</small>}
          </span>
          <strong>{i.value}</strong>
          <Bar share={i.share} />
        </li>
      ))}
    </ul>
  );
}

// The sentence that says where memory and CPU go (the debug use case).
export function serverFinding(s: MonitoringServer, t: T): string[] {
  const m = s.now.memory,
    live = s.now.live;
  const out: string[] = [];
  const share = m.limit ? m.rss / m.limit : 0;
  const parts = [
    { key: "heap", bytes: m.heapUsed },
    { key: "external", bytes: m.external },
    { key: "live", bytes: live.estimatedBytes },
    { key: "rest", bytes: m.rest },
  ].sort((a, b) => b.bytes - a.bytes);
  const top = parts[0];
  const what =
    top.key === "heap"
      ? t(`am meisten belegt der JavaScript-Speicher (V8-Heap, ${bytes(m.heapUsed)})`, `most of it is JavaScript memory (V8 heap, ${bytes(m.heapUsed)})`)
      : top.key === "external"
        ? t(`am meisten belegen Puffer außerhalb des Heaps (${bytes(m.external)}, z. B. Uploads, Bilder, Datenbank-Ergebnisse)`, `most of it is buffers outside the heap (${bytes(m.external)}, e.g. uploads, images, database results)`)
        : top.key === "live"
          ? t(`am meisten belegen Live-Verbindungen (≈ ${bytes(live.estimatedBytes)})`, `most of it is live connections (≈ ${bytes(live.estimatedBytes)})`)
          : t(`am meisten belegen Programmcode und Laufzeit (${bytes(m.rest)})`, `most of it is program code and runtime (${bytes(m.rest)})`);
  out.push(
    t(
      `RAM: ${bytes(m.rss)} von ${bytes(m.limit)} (${percent(share)}) – ${what}.`,
      `RAM: ${bytes(m.rss)} of ${bytes(m.limit)} (${percent(share)}) – ${what}.`,
    ),
  );
  if (live.documents || live.connections)
    out.push(
      t(
        `${num(live.documents)} Dokumente sind live geöffnet, mit ${num(live.connections)} Live-Verbindungen (${num(live.streams)} offene Streams insgesamt, ≈ ${bytes(live.estimatedBytes)}).`,
        `${num(live.documents)} documents are open live, with ${num(live.connections)} live connections (${num(live.streams)} open streams in total, ≈ ${bytes(live.estimatedBytes)}).`,
      ),
    );
  const total = Object.values(s.areas).reduce((a, b) => a + b, 0);
  const busiest = (Object.entries(s.areas) as [Area, number][]).filter(([k]) => k !== "other").sort((a, b) => b[1] - a[1])[0];
  out.push(
    busiest && total && busiest[1]
      ? t(
          `CPU: ${num(s.now.cpu.cores, 2)} von ${num(s.now.cpu.limit, 1)} Kernen in der letzten Minute – die meiste Rechenzeit ging an ${areaName(busiest[0], t)} (${percent(busiest[1] / total)}).`,
          `CPU: ${num(s.now.cpu.cores, 2)} of ${num(s.now.cpu.limit, 1)} cores in the last minute – most CPU time went to ${areaName(busiest[0], t)} (${percent(busiest[1] / total)}).`,
        )
      : t(`CPU: ${num(s.now.cpu.cores, 2)} von ${num(s.now.cpu.limit, 1)} Kernen in der letzten Minute.`, `CPU: ${num(s.now.cpu.cores, 2)} of ${num(s.now.cpu.limit, 1)} cores in the last minute.`),
  );
  return out;
}

export function ServerCard({ s, range }: { s: MonitoringServer; range: "1h" | "24h" | "7d" }) {
  const t = useT();
  const p = s.series.points;
  const m = s.now.memory;
  const long = range === "7d";
  const series = [
    { key: "cpu", label: "CPU", values: p.map((x) => x.cpu), color: 1 },
    { key: "ram", label: "RAM", values: p.map((x) => x.memory), color: 2 },
    { key: "disk", label: t("Speicherplatz", "Disk"), values: p.map((x) => x.disk), color: 3 },
  ];
  const limits = [
    t(`${num(s.now.cpu.limit, 1)} Kerne`, `${num(s.now.cpu.limit, 1)} cores`) + (s.now.cpu.limited ? t(" (Container-Limit)", " (container limit)") : t(" (Rechner)", " (machine)")),
    `${bytes(m.limit)}` + (m.limited ? t(" RAM (Container-Limit)", " RAM (container limit)") : t(" RAM (Rechner)", " RAM (machine)")),
  ].join(" · ");
  const memParts = [
    { key: "heap", label: t("V8-Heap (belegt)", "V8 heap (used)"), bytes: m.heapUsed, note: t(`von ${bytes(m.heapTotal)} reserviert`, `of ${bytes(m.heapTotal)} reserved`) },
    { key: "external", label: t("Puffer außerhalb des Heaps", "Buffers outside the heap"), bytes: m.external, note: t(`davon ArrayBuffer ${bytes(m.arrayBuffers)}`, `of which ArrayBuffers ${bytes(m.arrayBuffers)}`) },
    {
      key: "live",
      label: t("Live-Verbindungen (geschätzt)", "Live connections (estimated)"),
      bytes: s.now.live.estimatedBytes,
      note: t(`${num(s.now.live.documents)} Dokumente, ${num(s.now.live.connections)} Verbindungen`, `${num(s.now.live.documents)} documents, ${num(s.now.live.connections)} connections`),
    },
    ...(m.sqliteCache !== null ? [{ key: "sqlite", label: t("SQLite-Seitencache (höchstens)", "SQLite page cache (at most)"), bytes: m.sqliteCache, note: t("Teil des Rests", "part of the rest") }] : []),
    { key: "rest", label: t("Programmcode, Laufzeit, Sonstiges", "Program code, runtime, other"), bytes: m.rest, note: undefined },
  ];
  const areaTotal = Object.values(s.areas).reduce((a, b) => a + b, 0) || 1;
  const areas = (Object.entries(s.areas) as [Area, number][]).sort((a, b) => b[1] - a[1]);
  const disk = s.now.disk;
  return (
    <section className="setting-group mon-card" id="server" aria-labelledby="server-title">
      <header>
        <div>
          <h2 id="server-title">{t("Server", "Server")}</h2>
          <p>{t(`CPU, Arbeitsspeicher und Speicherplatz von Flowplan, ${rangeLabel(range, t)} · ${limits}`, `CPU, memory and disk of Flowplan, ${rangeLabel(range, t)} · ${limits}`)}</p>
        </div>
      </header>
      <div className="mon-card-body">
        <div className="mon-finding" role="note">
          {serverFinding(s, t).map((line) => (
            <p key={line}>{line}</p>
          ))}
        </div>
        <Legend items={series.map((x) => ({ label: x.label, color: x.color, line: true }))} />
        <LineChart
          title={t("Server: CPU, RAM, Speicherplatz", "Server: CPU, RAM, disk")}
          description={long ? t("Anteil am Limit, je Stunde.", "Share of the limit, per hour.") : range === "24h" ? t("Anteil am Limit, je 5 Minuten.", "Share of the limit, per 5 minutes.") : t("Anteil am Limit, je Minute.", "Share of the limit, per minute.")}
          x={p.map((x) => x.at)}
          series={series}
          area={false}
          maxY={1}
          formatX={long ? weekday : clock}
          formatTip={dateTime}
          formatY={(n) => percent(n)}
          height={180}
        />
        <div className="mon-server-columns">
          <div>
            <h3 className="mon-subhead">{t("Was den Arbeitsspeicher belegt", "What uses the memory")}</h3>
            <Shares
              label={t("Arbeitsspeicher nach Teil", "Memory by part")}
              items={memParts.map((x) => ({ key: x.key, label: x.label, value: bytes(x.bytes), share: m.rss ? x.bytes / m.rss : 0, note: x.note }))}
            />
            <p className="muted mon-small">
              {t(`Prozess: ${bytes(m.rss)}`, `Process: ${bytes(m.rss)}`)}
              {m.container !== null && t(` · Container insgesamt: ${bytes(m.container)} (mit Dateicache)`, ` · container in total: ${bytes(m.container)} (with file cache)`)}
              {disk.total !== null &&
                t(
                  ` · Speicherplatz: ${bytes(disk.total - (disk.free ?? 0))} von ${bytes(disk.total)} belegt (Datenbank ${disk.database === null ? "–" : bytes(disk.database)}, Uploads ${disk.uploads === null ? "–" : bytes(disk.uploads)})`,
                  ` · disk: ${bytes(disk.total - (disk.free ?? 0))} of ${bytes(disk.total)} used (database ${disk.database === null ? "–" : bytes(disk.database)}, uploads ${disk.uploads === null ? "–" : bytes(disk.uploads)})`,
                )}
            </p>
          </div>
          <div>
            <h3 className="mon-subhead">{t(`Wo die Rechenzeit hingeht (${rangeLabel(range, t)})`, `Where CPU time goes (${rangeLabel(range, t)})`)}</h3>
            <Shares label={t("Rechenzeit nach Bereich", "CPU time by area")} items={areas.map(([k, v]) => ({ key: k, label: areaName(k, t), value: percent(v / areaTotal), share: v / areaTotal }))} />
            <p className="muted mon-small">
              {t(
                "Gemessen beim Start und Ende jeder Anfrage und Aufgabe; was gleichzeitig läuft, teilt sich die Zeit (eine Schätzung unter Last).",
                "Measured when each request and task starts and ends; what runs at the same time shares the time (an estimate under load).",
              )}
            </p>
          </div>
        </div>
        <h3 className="mon-subhead">{t("Endpunkte mit der meisten Zeit", "Endpoints taking the most time")}</h3>
        <div className="mon-table">
          <ResponsiveTable
            label={t("Endpunkte mit der meisten Zeit", "Endpoints taking the most time")}
            rows={s.routes}
            rowKey={(r) => r.route}
            empty={<p className="muted mon-small">{t("Noch keine Anfragen gemessen (die Statistik zählt sie).", "No requests measured yet (the statistics count them).")}</p>}
            columns={[
              { key: "route", header: t("Endpunkt", "Endpoint"), primary: true, render: (r) => <code className="mon-route">{r.route}</code> },
              { key: "n", header: t("Anfragen", "Requests"), align: "end", render: (r) => num(r.requests) },
              { key: "total", header: t("Zeit gesamt", "Total time"), align: "end", render: (r) => ms(r.totalMs) },
              { key: "avg", header: t("Mittel", "Average"), align: "end", hideOnPhone: true, render: (r) => ms(r.avgMs) },
              { key: "p95", header: "p95", align: "end", render: (r) => ms(r.p95) },
              { key: "err", header: "5xx", align: "end", hideOnPhone: true, render: (r) => num(r.errors) },
            ]}
          />
        </div>
        {s.now.instances.length > 1 && (
          <ChartTable
            caption={t("Instanzen", "Instances")}
            head={[t("Instanz", "Instance"), "CPU", "RAM", t("Verbindungen", "Connections")]}
            rows={s.now.instances.map((i) => [
              i.id,
              // Several processes on one host: the limits come with process 1's row.
              i.cpuLimit ? `${num(i.cores, 2)} / ${num(i.cpuLimit, 1)}` : num(i.cores, 2),
              i.memLimit ? `${bytes(i.rss)} / ${bytes(i.memLimit)}` : bytes(i.rss),
              num(i.connections),
            ])}
          />
        )}
        {s.now.processes.length > 0 && (
          <ChartTable
            caption={t("Prozesse", "Processes")}
            head={[t("Prozess", "Process"), "PID", "CPU", "RAM", t("Neustarts", "Restarts")]}
            rows={s.now.processes.map((p) => [
              p.role === "supervisor" ? t("Steuerung", "Supervisor") : p.role === "primary" ? `${p.index} · ${t("Hauptprozess", "Primary process")}` : String(p.index),
              p.pid === null ? "–" : String(p.pid),
              p.cores === null ? "–" : num(p.cores, 2),
              p.rss === null ? "–" : bytes(p.rss),
              p.lastExit && p.restarts ? `${num(p.restarts)} (${p.lastExit})` : num(p.restarts),
            ])}
          />
        )}
      </div>
    </section>
  );
}
