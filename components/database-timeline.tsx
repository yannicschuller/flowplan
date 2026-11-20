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
import { ArrowLineRight, ArrowsInLineVertical, ArrowsOutLineVertical, CalendarBlank, Info, SlidersHorizontal, Warning, X } from "@phosphor-icons/react";
import { Modal } from "./ui";
import { cellText } from "@/lib/database";
import {
  dateDay,
  dayKey,
  defaultTimeline,
  rowRange,
  scheduleFields,
  schedulePatch,
  timelineDependencies,
  dependencyFields,
  criticalPath,
  dependencyConflict,
  dependencyTypes,
  type DependencyType,
  todayKey,
  DAY,
  type ScheduleChange,
  type TimelineConfig,
} from "@/lib/database-timeline";
import {
  followShifts,
  linkedDelta,
  migrateTimeline,
  planInputs,
  planShifts,
  rangePatch,
  redundantLinks,
  timelineSettings,
  type ArrowOverlap,
  type ArrowRouting,
  type ArrowVisibility,
  type ShiftMode,
} from "@/lib/timeline-plan";
import { anchoredLinks, descendants, groupRange, summaryRanges, timelineOutline, type OutlineLine } from "@/lib/timeline-tree";
import { barColor, timelineColorField, timelineGroupField, timelineGroups } from "@/lib/timeline-groups";
import type { Field, Row, View } from "@/lib/types";
import { dragCursor } from "./pointer-drag";
import { glide, layoutPosition, motionAllowed, prefersReducedMotion, type Point } from "@/lib/motion";
import { dataRange, keyDay, outsideLabel, SCALE_DAY_WIDTH, scaleOf, type SavedRange } from "@/lib/timeline-scale";
import {
  barPlacement,
  BarText,
  besideLabel,
  GoToDate,
  scaleOptions,
  ZoomSlider,
  measureLinks,
  measureObstacles,
  OffscreenChip,
  OutlineToggle,
  TimelineArrows,
  TimelineAxis,
  timelineKey,
  TimelineNavigation,
  TimelineZoom,
  useOutline,
  useTimelineFrame,
  VisibleRange,
  frameStyle,
  type ArrowObstacle,
  type MeasuredLink,
} from "./timeline-frame";
// Touch: how long a finger rests on a bar before it moves it, and how far
// it may wander meanwhile (further, it is a swipe that scrolls).
const TOUCH_HOLD_MS = 350;
const TOUCH_SLOP = 8;
type Drag = {
  row: Row;
  version: number;
  operation: "move" | "resize-start" | "resize-end";
  x: number;
  days: number;
  pointer: number;
};
type Range = { start: number; end: number };
// Drawing a dependency from the end of a bar onto another one.
type Linking = { from: string; pointer: number; x1: number; y1: number; x2: number; y2: number };
// A link between two shown lines; `real` is the link between the records
// (different from the lines when one of them is hidden in a collapsed
// parent or group).
type LineLink = { key: string; from: string; to: string; conflict: boolean; critical: boolean; real: { from: string; to: string } };
const parentId = (value: unknown) => (Array.isArray(value) ? value : value ? [value] : []).find((v): v is string => typeof v === "string");
export default function DatabaseTimeline({
  pageId,
  rows,
  fields,
  view,
  version,
  editable,
  viewEditable,
  selectedId,
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
  // The record open in the side panel (#392): its arrows stay in front.
  selectedId?: string | null;
  onOpen: (id: string) => void;
  onSchedule: (input: Record<string, unknown>) => Promise<unknown>;
  onView: (patch: Partial<View>) => Promise<unknown>;
}) {
  const t = useT();
  const [localRange, setLocalRange] = useState<{ value: SavedRange | undefined } | null>(null),
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
  const [measured, setMeasured] = useState<{ links: MeasuredLink[]; obstacles: ArrowObstacle[] }>({ links: [], obstacles: [] });
  const [, setMeasureTick] = useState(0);
  const [settingsOpen, setSettingsOpen] = useState(false),
    [helpOpen, setHelpOpen] = useState(false);
  // Focus (#395): the bar under the pointer, the row with the keyboard
  // focus and the hovered arrow.
  const [hoverLine, setHoverLine] = useState<string | null>(null),
    [keyLine, setKeyLine] = useState<string | null>(null),
    [hoverLink, setHoverLink] = useState<string | null>(null);
  const linkTimer = useRef<number>(undefined);
  // The settings open below the header line and push the grid down (no
  // layer over the bars, so dragging is never in its way); the button or
  // Escape closes them.
  const settingsButton = useRef<HTMLButtonElement>(null);
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
    pending = useRef(false),
    // A finger on a bar, until it has been held long enough to move it.
    held = useRef<{ pointer: number; x: number; y: number; timer: number } | null>(null);
  const config = view.timeline || defaultTimeline,
    settings = timelineSettings(config),
    scale = localScale || config.scale,
    weekends = localWeekends ?? config.showWeekends,
    range = localRange ? localRange.value : config.range,
    { start, end, invalidEnd } = scheduleFields(fields, view),
    canEdit = editable && !!start && !invalidEnd,
    today = dateDay(todayKey())!;
  // The grid spans the saved range, all records or today's period and the
  // records; the zoom is continuous (components/timeline-frame.tsx, #390).
  const frame = useTimelineFrame({
    range,
    dayWidth: config.dayWidth,
    scale,
    data: dataRange(rows.map((r) => rowRange(r, start, end))),
    today,
    storageId: `${pageId}:${view.id}`,
    onZoom: viewEditable ? (dayWidth) => void saveZoom(dayWidth) : undefined,
  });
  const period = { start: frame.window.start, end: frame.window.end, dayWidth: frame.dayWidth },
    width = (period.end - period.start) * period.dayWidth;
  const milestoneField = fields.find((f) => f.id === config.milestoneField && f.type === "checkbox"),
    labelFields = (config.labelFields || []).map((id) => fields.find((f) => f.id === id)).filter((f): f is Field => !!f);
  const detail = (row: Row) =>
    labelFields
      .map((f) => cellText(row.cells[f.id]))
      .filter(Boolean)
      .join(" · ");
  const helpText = [
    canEdit
      ? end
        ? t("Balken verschieben, an den Rändern verlängern oder über das Kalendersymbol planen. Alt + Pfeiltaste verschiebt um einen Tag; zusätzlich Umschalt ändert das Ende, Strg den Beginn.", "Move bars, stretch them at the edges or plan via the calendar icon. Alt + arrow key moves by one day; adding Shift changes the end, Ctrl the start.")
        : t("Balken verschieben oder über das Kalendersymbol planen. Alt + Pfeiltaste verschiebt um einen Tag. Für längere Zeiträume in den Ansichtseinstellungen ein separates Enddatumsfeld auswählen.", "Move bars or plan via the calendar icon. Alt + arrow key moves by one day. For longer periods choose a separate end date field in the view settings.")
      : t("Einträge öffnen oder den angezeigten Zeitraum ändern.", "Open records or change the period shown."),
    canEdit ? t("Auf Touchscreens einen Balken kurz halten, dann ziehen.", "On touch screens, hold a bar briefly, then drag it.") : "",
    t("Strg/⌘ + Mausrad oder zwei Finger zoomen; T springt zu heute, F passt ein.", "Ctrl/⌘ + mouse wheel or two fingers zoom; T jumps to today, F fits."),
    t("Vorhandene Uhrzeiten bleiben erhalten.", "Existing times are kept."),
  ]
    .filter(Boolean)
    .join(" ");
  const relations = dependencyFields(fields, pageId),
    dependencyField = relations.find((f) => f.id === config.dependencyField),
    dependencyType = config.dependencyType || "fs",
    shiftMode: ShiftMode = dependencyField ? settings.shiftMode : "off";
  // Hierarchy, groups and colours (#394).
  const hierarchyField = relations.find((f) => f.id === config.hierarchyField && f.id !== dependencyField?.id),
    groupField = timelineGroupField(fields, view.groupBy),
    colorField = timelineColorField(fields, config.colorField);
  // While dragging, the bars show where they would land; under the shift
  // mode the records waiting for the dragged one move along.
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
      if (shiftMode !== "off" && before && after)
        for (const [id, target] of followShifts(rows, dependencyField, start, end, config, { id: drag.row.id, range: after }, linkedDelta(dependencyType, before, after)) || []) {
          const row = rows.find((r) => r.id === id)!;
          changed.set(id, {
            ...row,
            cells: { ...row.cells, ...rangePatch(row, fields, view, rowRange(row, start, end)!, target) },
          });
        }
    } catch {}
    return { rows: rows.map((row) => changed.get(row.id) || row), changed };
  })();
  const shownRow = (id: string) => preview.changed.get(id) || rows.find((r) => r.id === id);
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
  // The outline: records below their parents, in groups; collapsed state
  // per view on this device.
  const grouping = groupField ? timelineGroups(rows, groupField, t) : null;
  const outlineInput = rows.map((row) => ({
    id: row.id,
    parent: hierarchyField ? parentId(row.cells[hierarchyField.id]) : undefined,
    group: grouping?.keyOf.get(row.id),
  }));
  const outlineOf = (collapsed: ReadonlySet<string>) => timelineOutline(outlineInput, { groups: grouping?.groups, collapsed });
  const outlineState = useOutline({
    storageId: `${pageId}:${view.id}`,
    grid,
    motion: motionAllowed,
    lines: (collapsed) => outlineOf(collapsed).lines.map((l) => l.id),
    onFrame: () => setMeasureTick((n) => n + 1),
  });
  const outline = outlineOf(outlineState.collapsed);
  const outlined = !!hierarchyField || !!grouping;
  const rangeOf = (id: string) => {
    const row = shownRow(id);
    return row ? rowRange(row, start, end) : null;
  };
  const summaries = outlined ? summaryRanges(outline.childrenOf, rangeOf) : new Map<string, Range>();
  const groupMembers = new Map<string, string[]>();
  if (grouping) for (const [id, key] of grouping.keyOf) groupMembers.set(key, [...(groupMembers.get(key) || []), id]);
  const collapsible = outline.lines.filter((l) => l.type === "group" || l.children > 0).map((l) => l.id);
  // Links between shown lines: a hidden record's links attach to the line
  // it shows on (its collapsed parent's summary bar, or its group).
  const lineLinks: LineLink[] = anchoredLinks(links, outline.anchor).map((l) => ({
    key: `${l.line.from}>${l.line.to}`,
    from: l.line.from,
    to: l.line.to,
    conflict: l.shift > 0 || cyclic.has(l.to),
    critical: critical.has(l.from) && critical.has(l.to),
    real: { from: l.from, to: l.to },
  }));
  const lineOf = (id: string) => outline.anchor.get(id) || id;
  const focus = hoverLine ?? keyLine ?? (selectedId && rows.some((r) => r.id === selectedId) ? lineOf(selectedId) : null);
  const hoveredLink = hoverLink && lineLinks.find((l) => l.key === hoverLink);
  // Links the current drag would break (shown as a warning before letting go).
  const dragConflicts = drag && preview.changed.size
    ? links.filter(
        (l) => l.shift > 0 && (preview.changed.has(l.to) || preview.changed.has(l.from)),
      )
    : [];
  // The days marked in the axis: the bar dragged, else the one under the
  // pointer or with the keyboard focus (#395).
  const highlight = (() => {
    if (shownDrag) return rangeOf(shownDrag.row.id);
    const id = hoverLine ?? keyLine;
    if (!id) return null;
    if (id.startsWith("group:")) return grouping ? groupRange(groupMembers.get(id.slice(6)) || [], rangeOf) : null;
    return summaries.get(id) || rangeOf(id);
  })();
  // Arrows follow the rendered bars, including clipping and active drags.
  useLayoutEffect(() => {
    const root = grid.current;
    // Layout positions, not screen boxes: a bar gliding to its new place
    // must not pull its arrows along the old way.
    const box = (el: HTMLElement, origin: DOMRect) => layoutPosition(el, root!, origin);
    const next = root
      ? measureLinks(root, lineLinks, box).map((a) => (arrowFresh(a.key) ? { ...a, fresh: true } : a))
      : [];
    const obstacles = root && next.length && settings.arrowOverlap === "transparent" ? measureObstacles(root, box) : [];
    // The first arrows seen once the records are there are known, not
    // fresh: rows often arrive after the first render (an empty timeline
    // first), and existing dependencies must not draw in then.
    if (!knownArrows.current && rows.length) knownArrows.current = new Map(next.map((a) => [a.key, 0]));
    setMeasured((previous) =>
      JSON.stringify(previous.links) === JSON.stringify(next) && JSON.stringify(previous.obstacles) === JSON.stringify(obstacles)
        ? previous
        : { links: next, obstacles },
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
  // Not when the period or scale changes, nor in large timelines, nor while
  // a parent opens or closes (the rows move with it then).
  useLayoutEffect(() => {
    const root = grid.current;
    if (!root) return;
    const bars = [...root.querySelectorAll<HTMLElement>(".timeline-entry[data-line-id] > .timeline-lane > .timeline-range")];
    const id = (el: Element) => el.closest<HTMLElement>(".timeline-entry")?.dataset.lineId;
    const origin = root.getBoundingClientRect(),
      at = new Map<string, Point>();
    for (const el of bars) {
      const key = id(el);
      if (key) at.set(key, layoutPosition(el, root, origin));
    }
    const period = `${frame.window.start}:${frame.dayWidth}:${weekends}`,
      previous = barPositions.current;
    barPositions.current = { period, at };
    if (!previous || previous.period !== period || bars.length > 150 || outlineState.moving()) return;
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
  useEffect(() => () => window.clearTimeout(linkTimer.current), []);
  // An arrow stays hovered for a moment after the pointer leaves it, so the
  // × at its end can be reached.
  function hoverArrow(key: string | null) {
    window.clearTimeout(linkTimer.current);
    if (key) setHoverLink(key);
    else linkTimer.current = window.setTimeout(() => setHoverLink(null), 300);
  }
  const title = (row: Row) => cellText(row.cells[fields[0]?.id]) || t("Unbenannt", "Untitled");
  const titleOf = (id: string) => {
    const row = rows.find((r) => r.id === id);
    return row ? title(row) : "";
  };
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
    extra: Record<string, unknown> = {},
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
        ...extra,
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
  // The conflict button: the record moves as far as its links need (off
  // weekends when the view asks); what waits for it follows the shift mode
  // on the server.
  function resolveChange(row: Row): { change: ScheduleChange; days: number } | null {
    const { ranges, predecessors } = planInputs(rows, dependencyField, start, end);
    const base = ranges.get(row.id),
      target = planShifts({ ranges, predecessors, type: dependencyType, scope: [row.id], avoidWeekends: settings.avoidWeekends })?.get(row.id);
    if (!base || !target) return null;
    return {
      days: target.start - base.start,
      change:
        target.end - target.start === base.end - base.start
          ? { operation: "move", days: target.start - base.start }
          : { operation: "set", start: dayKey(target.start), end: end ? dayKey(target.end) : "" },
    };
  }
  async function command(input: Record<string, unknown>) {
    setBusy(true);
    setError("");
    try {
      await onSchedule({ viewId: view.id, version, ...input });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function configureDependencies(field: string) {
    if (!viewEditable) return;
    setBusy(true);
    setError("");
    try {
      const { dependencyField: _, ...rest } = migrateTimeline(config);
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
    if ("range" in patch) setLocalRange({ value: patch.range });
    if (viewEditable) {
      setBusy(true);
      try {
        await onView({ timeline: migrateTimeline({ ...config, ...patch }) });
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setLocalScale(undefined);
        setLocalWeekends(undefined);
        setLocalRange(null);
        setBusy(false);
      }
    }
  }
  async function configureView(patch: Partial<View>) {
    if (!viewEditable) return;
    setBusy(true);
    setError("");
    try {
      await onView(patch);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  // A zoom chosen with the buttons, the slider, the wheel or the fingers
  // (debounced by the frame); a failed save keeps the zoom on screen.
  async function saveZoom(dayWidth: number) {
    if (config.dayWidth === dayWidth) return;
    try {
      await onView({ timeline: { ...config, dayWidth } });
    } catch (e) {
      setError((e as Error).message);
    }
  }
  // A new window: the zoom that fits it, from its start.
  function chooseRange(next: SavedRange | undefined) {
    frame.reset(next ? undefined : SCALE_DAY_WIDTH[scale]);
    void configure({ range: next, dayWidth: undefined });
  }
  const shownScale = scaleOf(frame.dayWidth),
    rangeMode = range === "fit" ? "fit" : range ? "custom" : "auto",
    rangeFrom = typeof range === "object" ? range.from : "",
    rangeTo = typeof range === "object" ? range.to : "";
  // While a bar is dragged by touch, the finger does not scroll the page.
  useEffect(() => {
    const root = grid.current;
    if (!root || !canEdit) return;
    const hold = (event: TouchEvent) => {
      if (dragging.current && event.cancelable) event.preventDefault();
    };
    root.addEventListener("touchmove", hold, { passive: false });
    return () => root.removeEventListener("touchmove", hold);
  }, [canEdit]);
  useEffect(() => () => clearHold(), []);
  // While an entry is dragged the cursor is the closed hand everywhere, and
  // Escape puts it back (#100).
  const dragged = drag !== null;
  useEffect(() => {
    if (!dragged) return;
    dragCursor(true);
    const key = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      cancel();
    };
    window.addEventListener("keydown", key, true);
    return () => {
      dragCursor(false);
      window.removeEventListener("keydown", key, true);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dragged]);
  function clearHold() {
    if (held.current) window.clearTimeout(held.current.timer);
    held.current = null;
  }
  function begin(
    event: ReactPointerEvent<HTMLButtonElement>,
    row: Row,
    operation: Drag["operation"],
  ) {
    if (!canEdit || busy || event.button !== 0) return;
    const target = event.currentTarget,
      pointer = event.pointerId,
      x = event.clientX;
    const start = () => {
      suppressed.current = false;
      const next = { row, version, operation, x, days: 0, pointer };
      dragging.current = next;
      setDrag(next);
      setError("");
    };
    // By touch a bar moves once it has been held for a moment; a swipe
    // before that scrolls the timeline (#98). Its edges move at once.
    if (event.pointerType !== "mouse" && operation === "move") {
      clearHold();
      held.current = {
        pointer,
        x,
        y: event.clientY,
        timer: window.setTimeout(() => {
          held.current = null;
          if (frame.pinching()) return;
          try {
            target.setPointerCapture(pointer);
          } catch {
            return; // The finger is gone.
          }
          start();
        }, TOUCH_HOLD_MS),
      };
      return;
    }
    target.setPointerCapture(pointer);
    start();
  }
  function pointerMove(event: ReactPointerEvent<HTMLButtonElement>) {
    const hold = held.current;
    if (
      hold?.pointer === event.pointerId &&
      Math.hypot(event.clientX - hold.x, event.clientY - hold.y) > TOUCH_SLOP
    )
      clearHold();
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
    if (held.current?.pointer === event.pointerId) clearHold();
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
    clearHold();
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
  // Links that a longer way already implies (a hint in the settings).
  const redundant = settingsOpen && dependencyField ? redundantLinks(timelineDependencies(rows, dependencyField, start, end, dependencyType).links, 20) : [];
  // A row's bar, its summary bar (parents, #394) or a group's.
  function lane(line: OutlineLine, row: Row | null) {
    const id = line.id;
    const summary = line.type === "group" ? groupRange(groupMembers.get(line.key) || [], rangeOf) : summaries.get(id);
    const effective = row ? preview.changed.get(row.id) || row : null;
    const own = effective ? rowRange(effective, start, end) : null;
    const name = row ? title(row) : line.type === "group" ? line.label : "";
    const linkHover = !!hoveredLink && (hoveredLink.from === id || hoveredLink.to === id);
    const todayLine = today >= period.start && today < period.end && (
      <span className="timeline-today" aria-hidden="true" style={{ left: (today - period.start) * period.dayWidth }} />
    );
    if (summary) {
      const box = barPlacement(summary, false, period, true).box;
      const baseline = row && config.summaryBaseline && own && (own.start !== summary.start || own.end !== summary.end) ? barPlacement(own, false, period, true).box : null;
      const count = line.type === "group" ? line.count : descendants(outline.childrenOf, id).length;
      const text =
        line.type === "group"
          ? t(`${name}: ${dayKey(summary.start)} bis ${dayKey(summary.end)}, ${count} Einträge`, `${name}: ${dayKey(summary.start)} to ${dayKey(summary.end)}, ${count} records`)
          : t(`${name}: ${dayKey(summary.start)} bis ${dayKey(summary.end)} (aus ${count} Untereinträgen)`, `${name}: ${dayKey(summary.start)} to ${dayKey(summary.end)} (from ${count} sub-records)`);
      const side = box ? besideLabel(box, width) : null;
      return (
        <div className="timeline-lane">
          {todayLine}
          {baseline && (
            <span
              className="timeline-baseline"
              aria-hidden="true"
              title={t(`Eigene Daten: ${dayKey(own!.start)} – ${dayKey(own!.end)}`, `Own dates: ${dayKey(own!.start)} – ${dayKey(own!.end)}`)}
              style={{ left: baseline.left, width: baseline.width }}
            />
          )}
          {box ? (
            <div
              className={`timeline-range summary label-${side}${box.clippedStart ? " clipped-start" : ""}${box.clippedEnd ? " clipped-end" : ""}${linkHover ? " link-hover" : ""}`}
              style={{ left: box.left, width: box.width, "--bar-left": `${box.left}px` } as React.CSSProperties}
              title={`${label(summary.start, { day: "numeric", month: "short", year: "numeric" })} – ${label(summary.end, { day: "numeric", month: "short", year: "numeric" })}`}
              onPointerEnter={() => setHoverLine(id)}
              onPointerLeave={() => setHoverLine((h) => (h === id ? null : h))}
            >
              {row ? (
                <button className="timeline-range-body" aria-label={text} onClick={() => onOpen(row.id)} />
              ) : (
                <span className="timeline-range-body" role="img" aria-label={text} />
              )}
              <span className="timeline-range-label" aria-hidden="true">
                <BarText name={name} detail={row ? detail(row) : undefined} />
              </span>
            </div>
          ) : (
            <OffscreenChip frame={frame} tag={LOCALE_TAG} range={summary} label={t("Zum Zeitraum springen", "Jump to the period")} text={t("Zum Zeitraum springen", "Jump to the period")} />
          )}
          {box && <OffscreenChip frame={frame} tag={LOCALE_TAG} range={summary} label={t(`Zu ${name} springen`, `Jump to ${name}`)} />}
        </div>
      );
    }
    if (!row || !effective) return <div className="timeline-lane">{todayLine}</div>;
    const range = own,
      placed = range && barPlacement(range, !!milestoneField && effective.cells[milestoneField.id] === true, period, !!config.milestoneOnlyField),
      bar = placed?.box,
      milestone = !!placed?.milestone,
      more = detail(row),
      color = barColor(colorField, row),
      // A bar too short for its title (a day in the month scale showed
      // "O…") has it beside it instead: right of the bar, or left where
      // the period ends (#346).
      outside = bar ? (milestone ? besideLabel(bar, width) : outsideLabel(bar, name, width)) : null;
    const handlers = {
      onPointerMove: pointerMove,
      onPointerUp: finish,
      onPointerCancel: cancel,
      onLostPointerCapture: () => {
        if (dragging.current) cancel();
      },
    };
    // The × at the end of the arrows into this bar (#395): for the hovered
    // arrow, or all of them while the row has the keyboard focus.
    const removable =
      canEdit && bar && dependencyField
        ? lineLinks.filter((l) => l.to === id && l.real.to === row.id && l.real.from === l.from && (hoverLink === l.key || keyLine === id))
        : [];
    const toStart = dependencyType === "fs" || dependencyType === "ss";
    return (
      <div className="timeline-lane">
        {todayLine}
        {bar ? (
          <div
            className={`timeline-range${preview.changed.has(row.id) || drag?.row.id === row.id ? " is-dragging" : ""}${critical.has(row.id) ? " critical" : ""}${color ? ` colored opt-${color}` : ""}${linkHover ? " link-hover" : ""}${linking && linking.from !== row.id ? " link-target" : ""}${outside ? ` label-${outside}` : ""}${bar.clippedStart ? " clipped-start" : ""}${bar.clippedEnd ? " clipped-end" : ""}${milestone ? " milestone" : ""}`}
            style={{ left: bar.left, width: bar.width, "--bar-left": `${bar.left}px` } as React.CSSProperties}
            title={`${label(range!.start, { day: "numeric", month: "short", year: "numeric" })} – ${label(range!.end, { day: "numeric", month: "short", year: "numeric" })}`}
            onPointerEnter={() => setHoverLine(id)}
            onPointerLeave={() => setHoverLine((h) => (h === id ? null : h))}
          >
            <button
              className="timeline-range-body"
              aria-label={t(
                `${name}: ${dayKey(range!.start)} bis ${dayKey(range!.end)}`,
                `${name}: ${dayKey(range!.start)} to ${dayKey(range!.end)}`,
              )}
              aria-disabled={busy}
              // Swipes scroll; a held finger moves the bar.
              style={{ touchAction: canEdit ? "pan-x pan-y" : "auto" }}
              onPointerDown={(event) => begin(event, row, "move")}
              {...handlers}
              onClick={(event) => {
                if (busy) return;
                if (event.detail === 0 || !suppressed.current) onOpen(row.id);
                suppressed.current = false;
              }}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  cancel();
                  return;
                }
                if (canEdit && !busy && event.altKey && ["ArrowLeft", "ArrowRight"].includes(event.key)) {
                  event.preventDefault();
                  void apply(row, version, {
                    operation: event.ctrlKey ? "resize-start" : event.shiftKey ? "resize-end" : "move",
                    days: event.key === "ArrowLeft" ? -1 : 1,
                  });
                }
              }}
            >
              {!outside && <BarText name={name} detail={more} />}
            </button>
            {outside && (
              <span className="timeline-range-label" aria-hidden="true">
                <BarText name={name} detail={more} />
              </span>
            )}
            {canEdit &&
              end &&
              !milestone &&
              bar.width >= 28 &&
              (["resize-start", "resize-end"] as const).map((operation) =>
                (operation === "resize-start" ? bar.clippedStart : bar.clippedEnd) ? null : (
                  <button
                    key={operation}
                    className={`timeline-resize ${operation}`}
                    aria-label={t(`${operation === "resize-start" ? "Beginn" : "Ende"} von ${name} ziehen`, `Drag ${operation === "resize-start" ? "start" : "end"} of ${name}`)}
                    aria-disabled={busy}
                    onPointerDown={(event) => begin(event, row, operation)}
                    {...handlers}
                    onKeyDown={(event) => {
                      if (!busy && ["ArrowLeft", "ArrowRight"].includes(event.key)) {
                        event.preventDefault();
                        void apply(row, version, { operation, days: event.key === "ArrowLeft" ? -1 : 1 });
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
        ) : range ? (
          <OffscreenChip frame={frame} tag={LOCALE_TAG} range={range} label={t("Zum Zeitraum springen", "Jump to the period")} text={t("Zum Zeitraum springen", "Jump to the period")} />
        ) : (
          <button className="timeline-unscheduled" disabled={!canEdit} onClick={() => edit(row)}>
            {t("Ohne gültigen Zeitraum", "Without a valid period")}
          </button>
        )}
        {bar && range && <OffscreenChip frame={frame} tag={LOCALE_TAG} range={range} label={t(`Zu ${name} springen`, `Jump to ${name}`)} />}
        {removable.map((l, i) => (
          <button
            key={l.key}
            type="button"
            className={`timeline-unlink${toStart ? " at-start" : " at-end"}`}
            style={{ left: toStart ? bar!.left - 22 - i * 22 : bar!.left + bar!.width + 4 + i * 22 }}
            aria-label={t(`Abhängigkeit ${titleOf(l.real.from)} → ${name} entfernen`, `Remove dependency ${titleOf(l.real.from)} → ${name}`)}
            title={t(`Abhängigkeit „${titleOf(l.real.from)}“ → „${name}“ entfernen`, `Remove dependency “${titleOf(l.real.from)}” → “${name}”`)}
            disabled={busy}
            onPointerEnter={() => hoverArrow(l.key)}
            onPointerLeave={() => hoverArrow(null)}
            onFocus={() => setHoverLink(l.key)}
            onClick={() => {
              setHoverLink(null);
              void command({ action: "timeline.unlink", from: l.real.from, to: l.real.to });
            }}
          >
            <X size={11} weight="bold" />
          </button>
        ))}
      </div>
    );
  }
  // The title column of a line: indented below its parent, ▾/▸ for parents
  // and groups, the conflict hint and buttons for records.
  function labelCell(line: OutlineLine, row: Row | null) {
    const toggle = (line.type === "group" || line.children > 0) && (
      <OutlineToggle name={line.type === "group" ? line.label : title(row!)} collapsed={line.collapsed} onToggle={() => outlineState.toggle(line.id)} t={t} />
    );
    const indent = { "--timeline-depth": line.depth } as React.CSSProperties;
    if (line.type === "group")
      return (
        <div className="timeline-entry-label timeline-outline" style={indent}>
          {toggle}
          <strong className="timeline-group-name" title={line.label}>
            {line.label}
          </strong>
          <span className="timeline-group-count">{line.count}</span>
        </div>
      );
    const r = row!;
    const name = title(r);
    const incoming = links.filter((l) => l.to === r.id),
      shift = Math.max(0, ...incoming.map((l) => l.shift)),
      loop = cyclic.has(r.id),
      blockers = incoming
        .filter((l) => l.shift > 0)
        .map((l) => titleOf(l.from))
        .filter(Boolean);
    const resolve = canEdit && !loop && shift > 0 ? resolveChange(r) : null;
    return (
      <div className={`timeline-entry-label${outlined ? " timeline-outline" : ""}`} style={outlined ? indent : undefined}>
        {outlined && (toggle || <span className="timeline-outline-spacer" aria-hidden="true" />)}
        <button
          className="timeline-name"
          onClick={() => onOpen(r.id)}
          title={name}
          onPointerEnter={() => setHoverLine(line.id)}
          onPointerLeave={() => setHoverLine((h) => (h === line.id ? null : h))}
        >
          {name}
        </button>
        {(loop || shift > 0) && (
          <span
            className="timeline-conflict"
            role="img"
            aria-label={loop ? t(`${name}: zyklische Abhängigkeit`, `${name}: circular dependency`) : `${name} ${dependencyConflict(dependencyType)} ${blockers.join(", ")}`}
            title={
              loop
                ? t("Zyklische Abhängigkeit", "Circular dependency")
                : `${dependencyConflict(dependencyType).replace(/^./, (c) => c.toUpperCase())} ${blockers.join(", ")}`
            }
          >
            <Warning size={15} weight="fill" />
          </span>
        )}
        {resolve && (
          <button
            className="icon-button"
            aria-label={t(`${name} hinter Vorgänger verschieben`, `Move ${name} after its predecessor`)}
            title={t(
              `Um ${resolve.days} ${resolve.days === 1 ? "Tag" : "Tage"} verschieben, damit die Abhängigkeit erfüllt ist`,
              `Move by ${resolve.days} ${resolve.days === 1 ? "day" : "days"} so the dependency is met`,
            )}
            disabled={busy}
            onClick={() => void apply(r, version, resolve.change, false, { resolve: true })}
          >
            <ArrowLineRight size={17} />
          </button>
        )}
        {canEdit && (
          <button className="icon-button" aria-label={t(`Zeitraum für ${name} bearbeiten`, `Edit period of ${name}`)} disabled={busy} onClick={() => edit(r)}>
            <CalendarBlank size={17} />
          </button>
        )}
      </div>
    );
  }
  const rowsById = new Map(rows.map((r) => [r.id, r]));
  const selectFields = fields.filter((f) => f.type === "select" || f.type === "multiselect");
  const groupable = fields.filter((f) => !!timelineGroupField(fields, f.id) && f.id !== start?.id && f.id !== end?.id);
  return (
    <section
      className={`timeline-view arrows-${settings.arrowOverlap}`}
      aria-label={t("Timeline", "Timeline")}
      onKeyDown={(event) => timelineKey(event, frame)}
    >
      {/* One header line (#390): ‹ Heute ›, what is visible, scale, period,
          zoom; everything else in the settings. */}
      <div className="timeline-controls">
        <TimelineNavigation frame={frame} t={t} />
        <VisibleRange frame={frame} tag={LOCALE_TAG} />
        <label title={t("Maßstab", "Scale")}>
          <span className="timeline-control-name">{t("Maßstab", "Scale")}</span>
          <Select
            aria-label={t("Timeline: Maßstab", "Timeline: scale")}
            value={shownScale || ""}
            disabled={busy}
            onChange={(event) => {
              const next = event.target.value as TimelineConfig["scale"];
              if (!next) return;
              frame.reset(SCALE_DAY_WIDTH[next]);
              // With a range the zoom would fit it otherwise.
              void configure({ scale: next, dayWidth: range ? SCALE_DAY_WIDTH[next] : undefined });
            }}
          >
            {!shownScale && <option value="">{t("Eigener Zoom", "Custom zoom")}</option>}
            {scaleOptions(t).map(([id, name]) => (
              <option key={id} value={id}>
                {name}
              </option>
            ))}
          </Select>
        </label>
        <label title={t("Zeitraum", "Period")}>
          <span className="timeline-control-name">{t("Zeitraum", "Period")}</span>
          <Select
            aria-label={t("Timeline: Zeitraum", "Timeline: period")}
            value={rangeMode}
            disabled={busy}
            onChange={(event) => {
              const mode = event.target.value;
              if (mode === "auto") chooseRange(undefined);
              else if (mode === "fit") chooseRange("fit");
              else {
                // From what is visible now.
                const a = Math.floor(frame.leftDay()),
                  b = Math.max(a, Math.floor(a + frame.lane.width / frame.dayWidth) - 1);
                chooseRange({ from: dayKey(a), to: dayKey(b) });
              }
            }}
          >
            <option value="auto">{t("Fortlaufend", "Continuous")}</option>
            <option value="fit">{t("Alle Einträge", "All records")}</option>
            <option value="custom">{t("Von – bis", "From – to")}</option>
          </Select>
        </label>
        {rangeMode === "custom" && (
          <span className="timeline-range-fields">
            <input
              aria-label={t("Timeline: von", "Timeline: from")}
              title={t("Von", "From")}
              type="date"
              min="0001-01-01"
              max={rangeTo || "9999-12-31"}
              value={rangeFrom}
              disabled={busy}
              onChange={(event) => {
                const from = event.target.value;
                if (keyDay(from) !== null) chooseRange({ from, to: rangeTo && rangeTo >= from ? rangeTo : from });
              }}
            />
            <span aria-hidden="true">–</span>
            <input
              aria-label={t("Timeline: bis", "Timeline: to")}
              title={t("Bis", "To")}
              type="date"
              min={rangeFrom || "0001-01-01"}
              max="9999-12-31"
              value={rangeTo}
              disabled={busy}
              onChange={(event) => {
                const to = event.target.value;
                if (keyDay(to) !== null) chooseRange({ from: rangeFrom && rangeFrom <= to ? rangeFrom : to, to });
              }}
            />
          </span>
        )}
        <TimelineZoom frame={frame} t={t} />
        {canEdit && !cyclic.size && links.some((l) => l.shift > 0) && (
          <button className="button compact" disabled={busy} onClick={() => void command({ action: "timeline.cascade" })}>
            {t("Alle Konflikte nachziehen", "Resolve all conflicts")}
          </button>
        )}
        {start && !invalidEnd && (
          <button
            className={`icon-button${helpOpen ? " active" : ""}`}
            aria-label={t("Hilfe zur Timeline", "Timeline help")}
            title={helpText}
            aria-expanded={helpOpen}
            aria-controls={`${view.id}-timeline-help`}
            onClick={() => setHelpOpen((open) => !open)}
          >
            <Info size={17} />
          </button>
        )}
        <button
          ref={settingsButton}
          className={`icon-button${settingsOpen ? " active" : ""}`}
          aria-label={t("Timeline-Einstellungen", "Timeline settings")}
          title={t("Timeline-Einstellungen", "Timeline settings")}
          aria-expanded={settingsOpen}
          aria-controls={`${view.id}-timeline-settings`}
          onClick={() => setSettingsOpen((open) => !open)}
        >
          <SlidersHorizontal size={17} />
        </button>
        {settingsOpen && (
          <div
            id={`${view.id}-timeline-settings`}
            className="timeline-settings"
            role="group"
            aria-label={t("Timeline-Einstellungen", "Timeline settings")}
            onKeyDown={(event) => {
              if (event.key !== "Escape") return;
              event.stopPropagation();
              setSettingsOpen(false);
              settingsButton.current?.focus();
            }}
          >
            <ZoomSlider frame={frame} t={t} />
            <GoToDate frame={frame} t={t} />
            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={weekends}
                disabled={busy}
                onChange={(event) => void configure({ showWeekends: event.target.checked })}
              />
              {t("Wochenenden markieren", "Mark weekends")}
            </label>
            <label>
              {t("Meilensteine", "Milestones")}
              <Select
                aria-label={t("Timeline: Meilensteine", "Timeline: milestones")}
                value={milestoneField?.id || ""}
                disabled={busy || !viewEditable}
                title={
                  config.milestoneOnlyField
                    ? t("Nur die gewählte Eigenschaft macht Einträge zu Meilensteinen (◆).", "Only the chosen property turns records into milestones (◆).")
                    : t("Eintägige Einträge sind immer Meilensteine (◆).", "Records of one day are always milestones (◆).")
                }
                onChange={(event) => void configure({ milestoneField: event.target.value || undefined })}
              >
                <option value="">{config.milestoneOnlyField ? t("Keine", "None||milestones") : t("Nur eintägige Einträge", "Only one-day records")}</option>
                {fields
                  .filter((f) => f.type === "checkbox")
                  .map((f) => (
                    <option key={f.id} value={f.id}>
                      {f.name}
                    </option>
                  ))}
              </Select>
            </label>
            <label className="checkbox-label" title={t("Eintägige Einträge bleiben dann Balken.", "Records of one day then stay bars.")}>
              <input
                type="checkbox"
                checked={!!config.milestoneOnlyField}
                disabled={busy || !viewEditable}
                onChange={(event) => void configure({ milestoneOnlyField: event.target.checked || undefined })}
              />
              {t("Nur das Meilensteinfeld macht Meilensteine", "Only the milestone property makes milestones")}
            </label>
            <fieldset className="timeline-label-fields">
              <legend>{t("Neben dem Titel zeigen", "Show beside the title")}</legend>
              {fields
                .filter((f, i) => i > 0 && f.id !== start?.id && f.id !== end?.id && f.type !== "relation")
                .map((f) => {
                  const chosen = labelFields.some((l) => l.id === f.id);
                  return (
                    <label key={f.id} className="checkbox-label">
                      <input
                        type="checkbox"
                        checked={chosen}
                        disabled={busy || !viewEditable || (!chosen && labelFields.length >= 4)}
                        onChange={(event) =>
                          void configure({
                            labelFields: event.target.checked
                              ? [...labelFields.map((l) => l.id), f.id]
                              : labelFields.map((l) => l.id).filter((id) => id !== f.id),
                          })
                        }
                      />
                      {f.name}
                    </label>
                  );
                })}
            </fieldset>
            <label>
              {t("Hierarchie-Feld", "Hierarchy property")}
              <Select
                aria-label={t("Timeline: Hierarchie-Feld", "Timeline: hierarchy property")}
                value={hierarchyField?.id || ""}
                disabled={busy || !viewEditable || !relations.length}
                title={t("Eine Relation auf diese Datenbank, die den übergeordneten Eintrag hält: Untereinträge stehen eingerückt darunter, übergeordnete Einträge zeigen einen Sammelbalken.", "A relation to this database holding the parent record: sub-records are indented below it, parents show a summary bar.")}
                onChange={(event) => void configure({ hierarchyField: event.target.value || undefined })}
              >
                <option value="">{relations.length ? t("Keine", "None||hierarchy") : t("Keine Selbstrelation", "No self-relation")}</option>
                {relations
                  .filter((f) => f.id !== dependencyField?.id)
                  .map((f) => (
                    <option key={f.id} value={f.id}>
                      {f.name}
                    </option>
                  ))}
              </Select>
            </label>
            {hierarchyField && (
              <label className="checkbox-label" title={t("Weichen die eigenen Daten eines übergeordneten Eintrags vom Sammelbalken ab, stehen sie als feine Linie darunter.", "When a parent's own dates differ from its summary bar, they show as a faint line below it.")}>
                <input
                  type="checkbox"
                  checked={!!config.summaryBaseline}
                  disabled={busy || !viewEditable}
                  onChange={(event) => void configure({ summaryBaseline: event.target.checked || undefined })}
                />
                {t("Eigene Daten als Grundlinie zeigen", "Show own dates as a baseline")}
              </label>
            )}
            <label>
              {t("Gruppieren nach", "Group by")}
              <Select
                aria-label={t("Timeline: Gruppieren nach", "Timeline: group by")}
                value={groupField?.id || ""}
                disabled={busy || !viewEditable}
                onChange={(event) => void configureView({ groupBy: event.target.value || undefined })}
              >
                <option value="">{t("Keine Gruppierung", "No grouping")}</option>
                {groupable.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.name}
                  </option>
                ))}
              </Select>
            </label>
            <label>
              {t("Farbe nach", "Colour by")}
              <Select
                aria-label={t("Timeline: Farbe nach", "Timeline: colour by")}
                value={colorField?.id || ""}
                disabled={busy || !viewEditable || !selectFields.length}
                title={selectFields.length ? t("Die Balken nehmen die Farbe der Option an.", "Bars take the colour of the option.") : t("Dafür eine Auswahl-Eigenschaft anlegen.", "Create a select property for that.")}
                onChange={(event) => void configure({ colorField: event.target.value || undefined })}
              >
                <option value="">{t("Einheitlich", "Uniform")}</option>
                {selectFields.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.name}
                  </option>
                ))}
              </Select>
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
                  {relations.length ? t("Keine", "None||dependency") : t("Keine Selbstrelation", "No self-relation")}
                </option>
                {relations
                  .filter((f) => f.id !== hierarchyField?.id)
                  .map((f) => (
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
                    await onSchema([...fields, field], { timeline: { ...migrateTimeline(config), dependencyField: field.id } });
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
                        {t.label()}
                      </option>
                    ))}
                  </Select>
                </label>
                <label>
                  {t("Nachfolger verschieben", "Move successors")}
                  <Select
                    aria-label={t("Timeline: Nachfolger verschieben", "Timeline: move successors")}
                    value={shiftMode}
                    disabled={busy || !viewEditable}
                    title={t(
                      "Nur bei Überschneidung: Wartende Einträge rücken nur so weit, wie die Abhängigkeit es verlangt; Puffer bleibt. Abstände halten: Sie rücken um dieselben Tage mit.",
                      "Only when dates overlap: waiting records move only as far as the dependency needs; slack stays. Keep the gaps: they move by the same days.",
                    )}
                    onChange={(event) => void configure({ shiftMode: event.target.value as ShiftMode, moveSuccessors: undefined })}
                  >
                    <option value="overlap">{t("Nur bei Überschneidung", "Only when dates overlap")}</option>
                    <option value="keep">{t("Abstände halten", "Keep the gaps")}</option>
                    <option value="off">{t("Aus", "Off||shift")}</option>
                  </Select>
                </label>
                <label
                  className="checkbox-label"
                  title={t(
                    "Mitverschobene Einträge beginnen und enden nie an einem Samstag oder Sonntag: Ein Beginn am Wochenende rückt auf Montag, die Zahl der Arbeitstage bleibt.",
                    "Records moved along never start or end on a Saturday or Sunday: a start on a weekend moves to Monday, the number of working days stays.",
                  )}
                >
                  <input
                    type="checkbox"
                    checked={settings.avoidWeekends}
                    disabled={busy || !viewEditable}
                    onChange={(event) => void configure({ avoidWeekends: event.target.checked || undefined })}
                  />
                  {t("Wochenenden meiden", "Avoid weekends")}
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
                <label>
                  {t("Pfeile zeigen", "Show arrows")}
                  <Select
                    aria-label={t("Timeline: Pfeile zeigen", "Timeline: show arrows")}
                    value={settings.arrowVisibility}
                    disabled={busy || !viewEditable}
                    title={t("Ausgeblendete Pfeile ändern nichts an den Abhängigkeiten und am kritischen Pfad.", "Hidden arrows change nothing about the dependencies and the critical path.")}
                    onChange={(event) => void configure({ arrowVisibility: event.target.value as ArrowVisibility })}
                  >
                    <option value="all">{t("Alle", "All||arrows")}</option>
                    <option value="critical">{t("Nur kritischer Pfad", "Only critical path")}</option>
                    <option value="selected">{t("Nur für den gewählten Eintrag", "Only for the chosen record")}</option>
                    <option value="hidden">{t("In dieser Ansicht ausblenden", "Hide in this view")}</option>
                  </Select>
                </label>
                <label>
                  {t("Pfeile über Balken", "Arrows over bars")}
                  <Select
                    aria-label={t("Timeline: Pfeile über Balken", "Timeline: arrows over bars")}
                    value={settings.arrowOverlap}
                    disabled={busy || !viewEditable}
                    onChange={(event) => void configure({ arrowOverlap: event.target.value as ArrowOverlap })}
                  >
                    <option value="opaque">{t("Deckend", "Opaque")}</option>
                    <option value="transparent">{t("Transparent", "Transparent")}</option>
                    <option value="behind">{t("Hinter Balken", "Behind bars")}</option>
                  </Select>
                </label>
                <label>
                  {t("Linienführung", "Routing")}
                  <Select
                    aria-label={t("Timeline: Linienführung", "Timeline: routing")}
                    value={settings.arrowRouting}
                    disabled={busy || !viewEditable}
                    onChange={(event) => void configure({ arrowRouting: event.target.value as ArrowRouting })}
                  >
                    <option value="orthogonal">{t("Rechtwinklig", "Orthogonal")}</option>
                    <option value="curved">{t("Geschwungen", "Curved")}</option>
                  </Select>
                </label>
                {redundant.length > 0 && (
                  <div className="timeline-redundant" role="note">
                    <p>
                      {redundant.length === 1
                        ? t("Eine Verknüpfung ergibt sich schon aus anderen:", "One link already follows from others:")
                        : t(`${redundant.length} Verknüpfungen ergeben sich schon aus anderen:`, `${redundant.length} links already follow from others:`)}
                    </p>
                    <ul>
                      {redundant.slice(0, 5).map((r) => (
                        <li key={`${r.from}>${r.to}`}>
                          <span>
                            {t(
                              `„${titleOf(r.from)}“ → „${titleOf(r.to)}“ (über ${r.via.map((v) => `„${titleOf(v)}“`).join(" → ")})`,
                              `“${titleOf(r.from)}” → “${titleOf(r.to)}” (via ${r.via.map((v) => `“${titleOf(v)}”`).join(" → ")})`,
                            )}
                          </span>
                          {canEdit && (
                            <button className="button compact" disabled={busy} onClick={() => void command({ action: "timeline.unlink", from: r.from, to: r.to })}>
                              {t("Entfernen", "Remove")}
                            </button>
                          )}
                        </li>
                      ))}
                    </ul>
                    {redundant.length > 5 && <p>{t(`… und ${redundant.length - 5} weitere`, `… and ${redundant.length - 5} more`)}</p>}
                  </div>
                )}
              </>
            )}
          </div>
        )}
      </div>
      {!start || invalidEnd ? (
        <p className="timeline-notice">
          {t("In den Ansichtseinstellungen gültige, unterschiedliche Datumsfelder für Beginn und Ende auswählen.", "Choose valid, different date fields for start and end in the view settings.")}
        </p>
      ) : (
        <>
          {helpOpen && (
            <p className="muted timeline-help" id={`${view.id}-timeline-help`}>
              {helpText}
            </p>
          )}
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
            ref={frame.scrollRef}
            aria-label={t("Zeitleiste horizontal scrollen", "Scroll the timeline horizontally")}
          >
            <div className="timeline-grid" ref={grid} style={frameStyle(frame, weekends)}>
              <div className="timeline-heading">
                <strong>
                  <span>{t("Eintrag", "Record")}</span>
                  {collapsible.length > 0 && (
                    <span className="timeline-outline-all">
                      <button
                        type="button"
                        className="icon-button"
                        aria-label={t("Alle aufklappen", "Expand all")}
                        title={t("Alle aufklappen", "Expand all")}
                        disabled={!outlineState.collapsed.size}
                        onClick={() => outlineState.set([])}
                      >
                        <ArrowsOutLineVertical size={15} />
                      </button>
                      <button
                        type="button"
                        className="icon-button"
                        aria-label={t("Alle zuklappen", "Collapse all")}
                        title={t("Alle zuklappen", "Collapse all")}
                        onClick={() => outlineState.set([...outline.childrenOf.keys(), ...outline.lines.filter((l) => l.type === "group").map((l) => l.id), ...outlineState.collapsed])}
                      >
                        <ArrowsInLineVertical size={15} />
                      </button>
                    </span>
                  )}
                </strong>
                <TimelineAxis frame={frame} tag={LOCALE_TAG} t={t} highlight={highlight} />
              </div>
              <TimelineArrows
                id={view.id}
                frame={frame}
                links={measured.links}
                obstacles={measured.obstacles}
                type={dependencyType}
                settings={{ visibility: settings.arrowVisibility, overlap: settings.arrowOverlap, routing: settings.arrowRouting }}
                focus={focus}
                hovered={hoverLink}
                onHover={hoverArrow}
                linking={linking}
              />
              {outline.lines.map((line) => {
                const row = line.type === "row" ? rowsById.get(line.id) || null : null;
                return (
                  <div
                    className={`timeline-entry${line.type === "group" ? " timeline-group" : ""}${line.type === "row" && line.children ? " is-parent" : ""}`}
                    key={line.id}
                    data-line-id={line.id}
                    data-row-id={row ? row.id : undefined}
                    onFocus={(event) => {
                      if ((event.target as HTMLElement).matches?.(":focus-visible")) setKeyLine(line.id);
                    }}
                    onBlur={(event) => {
                      if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setKeyLine((k) => (k === line.id ? null : k));
                    }}
                  >
                    {labelCell(line, row)}
                    {lane(line, row)}
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
