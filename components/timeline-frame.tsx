"use client";
// The scrolling frame of a timeline (#390), shared by the database view
// (components/database-timeline.tsx) and the published one
// (components/public-timeline.tsx): one continuous grid over the window,
// continuous zoom (buttons, slider, Ctrl/⌘ + wheel, pinch) around the
// cursor or the fingers, ‹/› by 80 % of the width, the two-row axis built
// only for the visible part, and the remembered scroll position.
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { distance, midpoint, pinchFactor, wheelFactor } from "@/lib/pinch-zoom";
import { readCollapsed, writeCollapsed } from "@/lib/timeline-tree";
import {
  arrowGeometry,
  arrowStep,
  axisSegments,
  clampDay,
  clampDayWidth,
  clipRange,
  MAX_DAY_WIDTH,
  milestoneBox,
  milestoneDay,
  MIN_DAY_WIDTH,
  DAY,
  dayAt,
  extendWindow,
  fitDayWidth,
  fitTarget,
  keyDay,
  initialLeft,
  readScrollDay,
  SCALE_DAY_WIDTH,
  scrollFor,
  settleDayWidth,
  sliderToZoom,
  stickyLabelLeft,
  timelineWindow,
  todayLeft,
  writeScrollDay,
  zoomStep,
  zoomToSlider,
  type ArrowBox,
  type AxisSegment,
  type DayRange,
  type LinkType,
  type SavedRange,
  type Scale,
} from "@/lib/timeline-scale";

type Translate = (de: string, en: string) => string;
const storage = () => {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
};
// How the visible part is told to the axis and the labels without
// re-rendering the whole timeline on every scroll frame.
type Viewport = { left: number; width: number };

export type TimelineFrame = ReturnType<typeof useTimelineFrame>;
export function useTimelineFrame({
  range,
  dayWidth: savedDayWidth,
  scale,
  data,
  today,
  storageId,
  onZoom,
}: {
  range?: SavedRange;
  dayWidth?: number;
  scale: Scale;
  data: DayRange | null;
  today: number;
  // Remembers the scroll position on this device (absent: not remembered).
  storageId?: string;
  // A changed zoom, to save (debounced; absent: not saved).
  onZoom?: (dayWidth: number) => void;
}) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  // The scroller as state too, so the listeners attach once it is there.
  const [scroller, setScroller] = useState<HTMLDivElement | null>(null);
  const [zoom, setZoom] = useState<number>();
  const [, setTick] = useState(0);
  const [extra, setExtra] = useState<DayRange | null>(null);
  // The visible lanes: width and the title column left of them.
  const [lane, setLane] = useState({ width: 800, label: 200 });
  const base = timelineWindow({ range, data, today, scale });
  const window_ = extendWindow(base, extra);
  const target = fitTarget(range, data, today, scale);
  const dayWidth = clampDayWidth(
    zoom ?? savedDayWidth ?? (range ? fitDayWidth(target.end - target.start, lane.width) : SCALE_DAY_WIDTH[scale]),
  );
  const ranged = !!range;
  // A day to put at a place after the next render: zooming, jumping, fitting.
  const anchor = useRef<{ day: number | "start"; px: number } | null>(null);
  const live = useRef({ start: window_.start, end: window_.end, dayWidth, lane, ranged, leftDay: NaN, restored: false });
  const listeners = useRef(new Set<() => void>());
  const viewport = useRef<Viewport>({ left: 0, width: 1600 });
  const saveTimer = useRef<number>(undefined);
  const scrollSave = useRef<number>(undefined);
  const pinchActive = useRef<() => boolean>(() => false);
  const onZoomRef = useRef(onZoom);
  onZoomRef.current = onZoom;
  const notify = () => {
    const el = scrollRef.current;
    // For the titles that stay in sight (.timeline-range-body in CSS).
    (el?.firstElementChild as HTMLElement | null)?.style.setProperty("--timeline-scroll", `${el!.scrollLeft}px`);
    if (el && (el.scrollLeft !== viewport.current.left || el.clientWidth !== viewport.current.width))
      viewport.current = { left: el.scrollLeft, width: el.clientWidth };
    for (const l of listeners.current) l();
  };
  // Restores the position, applies anchors and keeps the left day in place
  // when the window grows at its start or the zoom changes.
  useLayoutEffect(() => {
    const el = scrollRef.current,
      before = live.current;
    live.current = { ...before, start: window_.start, end: window_.end, dayWidth, lane, ranged };
    if (!el) return;
    if (!before.restored) {
      live.current.restored = true;
      const stored = storageId ? readScrollDay(storage(), storageId) : null;
      const day =
        stored ??
        initialLeft({ window: window_, ranged, today, scale });
      if (day < window_.start || day >= window_.end) {
        if (!ranged) {
          // Grow the window to the remembered day; placed on the next pass.
          anchor.current = { day, px: 0 };
          setExtra({ start: day - 14, end: day + 60 });
          return;
        }
        anchor.current = { day: "start", px: 0 };
      } else anchor.current = { day, px: 0 };
    }
    const a = anchor.current;
    if (a && (a.day === "start" || (a.day >= window_.start && a.day < window_.end))) {
      anchor.current = null;
      el.scrollLeft = a.day === "start" ? 0 : scrollFor(window_.start, a.day, a.px, dayWidth);
    } else if (!a && (before.start !== window_.start || before.dayWidth !== dayWidth) && Number.isFinite(before.leftDay)) {
      // At the very start it stays at the start (a fitted window that grew).
      el.scrollLeft = before.leftDay <= before.start + 0.01 ? 0 : scrollFor(window_.start, before.leftDay, 0, dayWidth);
    }
    live.current.leftDay = dayAt(window_.start, el.scrollLeft, 0, dayWidth);
    notify();
  });
  // The width of the lanes.
  useEffect(() => {
    const el = scroller;
    if (!el) return;
    const measure = () => {
      const grid = el.firstElementChild as HTMLElement | null;
      const label = grid ? parseFloat(getComputedStyle(grid).getPropertyValue("--timeline-label")) || 200 : 200;
      const width = Math.max(40, el.clientWidth - label);
      setLane((l) => (Math.abs(l.width - width) < 1 && l.label === label ? l : { width, label }));
      notify();
    };
    measure();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(el);
    return () => observer?.disconnect();
  }, [scroller]);
  function leftDay() {
    const el = scrollRef.current,
      l = live.current;
    return el ? dayAt(l.start, el.scrollLeft, 0, l.dayWidth) : l.leftDay;
  }
  // Scrolling: remembers the position and, without a saved range, grows
  // the window before the edge is reached.
  useEffect(() => {
    const el = scroller;
    if (!el) return;
    let frame = 0;
    const onScroll = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        const l = live.current;
        l.leftDay = dayAt(l.start, el.scrollLeft, 0, l.dayWidth);
        notify();
        if (storageId) {
          window.clearTimeout(scrollSave.current);
          const day = l.leftDay;
          scrollSave.current = window.setTimeout(() => writeScrollDay(storage(), storageId, day), 250);
        }
        if (l.ranged || anchor.current) return;
        const chunk = Math.max(90, Math.ceil((l.lane.width * 2) / l.dayWidth));
        if (el.scrollLeft < l.lane.width * 0.5) {
          anchor.current = { day: l.leftDay, px: 0 };
          setExtra((x) => ({ start: Math.min(x?.start ?? Infinity, l.start) - chunk, end: Math.max(x?.end ?? -Infinity, l.end) }));
        } else if (el.scrollLeft + el.clientWidth > el.scrollWidth - l.lane.width * 0.5)
          setExtra((x) => ({ start: Math.min(x?.start ?? Infinity, l.start), end: Math.max(x?.end ?? -Infinity, l.end) + chunk }));
      });
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      el.removeEventListener("scroll", onScroll);
      cancelAnimationFrame(frame);
    };
  }, [scroller, storageId]);
  function save(value: number) {
    if (!onZoomRef.current) return;
    window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => onZoomRef.current?.(settleDayWidth(value)), 600);
  }
  useEffect(() => () => window.clearTimeout(saveTimer.current), []);
  // Zooms to `to` keeping the day at `px` (default: the middle) in place.
  function zoomTo(to: number, px = live.current.lane.width / 2, persist = true) {
    const from = live.current.dayWidth,
      next = clampDayWidth(to);
    // Before the last zoom is laid out its anchor tells where the days are.
    const pending = anchor.current;
    const day = pending && pending.day !== "start" ? pending.day + (px - pending.px) / from : leftDay() + px / from;
    anchor.current = { day, px };
    live.current.dayWidth = next;
    setZoom(next);
    if (persist) save(next);
  }
  function goTo(day: number, px = 0) {
    const d = clampDay(day),
      l = live.current;
    if (d < l.start || d >= l.end) setExtra((x) => extendWindow({ start: Math.min(x?.start ?? d, d) - 7, end: Math.max(x?.end ?? d, d) + 60 }, null));
    anchor.current = { day: d, px };
    // Re-render even when nothing else changes.
    setTick((n) => n + 1);
  }
  // Ctrl/⌘ + wheel (also a trackpad pinch) and two fingers zoom.
  useEffect(() => {
    const el = scroller;
    if (!el) return;
    const px = (clientX: number) => Math.max(0, clientX - el.getBoundingClientRect().left - live.current.lane.label);
    const wheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      zoomTo(live.current.dayWidth * wheelFactor(event.deltaY, event.deltaMode), px(event.clientX));
    };
    let pinch: { distance: number; dayWidth: number; day: number } | null = null;
    pinchActive.current = () => pinch !== null;
    const points = (e: TouchEvent) => [0, 1].map((i) => ({ x: e.touches[i].clientX, y: e.touches[i].clientY }));
    const start = (event: TouchEvent) => {
      if (event.touches.length !== 2) return;
      const [a, b] = points(event),
        mid = midpoint(a, b);
      pinch = { distance: distance(a, b), dayWidth: live.current.dayWidth, day: leftDay() + px(mid.x) / live.current.dayWidth };
    };
    const move = (event: TouchEvent) => {
      if (!pinch || event.touches.length !== 2) return;
      if (event.cancelable) event.preventDefault();
      const [a, b] = points(event);
      const next = clampDayWidth(pinch.dayWidth * pinchFactor(pinch.distance, distance(a, b)));
      anchor.current = { day: pinch.day, px: px(midpoint(a, b).x) };
      live.current.dayWidth = next;
      setZoom(next);
    };
    const end = (event: TouchEvent) => {
      if (pinch && event.touches.length < 2) {
        save(live.current.dayWidth);
        pinch = null;
      }
    };
    el.addEventListener("wheel", wheel, { passive: false });
    el.addEventListener("touchstart", start, { passive: true });
    el.addEventListener("touchmove", move, { passive: false });
    el.addEventListener("touchend", end);
    el.addEventListener("touchcancel", end);
    return () => {
      el.removeEventListener("wheel", wheel);
      el.removeEventListener("touchstart", start);
      el.removeEventListener("touchmove", move);
      el.removeEventListener("touchend", end);
      el.removeEventListener("touchcancel", end);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scroller]);
  return {
    scrollRef: (el: HTMLDivElement | null) => {
      scrollRef.current = el;
      setScroller(el);
    },
    scroller: scrollRef,
    window: window_,
    dayWidth,
    lane,
    today,
    zoomTo,
    zoomIn: () => zoomTo(zoomStep(live.current.dayWidth, 1)),
    zoomOut: () => zoomTo(zoomStep(live.current.dayWidth, -1)),
    goTo,
    // "Einpassen": the saved range, else all records, at the zoom that fits.
    fit() {
      const t = fitTarget(range, data, today, scale);
      const next = fitDayWidth(t.end - t.start, live.current.lane.width);
      setExtra((x) => extendWindow(x || t, t));
      anchor.current = { day: t.start, px: 0 };
      live.current.dayWidth = next;
      setZoom(next);
      save(next);
    },
    showToday: () => goTo(todayLeft(today, live.current.lane.width, live.current.dayWidth)),
    step(direction: 1 | -1) {
      const el = scrollRef.current;
      if (el) el.scrollLeft += arrowStep(live.current.lane.width) * direction;
    },
    // A new range or scale: the saved (or fitting) zoom and its start.
    reset(dayWidth?: number) {
      // A zoom still waiting to be saved would overwrite the new one.
      window.clearTimeout(saveTimer.current);
      setExtra(null);
      setZoom(dayWidth);
      const half = live.current.lane.width / 2;
      anchor.current = dayWidth === undefined ? { day: "start", px: 0 } : { day: leftDay() + half / live.current.dayWidth, px: half };
      if (dayWidth !== undefined) live.current.dayWidth = dayWidth;
    },
    subscribe(listener: () => void) {
      listeners.current.add(listener);
      return () => listeners.current.delete(listener);
    },
    viewport: () => viewport.current,
    leftDay,
    // Two fingers are zooming (a held bar must not start moving then).
    pinching: () => pinchActive.current(),
  };
}
const SERVER_VIEWPORT: Viewport = { left: 0, width: 1600 };
export function useViewport(frame: TimelineFrame) {
  return useSyncExternalStore(frame.subscribe, frame.viewport, () => SERVER_VIEWPORT);
}
// Grid lines: every day from 12 px, every week from 2 px, else none.
export function frameStyle(frame: TimelineFrame, weekends: boolean) {
  const { window: w, dayWidth } = frame;
  const width = (w.end - w.start) * dayWidth;
  const weekOffset = -((new Date(w.start * DAY).getUTCDay() + 6) % 7) * dayWidth;
  return {
    "--timeline-width": `${width}px`,
    "--timeline-day": `${dayWidth}px`,
    "--timeline-line": `${dayWidth >= 12 ? dayWidth : dayWidth >= 2 ? dayWidth * 7 : width + 1}px`,
    "--timeline-line-offset": `${dayWidth >= 12 ? 0 : weekOffset}px`,
    "--timeline-week-offset": `${weekOffset}px`,
    "--timeline-weekend-color": weekends ? "color-mix(in srgb, var(--muted) 7%, transparent)" : "transparent",
  } as React.CSSProperties;
}

function format(day: number, tag: string, options: Intl.DateTimeFormatOptions) {
  return new Date(day * DAY).toLocaleDateString(tag, { ...options, timeZone: "UTC" });
}
function segmentLabel(s: AxisSegment, tag: string, t: Translate, width: number, top: boolean) {
  if (s.unit === "year") return String(s.value);
  if (s.unit === "quarter") return `${t("Q", "Q||quarter")}${s.value}${top ? ` ${s.year}` : ""}`;
  if (s.unit === "week") return width >= 40 ? `${t("KW", "W||calendar week")} ${s.value}` : String(s.value);
  if (s.unit === "day")
    return width >= 56 ? format(s.start, tag, { weekday: "short", day: "numeric" }) : String(s.value);
  return format(s.start, tag, top ? { month: "long", year: "numeric" } : { month: width >= 70 ? "long" : "short" });
}
// The two rows of the axis, for the visible part (plus a screen either side).
// `highlight`: the days of the bar under the pointer or being dragged,
// marked in the axis with its first and last day (#395).
export function TimelineAxis({
  frame,
  tag,
  t,
  highlight,
}: {
  frame: TimelineFrame;
  tag: string;
  t: Translate;
  highlight?: { start: number; end: number } | null;
}) {
  const view = useViewport(frame);
  const { window: w, dayWidth } = frame;
  const from = w.start + (view.left - view.width) / dayWidth,
    to = w.start + (view.left + view.width * 2) / dayWidth;
  const { top, bottom } = axisSegments(w, dayWidth, from, to);
  const visibleLeft = view.left;
  const pos = (s: AxisSegment) => ({ left: (s.start - w.start) * dayWidth, width: (s.end - s.start) * dayWidth });
  const today = frame.today;
  return (
    <div className="timeline-axis" data-units={`${top[0]?.unit || ""}-${bottom[0]?.unit || ""}`}>
      {top.map((s) => {
        const p = pos(s),
          text = segmentLabel(s, tag, t, p.width, true);
        const labelWidth = Math.min(p.width, text.length * 6.5 + 10);
        return (
          <span key={`t${s.start}`} className="timeline-axis-top" style={{ left: p.left, width: p.width }}>
            <span style={{ left: stickyLabelLeft(p.left, p.left + p.width, visibleLeft, labelWidth) - p.left }}>{text}</span>
          </span>
        );
      })}
      {bottom.map((s) => {
        const p = pos(s);
        return (
          <span
            key={`b${s.start}`}
            className={`timeline-axis-bottom${s.unit === "day" && today === s.start ? " is-today" : ""}`}
            style={{ left: p.left, width: p.width }}
            title={s.unit === "week" ? `${t("Kalenderwoche", "Calendar week")} ${s.value} (${s.year})` : undefined}
          >
            {p.width >= 14 ? segmentLabel(s, tag, t, p.width, false) : ""}
          </span>
        );
      })}
      {highlight && highlight.end + 1 > w.start && highlight.start < w.end && (
        <span
          className="timeline-axis-highlight"
          aria-hidden="true"
          style={{ left: (Math.max(highlight.start, w.start) - w.start) * dayWidth, width: (Math.min(highlight.end + 1, w.end) - Math.max(highlight.start, w.start)) * dayWidth }}
        >
          <span className="timeline-axis-day start">{format(highlight.start, tag, { day: "numeric", month: "short" })}</span>
          {highlight.end > highlight.start && <span className="timeline-axis-day end">{format(highlight.end, tag, { day: "numeric", month: "short" })}</span>}
        </span>
      )}
    </div>
  );
}
// The visible days, e.g. "3. Nov. 2026 – 12. Jan. 2027".
export function VisibleRange({ frame, tag }: { frame: TimelineFrame; tag: string }) {
  const view = useViewport(frame);
  const { window: w, dayWidth, lane } = frame;
  const a = Math.floor(w.start + view.left / dayWidth),
    b = Math.min(w.end - 1, Math.ceil(w.start + (view.left + lane.width) / dayWidth) - 1);
  const o: Intl.DateTimeFormatOptions = { day: "numeric", month: "short", year: "numeric" };
  return (
    <strong className="timeline-visible">
      {format(a, tag, o)} – {format(Math.max(a, b), tag, o)}
    </strong>
  );
}
// "Gehe zu": the first visible day; a date entered scrolls there.
export function GoToDate({ frame, t }: { frame: TimelineFrame; t: Translate }) {
  const view = useViewport(frame);
  const day = Math.min(frame.window.end - 1, Math.max(frame.window.start, Math.floor(frame.window.start + view.left / frame.dayWidth + 0.01)));
  return (
    <label>
      {t("Gehe zu", "Go to")}
      <input
        aria-label={t("Timeline: Datum", "Timeline: date")}
        type="date"
        min="0001-01-01"
        max="9999-12-31"
        value={new Date(day * DAY).toISOString().slice(0, 10)}
        onChange={(event) => {
          const next = keyDay(event.target.value);
          if (next !== null) frame.goTo(next);
        }}
      />
    </label>
  );
}
// ‹ Heute › and the zoom: −, slider, +, Einpassen.
export function TimelineNavigation({ frame, t, extra }: { frame: TimelineFrame; t: Translate; extra?: React.ReactNode }) {
  return (
    <>
      <button className="icon-button" aria-label={t("Timeline: vorheriger Zeitraum", "Timeline: previous period")} title={t("Zurück", "Back")} onClick={() => frame.step(-1)}>
        <span aria-hidden="true">‹</span>
      </button>
      <button className="button compact" onClick={frame.showToday} title={t("Heute (T)", "Today (T)")}>
        {t("Heute", "Today")}
      </button>
      <button className="icon-button" aria-label={t("Timeline: nächster Zeitraum", "Timeline: next period")} title={t("Weiter", "Forward")} onClick={() => frame.step(1)}>
        <span aria-hidden="true">›</span>
      </button>
      {extra}
    </>
  );
}
// −, + and Einpassen in the header line; the slider (fine zoom) sits in
// the settings.
export function TimelineZoom({ frame, t }: { frame: TimelineFrame; t: Translate }) {
  const { dayWidth } = frame;
  return (
    <span className="timeline-zoom" role="group" aria-label={t("Zoom", "Zoom")}>
      <button className="icon-button" aria-label={t("Timeline: verkleinern", "Timeline: zoom out")} title={t("Verkleinern (−)", "Zoom out (−)")} disabled={dayWidth <= MIN_DAY_WIDTH} onClick={frame.zoomOut}>
        <span aria-hidden="true">−</span>
      </button>
      <button className="icon-button" aria-label={t("Timeline: vergrößern", "Timeline: zoom in")} title={t("Vergrößern (+)", "Zoom in (+)")} disabled={dayWidth >= MAX_DAY_WIDTH} onClick={frame.zoomIn}>
        <span aria-hidden="true">+</span>
      </button>
      <button className="button compact" onClick={frame.fit} title={t("Alles einpassen (F)", "Fit everything (F)")}>
        {t("Einpassen", "Fit")}
      </button>
    </span>
  );
}
export function ZoomSlider({ frame, t }: { frame: TimelineFrame; t: Translate }) {
  const { dayWidth } = frame;
  return (
    <label className="timeline-zoom-slider">
      {t("Zoom", "Zoom")}
      <input
        type="range"
        min={0}
        max={100}
        step={1}
        aria-label={t("Timeline: Zoom", "Timeline: zoom")}
        aria-valuetext={t(`${Math.round(dayWidth * 10) / 10} Pixel pro Tag`, `${Math.round(dayWidth * 10) / 10} pixels per day`)}
        value={zoomToSlider(dayWidth)}
        onChange={(event) => frame.zoomTo(sliderToZoom(Number(event.target.value)))}
      />
    </label>
  );
}
// The scale menu: the presets of the zoom (#390), the main control.
export function scaleOptions(t: Translate): [Scale, string][] {
  return [
    ["day", t("Tag", "Day")],
    ["week", t("Woche", "Week")],
    ["twoWeeks", t("2 Wochen", "2 weeks")],
    ["month", t("Monat", "Month")],
    ["quarter", t("Quartal", "Quarter")],
    ["year", t("Jahr", "Year")],
    ["fiveYears", t("5 Jahre", "5 years")],
  ];
}
// Where a record's bar or milestone (◆) lies in the window.
export function barPlacement(
  range: { start: number; end: number },
  flagged: boolean,
  period: { start: number; end: number; dayWidth: number },
  onlyFlagged = false,
) {
  const day = milestoneDay(range, flagged, onlyFlagged);
  return day !== null
    ? { box: milestoneBox(day, period), milestone: true }
    : { box: clipRange(range.start, range.end, period), milestone: false };
}
// A bar's title and, muted, the properties shown with it. Inside the bar
// the text sticks to the left edge of the lanes while the bar's start is
// scrolled away (CSS position: sticky).
export function BarText({ name, detail }: { name: string; detail?: string }) {
  return (
    <span className="timeline-range-text">
      {name}
      {detail && <span className="timeline-range-detail"> · {detail}</span>}
    </span>
  );
}
// T, F, + and − while the timeline has the focus (not in fields).
export function timelineKey(event: React.KeyboardEvent, frame: TimelineFrame) {
  const target = event.target as HTMLElement;
  if (event.ctrlKey || event.metaKey || event.altKey || event.defaultPrevented) return;
  if (target.closest("input, select, textarea, [contenteditable='true'], .fp-select, [role='listbox'], [role='dialog']")) return;
  const key = event.key.toLowerCase();
  const run = key === "t" ? frame.showToday : key === "f" ? frame.fit : key === "+" || key === "=" ? frame.zoomIn : key === "-" ? frame.zoomOut : null;
  if (!run) return;
  event.preventDefault();
  run();
}

// ---- dependency arrows (#395) ----
// Which arrows are drawn, how they cross bars they do not link and their
// shape (lib/timeline-plan.ts timelineSettings).
export type ArrowSettings = {
  visibility: "all" | "critical" | "selected" | "hidden";
  overlap: "opaque" | "transparent" | "behind";
  routing: "curved" | "orthogonal";
};
export const DEFAULT_ARROWS: ArrowSettings = { visibility: "all", overlap: "opaque", routing: "curved" };
// A link between two shown lines (rows, or the collapsed line a hidden
// record shows on) with the boxes of their bars; null: the line has no bar
// in the window.
export type MeasuredLink = {
  key: string;
  from: string;
  to: string;
  a: ArrowBox | null;
  b: ArrowBox | null;
  conflict: boolean;
  critical: boolean;
  fresh?: boolean;
};
export type ArrowObstacle = { x: number; y: number; width: number; height: number };
type BoxOf = (el: HTMLElement, origin: DOMRect) => { x: number; y: number };
const round = (n: number) => Math.round(n * 10) / 10;
// The bars of the lines (`data-line-id` on .timeline-entry) the links join.
export function measureLinks(
  root: HTMLElement,
  links: { key: string; from: string; to: string; conflict: boolean; critical: boolean; fresh?: boolean }[],
  boxOf: BoxOf,
): MeasuredLink[] {
  if (!links.length) return [];
  const origin = root.getBoundingClientRect();
  const boxes = new Map<string, ArrowBox | null | undefined>();
  const bar = (id: string) => {
    if (boxes.has(id)) return boxes.get(id);
    const line = root.querySelector<HTMLElement>(`[data-line-id="${CSS.escape(id)}"]`);
    const el = line?.querySelector<HTMLElement>(":scope > .timeline-lane > .timeline-range");
    let value: ArrowBox | null | undefined = line ? null : undefined;
    if (el) {
      const at = boxOf(el, origin);
      value = { left: round(at.x), right: round(at.x + el.offsetWidth), top: round(at.y), height: el.offsetHeight };
    }
    boxes.set(id, value);
    return value;
  };
  const out: MeasuredLink[] = [];
  for (const link of links) {
    const a = bar(link.from),
      b = bar(link.to);
    if (a === undefined || b === undefined || (!a && !b)) continue;
    out.push({ ...link, a, b });
  }
  return out;
}
// Bars and the titles beside them, which "Transparent" arrows cross faintly.
export function measureObstacles(root: HTMLElement, boxOf: BoxOf): ArrowObstacle[] {
  const origin = root.getBoundingClientRect();
  return [...root.querySelectorAll<HTMLElement>(".timeline-range, .timeline-range-label")]
    .filter((el) => el.offsetWidth > 0)
    .map((el) => {
      const at = boxOf(el, origin);
      return { x: round(at.x), y: round(at.y), width: el.offsetWidth, height: el.offsetHeight };
    });
}
// The arrows: drawn for the visible part (an end out of sight becomes a
// stub), filtered by the view's choice, the hovered or selected record's
// own ones in front (`focus`, a line id) and the others dimmed; a hovered
// arrow (`hovered`, its key) alone in front. `onHover` makes them
// hoverable.
export function TimelineArrows({
  id,
  frame,
  links,
  obstacles = [],
  type,
  settings = DEFAULT_ARROWS,
  focus,
  hovered,
  onHover,
  linking,
}: {
  id: string;
  frame: TimelineFrame;
  links: MeasuredLink[];
  obstacles?: ArrowObstacle[];
  type: LinkType;
  settings?: ArrowSettings;
  focus?: string | null;
  hovered?: string | null;
  onHover?: (key: string | null) => void;
  linking?: { x1: number; y1: number; x2: number; y2: number } | null;
}) {
  const view = useViewport(frame);
  const visible = { left: view.left + frame.lane.label, right: view.left + view.width };
  const touches = (l: MeasuredLink) => !!focus && (l.from === focus || l.to === focus);
  const shown =
    settings.visibility === "hidden"
      ? []
      : links.filter(
          (l) =>
            settings.visibility === "all" ||
            l.key === hovered ||
            touches(l) ||
            (settings.visibility === "critical" && l.critical),
        );
  const drawn = shown
    .map((l) => ({ link: l, geometry: arrowGeometry(l.a, l.b, type, settings.routing, visible) }))
    .filter((x): x is { link: MeasuredLink; geometry: { d: string; stub: boolean } } => !!x.geometry);
  if (!drawn.length && !linking) return null;
  const hoveredShown = !!hovered && drawn.some((x) => x.link.key === hovered);
  const focusShown = !hoveredShown && drawn.some((x) => touches(x.link));
  const inFront = (l: MeasuredLink) => (hoveredShown ? l.key === hovered : focusShown && touches(l));
  const mask = settings.overlap === "transparent" ? `timeline-mask-${id}` : null;
  return (
    <>
    {onHover && drawn.length > 0 && (
      // Below the bars: arrows are hovered between them, never over the
      // handles at a bar's ends.
      <svg className="timeline-arrow-hits" aria-hidden="true">
        {drawn.map(({ link, geometry }) => (
          <path key={link.key} d={geometry.d} onPointerEnter={() => onHover(link.key)} onPointerLeave={() => onHover(null)} />
        ))}
      </svg>
    )}
    <svg
      className={`timeline-dependencies${settings.overlap === "behind" ? " is-behind" : ""}${hoveredShown || focusShown ? " has-focus" : ""}`}
      aria-hidden="true"
    >
      <defs>
        {(["ok", "conflict", "critical"] as const).map((kind) => (
          // One size for every arrow (a thicker line in front or on the
          // critical path keeps the head of a thin one).
          <marker key={kind} id={`timeline-arrow-${id}-${kind}`} className={kind} viewBox="0 0 8 8" refX="2" refY="4" markerUnits="userSpaceOnUse" markerWidth="12" markerHeight="12" orient="auto">
            <path d="M0 0 L8 4 L0 8 z" />
          </marker>
        ))}
        {mask && (
          <mask id={mask} maskUnits="userSpaceOnUse" x="0" y="0" width="100%" height="100%">
            <rect x="0" y="0" width="100%" height="100%" fill="white" />
            {obstacles.map((o, i) => (
              <rect key={i} x={o.x} y={o.y} width={o.width} height={o.height} fill="rgb(64,64,64)" />
            ))}
          </mask>
        )}
      </defs>
      {drawn.map(({ link, geometry }) => {
        const front = inFront(link);
        return (
          <path
            key={link.key}
            d={geometry.d}
            data-link={link.key}
            pathLength={link.fresh && !link.conflict && !geometry.stub ? 1 : undefined}
            mask={mask && !front ? `url(#${mask})` : undefined}
            className={
              [
                link.conflict ? "conflict" : link.critical ? "critical" : "",
                link.fresh && !geometry.stub ? "is-new" : "",
                geometry.stub ? "stub" : "",
                front ? "is-focus" : hoveredShown || focusShown ? "is-dimmed" : "",
              ]
                .filter(Boolean)
                .join(" ") || undefined
            }
            markerEnd={`url(#timeline-arrow-${id}-${link.conflict ? "conflict" : link.critical ? "critical" : "ok"})`}
          />
        );
      })}
      {linking && <path className="linking" d={`M ${linking.x1} ${linking.y1} L ${linking.x2} ${linking.y2}`} markerEnd={`url(#timeline-arrow-${id}-ok)`} />}
    </svg>
    </>
  );
}

// ---- rows out of sight (#395) ----
// A small ← or → at the edge of the lanes in a row whose bar is scrolled
// out of sight (or outside the window: `text` then says so); it jumps there.
export function OffscreenChip({
  frame,
  range,
  label,
  text,
  title,
  tag,
}: {
  frame: TimelineFrame;
  tag: string;
  range: { start: number; end: number };
  // The accessible name.
  label: string;
  // Visible text after the arrow (default: the first day).
  text?: string;
  title?: string;
}) {
  const view = useViewport(frame);
  const { window: w, dayWidth, lane } = frame;
  const first = w.start + view.left / dayWidth,
    last = w.start + (view.left + lane.width) / dayWidth;
  const side = range.end + 1 <= first ? "left" : range.start >= last ? "right" : null;
  if (!side) return null;
  return (
    <button
      type="button"
      className={`timeline-offscreen ${side}`}
      style={{ left: side === "left" ? view.left + 6 : view.left + lane.width - 6 }}
      aria-label={label}
      title={title || label}
      onClick={() => frame.goTo(range.start - 2)}
    >
      <span aria-hidden="true">{side === "left" ? "←" : "→"}</span>
      {text ?? format(range.start, tag, { day: "numeric", month: "short" })}
    </button>
  );
}

// ---- outline (#394) ----
// Collapsed parents and groups (remembered per view on this device when
// `storageId` is given) and the motion of opening and closing them: rows
// that appear grow from nothing below their parent and fade in, rows that
// go fold away, the rows below move along (about 220 ms, ease-out); the
// arrows are measured again on every frame meanwhile (`onFrame`). Instant
// when `motion()` says no (reduced motion) or many rows change at once.
const FOLD_MS = 220;
const FOLD_EASE = "cubic-bezier(0.2, 0.8, 0.2, 1)";
export function useOutline({
  storageId,
  grid,
  motion,
  lines,
  onFrame,
}: {
  storageId?: string;
  grid: React.RefObject<HTMLElement | null>;
  motion: () => boolean;
  // The line ids shown for a collapsed set.
  lines: (collapsed: ReadonlySet<string>) => string[];
  onFrame: () => void;
}) {
  const [collapsed, setCollapsed] = useState<Set<string>>(() => (storageId ? readCollapsed(storage(), storageId) : new Set()));
  const current = useRef(collapsed);
  current.current = collapsed;
  const entering = useRef<string[] | null>(null);
  const busyUntil = useRef(0);
  const frameRef = useRef(onFrame);
  frameRef.current = onFrame;
  const follow = () => {
    const until = performance.now() + FOLD_MS + 40;
    busyUntil.current = Date.now() + FOLD_MS + 80;
    const tick = () => {
      frameRef.current();
      if (performance.now() < until) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  };
  const commit = (next: Set<string>) => {
    setCollapsed(next);
    if (storageId) writeCollapsed(storage(), storageId, next);
  };
  function change(next: Set<string>) {
    const root = grid.current;
    const before = lines(current.current),
      after = lines(next);
    const was = new Set(before),
      will = new Set(after);
    const gone = before.filter((id) => !will.has(id)),
      added = after.filter((id) => !was.has(id));
    if (!root || !motion() || gone.length + added.length > 150 || typeof root.animate !== "function") {
      commit(next);
      return;
    }
    entering.current = added;
    const leaving = gone
      .map((id) => root.querySelector<HTMLElement>(`[data-line-id="${CSS.escape(id)}"]`))
      .filter((el): el is HTMLElement => !!el);
    if (!leaving.length) {
      commit(next);
      return;
    }
    follow();
    let left = leaving.length,
      finished = false;
    const done = () => {
      if (finished || --left > 0) return;
      finished = true;
      commit(next);
      // Rows still there afterwards (another change came between) come back.
      requestAnimationFrame(() => {
        for (const el of leaving)
          if (el.isConnected) {
            for (const a of el.getAnimations()) a.cancel();
            delete el.dataset.folding;
          }
      });
    };
    for (const el of leaving) {
      const height = el.offsetHeight;
      el.dataset.folding = "";
      const a = el.animate(
        [
          { height: `${height}px`, opacity: 1, transform: "none" },
          { height: "0px", opacity: 0, transform: "translateY(-8px)" },
        ],
        { duration: FOLD_MS, easing: FOLD_EASE, fill: "forwards" },
      );
      a.onfinish = done;
      a.oncancel = done;
    }
  }
  useLayoutEffect(() => {
    const ids = entering.current,
      root = grid.current;
    entering.current = null;
    if (!ids?.length || !root) return;
    let started = false;
    for (const id of ids) {
      const el = root.querySelector<HTMLElement>(`[data-line-id="${CSS.escape(id)}"]`);
      if (!el) continue;
      started = true;
      const height = el.offsetHeight;
      el.dataset.folding = "";
      const a = el.animate(
        [
          { height: "0px", opacity: 0, transform: "translateY(-8px)" },
          { height: `${height}px`, opacity: 1, transform: "none" },
        ],
        { duration: FOLD_MS, easing: FOLD_EASE },
      );
      a.onfinish = a.oncancel = () => delete el.dataset.folding;
    }
    if (started) follow();
  });
  return {
    collapsed,
    toggle: (id: string) => {
      const next = new Set(current.current);
      if (!next.delete(id)) next.add(id);
      change(next);
    },
    set: (ids: Iterable<string>) => change(new Set(ids)),
    // Rows are folding: other glides keep still.
    moving: () => Date.now() < busyUntil.current,
  };
}
// ▾/▸ before a parent's or group's name.
export function OutlineToggle({
  name,
  collapsed,
  onToggle,
  t,
}: {
  name: string;
  collapsed: boolean;
  onToggle: () => void;
  t: Translate;
}) {
  return (
    <button
      type="button"
      className="timeline-outline-toggle"
      aria-expanded={!collapsed}
      aria-label={collapsed ? t(`${name} aufklappen`, `Expand ${name}`) : t(`${name} zuklappen`, `Collapse ${name}`)}
      title={collapsed ? t("Aufklappen", "Expand") : t("Zuklappen", "Collapse")}
      onClick={onToggle}
    >
      <span aria-hidden="true">{collapsed ? "▸" : "▾"}</span>
    </button>
  );
}
// Where a summary bar's or milestone's title goes: right of it, or left
// where the window ends.
export const besideLabel = (box: { left: number; width: number }, width: number) =>
  width - box.left - box.width >= 120 || box.left < 120 ? "right" : "left";
