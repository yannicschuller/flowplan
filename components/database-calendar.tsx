"use client";
import { LOCALE_TAG } from "@/lib/locale-tag";
import { useT } from "./i18n";
import { Select } from "./select";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from "react";
import {
  CalendarBlank,
  CaretLeft,
  CaretRight,
  DotsSixVertical,
} from "@phosphor-icons/react";
import { Modal } from "./ui";
import { CalendarSubscribe } from "./calendar-subscribe";
import DateInput from "./date-input";
import {
  OCCURRENCE_SEPARATOR,
  occurrenceDates,
  parseRecurrence,
  shiftDateValue,
} from "@/lib/recurrence";
import { cellText } from "@/lib/database";
import {
  calendarDays,
  calendarRange,
  rangeOnDay,
  daySegments,
  type CalendarConfig,
  type CalendarChange,
  type CalendarDay,
  type CalendarSegment,
  isWeekend,
  weekdayLabels,
} from "@/lib/database-calendar";
import {
  Temporal,
  browserZone,
  dateInZone,
  formatDateValue,
  validZone,
} from "@/lib/date-values";
import { scheduleFields, dateDay } from "@/lib/database-timeline";
import type { Field, Row, View } from "@/lib/types";

const PX = 1; // One elapsed minute per pixel; DST days have 23/24/25 real hours.
type Drag = {
  row: Row;
  version: number;
  operation: "move-time" | "resize-time-start" | "resize-time-end";
  x: number;
  y: number;
  width: number;
  day: CalendarDay;
  base: number;
  offset: number;
  at: number;
  dx: number;
  dy: number;
  pointer: number;
  moved: boolean;
};
export default function DatabaseCalendar({
  rows: baseRows,
  fields,
  view,
  version,
  pageId,
  editable,
  viewEditable,
  onOpen,
  onCreate,
  onSchedule,
  onView,
}: {
  rows: Row[];
  fields: Field[];
  view: View;
  version: number;
  pageId: string;
  editable: boolean;
  viewEditable: boolean;
  onOpen: (id: string, occurrence?: string) => void;
  onCreate: (cells: Record<string, unknown>) => Promise<unknown>;
  onSchedule: (input: Record<string, unknown>) => Promise<unknown>;
  onView: (patch: Partial<View>) => Promise<unknown>;
}) {
  const t = useT();
  const [local, setLocal] = useState<CalendarConfig>(),
    [anchor, setAnchor] = useState(() =>
      dateInZone(view.calendar?.timeZone || browserZone()),
    ),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [zoneDraft, setZoneDraft] = useState(
      view.calendar?.timeZone || browserZone(),
    ),
    [drag, setDrag] = useState<Drag | null>(null),
    [draft, setDraft] = useState<{
      row: Row;
      version: number;
      start: string;
      end: string;
      zone: string;
    } | null>(null);
  const config = local ||
      view.calendar || { mode: "month", timeZone: browserZone() },
    zone = config.timeZone,
    { start, end, invalidEnd } = scheduleFields(fields, view),
    canEdit = editable && !!start && !invalidEnd,
    weekends = config.showWeekends !== false,
    days = useMemo(
      () =>
        calendarDays(anchor, config.mode, zone, config.weekStart).filter(
          (day) => weekends || config.mode === "day" || !isWeekend(day.date),
        ),
      [anchor, config.mode, zone, config.weekStart, weekends],
    );
  // Repeating entries appear as read-only occurrences within the shown days.
  const rows = useMemo(() => {
    if (!start || !days.length) return baseRows;
    const from = days[0].date,
      to = days[days.length - 1].date;
    return baseRows.flatMap((row) => {
      const rule = parseRecurrence(row.recurrence);
      const first = row.cells[start.id];
      if (!rule || typeof first !== "string" || !first) return [row];
      const last = end ? row.cells[end.id] : undefined;
      const span =
        typeof last === "string" && last
          ? Temporal.PlainDate.from(first.slice(0, 10)).until(
              Temporal.PlainDate.from(last.slice(0, 10)),
            ).days
          : 0;
      return [
        row,
        ...occurrenceDates(
          first,
          rule,
          Temporal.PlainDate.from(from).subtract({ days: span }).toString(),
          to,
        ).map((date) => {
          const shift = Temporal.PlainDate.from(first.slice(0, 10)).until(
            Temporal.PlainDate.from(date),
          ).days;
          return {
            ...row,
            id: `${row.id}${OCCURRENCE_SEPARATOR}${date}`,
            cells: {
              ...row.cells,
              [start.id]: shiftDateValue(first, shift),
              ...(end && typeof last === "string" && last
                ? { [end.id]: shiftDateValue(last, shift) }
                : {}),
            },
          };
        }),
      ];
    });
  }, [baseRows, start, end, days]);
  const occurrence = (id: string) => id.includes(OCCURRENCE_SEPARATOR);
  const openRow = (id: string) => {
    const [rowId, date] = id.split(OCCURRENCE_SEPARATOR);
    onOpen(rowId, date);
  };
  const ranges = useMemo(
    () =>
      new Map(
        rows.map((row) => [row.id, calendarRange(row, fields, view, zone)]),
      ),
    [rows, fields, view, zone],
  );
  // Touch devices move whole-day entries with a handle; the day under the
  // finger is the target (month cells and all-day rows carry data-day).
  const [touchTarget, setTouchTarget] = useState<string | null>(null);
  const touchMove = useRef<{
    row: Row;
    version: number;
    from: string;
    pointer: number;
  } | null>(null);
  const dayAt = (x: number, y: number) =>
    document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-day]")?.dataset
      .day || null;
  const pending = useRef(false),
    dragging = useRef<Drag | null>(null),
    suppressed = useRef(false),
    scroller = useRef<HTMLDivElement>(null);
  const title = (row: Row) =>
    cellText(row.cells[fields[0]?.id]) || t("Ohne Titel", "Untitled");
  useEffect(() => {
    setZoneDraft(zone);
  }, [zone]);
  useEffect(() => {
    if (scroller.current) scroller.current.scrollTop = 8 * 60 * PX;
  }, [config.mode]);
  useEffect(() => {
    const current = dragging.current;
    if (
      current &&
      (!canEdit ||
        version !== current.version ||
        rows.find((r) => r.id === current.row.id)?.version !==
          current.row.version)
    ) {
      dragging.current = null;
      setDrag(null);
      suppressed.current = true;
      setError(
        t("Die Daten wurden während des Ziehens geändert. Bitte erneut versuchen.", "The data changed while dragging. Please try again."),
      );
    }
  }, [rows, version, canEdit]);
  async function configure(next: CalendarConfig) {
    if (pending.current) return;
    if (!validZone(next.timeZone)) {
      setError(
        t("Bitte eine gültige IANA-Zeitzone eingeben, zum Beispiel Europe/Berlin.", "Please enter a valid IANA time zone, for example Europe/Berlin."),
      );
      return;
    }
    setLocal(next);
    setError("");
    if (viewEditable) {
      pending.current = true;
      setBusy(true);
      try {
        await onView({ calendar: next });
      } catch (e) {
        setError((e as Error).message);
      } finally {
        pending.current = false;
        setBusy(false);
        setLocal(undefined);
      }
    }
  }
  async function apply(
    row: Row,
    schemaVersion: number,
    change: CalendarChange,
    close = false,
  ) {
    if (pending.current || !canEdit || occurrence(row.id)) return;
    pending.current = true;
    setBusy(true);
    setError("");
    try {
      await onSchedule({
        action: "row.schedule",
        viewId: view.id,
        version: schemaVersion,
        rowId: row.id,
        rowVersion: row.version,
        change,
      });
      if (close) setDraft(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }
  function edit(row: Row) {
    setError("");
    setDraft({
      row,
      version,
      start: cellText(row.cells[start?.id || ""]),
      end: cellText(row.cells[end?.id || ""]),
      zone,
    });
  }
  function begin(
    event: ReactPointerEvent<HTMLButtonElement>,
    segment: CalendarSegment,
    day: CalendarDay,
    operation: Drag["operation"],
  ) {
    if (
      !canEdit ||
      pending.current ||
      event.button !== 0 ||
      occurrence(segment.row.id)
    )
      return;
    const column = event.currentTarget.closest(".calendar-hours-day")!;
    event.currentTarget.setPointerCapture(event.pointerId);
    suppressed.current = false;
    setError("");
    const base =
      operation === "resize-time-end"
        ? segment.range.endMs
        : operation === "resize-time-start"
          ? segment.range.startMs
          : segment.start;
    const next: Drag = {
      row: segment.row,
      version,
      operation,
      x: event.clientX,
      y: event.clientY,
      width: column.getBoundingClientRect().width,
      day,
      base,
      offset:
        operation === "move-time" ? segment.start - segment.range.startMs : 0,
      at: base,
      dx: 0,
      dy: 0,
      pointer: event.pointerId,
      moved: false,
    };
    dragging.current = next;
    setDrag(next);
  }
  function move(event: ReactPointerEvent<HTMLButtonElement>) {
    const current = dragging.current;
    if (!current || current.pointer !== event.pointerId) return;
    const columnDelta =
        config.mode === "day"
          ? 0
          : Math.round((event.clientX - current.x) / current.width),
      minutes = Math.round((event.clientY - current.y) / PX / 15) * 15;
    // Columns may skip hidden weekends, so move by visible columns.
    const index = days.findIndex((d) => d.date === current.day.date);
    const column =
      index >= 0
        ? days[Math.max(0, Math.min(days.length - 1, index + columnDelta))]
        : undefined;
    const dayDelta = column
      ? Temporal.PlainDate.from(current.day.date).until(
          Temporal.PlainDate.from(column.date),
        ).days
      : columnDelta;
    try {
      const targetDay = calendarDays(
          Temporal.PlainDate.from(current.day.date)
            .add({ days: dayDelta })
            .toString(),
          "day",
          zone,
        )[0],
        at =
          targetDay.start +
          (current.base - current.day.start) +
          minutes * 60000,
        moved = dayDelta !== 0 || minutes !== 0;
      const next = {
        ...current,
        at,
        moved,
        dx: dayDelta * current.width,
        dy: minutes * PX,
      };
      dragging.current = next;
      setDrag(next);
      if (moved) suppressed.current = true;
    } catch {
      cancel();
    }
  }
  function finish(event: ReactPointerEvent<HTMLButtonElement>) {
    const current = dragging.current;
    if (!current || current.pointer !== event.pointerId) return;
    dragging.current = null;
    setDrag(null);
    if (current.moved)
      void apply(current.row, current.version, {
        operation: current.operation,
        at: Temporal.Instant.fromEpochMilliseconds(
          current.at - current.offset,
        ).toString(),
        timeZone: zone,
      });
  }
  function cancel() {
    dragging.current = null;
    setDrag(null);
    suppressed.current = true;
  }
  const handlers = {
    onPointerMove: move,
    onPointerUp: finish,
    onPointerCancel: cancel,
    onLostPointerCapture: () => {
      if (dragging.current) cancel();
    },
  };
  function shift(row: Row, operation: Drag["operation"], minutes: number) {
    const range = ranges.get(row.id);
    if (range?.timed)
      void apply(row, version, {
        operation,
        at: Temporal.Instant.fromEpochMilliseconds(
          (operation === "resize-time-end" ? range.endMs : range.startMs) +
            minutes * 60000,
        ).toString(),
        timeZone: zone,
      });
  }
  function drop(event: React.DragEvent, day: CalendarDay) {
    event.preventDefault();
    if (!canEdit || busy) return;
    try {
      const moved = JSON.parse(
          event.dataTransfer.getData("application/x-flowplan-calendar"),
        ),
        row = rows.find((r) => r.id === moved.rowId);
      if (
        moved.pageId !== pageId ||
        moved.viewId !== view.id ||
        dateDay(moved.day) === null ||
        !row
      )
        return;
      void apply({ ...row, version: moved.rowVersion }, moved.version, {
        operation: "move-calendar",
        days: dateDay(day.date)! - dateDay(moved.day)!,
        timeZone: zone,
      });
    } catch {
      /* Ignore unrelated drag payloads. */
    }
  }
  function eventChip(row: Row, day: CalendarDay) {
    const range = ranges.get(row.id);
    return (
      <div
        className={`calendar-chip ${occurrence(row.id) ? "occurrence" : ""}`}
        key={row.id}
      >
        <button
          className="calendar-event"
          draggable={canEdit && !busy && !occurrence(row.id)}
          title={
            range
              ? `${formatDateValue(range.start, zone)} – ${formatDateValue(range.end, zone)}`
              : title(row)
          }
          onDragStart={(e) =>
            e.dataTransfer.setData(
              "application/x-flowplan-calendar",
              JSON.stringify({
                pageId,
                viewId: view.id,
                version,
                rowId: row.id,
                rowVersion: row.version,
                day: day.date,
              }),
            )
          }
          onClick={() => openRow(row.id)}
        >
          {range?.timed && (
            <span>
              {Temporal.Instant.from(range.start)
                .toZonedDateTimeISO(zone)
                .toPlainTime()
                .toString({ smallestUnit: "minute" })}{" "}
            </span>
          )}
          {parseRecurrence(row.recurrence) && (
            <span aria-label={t("Wiederholung", "Recurrence")} title={t("Wiederkehrender Eintrag", "Recurring record")}>
              ↻{" "}
            </span>
          )}
          {title(row)}
        </button>
        {canEdit && !occurrence(row.id) && (
          <button
            className="calendar-drag"
            aria-label={`${title(row)} verschieben`}
            disabled={busy}
            onPointerDown={(e) => {
              e.preventDefault();
              e.currentTarget.setPointerCapture(e.pointerId);
              touchMove.current = {
                row,
                version,
                from: day.date,
                pointer: e.pointerId,
              };
            }}
            onPointerMove={(e) => {
              if (touchMove.current?.pointer !== e.pointerId) return;
              setTouchTarget(dayAt(e.clientX, e.clientY));
            }}
            onPointerUp={(e) => {
              const moving = touchMove.current;
              touchMove.current = null;
              setTouchTarget(null);
              if (moving?.pointer !== e.pointerId) return;
              const target = dayAt(e.clientX, e.clientY);
              if (!target || target === moving.from) return;
              void apply(moving.row, moving.version, {
                operation: "move-calendar",
                days: dateDay(target)! - dateDay(moving.from)!,
                timeZone: zone,
              });
            }}
            onPointerCancel={() => {
              touchMove.current = null;
              setTouchTarget(null);
            }}
          >
            <DotsSixVertical size={13} />
          </button>
        )}
        {canEdit && !occurrence(row.id) && (
          <button
            className="calendar-edit"
            aria-label={t(`Termin für ${title(row)} bearbeiten`, `Edit date of ${title(row)}`)}
            disabled={busy}
            onClick={() => edit(row)}
          >
            <CalendarBlank size={14} />
          </button>
        )}
      </div>
    );
  }
  function navigate(delta: number) {
    const date = Temporal.PlainDate.from(anchor).add(
      config.mode === "month"
        ? { months: delta }
        : { days: delta * (config.mode === "week" ? 7 : 1) },
    );
    if (date.year >= 1 && date.year <= 9999) setAnchor(date.toString());
  }
  return (
    <section className="calendar-view" aria-label={t("Kalender", "Calendar")}>
      <div className="calendar-controls">
        <h3>
          {Temporal.PlainDate.from(anchor).toLocaleString(LOCALE_TAG, {
            month: "long",
            year: "numeric",
          })}
        </h3>
        <Select
          aria-label={t("Kalender: Ansicht", "Calendar: view")}
          disabled={busy}
          value={config.mode}
          onChange={(e) =>
            void configure({
              ...config,
              mode: e.target.value as CalendarConfig["mode"],
            })
          }
        >
          <option value="month">{t("Monat", "Month")}</option>
          <option value="week">{t("Woche", "Week")}</option>
          <option value="day">{t("Tag", "Day")}</option>
        </Select>
        <Select
          aria-label={t("Kalender: Wochenbeginn", "Calendar: week start")}
          disabled={busy}
          value={config.weekStart || "monday"}
          onChange={(e) =>
            void configure({
              ...config,
              weekStart: e.target.value as CalendarConfig["weekStart"],
            })
          }
        >
          <option value="monday">{t("Woche ab Montag", "Week from Monday")}</option>
          <option value="sunday">{t("Woche ab Sonntag", "Week from Sunday")}</option>
        </Select>
        <label className="checkbox-label">
          <input
            type="checkbox"
            aria-label={t("Kalender: Wochenenden anzeigen", "Calendar: show weekends")}
            disabled={busy}
            checked={weekends}
            onChange={(e) =>
              void configure({ ...config, showWeekends: e.target.checked })
            }
          />
          {t("Wochenenden", "Weekends")}
        </label>
        <input
          aria-label={t("Kalender: Datum", "Calendar: date")}
          type="date"
          min="0001-01-01"
          max="9999-12-31"
          value={anchor}
          onChange={(e) => {
            if (
              /^\d{4}-\d{2}-\d{2}$/.test(e.target.value) &&
              dateDay(e.target.value) !== null
            )
              setAnchor(e.target.value);
          }}
        />
        <button
          className="button compact"
          onClick={() => setAnchor(dateInZone(zone))}
        >
          {t("Heute", "Today")}
        </button>
        <button
          className="icon-button"
          aria-label={t("Vorheriger Zeitraum", "Previous period")}
          onClick={() => navigate(-1)}
        >
          <CaretLeft />
        </button>
        <button
          className="icon-button"
          aria-label={t("Nächster Zeitraum", "Next period")}
          onClick={() => navigate(1)}
        >
          <CaretRight />
        </button>
        <CalendarSubscribe pageId={pageId} viewId={view.id} />
      </div>
      <form
        className="calendar-zone"
        onSubmit={(e) => {
          e.preventDefault();
          void configure({ ...config, timeZone: zoneDraft });
        }}
      >
        <label>
          {t("Zeitzone", "Time zone")}{" "}
          <input
            aria-label={t("Kalender: Zeitzone", "Calendar: time zone")}
            value={zoneDraft}
            onChange={(e) => setZoneDraft(e.target.value)}
            disabled={busy}
            list="calendar-timezones"
          />
        </label>
        <datalist id="calendar-timezones">
          {[
            "UTC",
            "Europe/Berlin",
            "Europe/London",
            "America/New_York",
            "America/Los_Angeles",
            "Asia/Tokyo",
            "Australia/Sydney",
          ].map((z) => (
            <option key={z} value={z} />
          ))}
        </datalist>
        <button
          className="button compact"
          disabled={busy || zoneDraft === zone}
        >
          {t("Übernehmen", "Apply")}
        </button>
        {!viewEditable && <small>{t("Ansicht nur für dich", "View only for you")}</small>}
      </form>
      {error && !draft && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {!start || invalidEnd ? (
        <p className="timeline-notice">
          {t("In den Ansichtsoptionen gültige, unterschiedliche Datumsfelder für Beginn und Ende auswählen.", "Choose valid, different date fields for start and end in the view options.")}
        </p>
      ) : (
        <>
          {config.mode === "month" ? (
            <div className="calendar-scroll">
              <div
                className="calendar-grid"
                style={
                  { "--calendar-weekdays": weekends ? 7 : 5 } as CSSProperties
                }
              >
                {weekdayLabels(config).map((d) => (
                  <div className="weekday" key={d}>
                    {d}
                  </div>
                ))}
                {days.map((day) => (
                  <div
                    key={day.date}
                    data-day={day.date}
                    className={`calendar-day ${day.date.slice(0, 7) !== anchor.slice(0, 7) ? "other-month" : ""} ${touchTarget === day.date ? "touch-target" : ""}`}
                    onDragOver={(e) => e.preventDefault()}
                    onDrop={(e) => drop(e, day)}
                  >
                    <button
                      className={day.date === dateInZone(zone) ? "today" : ""}
                      onClick={() =>
                        canEdit && onCreate({ [start.id]: day.date })
                      }
                    >
                      {Number(day.date.slice(-2))}
                    </button>
                    {rows
                      .filter((row) => {
                        const range = ranges.get(row.id);
                        return range && rangeOnDay(range, day);
                      })
                      .map((row) => eventChip(row, day))}
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <>
              <details className="calendar-help">
                <summary>{t("Kalenderhilfe", "Calendar help")}</summary>
                <p className="timeline-help">
                  {t("Ziehen verschiebt Termine in 15-Minuten-Schritten, Randgriffe ändern Beginn und Ende. Alt + ↑/↓ verschiebt per Tastatur, Alt + ←/→ um einen Tag; zusätzlich Umschalt ändert das Ende. Ohne Enddatum wird eine Stunde angezeigt. Zeitumstellungen erscheinen mit ihrer tatsächlichen Tageslänge.", "Dragging moves events in 15-minute steps, the edge handles change start and end. Alt + ↑/↓ moves with the keyboard, Alt + ←/→ by one day; adding Shift changes the end. Without an end date one hour is shown. Clock changes appear with their real day length.")}
                </p>
              </details>
              <div
                className={`calendar-hours-scroll ${config.mode}`}
                ref={scroller}
              >
                <div
                  className="calendar-hours"
                  style={
                    {
                      "--calendar-columns": days.length,
                      "--calendar-minutes": Math.max(
                        ...days.map((d) => d.minutes),
                      ),
                    } as CSSProperties
                  }
                >
                  {days.map((day) => (
                    <div key={day.date} className="calendar-hours-column">
                      <header className="calendar-hours-heading">
                        <strong>
                          {Temporal.PlainDate.from(day.date).toLocaleString(
                            LOCALE_TAG,
                            {
                              weekday: "short",
                              day: "numeric",
                              month: "short",
                            },
                          )}
                        </strong>
                        <span>{day.minutes / 60} {t("Stunden", "Hours")}</span>
                        <div
                          className={`calendar-all-day ${touchTarget === day.date ? "touch-target" : ""}`}
                          data-day={day.date}
                          onDragOver={(e) => e.preventDefault()}
                          onDrop={(e) => drop(e, day)}
                        >
                          <button
                            className="calendar-all-day-label"
                            disabled={!canEdit || busy}
                            onClick={() => onCreate({ [start.id]: day.date })}
                          >
                            {t("Ganztägig", "All day")}{canEdit ? " +" : ""}
                          </button>
                          {rows
                            .filter((r) => {
                              const range = calendarRange(
                                r,
                                fields,
                                view,
                                zone,
                              );
                              return (
                                range && !range.timed && rangeOnDay(range, day)
                              );
                            })
                            .map((r) => eventChip(r, day))}
                        </div>
                      </header>
                      <div
                        className="calendar-hours-day"
                        data-day={day.date}
                        style={{ height: day.minutes * PX }}
                      >
                        {Array.from(
                          { length: Math.ceil(day.minutes / 60) },
                          (_, i) => {
                            const at = Temporal.Instant.fromEpochMilliseconds(
                                day.start + i * 3600000,
                              ),
                              label = at.toZonedDateTimeISO(zone),
                              text = label
                                .toPlainTime()
                                .toString({ smallestUnit: "minute" });
                            return (
                              <button
                                key={i}
                                className="calendar-hour"
                                style={{ top: i * 60 * PX }}
                                aria-label={t(`Termin am ${day.date} um ${text} UTC${label.offset} anlegen`, `Create event on ${day.date} at ${text} UTC${label.offset}`)}
                                disabled={!canEdit || busy}
                                onClick={() =>
                                  onCreate({
                                    [start.id]: at.toString(),
                                    ...(end
                                      ? {
                                          [end.id]: at
                                            .add({ hours: 1 })
                                            .toString(),
                                        }
                                      : {}),
                                  })
                                }
                              >
                                <span>
                                  {text}
                                  {day.minutes !== 1440 && (
                                    <small>{label.offset}</small>
                                  )}
                                </span>
                              </button>
                            );
                          },
                        )}
                        {daySegments(rows, fields, view, zone, day, ranges).map(
                          (segment) => {
                            const actual = rows.find(
                                (r) => r.id === segment.row.id,
                              )!,
                              original = calendarRange(
                                actual,
                                fields,
                                view,
                                zone,
                              )!,
                              name = title(actual),
                              label = `${name}: ${formatDateValue(segment.range.start, zone)} bis ${formatDateValue(segment.range.end, zone)}`,
                              gesture = {
                                ...segment,
                                row: actual,
                                range: original,
                                start: Math.max(original.startMs, day.start),
                                end: Math.min(original.endMs, day.end),
                              },
                              active =
                                drag?.row.id === actual.id &&
                                drag.day.date === day.date
                                  ? drag
                                  : null,
                              shiftY =
                                active?.operation === "resize-time-start"
                                  ? active.dy
                                  : 0,
                              heightDelta =
                                active?.operation === "resize-time-end"
                                  ? active.dy
                                  : -shiftY;
                            return (
                              <div
                                key={actual.id}
                                className={`calendar-time-event ${drag?.row.id === actual.id ? "is-dragging" : ""}`}
                                data-row-id={actual.id}
                                style={{
                                  top:
                                    ((segment.start - day.start) / 60000) * PX +
                                    shiftY,
                                  height: Math.max(
                                    20,
                                    ((segment.end - segment.start) / 60000) *
                                      PX +
                                      heightDelta,
                                  ),
                                  transform:
                                    active?.operation === "move-time"
                                      ? `translate(${active.dx}px, ${active.dy}px)`
                                      : undefined,
                                  left: `calc(40px + (100% - 42px) * ${segment.column / segment.columns})`,
                                  width: `calc((100% - 42px) / ${segment.columns} - 2px)`,
                                }}
                              >
                                <button
                                  className="calendar-time-body"
                                  aria-label={label}
                                  aria-disabled={busy}
                                  title={label}
                                  style={{
                                    touchAction: canEdit ? "none" : "auto",
                                  }}
                                  onPointerDown={(e) =>
                                    begin(e, gesture, day, "move-time")
                                  }
                                  {...handlers}
                                  onClick={(e) => {
                                    if (
                                      !busy &&
                                      (e.detail === 0 || !suppressed.current)
                                    )
                                      openRow(actual.id);
                                    suppressed.current = false;
                                  }}
                                  onKeyDown={(e) => {
                                    if (e.key === "Escape") {
                                      cancel();
                                      return;
                                    }
                                    if (
                                      !canEdit ||
                                      busy ||
                                      !e.altKey ||
                                      ![
                                        "ArrowUp",
                                        "ArrowDown",
                                        "ArrowLeft",
                                        "ArrowRight",
                                      ].includes(e.key)
                                    )
                                      return;
                                    e.preventDefault();
                                    if (
                                      e.key === "ArrowLeft" ||
                                      e.key === "ArrowRight"
                                    )
                                      void apply(actual, version, {
                                        operation: "move-calendar",
                                        days: e.key === "ArrowLeft" ? -1 : 1,
                                        timeZone: zone,
                                      });
                                    else
                                      shift(
                                        actual,
                                        e.shiftKey && end
                                          ? "resize-time-end"
                                          : "move-time",
                                        e.key === "ArrowUp" ? -15 : 15,
                                      );
                                  }}
                                >
                                  <strong>{name}</strong>
                                  <span>
                                    {Temporal.Instant.from(segment.range.start)
                                      .toZonedDateTimeISO(zone)
                                      .toPlainTime()
                                      .toString({ smallestUnit: "minute" })}
                                    –
                                    {Temporal.Instant.from(segment.range.end)
                                      .toZonedDateTimeISO(zone)
                                      .toPlainTime()
                                      .toString({ smallestUnit: "minute" })}
                                  </span>
                                </button>
                                {canEdit && (
                                  <button
                                    className="calendar-edit"
                                    disabled={busy}
                                    aria-label={t(`Termin für ${name} bearbeiten`, `Edit date of ${name}`)}
                                    onClick={() => edit(actual)}
                                  >
                                    <CalendarBlank size={14} />
                                  </button>
                                )}
                                {canEdit &&
                                  end &&
                                  (["start", "end"] as const).map(
                                    (edge) =>
                                      (edge === "start"
                                        ? segment.start ===
                                          segment.range.startMs
                                        : segment.end ===
                                          segment.range.endMs) && (
                                        <button
                                          key={edge}
                                          className={`calendar-time-resize ${edge}`}
                                          aria-label={t(`${edge === "start" ? "Beginn" : "Ende"} von ${name} ziehen`, `Drag ${edge === "start" ? "start" : "end"} of ${name}`)}
                                          aria-disabled={busy}
                                          onPointerDown={(e) =>
                                            begin(
                                              e,
                                              gesture,
                                              day,
                                              edge === "start"
                                                ? "resize-time-start"
                                                : "resize-time-end",
                                            )
                                          }
                                          {...handlers}
                                          onKeyDown={(e) => {
                                            if (e.key === "Escape") cancel();
                                            if (
                                              !busy &&
                                              (e.key === "ArrowUp" ||
                                                e.key === "ArrowDown")
                                            ) {
                                              e.preventDefault();
                                              shift(
                                                actual,
                                                edge === "start"
                                                  ? "resize-time-start"
                                                  : "resize-time-end",
                                                e.key === "ArrowUp" ? -15 : 15,
                                              );
                                            }
                                          }}
                                        />
                                      ),
                                  )}
                              </div>
                            );
                          },
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </>
          )}
          {rows.some((r) => !ranges.get(r.id)) && (
            <div className="undated">
              <strong>{t("Ohne gültigen Zeitraum", "Without a valid period")}</strong>
              {rows
                .filter((r) => !ranges.get(r.id))
                .map((r) => (
                  <div className="calendar-unscheduled" key={r.id}>
                    <button onClick={() => openRow(r.id)}>{title(r)}</button>
                    {canEdit && (
                      <button
                        className="button compact"
                        disabled={busy}
                        onClick={() => edit(r)}
                        aria-label={t(`Termin für ${title(r)} bearbeiten`, `Edit date of ${title(r)}`)}
                      >
                        {t("Termin festlegen", "Set date")}
                      </button>
                    )}
                  </div>
                ))}
            </div>
          )}
        </>
      )}
      <Modal
        open={!!draft}
        onClose={() => !busy && setDraft(null)}
        title={t("Termin bearbeiten", "Edit date")}
      >
        {draft && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void apply(
                draft.row,
                draft.version,
                {
                  operation: "set-range",
                  start: draft.start,
                  end: end ? draft.end : "",
                  timeZone: draft.zone,
                },
                true,
              );
            }}
          >
            <p>
              {title(draft.row)} · {draft.zone}
            </p>
            <label>
              {t("Beginn", "Start")}
              <DateInput
                name="Beginn"
                value={draft.start}
                timeZone={draft.zone}
                commit="change"
                disabled={busy || !canEdit}
                onChange={(start) => setDraft({ ...draft, start })}
              />
            </label>
            {end ? (
              <label>
                {t("Ende", "End")}
                <DateInput
                  name="Ende"
                  value={draft.end}
                  timeZone={draft.zone}
                  commit="change"
                  disabled={busy || !canEdit}
                  onChange={(end) => setDraft({ ...draft, end })}
                />
              </label>
            ) : (
              <p>
                {t("Für einen Zeitraum in den Ansichtsoptionen ein Enddatumsfeld auswählen.", "For a period, choose an end date field in the view options.")}
              </p>
            )}
            <p className="muted">
              {t("Beginn und Ende gemeinsam speichern. Ein leeres Enddatum bedeutet einen Tag beziehungsweise eine Stunde.", "Save start and end together. An empty end date means one day or one hour.")}
            </p>
            {error && (
              <p role="alert" className="error">
                {error}
              </p>
            )}
            <div className="dialog-actions">
              <button
                className="button"
                type="button"
                disabled={busy}
                onClick={() => setDraft(null)}
              >
                {t("Abbrechen", "Cancel")}
              </button>
              <button
                className="button primary"
                disabled={busy || !canEdit || !draft.start}
              >
                {busy ? t("Wird gespeichert …", "Saving …") : t("Termin speichern", "Save date")}
              </button>
            </div>
          </form>
        )}
      </Modal>
    </section>
  );
}
