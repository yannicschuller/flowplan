"use client";
import { serverMessage } from "@/lib/i18n-errors";
import { useT } from "./i18n";
import { useState, type CSSProperties } from "react";
import { useRouter } from "next/navigation";

export type PublicCalendarEntry = {
  rowId: string;
  title: string;
  href: string;
  start: string;
  end: string;
  occurrence: boolean;
};
const shift = (date: string, days: number) => {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};
const between = (a: string, b: string) =>
  Math.round(
    (Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000,
  );

// Month grid of a published calendar. Edit links move entries by drag and
// drop or with a date field; times of day and durations are kept.
export function PublicCalendarGrid({
  days,
  month,
  labels,
  weekends,
  entries,
  editable,
  token,
  pageId,
  startField,
  endField,
}: {
  days: string[];
  month: string;
  labels: string[];
  weekends: boolean;
  entries: PublicCalendarEntry[];
  editable: boolean;
  token: string;
  pageId: string;
  startField: string;
  endField?: string;
}) {
  const t = useT();
  const router = useRouter();
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [over, setOver] = useState<string | null>(null),
    [moving, setMoving] = useState<PublicCalendarEntry | null>(null);
  async function move(entry: PublicCalendarEntry, day: string) {
    if (entry.occurrence || day === entry.start) return;
    setBusy(true);
    setError("");
    try {
      const query = new URLSearchParams({ pageId, rowId: entry.rowId });
      const current = await fetch(`/api/share/${token}?${query}`, {
        cache: "no-store",
      });
      const data = await current.json();
      if (!current.ok) throw new Error(serverMessage(data.error));
      const offset = between(entry.start, day);
      const keep = (value: unknown) =>
        typeof value === "string" && /^\d{4}-\d{2}-\d{2}/.test(value)
          ? shift(value.slice(0, 10), offset) + value.slice(10)
          : value;
      const cells: Record<string, unknown> = {
        [startField]: keep(data.cells[startField]),
      };
      if (endField && data.cells[endField])
        cells[endField] = keep(data.cells[endField]);
      const response = await fetch(`/api/share/${token}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "cells",
          pageId,
          rowId: entry.rowId,
          version: data.version,
          cells,
        }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(serverMessage(result.error));
      setMoving(null);
      router.refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <div
        className="public-calendar-grid"
        style={{ "--calendar-weekdays": weekends ? 7 : 5 } as CSSProperties}
      >
        {labels.map((d) => (
          <div key={d} className="public-calendar-weekday">
            {d}
          </div>
        ))}
        {days.map((day) => (
          <div
            key={day}
            className={`public-calendar-day${day.startsWith(month) ? "" : " outside"}${over === day ? " drop" : ""}`}
            data-day={day}
            onDragOver={(e) => {
              if (!editable || busy) return;
              e.preventDefault();
              setOver(day);
            }}
            onDragLeave={() => setOver((d) => (d === day ? null : d))}
            onDrop={(e) => {
              e.preventDefault();
              setOver(null);
              const entry = entries.find(
                (x) =>
                  x.rowId === e.dataTransfer.getData("text/x-flowplan-row") &&
                  !x.occurrence,
              );
              if (entry) void move(entry, day);
            }}
          >
            <span className="public-calendar-date">{Number(day.slice(8))}</span>
            {entries
              .filter((e) => e.start <= day && e.end >= day)
              .map((e) => (
                <span
                  key={`${e.rowId}:${e.start}`}
                  className="public-calendar-item"
                >
                  <a
                    className={`public-calendar-entry${e.occurrence ? " occurrence" : ""}`}
                    href={e.href}
                    draggable={editable && !e.occurrence && !busy}
                    onDragStart={(event) =>
                      event.dataTransfer.setData("text/x-flowplan-row", e.rowId)
                    }
                  >
                    {e.title}
                  </a>
                  {editable && !e.occurrence && day === e.start && (
                    <button
                      type="button"
                      className="public-calendar-move"
                      aria-label={`${e.title} verschieben`}
                      disabled={busy}
                      onClick={() => setMoving(e)}
                    >
                      ⇄
                    </button>
                  )}
                </span>
              ))}
          </div>
        ))}
      </div>
      {moving && (
        <form
          className="public-calendar-dialog"
          role="dialog"
          aria-label={`${moving.title} verschieben`}
          onSubmit={(e) => {
            e.preventDefault();
            const value = new FormData(e.currentTarget).get("day");
            if (typeof value === "string" && value) void move(moving, value);
          }}
        >
          <label>
            {t("Neuer Beginn", "New start")}
            <input
              type="date"
              name="day"
              defaultValue={moving.start}
              required
            />
          </label>
          <button className="button primary" disabled={busy}>
            {t("Verschieben", "Move")}
          </button>
          <button
            type="button"
            className="button"
            onClick={() => setMoving(null)}
          >
            {t("Abbrechen", "Cancel")}
          </button>
        </form>
      )}
      {error && (
        <p role="alert" className="field-error">
          {error}
        </p>
      )}
    </>
  );
}
