"use client";
import { useEffect, useRef } from "react";
import { ArrowRight, CalendarBlank, Notebook } from "@phosphor-icons/react";

export type JournalDay = {
  id: string;
  title: string;
  journal_date: string;
  updated_at: string;
};
// The user's local calendar day; a new journal day starts at local midnight.
export function localDay(date = new Date()) {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}
const utc = (day: string) => new Date(`${day}T00:00:00Z`);
const monthName = new Intl.DateTimeFormat("de-DE", {
  month: "long",
  year: "numeric",
  timeZone: "UTC",
});
const weekday = new Intl.DateTimeFormat("de-DE", {
  weekday: "long",
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

export function JournalView({
  pageId,
  days,
  editable,
  onOpen,
  onRoll,
}: {
  pageId: string;
  days: JournalDay[];
  editable: boolean;
  onOpen: (id: string) => void;
  onRoll: (pageId: string, date: string) => Promise<unknown>;
}) {
  const today = localDay();
  const current = days.find((d) => d.journal_date === today);
  // Opening the journal makes sure today's page exists.
  const rolled = useRef("");
  useEffect(() => {
    if (!editable || current || rolled.current === `${pageId}:${today}`)
      return;
    rolled.current = `${pageId}:${today}`;
    void onRoll(pageId, today);
  }, [editable, current, pageId, today, onRoll]);
  const past = days.filter((d) => d.journal_date !== today);
  const months = new Map<string, JournalDay[]>();
  for (const day of past) {
    const key = day.journal_date.slice(0, 7);
    months.set(key, [...(months.get(key) || []), day]);
  }
  return (
    <div className="journal">
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
              ? "Schreib auf, was ansteht und was passiert ist."
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
      <p className="journal-hint">
        <Notebook size={16} />
        Jeden Tag entsteht hier eine neue Seite. Offene Aufgaben wandern
        automatisch in den nächsten Tag; Tage ohne eigenen Eintrag verschwinden
        wieder.
      </p>
      {past.length ? (
        [...months].map(([key, list]) => (
          <section className="journal-month" key={key}>
            <h2>{monthName.format(utc(`${key}-01`))}</h2>
            <ul>
              {list.map((day) => (
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
                    </span>
                    <span className="journal-day-when">
                      {relative(day.journal_date, today)}
                    </span>
                  </button>
                </li>
              ))}
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
    </div>
  );
}
