import { effectiveFilterGroup, filterCount } from "./database-filters";
import type { RecordLayout, RecordOpenMode } from "./record-layout";
import type { Field, FilterGroup, View } from "./types";

// The database toolbar: what its chips say, which view tabs are shown and
// how the records of a view open. Pure helpers, so the labels are testable.
export type Translate = (de: string, en: string) => string;

// A chip reads as its action while nothing is set, and as a summary of the
// setting once it is ("Filtern" → "2 Filter", "Sortieren" → "Sortiert nach
// Fällig +1"). `active` colours the chip.
export type ChipLabel = { label: string; active: boolean };

export function filterChipLabel(
  view: Pick<View, "filters" | "filterGroup">,
  t: Translate,
): ChipLabel {
  const count = filterCount(effectiveFilterGroup(view));
  if (!count) return { label: t("Filtern", "Filter"), active: false };
  return {
    label:
      count === 1
        ? t("1 Filter", "1 filter")
        : t(`${count} Filter`, `${count} filters`),
    active: true,
  };
}

function fieldName(fields: Pick<Field, "id" | "name">[], id: string, t: Translate) {
  return (
    fields.find((f) => f.id === id)?.name ||
    t("gelöschte Eigenschaft", "deleted property")
  );
}

export function sortChipLabel(
  view: Pick<View, "sorts">,
  fields: Pick<Field, "id" | "name">[],
  t: Translate,
): ChipLabel {
  if (!view.sorts.length) return { label: t("Sortieren", "Sort"), active: false };
  const first = fieldName(fields, view.sorts[0].field, t);
  const more = view.sorts.length - 1;
  return {
    label: more
      ? t(`Sortiert nach ${first} +${more}`, `Sorted by ${first} +${more}`)
      : t(`Sortiert nach ${first}`, `Sorted by ${first}`),
    active: true,
  };
}

export function groupChipLabel(
  view: Pick<View, "groupBy">,
  fields: Pick<Field, "id" | "name">[],
  t: Translate,
): ChipLabel {
  if (!view.groupBy) return { label: t("Gruppieren", "Group"), active: false };
  const name = fieldName(fields, view.groupBy, t);
  return { label: t(`Nach ${name}`, `By ${name}`), active: true };
}

export function propertiesChipLabel(
  view: Pick<View, "hiddenFields">,
  fields: Pick<Field, "id">[],
  t: Translate,
): ChipLabel {
  const hidden = (view.hiddenFields || []).filter((id) =>
    fields.some((f) => f.id === id),
  ).length;
  if (!hidden) return { label: t("Eigenschaften", "Properties"), active: false };
  return {
    label:
      hidden === 1
        ? t("1 ausgeblendet", "1 hidden")
        : t(`${hidden} ausgeblendet`, `${hidden} hidden`),
    active: true,
  };
}

// The small filter popover edits one flat list of conditions; nested groups
// (AND inside OR) need the full editor.
export function hasNestedFilterGroups(group: FilterGroup): boolean {
  return group.rules.some((rule) => rule.kind === "group");
}

// View tabs beyond this many fold into a "more views" menu. The current view
// always stays visible as a tab, in place of the last one when necessary.
export const MAX_VIEW_TABS = 5;
export function visibleViewTabs<V extends { id: string }>(
  views: V[],
  activeId: string,
  max = MAX_VIEW_TABS,
): { shown: V[]; more: V[] } {
  if (views.length <= max) return { shown: views, more: [] };
  const shown = views.slice(0, max);
  const active = views.find((v) => v.id === activeId);
  if (active && !shown.includes(active)) shown[max - 1] = active;
  return { shown, more: views.filter((v) => !shown.includes(v)) };
}

// How the records of a view open: the view's own choice, else the
// database-wide default of the record layout.
export function viewRecordOpenMode(
  view: Pick<View, "recordOpen">,
  layout: Pick<RecordLayout, "open">,
): RecordOpenMode {
  return view.recordOpen || layout.open;
}
