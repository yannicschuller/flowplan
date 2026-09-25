"use client";
import { Select } from "./select";
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import {
  ArrowLineRight,
  CalendarBlank,
  CaretLeft,
  CaretRight,
  Warning,
} from "@phosphor-icons/react";
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
  timelineDependencies,
  dependencyFields,
  dependencyConflict,
  dependencyTypes,
  type DependencyType,
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
type Arrow = { key: string; d: string; conflict: boolean };
export default function DatabaseTimeline({
  pageId,
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
  pageId: string;
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
  const [arrows, setArrows] = useState<Arrow[]>([]);
  const grid = useRef<HTMLDivElement>(null);
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
  const relations = dependencyFields(fields, pageId),
    dependencyField = relations.find((f) => f.id === config.dependencyField),
    dependencyType = config.dependencyType || "fs",
    { links, cyclic } = timelineDependencies(
      rows,
      dependencyField,
      start,
      end,
      dependencyType,
    );
  // Arrows follow the rendered bars, including clipping and active drags.
  useLayoutEffect(() => {
    const root = grid.current;
    const next: Arrow[] = [];
    if (root && links.length) {
      const origin = root.getBoundingClientRect();
      const bar = (id: string) =>
        root
          .querySelector(`[data-row-id="${CSS.escape(id)}"] .timeline-range`)
          ?.getBoundingClientRect();
      for (const link of links) {
        const a = bar(link.from),
          b = bar(link.to);
        if (!a || !b) continue;
        // Arrows leave and enter the linked ends of both bars.
        const fromEnd = dependencyType === "fs" || dependencyType === "ff",
          toStart = dependencyType === "fs" || dependencyType === "ss";
        const x1 = (fromEnd ? a.right : a.left) - origin.left,
          y1 = a.top + a.height / 2 - origin.top,
          x2 = (toStart ? b.left : b.right) - origin.left,
          y2 = b.top + b.height / 2 - origin.top,
          bend = Math.max(12, Math.min(40, Math.abs(x2 - x1) / 2)),
          out = fromEnd ? bend : -bend,
          into = toStart ? -bend : bend;
        next.push({
          key: `${link.from}>${link.to}`,
          d: `M ${x1} ${y1} C ${x1 + out} ${y1}, ${x2 + into} ${y2}, ${x2 + (toStart ? -6 : 6)} ${y2}`,
          conflict: link.shift > 0 || cyclic.has(link.to),
        });
      }
    }
    setArrows((previous) =>
      JSON.stringify(previous) === JSON.stringify(next) ? previous : next,
    );
  });
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
  async function configureDependencies(field: string) {
    if (!viewEditable) return;
    setBusy(true);
    setError("");
    try {
      const { dependencyField: _, ...rest } = config;
      await onView({
        timeline: field ? { ...rest, dependencyField: field } : rest,
      });
    } catch (error) {
      setError((error as Error).message);
    } finally {
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
          <Select
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
          </Select>
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
        <label>
          Abhängigkeiten
          <Select
            aria-label="Timeline: Abhängigkeiten"
            value={dependencyField?.id || ""}
            disabled={busy || !viewEditable || !relations.length}
            title={
              relations.length
                ? undefined
                : "Dafür eine Relation auf diese Datenbank anlegen."
            }
            onChange={(event) => void configureDependencies(event.target.value)}
          >
            <option value="">
              {relations.length ? "Keine" : "Keine Selbstrelation"}
            </option>
            {relations.map((f) => (
              <option key={f.id} value={f.id}>
                {f.name}
              </option>
            ))}
          </Select>
        </label>
        {dependencyField && (
          <label>
            Verknüpfung
            <Select
              aria-label="Timeline: Art der Abhängigkeit"
              value={dependencyType}
              disabled={busy || !viewEditable}
              onChange={(event) =>
                void configure({
                  dependencyType: event.target.value as DependencyType,
                })
              }
            >
              {dependencyTypes.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.label}
                </option>
              ))}
            </Select>
          </label>
        )}
        {canEdit && !cyclic.size && links.some((l) => l.shift > 0) && (
          <button
            className="button compact"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              setError("");
              try {
                await onSchedule({
                  action: "timeline.cascade",
                  viewId: view.id,
                  version,
                });
              } catch (e) {
                setError((e as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            Alle Konflikte nachziehen
          </button>
        )}
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
              ref={grid}
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
              {arrows.length > 0 && (
                <svg className="timeline-dependencies" aria-hidden="true">
                  <defs>
                    {(["ok", "conflict"] as const).map((kind) => (
                      <marker
                        key={kind}
                        id={`timeline-arrow-${view.id}-${kind}`}
                        className={kind}
                        viewBox="0 0 8 8"
                        refX="2"
                        refY="4"
                        markerWidth="8"
                        markerHeight="8"
                        orient="auto"
                      >
                        <path d="M0 0 L8 4 L0 8 z" />
                      </marker>
                    ))}
                  </defs>
                  {arrows.map((arrow) => (
                    <path
                      key={arrow.key}
                      d={arrow.d}
                      className={arrow.conflict ? "conflict" : undefined}
                      markerEnd={`url(#timeline-arrow-${view.id}-${arrow.conflict ? "conflict" : "ok"})`}
                    />
                  ))}
                </svg>
              )}
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
                const incoming = links.filter((l) => l.to === row.id),
                  shift = Math.max(0, ...incoming.map((l) => l.shift)),
                  loop = cyclic.has(row.id),
                  blockers = incoming
                    .filter((l) => l.shift > 0)
                    .map((l) => {
                      const other = rows.find((r) => r.id === l.from);
                      return other ? title(other) : "";
                    })
                    .filter(Boolean);
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
                      {(loop || shift > 0) && (
                        <span
                          className="timeline-conflict"
                          role="img"
                          aria-label={
                            loop
                              ? `${name}: zyklische Abhängigkeit`
                              : `${name} ${dependencyConflict(dependencyType)} ${blockers.join(", ")}`
                          }
                          title={
                            loop
                              ? "Zyklische Abhängigkeit"
                              : `${dependencyConflict(dependencyType).replace(/^./, (c) => c.toUpperCase())} ${blockers.join(", ")}`
                          }
                        >
                          <Warning size={15} weight="fill" />
                        </span>
                      )}
                      {canEdit && !loop && shift > 0 && (
                        <button
                          className="icon-button"
                          aria-label={`${name} hinter Vorgänger verschieben`}
                          title={`Um ${shift} ${shift === 1 ? "Tag" : "Tage"} verschieben, damit die Abhängigkeit erfüllt ist`}
                          disabled={busy}
                          onClick={() =>
                            void apply(row, version, {
                              operation: "move",
                              days: shift,
                            })
                          }
                        >
                          <ArrowLineRight size={17} />
                        </button>
                      )}
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
