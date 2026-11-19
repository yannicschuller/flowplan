"use client";
// The published timeline (#390): the app's layout read-only – the same
// window and zoom the view stores, the two-row axis, weekends, today's
// line, dependency arrows and the critical path. Readers scroll and zoom;
// nothing is saved. The server (components/public-views.tsx) hands over
// only public properties.
import { useLayoutEffect, useRef, useState } from "react";
import { useT } from "./i18n";
import { dataRange, outsideLabel, type LinkType, type SavedRange, type Scale } from "@/lib/timeline-scale";
import {
  barPlacement,
  BarText,
  frameStyle,
  measureArrows,
  TimelineArrows,
  TimelineAxis,
  timelineKey,
  TimelineNavigation,
  TimelineZoom,
  useTimelineFrame,
  VisibleRange,
  type TimelineArrow,
} from "./timeline-frame";

export type PublicTimelineEntry = {
  id: string;
  title: string;
  href: string;
  // Days since 1970-01-01, the end inclusive; absent without a valid period.
  start?: number;
  end?: number;
  // Labels of start and end (ISO dates), for the title and screen readers.
  label?: string;
  // Marked as a milestone by the view's checkbox property.
  milestone?: boolean;
  // Public properties shown beside the title.
  detail?: string;
};
export function PublicTimelineGrid({
  id,
  entries,
  links,
  critical,
  linkType,
  range,
  dayWidth,
  scale,
  weekends,
  today,
  tag,
}: {
  id: string;
  entries: PublicTimelineEntry[];
  links: { from: string; to: string; shift: number }[];
  critical: string[];
  linkType: LinkType;
  range?: SavedRange;
  dayWidth?: number;
  scale: Scale;
  weekends: boolean;
  today: number;
  tag: string;
}) {
  const t = useT();
  const frame = useTimelineFrame({
    range,
    dayWidth,
    scale,
    data: dataRange(entries.map((e) => (e.start !== undefined && e.end !== undefined ? { start: e.start, end: e.end } : null))),
    today,
  });
  const grid = useRef<HTMLDivElement>(null);
  const [arrows, setArrows] = useState<TimelineArrow[]>([]);
  const criticalSet = new Set(critical);
  useLayoutEffect(() => {
    const root = grid.current;
    if (!root) return;
    const next = measureArrows(root, links, linkType, criticalSet, new Set(), (el, origin) => {
      const r = el.getBoundingClientRect();
      return { x: r.left - origin.left, y: r.top - origin.top };
    });
    setArrows((previous) => (JSON.stringify(previous) === JSON.stringify(next) ? previous : next));
  });
  const period = { start: frame.window.start, end: frame.window.end, dayWidth: frame.dayWidth },
    width = (period.end - period.start) * period.dayWidth;
  return (
    <div className="public-timeline-app" onKeyDown={(event) => timelineKey(event, frame)}>
      <div className="timeline-controls">
        <TimelineNavigation frame={frame} t={t} />
        <VisibleRange frame={frame} tag={tag} />
        <TimelineZoom frame={frame} t={t} />
      </div>
      <div className="timeline-scroll" tabIndex={0} ref={frame.scrollRef} aria-label={t("Zeitleiste horizontal scrollen", "Scroll the timeline horizontally")}>
        <div className="timeline-grid" ref={grid} style={frameStyle(frame, weekends)}>
          <div className="timeline-heading">
            <strong>{t("Eintrag", "Record")}</strong>
            <TimelineAxis frame={frame} tag={tag} t={t} />
          </div>
          <TimelineArrows id={`public-${id}`} arrows={arrows} />
          {entries.map((entry) => {
            const placed =
              entry.start !== undefined && entry.end !== undefined
                ? barPlacement({ start: entry.start, end: entry.end }, !!entry.milestone, period)
                : null;
            const bar = placed?.box,
              milestone = !!placed?.milestone;
            const outside = bar
              ? milestone
                ? width - bar.left - bar.width >= 120 || bar.left < 120
                  ? "right"
                  : "left"
                : outsideLabel(bar, entry.title, width)
              : null;
            return (
              <div className="timeline-entry" key={entry.id} data-row-id={entry.id}>
                <div className="timeline-entry-label">
                  <a className="timeline-name" href={entry.href} title={entry.title}>
                    {entry.title}
                  </a>
                </div>
                <div className="timeline-lane">
                  {today >= period.start && today < period.end && (
                    <span className="timeline-today" aria-hidden="true" style={{ left: (today - period.start) * period.dayWidth }} />
                  )}
                  {bar ? (
                    <div
                      className={`timeline-range${criticalSet.has(entry.id) ? " critical" : ""}${outside ? ` label-${outside}` : ""}${bar.clippedStart ? " clipped-start" : ""}${bar.clippedEnd ? " clipped-end" : ""}${milestone ? " milestone" : ""}`}
                      style={{ left: bar.left, width: bar.width, "--bar-left": `${bar.left}px` } as React.CSSProperties}
                      title={entry.label}
                    >
                      <a className="timeline-range-body" href={entry.href} aria-label={`${entry.title}: ${entry.label}`}>
                        {!outside && <BarText name={entry.title} detail={entry.detail} />}
                      </a>
                      {outside && (
                        <span className="timeline-range-label" aria-hidden="true">
                          <BarText name={entry.title} detail={entry.detail} />
                        </span>
                      )}
                    </div>
                  ) : entry.start !== undefined ? (
                    <button type="button" className="timeline-unscheduled" onClick={() => frame.goTo(entry.start! - 2)}>
                      {t("Zum Zeitraum springen", "Jump to the period")}
                    </button>
                  ) : (
                    <span className="timeline-unscheduled">{t("Ohne Zeitraum", "Without a period")}</span>
                  )}
                </div>
              </div>
            );
          })}
          {!entries.length && <p className="timeline-notice">{t("Keine Einträge.", "No records.")}</p>}
        </div>
      </div>
    </div>
  );
}
