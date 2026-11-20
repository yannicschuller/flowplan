// What a published timeline (#390) hands to the reader's browser
// (components/public-timeline.tsx): every record of the view in its order
// – with its period when it has one –, the view's window and zoom, and the
// dependencies and critical path. Relations are never public properties,
// but the view's self-relations only link records the reader sees anyway
// (links to filtered or hidden records are dropped); a self-relation is
// left out when a field rule restricts reading it. That holds for the
// dependencies and for the hierarchy (#394: parents with summary bars);
// groups and bar colours come only from public properties. The arrow
// settings (#395) come along; nothing can be changed. Server side, for the
// tests.
import {
  criticalPath,
  dayKey,
  defaultTimeline,
  dependencyFields,
  rowRange,
  scheduleFields,
  timelineDependencies,
} from "./database-timeline";
import { publicHiddenFieldIds, readRestricted } from "./field-access";
import { publicFieldIds } from "./shared-content";
import { cellText } from "./cell-text";
import { timelineSettings } from "./timeline-plan";
import { barColor, timelineColorField, timelineGroupField, timelineGroups } from "./timeline-groups";
import type { Field, Row, View } from "./types";

export function publicTimelineData(pageId: string, records: Row[], fields: Field[], view: View, t?: (de: string, en: string) => string) {
  const config = view.timeline || defaultTimeline;
  const { start, end } = scheduleFields(fields, view);
  const hidden = publicHiddenFieldIds(fields);
  const selfRelations = dependencyFields(fields, pageId).filter((f) => !readRestricted(f) && !hidden.has(f.id));
  const dependency = selfRelations.find((f) => f.id === config.dependencyField);
  const hierarchy = selfRelations.find((f) => f.id === config.hierarchyField && f.id !== dependency?.id);
  const linkType = config.dependencyType || "fs";
  // Milestones and the properties beside the title: only public ones.
  const publicIds = publicFieldIds(fields);
  const milestone = fields.find((f) => f.id === config.milestoneField && f.type === "checkbox" && publicIds.has(f.id));
  const labels = (config.labelFields || []).filter((id) => publicIds.has(id));
  const groupField = timelineGroupField(fields, view.groupBy),
    grouping = groupField && publicIds.has(groupField.id) ? timelineGroups(records, groupField, t) : null;
  const colorField = timelineColorField(fields, config.colorField),
    color = colorField && publicIds.has(colorField.id) ? colorField : undefined;
  const shown = new Set(records.map((r) => r.id));
  const { links } = timelineDependencies(records, dependency, start, end, linkType);
  const critical = config.criticalPath ? criticalPath(records, dependency, start, end, linkType) : new Set<string>();
  const settings = timelineSettings(config);
  return {
    rows: records.map((row) => {
      const range = rowRange(row, start, end);
      const rawParent = hierarchy ? row.cells[hierarchy.id] : undefined;
      const parent = (Array.isArray(rawParent) ? rawParent : []).find((v): v is string => typeof v === "string" && v !== row.id && shown.has(v));
      const tint = barColor(color, row);
      return {
        row,
        milestone: !!milestone && row.cells[milestone.id] === true,
        detail: labels
          .map((id) => cellText(row.cells[id]))
          .filter(Boolean)
          .join(" · "),
        ...(parent ? { parent } : {}),
        ...(grouping ? { group: grouping.keyOf.get(row.id) } : {}),
        ...(tint ? { color: tint } : {}),
        ...(range
          ? {
              start: range.start,
              end: range.end,
              label: range.end > range.start ? `${dayKey(range.start)} – ${dayKey(range.end)}` : dayKey(range.start),
            }
          : {}),
      };
    }),
    links,
    critical: [...critical],
    linkType,
    range: config.range,
    dayWidth: config.dayWidth,
    scale: config.scale,
    weekends: config.showWeekends,
    ...(grouping ? { groups: grouping.groups } : {}),
    arrows: { visibility: settings.arrowVisibility, overlap: settings.arrowOverlap, routing: settings.arrowRouting },
    milestoneOnly: !!config.milestoneOnlyField,
    summaryBaseline: !!config.summaryBaseline && !!hierarchy,
  };
}
