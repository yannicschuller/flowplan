"use client";
import { LOCALE_TAG } from "@/lib/locale-tag";
import { useT } from "./i18n";
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
  criticalPath,
  successorShifts,
  dependencyConflict,
  dependencyTypes,
  type DependencyType,
  todayKey,
  DAY,
  type ScheduleChange,
  type TimelineConfig,
} from "@/lib/database-timeline";
import type { Field, Row, View } from "@/lib/types";
import { glide, layoutPosition, motionAllowed, prefersReducedMotion, type Point } from "@/lib/motion";
type Drag = {
  row: Row;
  version: number;
  operation: "move" | "resize-start" | "resize-end";
  x: number;
  days: number;
  pointer: number;
};
type Arrow = { key: string; d: string; conflict: boolean; critical?: boolean; fresh?: boolean };
// Drawing a dependency from the end of a bar onto another one.
type Linking = { from: string; pointer: number; x1: number; y1: number; x2: number; y2: number };
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
  onSchema,
}: {
  // Changes properties and this view together (absent where properties
  // cannot be changed, e.g. in linked views).
  onSchema?: (fields: Field[], patch: Partial<View>) => Promise<unknown>;
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
  const t = useT();
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
  const [linking, setLinking] = useState<Linking | null>(null);
  // A dropped bar (and the successors moving with it) stays where it was
  // let go until the saved dates arrive, instead of jumping back first.
  const [landing, setLanding] = useState<Drag | null>(null);
  const grid = useRef<HTMLDivElement>(null);
  // Arrows of links that appear after the first render draw in once.
  const knownArrows = useRef<Map<string, number> | null>(null);
  // Bar positions of the last render, to let moved bars glide (FLIP).
  const barPositions = useRef<{ period: string; at: Map<string, Point> } | null>(null);
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
    moveSuccessors = !!dependencyField && !!config.moveSuccessors;
  // While dragging, the bars show where they would land; with "Nachfolger
  // mitverschieben" the records waiting for the dragged one move along.
  const shownDrag =
    drag ||
    (landing && rows.find((r) => r.id === landing.row.id)?.version === landing.row.version ? landing : null);
  const preview = (() => {
    const changed = new Map<string, Row>();
    const drag = shownDrag;
    if (!drag?.days) return { rows, changed };
    try {
      const moved = {
        ...drag.row,
        cells: {
          ...drag.row.cells,
          ...schedulePatch(drag.row, fields, view, {
            operation: drag.operation,
            days: drag.days,
          }),
        },
      };
      changed.set(drag.row.id, moved);
      const before = rowRange(drag.row, start, end),
        after = rowRange(moved, start, end);
      if (moveSuccessors && before && after)
        for (const [id, days] of successorShifts(rows, dependencyField, start, end, drag.row.id, after.end - before.end) || []) {
          const row = rows.find((r) => r.id === id)!;
          changed.set(id, {
            ...row,
            cells: { ...row.cells, ...schedulePatch(row, fields, view, { operation: "move", days }) },
          });
        }
    } catch {}
    return { rows: rows.map((row) => changed.get(row.id) || row), changed };
  })();
  const { links, cyclic } = timelineDependencies(
      preview.rows,
      dependencyField,
      start,
      end,
      dependencyType,
    ),
    critical = config.criticalPath
      ? criticalPath(preview.rows, dependencyField, start, end, dependencyType)
      : new Set<string>();
  // Links the current drag would break (shown as a warning before letting go).
  const dragConflicts = drag && preview.changed.size
    ? links.filter(
        (l) => l.shift > 0 && (preview.changed.has(l.to) || preview.changed.has(l.from)),
      )
    : [];
  // Arrows follow the rendered bars, including clipping and active drags.
  useLayoutEffect(() => {
    const root = grid.current;
    const next: Arrow[] = [];
    if (root && links.length) {
      const origin = root.getBoundingClientRect();
      // Layout positions, not screen boxes: a bar gliding to its new place
      // must not pull its arrows along the old way.
      const bar = (id: string) => {
        const el = root.querySelector<HTMLElement>(
          `[data-row-id="${CSS.escape(id)}"] .timeline-range`,
        );
        if (!el) return undefined;
        const at = layoutPosition(el, root, origin);
        return { left: at.x, right: at.x + el.offsetWidth, top: at.y, height: el.offsetHeight };
      };
      for (const link of links) {
        const a = bar(link.from),
          b = bar(link.to);
        if (!a || !b) continue;
        // Arrows leave and enter the linked ends of both bars.
        const fromEnd = dependencyType === "fs" || dependencyType === "ff",
          toStart = dependencyType === "fs" || dependencyType === "ss";
        const x1 = fromEnd ? a.right : a.left,
          y1 = a.top + a.height / 2,
          x2 = toStart ? b.left : b.right,
          y2 = b.top + b.height / 2,
          bend = Math.max(12, Math.min(40, Math.abs(x2 - x1) / 2)),
          out = fromEnd ? bend : -bend,
          into = toStart ? -bend : bend;
        const key = `${link.from}>${link.to}`;
        next.push({
          key,
          ...(arrowFresh(key) ? { fresh: true } : {}),
          d: `M ${x1} ${y1} C ${x1 + out} ${y1}, ${x2 + into} ${y2}, ${x2 + (toStart ? -6 : 6)} ${y2}`,
          conflict: link.shift > 0 || cyclic.has(link.to),
          critical: critical.has(link.from) && critical.has(link.to),
        });
      }
    }
    if (!knownArrows.current) knownArrows.current = new Map(next.map((a) => [a.key, 0]));
    setArrows((previous) =>
      JSON.stringify(previous) === JSON.stringify(next) ? previous : next,
    );
  });
  // Links made after the first render (drawn onto a bar, set in a record)
  // count as fresh for a moment: their arrows draw in.
  function arrowFresh(key: string) {
    const known = knownArrows.current;
    if (!known) return false;
    if (!known.has(key)) known.set(key, Date.now() + 600);
    return Date.now() < known.get(key)!;
  }
  // Bars that moved without being the one dragged glide to their new place:
  // successors moving along (while dragging and after the drop), all
  // conflicts resolved, a move after the predecessor, a change by someone
  // else, a new sort. The arrows fade back in once the bars have arrived.
  // Not when the period or scale changes, nor in large timelines.
  useLayoutEffect(() => {
    const root = grid.current;
    if (!root) return;
    const bars = [...root.querySelectorAll<HTMLElement>(".timeline-entry[data-row-id] .timeline-range")];
    const id = (el: Element) => el.closest<HTMLElement>(".timeline-entry")?.dataset.rowId;
    const origin = root.getBoundingClientRect(),
      at = new Map<string, Point>();
    for (const el of bars) {
      const key = id(el);
      if (key) at.set(key, layoutPosition(el, root, origin));
    }
    const period = `${scale}:${anchor}:${weekends}`,
      previous = barPositions.current;
    barPositions.current = { period, at };
    if (!previous || previous.period !== period || bars.length > 150) return;
    // During a drag the pointer is held: only the successors' preview moves.
    if (drag ? prefersReducedMotion() : !motionAllowed()) return;
    let moved = false;
    for (const el of bars) {
      const key = id(el),
        from = key && previous.at.get(key),
        to = key && at.get(key);
      if (!from || !to || key === drag?.row.id) continue;
      const dx = from.x - to.x,
        dy = from.y - to.y;
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1) continue;
      glide(el, { x: dx, y: dy }, { duration: drag ? 150 : 260 });
      moved = true;
    }
    if (moved && !drag)
      root
        .querySelector(".timeline-dependencies")
        ?.animate([{ opacity: 0 }, { opacity: 0, offset: 0.6 }, { opacity: 1 }], { duration: 420, easing: "ease-out" });
  });
  const title = (row: Row) => cellText(row.cells[fields[0]?.id]) || t("Unbenannt", "Untitled");
  const label = (
    day: number,
    options: Intl.DateTimeFormatOptions = { day: "numeric", month: "short" },
  ) =>
    new Date(day * DAY).toLocaleDateString(LOCALE_TAG, {
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
        t("Die Daten wurden während des Ziehens geändert. Bitte erneut versuchen.", "The data changed while dragging. Please try again."),
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
      // The reloaded rows are in place by now (or the change failed).
      setLanding(null);
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
    if (current.days) {
      setLanding(current);
      void apply(current.row, current.version, {
        operation: current.operation,
        days: current.days,
      });
    }
  }
  function cancel() {
    dragging.current = null;
    setDrag(null);
    suppressed.current = true;
  }
  // The end handle of a bar: drop it on another bar to make that one wait.
  function linkPoint(event: { clientX: number; clientY: number }) {
    const origin = grid.current?.getBoundingClientRect();
    return { x: event.clientX - (origin?.left || 0), y: event.clientY - (origin?.top || 0) };
  }
  function beginLink(event: ReactPointerEvent<HTMLButtonElement>, row: Row) {
    if (!canEdit || busy || event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    const p = linkPoint(event);
    setError("");
    setLinking({ from: row.id, pointer: event.pointerId, x1: p.x, y1: p.y, x2: p.x, y2: p.y });
  }
  function moveLink(event: ReactPointerEvent<HTMLButtonElement>) {
    if (!linking || linking.pointer !== event.pointerId) return;
    const p = linkPoint(event);
    setLinking({ ...linking, x2: p.x, y2: p.y });
  }
  async function finishLink(event: ReactPointerEvent<HTMLButtonElement>) {
    if (!linking || linking.pointer !== event.pointerId) return;
    const from = linking.from;
    setLinking(null);
    const target = document
      .elementFromPoint(event.clientX, event.clientY)
      ?.closest<HTMLElement>("[data-row-id]")?.dataset.rowId;
    if (!target || target === from) return;
    setBusy(true);
    try {
      await onSchedule({ action: "timeline.link", viewId: view.id, version, from, to: target });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
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
    <section className="timeline-view" aria-label={t("Timeline", "Timeline")}>
      <div className="timeline-controls">
        <button
          className="icon-button"
          aria-label={t("Timeline: vorheriger Zeitraum", "Timeline: previous period")}
          disabled={period.start <= dateDay("0001-01-01")!}
          onClick={() => setAnchor(dayKey(period.start - 1))}
        >
          <CaretLeft />
        </button>
        <button
          className="button compact"
          onClick={() => setAnchor(todayKey())}
        >
          {t("Heute", "Today")}
        </button>
        <button
          className="icon-button"
          aria-label={t("Timeline: nächster Zeitraum", "Timeline: next period")}
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
          {t("Zeitraum", "Period")}
          <input
            aria-label={t("Timeline: Datum", "Timeline: date")}
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
          {t("Maßstab", "Scale")}
          <Select
            aria-label={t("Timeline: Maßstab", "Timeline: scale")}
            value={scale}
            disabled={busy}
            onChange={(event) =>
              void configure({
                scale: event.target.value as TimelineConfig["scale"],
              })
            }
          >
            <option value="week">{t("Woche", "Week")}</option>
            <option value="month">{t("Monat", "Month")}</option>
            <option value="quarter">{t("Quartal", "Quarter")}</option>
            <option value="year">{t("Jahr", "Year")}</option>
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
          {t("Wochenenden markieren", "Mark weekends")}
        </label>
        <label>
          {t("Abhängigkeiten", "Dependencies")}
          <Select
            aria-label={t("Timeline: Abhängigkeiten", "Timeline: dependencies")}
            value={dependencyField?.id || ""}
            disabled={busy || !viewEditable || !relations.length}
            title={
              relations.length
                ? undefined
                : t("Dafür eine Relation auf diese Datenbank anlegen.", "Create a relation to this database for that.")
            }
            onChange={(event) => void configureDependencies(event.target.value)}
          >
            <option value="">
              {relations.length ? t("Keine", "None") : t("Keine Selbstrelation", "No self-relation")}
            </option>
            {relations.map((f) => (
              <option key={f.id} value={f.id}>
                {f.name}
              </option>
            ))}
          </Select>
        </label>
        {!dependencyField && viewEditable && onSchema && (
          <button
            className="button compact"
            disabled={busy}
            title={t("Legt eine Eigenschaft an, in der jeder Eintrag die Einträge nennt, auf die er wartet.", "Adds a property in which each record names the records it waits for.")}
            onClick={async () => {
              setBusy(true);
              setError("");
              try {
                const field: Field = {
                  id: crypto.randomUUID(),
                  name: t("Abhängigkeiten", "Dependencies"),
                  type: "relation",
                  relationPage: pageId,
                };
                await onSchema([...fields, field], { timeline: { ...config, dependencyField: field.id } });
              } catch (e) {
                setError((e as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            {t("Abhängigkeiten einrichten", "Set up dependencies")}
          </button>
        )}
        {dependencyField && (
          <>
          <label>
            {t("Verknüpfung", "Link")}
            <Select
              aria-label={t("Timeline: Art der Abhängigkeit", "Timeline: kind of dependency")}
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
          <label
            className="checkbox-label"
            title={t("Wird ein Eintrag verschoben, rücken alle Einträge, die auf ihn warten, um dieselben Tage mit.", "When a record moves, every record waiting for it moves by the same number of days.")}
          >
            <input
              type="checkbox"
              checked={moveSuccessors}
              disabled={busy || !viewEditable}
              onChange={(event) => void configure({ moveSuccessors: event.target.checked })}
            />
            {t("Nachfolger mitverschieben", "Move successors along")}
          </label>
          <label
            className="checkbox-label"
            title={t("Einträge ohne Puffer: Verzögert sich einer, verschiebt sich das Ende des ganzen Plans.", "Records without slack: if one is delayed, the end of the whole plan moves.")}
          >
            <input
              type="checkbox"
              checked={!!config.criticalPath}
              disabled={busy || !viewEditable}
              onChange={(event) => void configure({ criticalPath: event.target.checked })}
            />
            {t("Kritischen Pfad hervorheben", "Highlight critical path")}
          </label>
          </>
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
            {t("Alle Konflikte nachziehen", "Resolve all conflicts")}
          </button>
        )}
      </div>
      {!start || invalidEnd ? (
        <p className="timeline-notice">
          {t("In den Ansichtseinstellungen gültige, unterschiedliche Datumsfelder für Beginn und Ende auswählen.", "Choose valid, different date fields for start and end in the view settings.")}
        </p>
      ) : (
        <>
          <p className="muted timeline-help">
            {canEdit
              ? end
                ? t("Balken verschieben, an den Rändern verlängern oder über das Kalendersymbol planen. Alt + Pfeiltaste verschiebt um einen Tag; zusätzlich Umschalt ändert das Ende, Strg den Beginn.", "Move bars, stretch them at the edges or plan via the calendar icon. Alt + arrow key moves by one day; adding Shift changes the end, Ctrl the start.")
                : t("Balken verschieben oder über das Kalendersymbol planen. Alt + Pfeiltaste verschiebt um einen Tag. Für längere Zeiträume in den Ansichtseinstellungen ein separates Enddatumsfeld auswählen.", "Move bars or plan via the calendar icon. Alt + arrow key moves by one day. For longer periods choose a separate end date field in the view settings.")
              : t("Einträge öffnen oder den angezeigten Zeitraum ändern.", "Open records or change the period shown.")}{" "}
            {t("Vorhandene Uhrzeiten bleiben erhalten.", "Existing times are kept.")}
          </p>
          {dragConflicts.length > 0 && (
            <p className="timeline-drag-warning" role="status">
              <Warning size={15} weight="fill" />{" "}
              {(() => {
                const name = (id: string) => title(preview.rows.find((r) => r.id === id) || rows.find((r) => r.id === id)!);
                const first = dragConflicts[0];
                return t(
                  `„${name(first.to)}“ läge dann zu früh: Es wartet auf „${name(first.from)}“.${dragConflicts.length > 1 ? ` (+${dragConflicts.length - 1} weitere)` : ""}`,
                  `“${name(first.to)}” would then be too early: it waits for “${name(first.from)}”.${dragConflicts.length > 1 ? ` (+${dragConflicts.length - 1} more)` : ""}`,
                );
              })()}
            </p>
          )}
          <div
            className="timeline-scroll"
            tabIndex={0}
            aria-label={t("Zeitleiste horizontal scrollen", "Scroll the timeline horizontally")}
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
                <strong>{t("Eintrag", "Record")}</strong>
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
              {(arrows.length > 0 || linking) && (
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
                      pathLength={arrow.fresh && !arrow.conflict ? 1 : undefined}
                      className={
                        [arrow.conflict ? "conflict" : arrow.critical ? "critical" : "", arrow.fresh ? "is-new" : ""]
                          .filter(Boolean)
                          .join(" ") || undefined
                      }
                      markerEnd={`url(#timeline-arrow-${view.id}-${arrow.conflict ? "conflict" : "ok"})`}
                    />
                  ))}
                  {linking && (
                    <path
                      className="linking"
                      d={`M ${linking.x1} ${linking.y1} L ${linking.x2} ${linking.y2}`}
                      markerEnd={`url(#timeline-arrow-${view.id}-ok)`}
                    />
                  )}
                </svg>
              )}
              {rows.map((row) => {
                const effective = preview.changed.get(row.id) || row;
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
                              ? t(`${name}: zyklische Abhängigkeit`, `${name}: circular dependency`)
                              : `${name} ${dependencyConflict(dependencyType)} ${blockers.join(", ")}`
                          }
                          title={
                            loop
                              ? t("Zyklische Abhängigkeit", "Circular dependency")
                              : `${dependencyConflict(dependencyType).replace(/^./, (c) => c.toUpperCase())} ${blockers.join(", ")}`
                          }
                        >
                          <Warning size={15} weight="fill" />
                        </span>
                      )}
                      {canEdit && !loop && shift > 0 && (
                        <button
                          className="icon-button"
                          aria-label={t(`${name} hinter Vorgänger verschieben`, `Move ${name} after its predecessor`)}
                          title={t(`Um ${shift} ${shift === 1 ? "Tag" : "Tage"} verschieben, damit die Abhängigkeit erfüllt ist`, `Move by ${shift} ${shift === 1 ? "day" : "days"} so the dependency is met`)}
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
                          aria-label={t(`Zeitraum für ${name} bearbeiten`, `Edit period of ${name}`)}
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
                          className={`timeline-range${preview.changed.has(row.id) || drag?.row.id === row.id ? " is-dragging" : ""}${critical.has(row.id) ? " critical" : ""}${linking && linking.from !== row.id ? " link-target" : ""}`}
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
                                    aria-label={t(`${operation === "resize-start" ? "Beginn" : "Ende"} von ${name} ziehen`, `Drag ${operation === "resize-start" ? "start" : "end"} of ${name}`)}
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
                          {canEdit && dependencyField && !bar.clippedEnd && (
                            <button
                              className="timeline-link-handle"
                              aria-label={t(`Abhängigkeit von ${name} auf einen anderen Eintrag ziehen`, `Drag a dependency from ${name} onto another record`)}
                              title={t("Auf einen anderen Balken ziehen: Er wartet dann auf diesen.", "Drag onto another bar: it then waits for this one.")}
                              disabled={busy}
                              onPointerDown={(event) => beginLink(event, row)}
                              onPointerMove={moveLink}
                              onPointerUp={(event) => void finishLink(event)}
                              onPointerCancel={() => setLinking(null)}
                            />
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
                            ? t("Zum Zeitraum springen", "Jump to the period")
                            : t("Ohne gültigen Zeitraum", "Without a valid period")}
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
              {!rows.length && (
                <p className="timeline-notice">
                  {t("Keine Einträge für diese Suche oder Filter.", "No records for this search or filter.")}
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
          title={t("Zeitraum bearbeiten", "Edit period")}
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
              {t("Beginn", "Start")}
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
                {t("Ende", "End")}
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
              {t("Ohne Enddatum wird der Eintrag an einem Tag angezeigt. Vorhandene Uhrzeiten bleiben erhalten.", "Without an end date the record is shown on one day. Existing times are kept.")}
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
                {t("Abbrechen", "Cancel")}
              </button>
              <button className="button primary" disabled={busy || !canEdit}>
                {t("Zeitraum speichern", "Save period")}
              </button>
            </div>
          </form>
        </Modal>
      )}
    </section>
  );
}
