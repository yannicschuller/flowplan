"use client";
// The published timeline (#390): the app's layout read-only – the same
// window and zoom the view stores, the two-row axis, weekends, today's
// line, dependency arrows (drawn as the view chooses, #395), the critical
// path, the hierarchy with summary bars, groups and bar colours (#394).
// Readers scroll, zoom, open and close parents and groups; nothing is
// saved. The server (components/public-views.tsx) hands over only public
// properties.
import { useLayoutEffect, useRef, useState } from "react";
import { ArrowsInLineVertical, ArrowsOutLineVertical } from "@phosphor-icons/react";
import { useT } from "./i18n";
import { dataRange, outsideLabel, type LinkType, type SavedRange, type Scale } from "@/lib/timeline-scale";
import { anchoredLinks, descendants, groupRange, summaryRanges, timelineOutline, type OutlineLine } from "@/lib/timeline-tree";
import {
  barPlacement,
  BarText,
  besideLabel,
  DEFAULT_ARROWS,
  frameStyle,
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
  type ArrowObstacle,
  type ArrowSettings,
  type MeasuredLink,
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
  // The parent record (hierarchy), the group's key, the bar's colour.
  parent?: string;
  group?: string;
  color?: string;
};
const motion = () => {
  try {
    return !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
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
  groups,
  arrows = DEFAULT_ARROWS,
  milestoneOnly = false,
  summaryBaseline = false,
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
  groups?: { key: string; label: string }[];
  arrows?: ArrowSettings;
  milestoneOnly?: boolean;
  summaryBaseline?: boolean;
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
  const [measured, setMeasured] = useState<{ links: MeasuredLink[]; obstacles: ArrowObstacle[] }>({ links: [], obstacles: [] });
  const [, setTick] = useState(0);
  const [hoverLine, setHoverLine] = useState<string | null>(null),
    [hoverLink, setHoverLink] = useState<string | null>(null);
  const criticalSet = new Set(critical);
  const byId = new Map(entries.map((e) => [e.id, e]));
  const input = entries.map((e) => ({ id: e.id, parent: e.parent, group: e.group }));
  const outlineOf = (collapsed: ReadonlySet<string>) => timelineOutline(input, { groups, collapsed });
  const state = useOutline({
    grid,
    motion,
    lines: (collapsed) => outlineOf(collapsed).lines.map((l) => l.id),
    onFrame: () => setTick((n) => n + 1),
  });
  const outline = outlineOf(state.collapsed);
  const outlined = !!groups || entries.some((e) => e.parent);
  const rangeOf = (rid: string) => {
    const e = byId.get(rid);
    return e && e.start !== undefined && e.end !== undefined ? { start: e.start, end: e.end } : null;
  };
  const summaries = summaryRanges(outline.childrenOf, rangeOf);
  const members = new Map<string, string[]>();
  for (const e of entries) if (e.group !== undefined) members.set(e.group, [...(members.get(e.group) || []), e.id]);
  const lineLinks = anchoredLinks(links, outline.anchor).map((l) => ({
    key: `${l.line.from}>${l.line.to}`,
    from: l.line.from,
    to: l.line.to,
    conflict: false,
    critical: criticalSet.has(l.from) && criticalSet.has(l.to),
  }));
  useLayoutEffect(() => {
    const root = grid.current;
    if (!root) return;
    const box = (el: HTMLElement, origin: DOMRect) => {
      const r = el.getBoundingClientRect();
      return { x: r.left - origin.left, y: r.top - origin.top };
    };
    const next = measureLinks(root, lineLinks, box);
    const obstacles = next.length && arrows.overlap === "transparent" ? measureObstacles(root, box) : [];
    setMeasured((previous) =>
      JSON.stringify(previous.links) === JSON.stringify(next) && JSON.stringify(previous.obstacles) === JSON.stringify(obstacles)
        ? previous
        : { links: next, obstacles },
    );
  });
  const period = { start: frame.window.start, end: frame.window.end, dayWidth: frame.dayWidth },
    width = (period.end - period.start) * period.dayWidth;
  const highlight = hoverLine
    ? hoverLine.startsWith("group:")
      ? groupRange(members.get(hoverLine.slice(6)) || [], rangeOf)
      : summaries.get(hoverLine) || rangeOf(hoverLine)
    : null;
  const hovered = hoverLink ? lineLinks.find((l) => l.key === hoverLink) : undefined;
  const hover = (lineId: string) => ({
    onPointerEnter: () => setHoverLine(lineId),
    onPointerLeave: () => setHoverLine((h) => (h === lineId ? null : h)),
  });
  const todayLine = today >= period.start && today < period.end && (
    <span className="timeline-today" aria-hidden="true" style={{ left: (today - period.start) * period.dayWidth }} />
  );
  function lane(line: OutlineLine, entry: PublicTimelineEntry | undefined) {
    const lineHover = !!hovered && (hovered.from === line.id || hovered.to === line.id);
    const summary = line.type === "group" ? groupRange(members.get(line.key) || [], rangeOf) : summaries.get(line.id);
    const name = entry ? entry.title : line.type === "group" ? line.label : "";
    if (summary) {
      const box = barPlacement(summary, false, period, true).box;
      const own = entry ? rangeOf(entry.id) : null;
      const baseline = summaryBaseline && own && (own.start !== summary.start || own.end !== summary.end) ? barPlacement(own, false, period, true).box : null;
      const count = line.type === "group" ? line.count : descendants(outline.childrenOf, line.id).length;
      return (
        <div className="timeline-lane">
          {todayLine}
          {baseline && <span className="timeline-baseline" aria-hidden="true" style={{ left: baseline.left, width: baseline.width }} />}
          {box ? (
            <div
              className={`timeline-range summary label-${besideLabel(box, width)}${box.clippedStart ? " clipped-start" : ""}${box.clippedEnd ? " clipped-end" : ""}${lineHover ? " link-hover" : ""}`}
              style={{ left: box.left, width: box.width, "--bar-left": `${box.left}px` } as React.CSSProperties}
              {...hover(line.id)}
            >
              {entry ? (
                <a
                  className="timeline-range-body"
                  href={entry.href}
                  aria-label={t(`${name}: ${count} Untereinträge`, `${name}: ${count} sub-records`)}
                />
              ) : (
                <span className="timeline-range-body" role="img" aria-label={t(`${name}: ${count} Einträge`, `${name}: ${count} records`)} />
              )}
              <span className="timeline-range-label" aria-hidden="true">
                <BarText name={name} detail={entry?.detail} />
              </span>
            </div>
          ) : (
            <OffscreenChip frame={frame} tag={tag} range={summary} label={t("Zum Zeitraum springen", "Jump to the period")} text={t("Zum Zeitraum springen", "Jump to the period")} />
          )}
          {box && <OffscreenChip frame={frame} tag={tag} range={summary} label={t(`Zu ${name} springen`, `Jump to ${name}`)} />}
        </div>
      );
    }
    if (!entry) return <div className="timeline-lane">{todayLine}</div>;
    const own = rangeOf(entry.id);
    const placed = own ? barPlacement(own, !!entry.milestone, period, milestoneOnly) : null;
    const bar = placed?.box,
      milestone = !!placed?.milestone;
    const outside = bar ? (milestone ? besideLabel(bar, width) : outsideLabel(bar, entry.title, width)) : null;
    return (
      <div className="timeline-lane">
        {todayLine}
        {bar ? (
          <div
            className={`timeline-range${criticalSet.has(entry.id) ? " critical" : ""}${entry.color ? ` colored opt-${entry.color}` : ""}${lineHover ? " link-hover" : ""}${outside ? ` label-${outside}` : ""}${bar.clippedStart ? " clipped-start" : ""}${bar.clippedEnd ? " clipped-end" : ""}${milestone ? " milestone" : ""}`}
            style={{ left: bar.left, width: bar.width, "--bar-left": `${bar.left}px` } as React.CSSProperties}
            title={entry.label}
            {...hover(line.id)}
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
        ) : own ? (
          <OffscreenChip frame={frame} tag={tag} range={own} label={t("Zum Zeitraum springen", "Jump to the period")} text={t("Zum Zeitraum springen", "Jump to the period")} />
        ) : (
          <span className="timeline-unscheduled">{t("Ohne Zeitraum", "Without a period")}</span>
        )}
        {bar && own && <OffscreenChip frame={frame} tag={tag} range={own} label={t(`Zu ${entry.title} springen`, `Jump to ${entry.title}`)} />}
      </div>
    );
  }
  const collapsible = outline.lines.some((l) => l.type === "group" || l.children > 0);
  return (
    <div className="public-timeline-app" onKeyDown={(event) => timelineKey(event, frame)}>
      <div className="timeline-controls">
        <TimelineNavigation frame={frame} t={t} />
        <VisibleRange frame={frame} tag={tag} />
        <TimelineZoom frame={frame} t={t} />
      </div>
      <div className="timeline-scroll" tabIndex={0} ref={frame.scrollRef} aria-label={t("Zeitleiste horizontal scrollen", "Scroll the timeline horizontally")}>
        <div className={`timeline-grid arrows-${arrows.overlap}`} ref={grid} style={frameStyle(frame, weekends)}>
          <div className="timeline-heading">
            <strong>
              <span>{t("Eintrag", "Record")}</span>
              {collapsible && (
                <span className="timeline-outline-all">
                  <button
                    type="button"
                    className="icon-button"
                    aria-label={t("Alle aufklappen", "Expand all")}
                    title={t("Alle aufklappen", "Expand all")}
                    disabled={!state.collapsed.size}
                    onClick={() => state.set([])}
                  >
                    <ArrowsOutLineVertical size={15} />
                  </button>
                  <button
                    type="button"
                    className="icon-button"
                    aria-label={t("Alle zuklappen", "Collapse all")}
                    title={t("Alle zuklappen", "Collapse all")}
                    onClick={() => state.set([...outline.childrenOf.keys(), ...outline.lines.filter((l) => l.type === "group").map((l) => l.id)])}
                  >
                    <ArrowsInLineVertical size={15} />
                  </button>
                </span>
              )}
            </strong>
            <TimelineAxis frame={frame} tag={tag} t={t} highlight={highlight} />
          </div>
          <TimelineArrows
            id={`public-${id}`}
            frame={frame}
            links={measured.links}
            obstacles={measured.obstacles}
            type={linkType}
            settings={arrows}
            focus={hoverLine}
            hovered={hoverLink}
            onHover={setHoverLink}
          />
          {outline.lines.map((line) => {
            const entry = line.type === "row" ? byId.get(line.id) : undefined;
            const toggle = (line.type === "group" || line.children > 0) && (
              <OutlineToggle name={line.type === "group" ? line.label : entry!.title} collapsed={line.collapsed} onToggle={() => state.toggle(line.id)} t={t} />
            );
            const indent = { "--timeline-depth": line.depth } as React.CSSProperties;
            return (
              <div
                className={`timeline-entry${line.type === "group" ? " timeline-group" : ""}${line.type === "row" && line.children ? " is-parent" : ""}`}
                key={line.id}
                data-line-id={line.id}
                data-row-id={entry?.id}
              >
                <div className={`timeline-entry-label${outlined ? " timeline-outline" : ""}`} style={outlined ? indent : undefined}>
                  {outlined && (toggle || <span className="timeline-outline-spacer" aria-hidden="true" />)}
                  {line.type === "group" ? (
                    <>
                      <strong className="timeline-group-name" title={line.label}>
                        {line.label}
                      </strong>
                      <span className="timeline-group-count">{line.count}</span>
                    </>
                  ) : (
                    <a className="timeline-name" href={entry!.href} title={entry!.title} {...hover(line.id)}>
                      {entry!.title}
                    </a>
                  )}
                </div>
                {lane(line, entry)}
              </div>
            );
          })}
          {!entries.length && <p className="timeline-notice">{t("Keine Einträge.", "No records.")}</p>}
        </div>
      </div>
    </div>
  );
}
