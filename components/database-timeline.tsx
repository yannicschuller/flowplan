"use client";
import {
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { CalendarBlank, CaretLeft, CaretRight } from "@phosphor-icons/react";
import { Modal } from "./ui";
import { cellText } from "@/lib/database";
import {
  clipRange,
  dateDay,
  dayKey,
  defaultTimeline,
  rowRange,
  scheduleFields,
  schedulePatch,
  timelinePeriod,
  todayKey,
  DAY,
  type ScheduleChange,
  type TimelineConfig,
} from "@/lib/database-timeline";
import type { Field, Row, View } from "@/lib/types";
type Drag = {
  row: Row;
  version: number;
  operation: "move" | "resize-start" | "resize-end";
  x: number;
  days: number;
  pointer: number;
};
export default function DatabaseTimeline({
  rows,
  fields,
  view,
  version,
  editable,
  viewEditable,
  onOpen,
  onSchedule,
  onView,
}: {
  rows: Row[];
  fields: Field[];
  view: View;
  version: number;
  editable: boolean;
  viewEditable: boolean;
  onOpen: (id: string) => void;
  onSchedule: (input: Record<string, unknown>) => Promise<unknown>;
  onView: (patch: Partial<View>) => Promise<unknown>;
}) {
  const [anchor, setAnchor] = useState(todayKey),
    [localScale, setLocalScale] = useState<TimelineConfig["scale"]>(),
    [localWeekends, setLocalWeekends] = useState<boolean>(),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [drag, setDrag] = useState<Drag | null>(null),
    [draft, setDraft] = useState<{
      row: Row;
      version: number;
      start: string;
      end: string;
    } | null>(null);
  const dragging = useRef<Drag | null>(null),
    suppressed = useRef(false),
    pending = useRef(false);
  const config = view.timeline || defaultTimeline,
    scale = localScale || config.scale,
    weekends = localWeekends ?? config.showWeekends,
    period = timelinePeriod(anchor, scale),
    width = period.days * period.dayWidth,
    { start, end, invalidEnd } = scheduleFields(fields, view),
    canEdit = editable && !!start && !invalidEnd;
  const title = (row: Row) => cellText(row.cells[fields[0]?.id]) || "Unbenannt";
  const label = (
    day: number,
    options: Intl.DateTimeFormatOptions = { day: "numeric", month: "short" },
  ) =>
    new Date(day * DAY).toLocaleDateString("de-DE", {
      ...options,
      timeZone: "UTC",
    });
  useEffect(() => {
    const current = dragging.current;
    if (
      current &&
      (!editable ||
        version !== current.version ||
        rows.find((row) => row.id === current.row.id)?.version !==
          current.row.version)
    ) {
      dragging.current = null;
      setDrag(null);
      suppressed.current = true;
      setError(
        "Die Daten wurden während des Ziehens geändert. Bitte erneut versuchen.",
      );
    }
  }, [rows, version, editable]);
  async function apply(
    row: Row,
    schemaVersion: number,
    change: ScheduleChange,
    close = false,
  ) {
    if (pending.current) return;
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
    } catch (error) {
      setError((error as Error).message);
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }
  async function configure(patch: Partial<TimelineConfig>) {
    if (patch.scale) setLocalScale(patch.scale);
    if (patch.showWeekends !== undefined) setLocalWeekends(patch.showWeekends);
    if (viewEditable) {
      setBusy(true);
      try {
        await onView({ timeline: { ...config, ...patch } });
      } finally {
        setLocalScale(undefined);
        setLocalWeekends(undefined);
        setBusy(false);
      }
    }
  }
  function begin(
    event: ReactPointerEvent<HTMLButtonElement>,
    row: Row,
    operation: Drag["operation"],
  ) {
    if (!canEdit || busy || event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    suppressed.current = false;
    const next = {
      row,
      version,
      operation,
      x: event.clientX,
      days: 0,
      pointer: event.pointerId,
    };
    dragging.current = next;
    setDrag(next);
    setError("");
  }
  function pointerMove(event: ReactPointerEvent<HTMLButtonElement>) {
    const current = dragging.current;
    if (!current || current.pointer !== event.pointerId) return;
    const days = Math.round((event.clientX - current.x) / period.dayWidth);
    if (days !== current.days) {
      const next = { ...current, days };
      dragging.current = next;
      setDrag(next);
      if (days) suppressed.current = true;
    }
  }
  function finish(event: ReactPointerEvent<HTMLButtonElement>) {
    const current = dragging.current;
    if (!current || current.pointer !== event.pointerId) return;
    dragging.current = null;
    setDrag(null);
    if (current.days)
      void apply(current.row, current.version, {
        operation: current.operation,
        days: current.days,
      });
  }
  function cancel() {
    dragging.current = null;
    setDrag(null);
    suppressed.current = true;
  }
  function edit(row: Row) {
    setError("");
    setDraft({
      row,
      version,
      start:
        typeof row.cells[start?.id || ""] === "string"
          ? String(row.cells[start?.id || ""]).slice(0, 10)
          : "",
      end:
        typeof row.cells[end?.id || ""] === "string"
          ? String(row.cells[end?.id || ""]).slice(0, 10)
          : "",
    });
  }
  return (
    <section className="timeline-view" aria-label="Timeline">
      <div className="timeline-controls">
        <button
          className="icon-button"
          aria-label="Timeline: vorheriger Zeitraum"
          disabled={period.start <= dateDay("0001-01-01")!}
          onClick={() => setAnchor(dayKey(period.start - 1))}
        >
          <CaretLeft />
        </button>
        <button
          className="button compact"
          onClick={() => setAnchor(todayKey())}
        >
          Heute
        </button>
        <button
          className="icon-button"
          aria-label="Timeline: nächster Zeitraum"
          disabled={period.end > dateDay("9999-12-31")!}
          onClick={() => setAnchor(dayKey(period.end))}
        >
          <CaretRight />
        </button>
        <strong>
          {label(period.start, {
            day: "numeric",
            month: "short",
            year: "numeric",
          })}{" "}
          –{" "}
          {label(period.end - 1, {
            day: "numeric",
            month: "short",
            year: "numeric",
          })}
        </strong>
        <label>
          Zeitraum
          <input
            aria-label="Timeline: Datum"
            type="date"
            min="0001-01-01"
            max="9999-12-31"
            value={anchor}
            onChange={(event) => {
              if (dateDay(event.target.value) !== null)
                setAnchor(event.target.value);
            }}
          />
        </label>
        <label>
          Maßstab
          <select
            aria-label="Timeline: Maßstab"
            value={scale}
            disabled={busy}
            onChange={(event) =>
              void configure({
                scale: event.target.value as TimelineConfig["scale"],
              })
            }
          >
            <option value="week">Woche</option>
            <option value="month">Monat</option>
            <option value="quarter">Quartal</option>
            <option value="year">Jahr</option>
          </select>
        </label>
        <label className="checkbox-label">
          <input
            type="checkbox"
            checked={weekends}
            disabled={busy}
            onChange={(event) =>
              void configure({ showWeekends: event.target.checked })
            }
          />
          Wochenenden markieren
        </label>
      </div>
      {!start || invalidEnd ? (
        <p className="timeline-notice">
          In den Ansichtseinstellungen gültige, unterschiedliche Datumsfelder
          für Beginn und Ende auswählen.
        </p>
      ) : (
        <>
          <p className="muted timeline-help">
            {canEdit
              ? end
                ? "Balken verschieben, an den Rändern verlängern oder über das Kalendersymbol planen. Alt + Pfeiltaste verschiebt um einen Tag; zusätzlich Umschalt ändert das Ende, Strg den Beginn."
                : "Balken verschieben oder über das Kalendersymbol planen. Alt + Pfeiltaste verschiebt um einen Tag. Für längere Zeiträume in den Ansichtseinstellungen ein separates Enddatumsfeld auswählen."
              : "Einträge öffnen oder den angezeigten Zeitraum ändern."}{" "}
            Vorhandene Uhrzeiten bleiben erhalten.
          </p>
          <div
            className="timeline-scroll"
            tabIndex={0}
            aria-label="Zeitleiste horizontal scrollen"
          >
            <div
              className="timeline-grid"
              style={
                {
                  "--timeline-width": `${width}px`,
                  "--timeline-day": `${period.dayWidth}px`,
                  "--timeline-week-offset": `${-((new Date(period.start * DAY).getUTCDay() + 6) % 7) * period.dayWidth}px`,
                  "--timeline-weekend-color": weekends
                    ? "color-mix(in srgb, var(--muted) 7%, transparent)"
                    : "transparent",
                } as React.CSSProperties
              }
            >
              <div className="timeline-heading">
                <strong>Eintrag</strong>
                <div className="timeline-axis">
                  {Array.from({ length: period.days }, (_, i) => {
                    const day = period.start + i,
                      d = new Date(day * DAY);
                    return (
                      <span
                        key={day}
                        style={{
                          left: i * period.dayWidth,
                          width: Math.max(period.dayWidth, 60),
                        }}
                      >
                        {scale === "week" || scale === "month"
                          ? label(day, { day: "numeric" })
                          : scale === "quarter"
                            ? d.getUTCDay() === 1
                              ? label(day)
                              : ""
                            : d.getUTCDate() === 1
                              ? label(day, { month: "short" })
                              : ""}
                      </span>
                    );
                  })}
                </div>
              </div>
              {rows.map((row) => {
                let effective = row;
                if (drag?.row.id === row.id)
                  try {
                    effective = {
                      ...row,
                      cells: {
                        ...row.cells,
                        ...schedulePatch(drag.row, fields, view, {
                          operation: drag.operation,
                          days: drag.days,
                        }),
                      },
                    };
                  } catch {}
                const range = rowRange(effective, start, end),
                  bar = range && clipRange(range.start, range.end, period),
                  name = title(row);
                const handlers = {
                  onPointerMove: pointerMove,
                  onPointerUp: finish,
                  onPointerCancel: cancel,
                  onLostPointerCapture: () => {
                    if (dragging.current) cancel();
                  },
                };
                return (
                  <div
                    className="timeline-entry"
                    key={row.id}
                    data-row-id={row.id}
                  >
                    <div className="timeline-entry-label">
                      <button
                        className="timeline-name"
                        onClick={() => onOpen(row.id)}
                        title={name}
                      >
                        {name}
                      </button>
                      {canEdit && (
                        <button
                          className="icon-button"
                          aria-label={`Zeitraum für ${name} bearbeiten`}
                          disabled={busy}
                          onClick={() => edit(row)}
                        >
                          <CalendarBlank size={17} />
                        </button>
                      )}
                    </div>
                    <div className="timeline-lane">
                      {dateDay(todayKey())! >= period.start &&
                        dateDay(todayKey())! < period.end && (
                          <span
                            className="timeline-today"
                            aria-hidden="true"
                            style={{
                              left:
                                (dateDay(todayKey())! - period.start) *
                                period.dayWidth,
                            }}
                          />
                        )}
                      {bar ? (
                        <div
                          className={`timeline-range ${drag?.row.id === row.id ? "is-dragging" : ""}`}
                          style={{ left: bar.left, width: bar.width }}
                          title={`${label(range!.start, { day: "numeric", month: "short", year: "numeric" })} – ${label(range!.end, { day: "numeric", month: "short", year: "numeric" })}`}
                        >
                          <button
                            className="timeline-range-body"
                            aria-label={`${name}: ${dayKey(range!.start)} bis ${dayKey(range!.end)}`}
                            aria-disabled={busy}
                            style={{ touchAction: canEdit ? "none" : "auto" }}
                            onPointerDown={(event) => begin(event, row, "move")}
                            {...handlers}
                            onClick={(event) => {
                              if (busy) return;
                              if (event.detail === 0 || !suppressed.current)
                                onOpen(row.id);
                              suppressed.current = false;
                            }}
                            onKeyDown={(event) => {
                              if (event.key === "Escape") {
                                cancel();
                                return;
                              }
                              if (
                                canEdit &&
                                !busy &&
                                event.altKey &&
                                ["ArrowLeft", "ArrowRight"].includes(event.key)
                              ) {
                                event.preventDefault();
                                void apply(row, version, {
                                  operation: event.ctrlKey
                                    ? "resize-start"
                                    : event.shiftKey
                                      ? "resize-end"
                                      : "move",
                                  days: event.key === "ArrowLeft" ? -1 : 1,
                                });
                              }
                            }}
                          >
                            {name}
                          </button>
                          {canEdit &&
                            end &&
                            bar.width >= 28 &&
                            (["resize-start", "resize-end"] as const).map(
                              (operation) =>
                                (
                                  operation === "resize-start"
                                    ? bar.clippedStart
                                    : bar.clippedEnd
                                ) ? null : (
                                  <button
                                    key={operation}
                                    className={`timeline-resize ${operation}`}
                                    aria-label={`${operation === "resize-start" ? "Beginn" : "Ende"} von ${name} ziehen`}
                                    aria-disabled={busy}
                                    onPointerDown={(event) =>
                                      begin(event, row, operation)
                                    }
                                    {...handlers}
                                    onKeyDown={(event) => {
                                      if (
                                        !busy &&
                                        ["ArrowLeft", "ArrowRight"].includes(
                                          event.key,
                                        )
                                      ) {
                                        event.preventDefault();
                                        void apply(row, version, {
                                          operation,
                                          days:
                                            event.key === "ArrowLeft" ? -1 : 1,
                                        });
                                      }
                                    }}
                                  />
                                ),
                            )}
                        </div>
                      ) : (
                        <button
                          className="timeline-unscheduled"
                          disabled={!range && !canEdit}
                          onClick={() =>
                            range ? setAnchor(dayKey(range.start)) : edit(row)
                          }
                        >
                          {range
                            ? "Zum Zeitraum springen"
                            : "Ohne gültigen Zeitraum"}
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
              {!rows.length && (
                <p className="timeline-notice">
                  Keine Einträge für diese Suche oder Filter.
                </p>
              )}
            </div>
          </div>
        </>
      )}
      {error && !draft && (
        <p className="lifecycle-error" role="alert">
          {error}
        </p>
      )}
      {draft && (
        <Modal
          open
          title="Zeitraum bearbeiten"
          onClose={() => {
            if (!busy) {
              setDraft(null);
              setError("");
            }
          }}
        >
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void apply(
                draft.row,
                draft.version,
                { operation: "set", start: draft.start, end: draft.end },
                true,
              );
            }}
          >
            <p>
              <strong>{title(draft.row)}</strong>
            </p>
            <label>
              Beginn
              <input
                required
                type="date"
                min="0001-01-01"
                max="9999-12-31"
                value={draft.start}
                disabled={busy}
                onChange={(event) =>
                  setDraft({ ...draft, start: event.target.value })
                }
              />
            </label>
            {end && (
              <label>
                Ende
                <input
                  type="date"
                  min={draft.start || "0001-01-01"}
                  max="9999-12-31"
                  value={draft.end}
                  disabled={busy}
                  onChange={(event) =>
                    setDraft({ ...draft, end: event.target.value })
                  }
                />
              </label>
            )}
            <p className="muted">
              Ohne Enddatum wird der Eintrag an einem Tag angezeigt. Vorhandene
              Uhrzeiten bleiben erhalten.
            </p>
            {error && (
              <p role="alert" className="lifecycle-error">
                {error}
              </p>
            )}
            <div className="modal-actions">
              <button
                type="button"
                className="button"
                disabled={busy}
                onClick={() => {
                  setDraft(null);
                  setError("");
                }}
              >
                Abbrechen
              </button>
              <button className="button primary" disabled={busy || !canEdit}>
                Zeitraum speichern
              </button>
            </div>
          </form>
        </Modal>
      )}
    </section>
  );
}
