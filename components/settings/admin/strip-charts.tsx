"use client";
// The charts of the landing page's live strip as a carousel: requests per
// minute, active people with the server's load, AI tokens, CPU/RAM/disk and
// errors with the slowest routes. Only charts whose feature is on appear.
// Swipe (touch), ‹ › (wider screens), the arrow keys or the dots below
// switch; the chart last shown is remembered on this device. The data comes
// with the strip's live answer (/api/admin/monitoring?view=live).
import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";
import { CaretLeft, CaretRight, Info } from "@phosphor-icons/react";
import type { MonitoringLive } from "@/lib/admin-monitoring";
import { useT } from "../../i18n";
import { BarChart, Legend, LineChart } from "../../charts";
import { RequestsChart } from "./live";
import { bytes, clock, compact, dateTime, longDay, ms, num, percent, shortDay } from "./monitoring-format";

type T = (de: string, en: string) => string;
export type StripSlide = { id: string; title: string; render: () => ReactNode };

const STORE_KEY = "flowplan-admin-strip-chart";
const stored = () => {
  try {
    return localStorage.getItem(STORE_KEY);
  } catch {
    return null;
  }
};
const remember = (id: string) => {
  try {
    localStorage.setItem(STORE_KEY, id);
  } catch {}
};

export function ChartCarousel({ slides, badge }: { slides: StripSlide[]; badge?: ReactNode }) {
  const t = useT();
  const [chosen, setChosen] = useState<string | null>(null);
  const [direction, setDirection] = useState<"next" | "prev" | null>(null);
  const touch = useRef<{ x: number; y: number; at: number } | null>(null);
  useEffect(() => setChosen(stored()), []);
  const index = Math.max(0, slides.findIndex((s) => s.id === chosen));
  const current = slides[index];
  const go = (to: number, dir: "next" | "prev") => {
    if (slides.length < 2) return;
    const next = slides[(to + slides.length) % slides.length];
    setDirection(dir);
    setChosen(next.id);
    remember(next.id);
  };
  const onKeyDown = (e: KeyboardEvent) => {
    // The chart itself reads values with the arrow keys (it prevents the default).
    if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey) return;
    if (e.key === "ArrowRight") go(index + 1, "next");
    else if (e.key === "ArrowLeft") go(index - 1, "prev");
    else return;
    e.preventDefault();
  };
  const onPointerDown = (e: PointerEvent) => {
    if (e.pointerType === "mouse") return;
    touch.current = { x: e.clientX, y: e.clientY, at: e.timeStamp };
  };
  const onPointerUp = (e: PointerEvent) => {
    const start = touch.current;
    touch.current = null;
    if (!start) return;
    const dx = e.clientX - start.x,
      dy = e.clientY - start.y;
    // A quick horizontal swipe; a slow drag reads the chart's values.
    if (Math.abs(dx) >= 40 && Math.abs(dx) > Math.abs(dy) * 1.5 && e.timeStamp - start.at < 600) go(dx < 0 ? index + 1 : index - 1, dx < 0 ? "next" : "prev");
  };
  if (!current) return null;
  const label = (i: number) => t(`Diagramm ${i + 1} von ${slides.length}: ${slides[i].title}`, `Chart ${i + 1} of ${slides.length}: ${slides[i].title}`);
  return (
    <section className="strip-carousel" aria-roledescription={t("Karussell", "carousel")} aria-label={t("Diagramme", "Charts")} onKeyDown={onKeyDown}>
      <header>
        <h2>{current.title}</h2>
        <div className="strip-carousel-tools">
          {badge}
          {slides.length > 1 && (
            <span className="strip-carousel-nav">
              <button type="button" className="icon-button" aria-label={t("Voriges Diagramm", "Previous chart")} onClick={() => go(index - 1, "prev")}>
                <CaretLeft size={16} weight="bold" aria-hidden />
              </button>
              <button type="button" className="icon-button" aria-label={t("Nächstes Diagramm", "Next chart")} onClick={() => go(index + 1, "next")}>
                <CaretRight size={16} weight="bold" aria-hidden />
              </button>
            </span>
          )}
        </div>
      </header>
      <div
        key={current.id}
        className={`strip-carousel-slide${direction ? ` enter-${direction}` : ""}`}
        role="group"
        aria-roledescription={t("Folie", "slide")}
        aria-label={label(index)}
        onPointerDown={onPointerDown}
        onPointerUp={onPointerUp}
        onPointerCancel={() => (touch.current = null)}
      >
        {current.render()}
      </div>
      {slides.length > 1 && (
        <div className="strip-carousel-dots" role="group" aria-label={t("Diagramm wählen", "Choose chart")}>
          {slides.map((s, i) => (
            <button key={s.id} type="button" aria-label={label(i)} aria-current={i === index ? "true" : undefined} onClick={() => go(i, i < index ? "prev" : "next")}>
              <i aria-hidden />
            </button>
          ))}
        </div>
      )}
      <p className="sr-only" aria-live="polite">
        {direction ? label(index) : ""}
      </p>
    </section>
  );
}

/* ---------- The charts ---------- */

const pct = (n: number) => percent(n);
const last = <T,>(values: (T | null)[]) => {
  for (let i = values.length - 1; i >= 0; i--) if (values[i] !== null && values[i] !== undefined) return values[i];
  return null;
};

function Off({ children }: { children: ReactNode }) {
  return (
    <p className="muted live-strip-off">
      <Info size={16} aria-hidden /> {children}
    </p>
  );
}

// b. Active people with CPU and RAM over them: does the load follow the people?
function PeopleLoad({ live, t }: { live: MonitoringLive; t: T }) {
  const p = live.server.points;
  const people = p.map((x) => x.active);
  const cpu = p.map((x) => x.cpu),
    mem = p.map((x) => x.memory);
  const hasPeople = live.collecting.enabled && people.some((v) => v !== null);
  return (
    <>
      <Legend
        items={[
          ...(hasPeople ? [{ label: t("Aktive Personen", "Active people"), color: 0, value: num(last(people) ?? 0) }] : []),
          { label: "CPU", color: 1, value: last(cpu) === null ? "–" : pct(last(cpu)!), line: true },
          { label: "RAM", color: 2, value: last(mem) === null ? "–" : pct(last(mem)!), line: true },
        ]}
      />
      <LineChart
        title={t("Aktive Personen und Serverlast", "Active people and server load")}
        description={t(
          "Personen der letzten 5 Minuten (links) und CPU und Arbeitsspeicher in % des Limits (rechts), je 5 Minuten, 24 Stunden.",
          "People of the last 5 minutes (left) and CPU and memory in % of the limit (right), per 5 minutes, 24 hours.",
        )}
        x={p.map((x) => x.at)}
        series={hasPeople ? [{ key: "people", label: t("Aktive Personen", "Active people"), values: people, color: 0 }] : []}
        right={{
          series: [
            { key: "cpu", label: "CPU", values: cpu, color: 1 },
            { key: "ram", label: "RAM", values: mem, color: 2 },
          ],
          format: pct,
          max: 1,
        }}
        formatX={clock}
        formatTip={dateTime}
        formatY={(n) => num(n, n < 10 && n % 1 ? 1 : 0)}
        height={150}
      />
      {!live.collecting.enabled && <Off>{t("Aktive Personen nur mit eingeschalteter Statistik (Überwachung → Statistik).", "Active people only with statistics on (Monitoring → Statistics).")}</Off>}
    </>
  );
}

// c. AI tokens per day and the estimated cost.
function AiChart({ ai, t }: { ai: NonNullable<MonitoringLive["ai"]>; t: T }) {
  const series = [
    { key: "in", label: t("Eingabe", "Input"), values: ai.perDay.map((d) => d.tokensIn), color: 0 },
    { key: "out", label: t("Ausgabe", "Output"), values: ai.perDay.map((d) => d.tokensOut), color: 2 },
  ];
  const tokens = ai.total.tokensIn + ai.total.tokensOut;
  const money = (n: number) => n.toLocaleString(undefined, { style: "currency", currency: ai.currency, maximumFractionDigits: n < 10 ? 2 : 0 });
  const failed = ai.total.errors + ai.total.timeouts;
  return (
    <>
      <Legend items={series.map((s) => ({ label: s.label, color: s.color }))} />
      <BarChart
        title={t("KI-Tokens je Tag", "AI tokens per day")}
        description={t("Eingabe- und Ausgabe-Tokens je Tag, 14 Tage.", "Input and output tokens per day, 14 days.")}
        labels={ai.perDay.map((d) => shortDay(d.day))}
        tips={ai.perDay.map((d) => longDay(d.day))}
        series={series}
        formatY={(n) => compact(n)}
        height={140}
      />
      <p className="strip-chart-note">
        {[
          t(`${compact(tokens)} Tokens · ${num(ai.total.requests)} Anfragen`, `${compact(tokens)} tokens · ${num(ai.total.requests)} requests`),
          ai.total.cost !== null ? t(`≈ ${money(ai.total.cost)} (geschätzt)`, `≈ ${money(ai.total.cost)} (estimated)`) : ai.priced ? "" : t("ohne Preise", "no prices"),
          failed ? t(`${num(failed)} fehlgeschlagen`, `${num(failed)} failed`) : "",
          ai.total.p95 !== null ? t(`Antwort p95 ${ms(ai.total.p95)}`, `Answer p95 ${ms(ai.total.p95)}`) : "",
        ]
          .filter(Boolean)
          .join(" · ")}{" "}
        <a href="#settings/instance/ai/ai-statistics">{t("Details", "Details")}</a>
      </p>
    </>
  );
}

// d. CPU, RAM and disk of the server, in % of what there is.
function ServerChart({ live, t }: { live: MonitoringLive; t: T }) {
  const p = live.server.points;
  const series = [
    { key: "cpu", label: "CPU", values: p.map((x) => x.cpu), color: 1 },
    { key: "ram", label: "RAM", values: p.map((x) => x.memory), color: 2 },
    { key: "disk", label: t("Speicherplatz", "Disk"), values: p.map((x) => x.disk), color: 3 },
  ];
  const rss = last(p.map((x) => x.rss));
  return (
    <>
      <Legend items={series.map((s) => ({ label: s.label, color: s.color, value: last(s.values) === null ? "–" : pct(last(s.values)!), line: true }))} />
      <LineChart
        title={t("Server: CPU, RAM, Speicherplatz", "Server: CPU, RAM, disk")}
        description={t("Anteil am Limit des Containers (sonst des Rechners), je 5 Minuten, 24 Stunden.", "Share of the container's limit (else the machine's), per 5 minutes, 24 hours.")}
        x={p.map((x) => x.at)}
        series={series}
        area={false}
        maxY={1}
        formatX={clock}
        formatTip={dateTime}
        formatY={pct}
        height={150}
      />
      <p className="strip-chart-note">
        {rss !== null && t(`Flowplan belegt ${bytes(rss)} Arbeitsspeicher.`, `Flowplan uses ${bytes(rss)} of memory.`)}{" "}
        <a href="#settings/instance/monitoring/server">{t("Was ihn belegt", "What uses it")}</a>
      </p>
    </>
  );
}

// e. Error rates and the slowest routes.
function ErrorsChart({ live, t }: { live: MonitoringLive; t: T }) {
  const p = live.requests.points;
  const rate = (n: number | null, of: number | null) => (n === null || of === null ? null : of ? n / of : 0);
  return (
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
        x={p.map((x) => x.at)}
        series={[
          { key: "5xx", label: "5xx", values: p.map((x) => rate(x.errors, x.requests)), color: 1 },
          { key: "4xx", label: "4xx", values: p.map((x) => rate(x.clientErrors, x.requests)), color: 4 },
        ]}
        area={false}
        formatX={clock}
        formatTip={dateTime}
        formatY={pct}
        height={104}
      />
      <h3 className="strip-chart-sub">{t("Langsamste Endpunkte (p95, 24 Std.)", "Slowest endpoints (p95, 24 h)")}</h3>
      {live.slowRoutes.length ? (
        <ol className="strip-routes">
          {live.slowRoutes.map((r) => (
            <li key={r.route}>
              <code>{r.route}</code>
              <span>{ms(r.p95)}</span>
            </li>
          ))}
        </ol>
      ) : (
        <p className="muted strip-chart-note">{t("Noch keine Anfragen gemessen.", "No requests measured yet.")}</p>
      )}
    </>
  );
}

export function stripSlides(live: MonitoringLive, t: T): StripSlide[] {
  const on = live.collecting.enabled;
  const slides: StripSlide[] = [];
  if (on) slides.push({ id: "requests", title: t("Anfragen pro Minute", "Requests per minute"), render: () => <RequestsChart requests={live.requests} height={170} /> });
  slides.push({ id: "people", title: t("Aktive Personen und Serverlast", "Active people and server load"), render: () => <PeopleLoad live={live} t={t} /> });
  if (live.ai) {
    const ai = live.ai;
    slides.push({ id: "ai", title: t("KI-Nutzung", "AI usage"), render: () => <AiChart ai={ai} t={t} /> });
  }
  slides.push({ id: "server", title: t("Server: CPU, RAM, Speicherplatz", "Server: CPU, RAM, disk"), render: () => <ServerChart live={live} t={t} /> });
  if (on) slides.push({ id: "errors", title: t("Fehler und langsame Endpunkte", "Errors and slow endpoints"), render: () => <ErrorsChart live={live} t={t} /> });
  return slides;
}
