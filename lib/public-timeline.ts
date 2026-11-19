// What a published timeline (#390) hands to the reader's browser
// (components/public-timeline.tsx): every record of the view in its order
// – with its period when it has one –, the view's window and zoom, and the
// dependencies and critical path. Relations are never public properties,
// but the view's self-relation only links records the reader sees anyway
// (links to filtered or hidden records are dropped); it is left out when a
// field rule restricts reading it. Server side, for the tests.
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
import type { Field, Row, View } from "./types";

export function publicTimelineData(pageId: string, records: Row[], fields: Field[], view: View) {
  const config = view.timeline || defaultTimeline;
  const { start, end } = scheduleFields(fields, view);
  const hidden = publicHiddenFieldIds(fields);
  const dependency = dependencyFields(fields, pageId).find(
    (f) => f.id === config.dependencyField && !readRestricted(f) && !hidden.has(f.id),
  );
  const linkType = config.dependencyType || "fs";
  // Milestones and the properties beside the title: only public ones.
  const publicIds = publicFieldIds(fields);
  const milestone = fields.find((f) => f.id === config.milestoneField && f.type === "checkbox" && publicIds.has(f.id));
  const labels = (config.labelFields || []).filter((id) => publicIds.has(id));
  const { links } = timelineDependencies(records, dependency, start, end, linkType);
  const critical = config.criticalPath ? criticalPath(records, dependency, start, end, linkType) : new Set<string>();
  return {
    rows: records.map((row) => {
      const range = rowRange(row, start, end);
      return {
        row,
        milestone: !!milestone && row.cells[milestone.id] === true,
        detail: labels
          .map((id) => cellText(row.cells[id]))
          .filter(Boolean)
          .join(" · "),
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
  };
}
