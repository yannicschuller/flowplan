"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowRight,
  CalendarBlank,
  CaretLeft,
  CaretRight,
  ClockCounterClockwise,
  Fire,
  GearSix,
  ListBullets,
  Lock,
  MapPin,
  Notebook,
  SquaresFour,
} from "@phosphor-icons/react";
import {
  JournalReview,
  JournalSettingsDialog,
  moodFaces,
  type JournalSettings,
} from "./journal-parts";

export type JournalDay = {
  id: string;
  title: string;
  journal_date: string;
  updated_at: string;
  values?: Record<string, number | boolean>;
  place?: string;
  image?: string | null;
  words?: number;
  excerpt?: string;
};
// The user's local calendar day; a new journal day starts at local midnight.
export function localDay(date = new Date()) {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}
const utc = (day: string) => new Date(`${day}T00:00:00Z`);
export const shiftDay = (day: string, days: number) => {
  const d = utc(day);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};
const shiftMonths = (day: string, months: number) => {
  const d = utc(day);
  const target = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + months, 1));
  const last = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(d.getUTCDate(), last));
  return target.toISOString().slice(0, 10);
};
const monthName = new Intl.DateTimeFormat("de-DE", {
  month: "long",
  year: "numeric",
  timeZone: "UTC",
});
const weekday = new Intl.DateTimeFormat("de-DE", {
  weekday: "long",
  timeZone: "UTC",
});
const longDate = new Intl.DateTimeFormat("de-DE", {
  day: "numeric",
  month: "long",
  year: "numeric",
  timeZone: "UTC",
});
// The title a day page gets automatically (see lib/journal.ts).
const autoTitle = new Intl.DateTimeFormat("de-DE", {
  weekday: "long",
  day: "numeric",
  month: "long",
  year: "numeric",
  timeZone: "UTC",
});
const shortMonth = new Intl.DateTimeFormat("de-DE", {
  month: "short",
  timeZone: "UTC",
});
function relative(day: string, today: string) {
  const diff = Math.round((utc(today).getTime() - utc(day).getTime()) / 864e5);
  if (diff === 0) return "Heute";
  if (diff === 1) return "Gestern";
  return `vor ${diff} Tagen`;
}
// Days in a row up to today (or yesterday, while today is still open).
export function currentStreak(dates: Set<string>, today: string) {
  let day = dates.has(today) ? today : shiftDay(today, -1);
  let streak = 0;
  while (dates.has(day)) {
    streak++;
    day = shiftDay(day, -1);
  }
  return streak;
}
export function longestStreak(dates: string[]) {
  const sorted = [...new Set(dates)].sort();
  let best = 0;
  let run = 0;
  let previous = "";
  for (const day of sorted) {
    run = previous && shiftDay(previous, 1) === day ? run + 1 : 1;
    best = Math.max(best, run);
    previous = day;
  }
  return best;
}
// Earlier days worth a look today: a month, half a year and whole years ago.
export function onThisDay(days: JournalDay[], today: string) {
  const byDate = new Map(days.map((d) => [d.journal_date, d]));
  const found: { label: string; day: JournalDay }[] = [];
  const add = (label: string, date: string) => {
    const day = byDate.get(date);
    if (day) found.push({ label, day });
  };
  add("Vor einer Woche", shiftDay(today, -7));
  add("Vor einem Monat", shiftMonths(today, -1));
  add("Vor einem halben Jahr", shiftMonths(today, -6));
  for (let years = 1; years <= 20; years++)
    add(years === 1 ? "Vor einem Jahr" : `Vor ${years} Jahren`, shiftMonths(today, -12 * years));
  return found;
}
function level(words: number) {
  if (words <= 0) return 1;
  if (words < 60) return 1;
  if (words < 200) return 2;
  if (words < 500) return 3;
  return 4;
}

export function JournalView({
  pageId,
  days,
  settings,
  editable,
  onOpen,
  onRoll,
  onChanged,
  onError,
}: {
  pageId: string;
  days: JournalDay[];
  settings?: JournalSettings;
  editable: boolean;
  onOpen: (id: string) => void;
  onRoll: (pageId: string, date: string, recreate?: boolean) => Promise<unknown>;
  onChanged: () => Promise<unknown> | void;
  onError: (message: string) => void;
}) {
  const today = localDay();
  const current = days.find((d) => d.journal_date === today);
  // Opening the journal makes sure today's page exists.
  const rolled = useRef("");
  // Today's page was deleted: say so instead of waiting for it.
  const [trashed, setTrashed] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!editable || current || rolled.current === `${pageId}:${today}`)
      return;
    rolled.current = `${pageId}:${today}`;
    void onRoll(pageId, today).then((result) => {
      const r = result as { trashed?: boolean; dayId?: string } | null;
      setTrashed(r?.trashed && r.dayId ? r.dayId : null);
    });
  }, [editable, current, pageId, today, onRoll]);
  const [layout, setLayout] = useState<"list" | "calendar">(() => {
    try {
      return localStorage.getItem("flowplan:journal-layout") === "calendar" ? "calendar" : "list";
    } catch {
      return "list";
    }
  });
  const chooseLayout = (next: "list" | "calendar") => {
    setLayout(next);
    try {
      localStorage.setItem("flowplan:journal-layout", next);
    } catch {}
  };
  const [review, setReview] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const trackers = settings?.trackers || [];
  const mood = trackers.find((t) => t.kind === "mood");
  const past = days.filter((d) => d.journal_date !== today);
  const months = new Map<string, JournalDay[]>();
  for (const day of past) {
    const key = day.journal_date.slice(0, 7);
    months.set(key, [...(months.get(key) || []), day]);
  }
  const dates = useMemo(() => new Set(days.map((d) => d.journal_date)), [days]);
  // Days that count for the streak: something written or tracked.
  const written = useMemo(
    () =>
      days.filter(
        (d) => (d.words || 0) > 0 || Object.keys(d.values || {}).length > 0 || d.image,
      ),
    [days],
  );
  const writtenDates = useMemo(() => new Set(written.map((d) => d.journal_date)), [written]);
  const streak = currentStreak(writtenDates, today);
  const best = longestStreak([...writtenDates]);
  const totalWords = days.reduce((sum, d) => sum + (d.words || 0), 0);
  const memories = onThisDay(past, today);

  return (
    <div className="journal">
      <div className="journal-toolbar">
        <div className="journal-layout" role="group" aria-label="Darstellung">
          <button
            type="button"
            className={layout === "list" ? "active" : ""}
            aria-pressed={layout === "list"}
            onClick={() => chooseLayout("list")}
          >
            <ListBullets size={16} /> Liste
          </button>
          <button
            type="button"
            className={layout === "calendar" ? "active" : ""}
            aria-pressed={layout === "calendar"}
            onClick={() => chooseLayout("calendar")}
          >
            <SquaresFour size={16} /> Kalender
          </button>
        </div>
        <span className="journal-toolbar-gap" />
        <button type="button" className="button" onClick={() => setReview(true)}>
          <ClockCounterClockwise size={16} /> Rückblick
        </button>
        {settings?.locked && (
          <button
            type="button"
            className="icon-button"
            aria-label="Journal jetzt sperren"
            title="Journal jetzt sperren"
            onClick={async () => {
              const { api } = await import("./ui");
              await api("/api/command", { action: "journal.relock", pageId });
              await onChanged();
            }}
          >
            <Lock size={18} />
          </button>
        )}
        {editable && settings && (
          <button
            type="button"
            className="icon-button"
            aria-label="Journal einrichten"
            title="Journal einrichten"
            onClick={() => setSettingsOpen(true)}
          >
            <GearSix size={18} />
          </button>
        )}
      </div>
      <button
        type="button"
        className="journal-today"
        disabled={!current}
        onClick={() => current && onOpen(current.id)}
      >
        <span className="journal-today-date" aria-hidden="true">
          <small>{shortMonth.format(utc(today))}</small>
          <strong>{Number(today.slice(8))}</strong>
        </span>
        <span className="journal-today-text">
          <small>Heute</small>
          <strong>{weekday.format(utc(today))}</strong>
          <span>
            {current
              ? current.excerpt || "Schreib auf, was ansteht und was passiert ist."
              : trashed
                ? "Die Seite für heute liegt im Papierkorb."
                : editable
                  ? "Die Seite für heute wird angelegt …"
                  : "Für heute gibt es noch keinen Eintrag."}
          </span>
        </span>
        {current && (
          <span className="journal-today-open">
            Öffnen <ArrowRight size={16} />
          </span>
        )}
      </button>

      {!current && trashed && editable && (
        <div className="journal-trashed" role="status">
          <span>Du hast die heutige Seite gelöscht.</span>
          <button
            type="button"
            className="button primary compact"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await onRoll(pageId, today, true);
                setTrashed(null);
              } catch (e) {
                onError((e as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            Neu anlegen
          </button>
          <button
            type="button"
            className="button compact"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                const { api } = await import("./ui");
                await api("/api/command", { action: "page.restore", pageId: trashed });
                setTrashed(null);
                await onChanged();
              } catch (e) {
                onError((e as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            Aus dem Papierkorb holen
          </button>
        </div>
      )}
      {days.length > 0 && (
        <section className="journal-stats" aria-label="Schreibstatistik">
          <div className="journal-stat">
            <Fire size={18} weight={streak ? "fill" : "regular"} className={streak ? "hot" : ""} />
            <strong>{streak}</strong>
            <span>{streak === 1 ? "Tag in Folge" : "Tage in Folge"}</span>
          </div>
          <div className="journal-stat">
            <strong>{best}</strong>
            <span>längste Serie</span>
          </div>
          <div className="journal-stat">
            <strong>{written.length}</strong>
            <span>{written.length === 1 ? "Eintrag" : "Einträge"}</span>
          </div>
          <div className="journal-stat">
            <strong>{totalWords.toLocaleString("de-DE")}</strong>
            <span>Wörter</span>
          </div>
          <Heatmap days={days} today={today} onOpen={onOpen} />
        </section>
      )}

      {memories.length > 0 && (
        <section className="journal-memories" aria-label="An diesem Tag">
          <h2>An diesem Tag</h2>
          <div className="journal-memory-list">
            {memories.map(({ label, day }) => (
              <button key={day.id} type="button" className="journal-memory" onClick={() => onOpen(day.id)}>
                {day.image && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={day.image} alt="" loading="lazy" />
                )}
                <span>
                  <small>{label}</small>
                  <strong>{longDate.format(utc(day.journal_date))}</strong>
                  {day.excerpt && <em>{day.excerpt}</em>}
                </span>
              </button>
            ))}
          </div>
        </section>
      )}

      <TrackerTrends days={days} today={today} trackers={trackers} />

      {layout === "calendar" ? (
        <JournalCalendar days={days} today={today} mood={mood?.id} onOpen={onOpen} />
      ) : past.length ? (
        [...months].map(([key, list]) => (
          <section className="journal-month" key={key}>
            <h2>{monthName.format(utc(`${key}-01`))}</h2>
            <ul>
              {list.map((day) => {
                const face = mood && typeof day.values?.[mood.id] === "number"
                  ? moodFaces[(day.values[mood.id] as number) - 1]
                  : null;
                return (
                  <li key={day.id}>
                    <button type="button" onClick={() => onOpen(day.id)}>
                      <span className="journal-day-number">
                        {Number(day.journal_date.slice(8))}
                      </span>
                      <span className="journal-day-name">
                        {weekday.format(utc(day.journal_date))}
                        {day.title !== autoTitle.format(utc(day.journal_date)) && (
                          <small>{day.title}</small>
                        )}
                        {day.excerpt && <span className="journal-day-excerpt">{day.excerpt}</span>}
                        {day.place && (
                          <span className="journal-day-place">
                            <MapPin size={12} /> {day.place}
                          </span>
                        )}
                      </span>
                      {day.image && (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img className="journal-day-thumb" src={day.image} alt="" loading="lazy" />
                      )}
                      <span className="journal-day-when">
                        {face && <span className="journal-day-mood" title="Stimmung">{face}</span>}
                        {relative(day.journal_date, today)}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>
        ))
      ) : (
        <p className="journal-empty">
          <CalendarBlank size={18} />
          Frühere Tage erscheinen hier, sobald du an ihnen etwas eingetragen
          hast.
        </p>
      )}
      <p className="journal-hint">
        <Notebook size={16} />
        Jeden Tag entsteht hier eine neue Seite. Offene Aufgaben wandern
        automatisch in den nächsten Tag; Tage ohne eigenen Eintrag verschwinden
        wieder.
      </p>
      {review && (
        <JournalReview
          pageId={pageId}
          today={today}
          onClose={() => setReview(false)}
          onOpen={(id) => {
            setReview(false);
            onOpen(id);
          }}
          onError={onError}
        />
      )}
      {settingsOpen && settings && (
        <JournalSettingsDialog
          pageId={pageId}
          settings={settings}
          todayId={current?.id}
          onClose={() => setSettingsOpen(false)}
          onChanged={onChanged}
          onError={onError}
        />
      )}
    </div>
  );
}

// A year of days as squares, one column per week (Monday on top).
function Heatmap({
  days,
  today,
  onOpen,
}: {
  days: JournalDay[];
  today: string;
  onOpen: (id: string) => void;
}) {
  const byDate = new Map(days.map((d) => [d.journal_date, d]));
  const weekdayIndex = (utc(today).getUTCDay() + 6) % 7;
  const start = shiftDay(today, -(52 * 7 + weekdayIndex));
  const cells: { date: string; day?: JournalDay }[] = [];
  for (let i = 0; i <= 52 * 7 + weekdayIndex; i++) {
    const date = shiftDay(start, i);
    cells.push({ date, day: byDate.get(date) });
  }
  return (
    <div className="journal-heatmap" aria-label="Einträge im letzten Jahr">
      {cells.map(({ date, day }) =>
        day ? (
          <button
            key={date}
            type="button"
            className={`level-${level(day.words || 0)}`}
            title={`${longDate.format(utc(date))} · ${(day.words || 0).toLocaleString("de-DE")} Wörter`}
            aria-label={`${longDate.format(utc(date))} öffnen`}
            onClick={() => onOpen(day.id)}
          />
        ) : (
          <span key={date} className={date > today ? "future" : ""} title={longDate.format(utc(date))} />
        ),
      )}
    </div>
  );
}

// The last 30 days of every tracker: bars for numbers, dots for yes/no.
function TrackerTrends({
  days,
  today,
  trackers,
}: {
  days: JournalDay[];
  today: string;
  trackers: JournalSettings["trackers"];
}) {
  const byDate = new Map(days.map((d) => [d.journal_date, d]));
  const span = Array.from({ length: 30 }, (_, i) => shiftDay(today, i - 29));
  const shown = trackers
    .map((tracker) => {
      const values = span.map((date) => byDate.get(date)?.values?.[tracker.id]);
      const numbers = values.filter((v): v is number => typeof v === "number");
      const checks = values.filter((v) => v === true).length;
      return { tracker, values, numbers, checks };
    })
    .filter((t) => t.numbers.length || t.checks);
  if (!shown.length) return null;
  return (
    <section className="journal-trends" aria-label="Tracker der letzten 30 Tage">
      <h2>Letzte 30 Tage</h2>
      {shown.map(({ tracker, values, numbers, checks }) => {
        const max =
          tracker.kind === "mood" || tracker.kind === "scale" ? 5 : Math.max(1, ...numbers);
        const average = numbers.length
          ? numbers.reduce((a, b) => a + b, 0) / numbers.length
          : 0;
        return (
          <div className="journal-trend" key={tracker.id}>
            <span className="journal-trend-name">
              {tracker.name}
              <small>
                {tracker.kind === "check"
                  ? `${checks} von 30 Tagen`
                  : tracker.kind === "mood"
                    ? `Ø ${moodFaces[Math.round(average) - 1] || ""} ${average.toLocaleString("de-DE", { maximumFractionDigits: 1 })}`
                    : `Ø ${average.toLocaleString("de-DE", { maximumFractionDigits: 1 })}${tracker.unit ? ` ${tracker.unit}` : ""}`}
              </small>
            </span>
            <span className="journal-trend-bars" aria-hidden="true">
              {values.map((value, i) => (
                <i
                  key={span[i]}
                  title={`${longDate.format(utc(span[i]))}: ${value === undefined ? "–" : value === true ? "ja" : value === false ? "nein" : value}`}
                  className={tracker.kind === "check" ? (value === true ? "yes" : "no") : value === undefined ? "none" : ""}
                  style={
                    tracker.kind === "check" || typeof value !== "number"
                      ? undefined
                      : { height: `${Math.max(8, (value / max) * 100)}%` }
                  }
                />
              ))}
            </span>
          </div>
        );
      })}
    </section>
  );
}

// A month as a calendar with the first photo of each day.
function JournalCalendar({
  days,
  today,
  mood,
  onOpen,
}: {
  days: JournalDay[];
  today: string;
  mood?: string;
  onOpen: (id: string) => void;
}) {
  const [month, setMonth] = useState(today.slice(0, 7));
  const byDate = new Map(days.map((d) => [d.journal_date, d]));
  const first = `${month}-01`;
  const offset = (utc(first).getUTCDay() + 6) % 7;
  const length = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).getUTCDate();
  const cells = [
    ...Array.from({ length: offset }, () => null),
    ...Array.from({ length }, (_, i) => `${month}-${String(i + 1).padStart(2, "0")}`),
  ];
  const move = (n: number) => setMonth(shiftMonths(first, n).slice(0, 7));
  return (
    <section className="journal-calendar" aria-label="Kalender">
      <header>
        <button type="button" className="icon-button" aria-label="Vorheriger Monat" onClick={() => move(-1)}>
          <CaretLeft size={16} />
        </button>
        <h2>{monthName.format(utc(first))}</h2>
        <button type="button" className="icon-button" aria-label="Nächster Monat" onClick={() => move(1)}>
          <CaretRight size={16} />
        </button>
      </header>
      <div className="journal-calendar-grid">
        {["Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"].map((d) => (
          <span key={d} className="journal-calendar-head">{d}</span>
        ))}
        {cells.map((date, i) => {
          if (!date) return <span key={`gap-${i}`} />;
          const day = byDate.get(date);
          const value = day && mood ? day.values?.[mood] : undefined;
          const content = (
            <>
              <b>{Number(date.slice(8))}</b>
              {typeof value === "number" && <em>{moodFaces[value - 1]}</em>}
            </>
          );
          return day ? (
            <button
              key={date}
              type="button"
              className={`has-entry${date === today ? " today" : ""}${day.image ? " has-image" : ""}`}
              style={day.image ? { backgroundImage: `url(${day.image})` } : undefined}
              aria-label={`${longDate.format(utc(date))} öffnen`}
              onClick={() => onOpen(day.id)}
            >
              {content}
            </button>
          ) : (
            <span key={date} className={date === today ? "today" : ""}>
              {content}
            </span>
          );
        })}
      </div>
    </section>
  );
}
