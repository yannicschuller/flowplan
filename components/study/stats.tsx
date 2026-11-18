"use client";
// Flashcard statistics (docs/specs/flashcards.md §11.1), of one deck (the
// view "Lernen") or of all decks (#study): today, the streak, ratings per
// study day of the last year as a heatmap, the cards due in the next 30
// days, true retention against the target and the cards by state – the
// person's own numbers only (lib/study-stats.ts). Every chart has its
// table; colours are levels of one token, never meaning on their own.
import { useEffect, useState } from "react";
import { Fire } from "@phosphor-icons/react";
import { useT } from "../i18n";
import { api } from "../ui";
import { BarChart, ChartTable } from "../charts";
import { formatNumber } from "@/lib/field-format";
import { LOCALE_TAG } from "@/lib/locale-tag";
import { studyZoneNow, type StudyModel } from "./focus";

export type StudyStatsData = {
  day: string;
  scope: "deck" | "all";
  decks: number;
  today: { reviews: number; new: number; minutes: number; correct: number | null };
  streak: number;
  studiedDays: number;
  heatmap: { day: string; reviews: number; minutes: number }[];
  forecast: { day: string; due: number }[];
  overdue: number;
  retention: { days: number; reviews: number; rate: number | null }[];
  target: number | null;
  states: { new: number; learning: number; young: number; mature: number; suspended: number };
  // One deck: the FSRS parameters it uses for the person.
  model?: StudyModel | null;
};

const utc = (day: string) => new Date(`${day}T00:00:00Z`);
const shift = (day: string, n: number) => new Date(utc(day).getTime() + n * 86_400_000).toISOString().slice(0, 10);
const percent = (rate: number | null) => (rate === null ? "–" : `${Math.round(rate * 100)} %`);

export function useStudyStats(query: { pageId?: string; workspaceId?: string }, version = 0) {
  const [stats, setStats] = useState<StudyStatsData | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let live = true;
    const params = new URLSearchParams({ zone: studyZoneNow() });
    if (query.pageId) params.set("page", query.pageId);
    if (query.workspaceId) params.set("workspace", query.workspaceId);
    api<StudyStatsData>(`/api/study/stats?${params}`)
      .then((s) => live && setStats(s))
      .catch((e) => live && setError((e as Error).message));
    return () => {
      live = false;
    };
  }, [query.pageId, query.workspaceId, version]);
  return { stats, error };
}

// A year of study days, one column per week (Monday on top), as the
// journal's heatmap; levels by quartiles of the days with ratings.
function Heatmap({ stats }: { stats: StudyStatsData }) {
  const t = useT();
  const byDay = new Map(stats.heatmap.map((d) => [d.day, d]));
  const counts = stats.heatmap.map((d) => d.reviews).filter((n) => n > 0).sort((a, b) => a - b);
  const quantile = (q: number) => counts[Math.min(counts.length - 1, Math.floor(q * counts.length))] ?? 0;
  const steps = [quantile(0.25), quantile(0.5), quantile(0.75)];
  const level = (n: number) => (!n ? 0 : n <= steps[0] ? 1 : n <= steps[1] ? 2 : n <= steps[2] ? 3 : 4);
  const weekday = (utc(stats.day).getUTCDay() + 6) % 7;
  const start = shift(stats.day, -(52 * 7 + weekday));
  const long = new Intl.DateTimeFormat(LOCALE_TAG, { weekday: "short", day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
  const cells = Array.from({ length: 52 * 7 + weekday + 1 }, (_, i) => shift(start, i));
  const months = new Map<string, number>();
  for (const d of stats.heatmap) months.set(d.day.slice(0, 7), (months.get(d.day.slice(0, 7)) || 0) + d.reviews);
  const month = new Intl.DateTimeFormat(LOCALE_TAG, { month: "long", year: "numeric", timeZone: "UTC" });
  return (
    <section className="study-stats-block" aria-labelledby="study-heatmap-title">
      <h4 id="study-heatmap-title">{t("Wertungen pro Tag", "Ratings per day")}</h4>
      <div className="journal-heatmap study-heatmap" role="img" aria-label={t(`Wertungen der letzten 365 Tage, an ${stats.heatmap.length} Tagen gelernt`, `Ratings of the last 365 days, studied on ${stats.heatmap.length} days`)}>
        {cells.map((day) => {
          const d = byDay.get(day);
          return (
            <span
              key={day}
              className={day > stats.day ? "future" : `level-${level(d?.reviews || 0)}`}
              title={`${long.format(utc(day))} · ${t(`${formatNumber(d?.reviews || 0)} Wertungen`, `${formatNumber(d?.reviews || 0)} ratings`)}`}
            />
          );
        })}
      </div>
      <ChartTable
        caption={t("Wertungen pro Monat", "Ratings per month")}
        head={[t("Monat", "Month"), t("Wertungen", "Ratings")]}
        rows={[...months].map(([m, n]) => [month.format(utc(`${m}-01`)), formatNumber(n)])}
      />
    </section>
  );
}

export function StudyStats({ stats }: { stats: StudyStatsData }) {
  const t = useT();
  const short = new Intl.DateTimeFormat(LOCALE_TAG, { day: "numeric", month: "numeric", timeZone: "UTC" });
  const long = new Intl.DateTimeFormat(LOCALE_TAG, { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" });
  const month = stats.retention.find((r) => r.days === 30);
  const total = stats.states.new + stats.states.learning + stats.states.young + stats.states.mature + stats.states.suspended;
  const states: { key: keyof StudyStatsData["states"]; label: string }[] = [
    { key: "new", label: t("Neu", "New") },
    { key: "learning", label: t("In Lernschritten", "In learning steps") },
    { key: "young", label: t("Jung (unter 21 Tagen)", "Young (under 21 days)") },
    { key: "mature", label: t("Reif (ab 21 Tagen)", "Mature (21 days or more)") },
    { key: "suspended", label: t("Ausgesetzt", "Suspended") },
  ];
  return (
    <div className="study-stats">
      <div className="study-stats-tiles">
        <section className="study-stat" aria-label={t("Heute", "Today")}>
          <h4>{t("Heute", "Today")}</h4>
          <strong>{formatNumber(stats.today.reviews)}</strong>
          <span>
            {t(`Wertungen · ${stats.today.new} neu · ${stats.today.minutes} Min`, `ratings · ${stats.today.new} new · ${stats.today.minutes} min`)}
            {stats.today.correct !== null && ` · ${t("richtig", "correct")} ${percent(stats.today.correct)}`}
          </span>
        </section>
        <section className="study-stat" aria-label={t("Serie", "Streak")}>
          <h4>{t("Serie", "Streak")}</h4>
          <strong>
            <Fire aria-hidden weight="fill" className="study-streak-icon" /> {formatNumber(stats.streak)}
          </strong>
          <span>{stats.streak === 1 ? t("Lerntag in Folge", "study day in a row") : t("Lerntage in Folge", "study days in a row")}</span>
        </section>
        <section className="study-stat" aria-label={t("Behaltensrate", "Retention")}>
          <h4>{t("Behaltensrate (30 Tage)", "Retention (30 days)")}</h4>
          <strong>{percent(month?.rate ?? null)}</strong>
          <span>
            {stats.target !== null ? t(`Ziel ${Math.round(stats.target * 100)} %`, `target ${Math.round(stats.target * 100)} %`) : t(`aus ${formatNumber(month?.reviews || 0)} Wiederholungen`, `from ${formatNumber(month?.reviews || 0)} reviews`)}
          </span>
        </section>
        <section className="study-stat" aria-label={t("Karten", "Cards")}>
          <h4>{t("Karten", "Cards")}</h4>
          <strong>{formatNumber(total)}</strong>
          <span>{stats.scope === "all" ? t(`in ${stats.decks} Stapeln`, `in ${stats.decks} decks`) : t(`${formatNumber(stats.states.mature)} reif`, `${formatNumber(stats.states.mature)} mature`)}</span>
        </section>
      </div>
      <Heatmap stats={stats} />
      <section className="study-stats-block" aria-labelledby="study-forecast-title">
        <h4 id="study-forecast-title">{t("Fällig in den nächsten 30 Tagen", "Due in the next 30 days")}</h4>
        <BarChart
          title={t("Fällige Karten pro Tag", "Cards due per day")}
          description={stats.overdue ? t(`Heute mit ${stats.overdue} überfälligen`, `Today including ${stats.overdue} overdue`) : t("Pro Lerntag", "Per study day")}
          labels={stats.forecast.map((f) => short.format(utc(f.day)))}
          tips={stats.forecast.map((f) => long.format(utc(f.day)))}
          series={[{ key: "due", label: t("Fällig", "Due"), values: stats.forecast.map((f) => f.due), color: 0 }]}
          formatY={(n) => formatNumber(n)}
          height={130}
        />
        <ChartTable
          caption={t("Fällige Karten pro Tag", "Cards due per day")}
          head={[t("Tag", "Day"), t("Fällig", "Due")]}
          rows={stats.forecast.map((f) => [long.format(utc(f.day)), formatNumber(f.due)])}
        />
      </section>
      <div className="study-stats-columns">
        <section className="study-stats-block" aria-labelledby="study-retention-title">
          <h4 id="study-retention-title">{t("Wahre Behaltensrate", "True retention")}</h4>
          <table className="study-stats-table">
            <thead>
              <tr>
                <th scope="col">{t("Zeitraum", "Period")}</th>
                <th scope="col">{t("Richtig", "Correct")}</th>
                <th scope="col">{t("Wiederholungen", "Reviews")}</th>
              </tr>
            </thead>
            <tbody>
              {stats.retention.map((r) => (
                <tr key={r.days}>
                  <th scope="row">{t(`${r.days} Tage`, `${r.days} days`)}</th>
                  <td>{percent(r.rate)}</td>
                  <td>{formatNumber(r.reviews)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="muted">{t("Anteil der Wiederholungen, die du nicht mit „Nochmal“ gewertet hast.", "Share of reviews you did not rate “Again”.")}</p>
        </section>
        <section className="study-stats-block" aria-labelledby="study-states-title">
          <h4 id="study-states-title">{t("Karten nach Zustand", "Cards by state")}</h4>
          <ul className="study-states">
            {states.map((s) => (
              <li key={s.key} className={`study-state ${s.key}`}>
                <span>{s.label}</span>
                <meter min={0} max={Math.max(1, total)} value={stats.states[s.key]} aria-hidden />
                <strong>{formatNumber(stats.states[s.key])}</strong>
              </li>
            ))}
          </ul>
        </section>
      </div>
      {stats.model && <ModelLine model={stats.model} />}
    </div>
  );
}
// Which FSRS parameters the deck uses for the person (§23).
function ModelLine({ model }: { model: StudyModel }) {
  const t = useT();
  const day = model.at ? new Intl.DateTimeFormat(LOCALE_TAG, { day: "numeric", month: "long", year: "numeric" }).format(new Date(model.at)) : "";
  const reviews = formatNumber(model.reviews ?? 0);
  return (
    <p className="muted study-stats-model">
      {model.source === "default"
        ? t("Gedächtnismodell: FSRS-6 mit Standardparametern.", "Memory model: FSRS-6 with default parameters.")
        : model.source === "deck"
          ? t(`Gedächtnismodell: FSRS-6 mit deinen Parametern für diesen Stapel, optimiert am ${day} aus ${reviews} Wertungen.`, `Memory model: FSRS-6 with your parameters for this deck, optimised on ${day} from ${reviews} ratings.`)
          : t(`Gedächtnismodell: FSRS-6 mit deinen Parametern für alle Stapel, optimiert am ${day} aus ${reviews} Wertungen.`, `Memory model: FSRS-6 with your parameters for all decks, optimised on ${day} from ${reviews} ratings.`)}
      {model.fit && ` ${t(`RMSE ${formatNumber(model.fit.after.rmse * 100, "", 1)} % statt ${formatNumber(model.fit.before.rmse * 100, "", 1)} %.`, `RMSE ${formatNumber(model.fit.after.rmse * 100, "", 1)} % instead of ${formatNumber(model.fit.before.rmse * 100, "", 1)} %.`)}`}
    </p>
  );
}

// The panel with loading and errors.
export function StudyStatsPanel({ pageId, workspaceId, version }: { pageId?: string; workspaceId?: string; version?: number }) {
  const t = useT();
  const { stats, error } = useStudyStats({ pageId, workspaceId }, version);
  if (error) return <p className="study-error" role="alert">{error}</p>;
  if (!stats) return <p className="muted">{t("Statistik wird geladen …", "Loading statistics …")}</p>;
  if (!stats.studiedDays && !stats.states.learning && !stats.states.young && !stats.states.mature)
    return <p className="muted">{t("Noch keine Statistik: Sobald du Karten wertest, erscheinen hier deine Zahlen. Nur du siehst sie.", "No statistics yet: once you rate cards, your numbers show here. Only you see them.")}</p>;
  return (
    <>
      <StudyStats stats={stats} />
      <p className="muted study-stats-note">{t("Nur du siehst diese Zahlen. Ein Lerntag beginnt um 04:00 Uhr.", "Only you see these numbers. A study day starts at 04:00.")}</p>
    </>
  );
}
