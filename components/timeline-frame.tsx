"use client";
// The scrolling frame of a timeline (#390), shared by the database view
// (components/database-timeline.tsx) and the published one
// (components/public-timeline.tsx): one continuous grid over the window,
// continuous zoom (buttons, slider, Ctrl/⌘ + wheel, pinch) around the
// cursor or the fingers, ‹/› by 80 % of the width, the two-row axis built
// only for the visible part, and the remembered scroll position.
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { distance, midpoint, pinchFactor, wheelFactor } from "@/lib/pinch-zoom";
import {
  arrowPath,
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
export function TimelineAxis({ frame, tag, t }: { frame: TimelineFrame; tag: string; t: Translate }) {
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
) {
  const day = milestoneDay(range, flagged);
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

export type TimelineArrow = { key: string; d: string; conflict: boolean; critical?: boolean; fresh?: boolean };
// Arrows between the rendered bars of `root` (bars carry data-row-id on
// their .timeline-entry). `box` measures a bar inside the root.
export function measureArrows(
  root: HTMLElement,
  links: { from: string; to: string; shift: number }[],
  type: LinkType,
  critical: Set<string>,
  cyclic: Set<string>,
  box: (el: HTMLElement, origin: DOMRect) => { x: number; y: number },
): TimelineArrow[] {
  const next: TimelineArrow[] = [];
  if (!links.length) return next;
  const origin = root.getBoundingClientRect();
  const bar = (id: string): ArrowBox | undefined => {
    const el = root.querySelector<HTMLElement>(`[data-row-id="${CSS.escape(id)}"] .timeline-range`);
    if (!el) return undefined;
    const at = box(el, origin);
    return { left: at.x, right: at.x + el.offsetWidth, top: at.y, height: el.offsetHeight };
  };
  for (const link of links) {
    const a = bar(link.from),
      b = bar(link.to);
    if (!a || !b) continue;
    next.push({
      key: `${link.from}>${link.to}`,
      d: arrowPath(a, b, type),
      conflict: link.shift > 0 || cyclic.has(link.to),
      critical: critical.has(link.from) && critical.has(link.to),
    });
  }
  return next;
}
export function TimelineArrows({
  id,
  arrows,
  linking,
}: {
  id: string;
  arrows: TimelineArrow[];
  linking?: { x1: number; y1: number; x2: number; y2: number } | null;
}) {
  if (!arrows.length && !linking) return null;
  return (
    <svg className="timeline-dependencies" aria-hidden="true">
      <defs>
        {(["ok", "conflict"] as const).map((kind) => (
          <marker key={kind} id={`timeline-arrow-${id}-${kind}`} className={kind} viewBox="0 0 8 8" refX="2" refY="4" markerWidth="8" markerHeight="8" orient="auto">
            <path d="M0 0 L8 4 L0 8 z" />
          </marker>
        ))}
      </defs>
      {arrows.map((arrow) => (
        <path
          key={arrow.key}
          d={arrow.d}
          pathLength={arrow.fresh && !arrow.conflict ? 1 : undefined}
          className={[arrow.conflict ? "conflict" : arrow.critical ? "critical" : "", arrow.fresh ? "is-new" : ""].filter(Boolean).join(" ") || undefined}
          markerEnd={`url(#timeline-arrow-${id}-${arrow.conflict ? "conflict" : "ok"})`}
        />
      ))}
      {linking && <path className="linking" d={`M ${linking.x1} ${linking.y1} L ${linking.x2} ${linking.y2}`} markerEnd={`url(#timeline-arrow-${id}-ok)`} />}
    </svg>
  );
}
