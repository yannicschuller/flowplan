// Colours of the options of select and multi-select properties (#242).
// Each option may have one of the workspace tags' colours
// (lib/page-properties.ts PAGE_TAG_COLORS), stored next to the options as
// `optionColors: { [option]: colour }` in the property (the database's
// fields JSON). Options without one keep the look they had before (the
// fixed words of components/database-view.tsx, otherwise grey), so existing
// databases look as they did; options added later – by hand, through the
// API, an import or the AI – get the next colour in turn. Client-safe.
import { isTagField, PAGE_TAG_COLORS, type PageTagColor } from "./page-properties";
import type { Field } from "./types";

export const OPTION_COLORS = PAGE_TAG_COLORS;
export type OptionColor = PageTagColor;
// New options take these in turn (grey would look like "no colour").
export const AUTO_COLORS: readonly OptionColor[] = PAGE_TAG_COLORS.filter((c) => c !== "gray");

export const isOptionColor = (value: unknown): value is OptionColor =>
  typeof value === "string" && (OPTION_COLORS as readonly string[]).includes(value);
// A select or multi-select with options of its own (tag-backed ones show
// the tags' colours, lib/tag-fields.ts).
export const hasOwnOptions = (f: Pick<Field, "type" | "tagOptions"> | undefined) =>
  !!f && (f.type === "select" || f.type === "multiselect") && !isTagField(f);

export function optionColor(f: Pick<Field, "optionColors"> | undefined, option: string): OptionColor | undefined {
  const color = f?.optionColors?.[option];
  return isOptionColor(color) ? color : undefined;
}

// The colour after `previous` in the round, or the one for this place in
// the list when there is no previous one.
export function nextColor(previous: OptionColor | undefined, index: number): OptionColor {
  const at = previous ? AUTO_COLORS.indexOf(previous) : -1;
  return AUTO_COLORS[at >= 0 ? (at + 1) % AUTO_COLORS.length : index % AUTO_COLORS.length];
}

// Every option coloured in turn from the start ("Assign colours
// automatically"); replaces the colours set so far.
export function autoColors(options: readonly string[]): Record<string, OptionColor> {
  return Object.fromEntries(options.map((o, i) => [o, AUTO_COLORS[i % AUTO_COLORS.length]]));
}

// While the options are typed as text, a renamed option keeps its colour.
export function carryColors(
  colors: Record<string, string> | undefined,
  renames: readonly { from: string; to: string }[],
): Record<string, OptionColor> | undefined {
  if (!colors) return colors;
  const next: Record<string, OptionColor> = {};
  for (const [option, color] of Object.entries(colors)) if (isOptionColor(color)) next[option] = color;
  for (const r of renames) if (next[r.from] && !next[r.to]) next[r.to] = next[r.from];
  return next;
}

// Prepares the colours of the properties as they are stored, in place:
// - a property without `optionColors` keeps the stored colours (an API
//   client that does not know them leaves them alone; `{}` clears them);
// - renamed options (`renames`, as database.update's optionRenames) take
//   their colour along;
// - options that are new to the property get the next colour in turn,
//   options it had before stay as they are (coloured or not);
// - colours of options that are gone are dropped; no colours, no key.
// `before` is the stored state (omitted: every option is new).
export function colorOptions(
  fields: Field[],
  before?: readonly Field[] | null,
  renames: readonly { field: string; from: string; to: string }[] = [],
): Field[] {
  for (const f of fields) {
    if (!hasOwnOptions(f)) {
      delete f.optionColors;
      continue;
    }
    const old = before?.find((o) => o.id === f.id);
    const stored = hasOwnOptions(old) ? old : undefined;
    const known = new Set(stored?.options || []);
    const given = f.optionColors === undefined ? stored?.optionColors : f.optionColors;
    const colors = carryColors(given || {}, []) || {};
    for (const r of renames) {
      if (r.field !== f.id) continue;
      // A renamed option is not a new one: uncoloured, it stays so.
      if (known.has(r.from)) known.add(r.to);
      const color = optionColor(stored, r.from);
      if (color && !colors[r.to]) colors[r.to] = color;
    }
    const options = f.options || [];
    const next: Record<string, OptionColor> = {};
    options.forEach((option, i) => {
      const color = colors[option] ?? (known.has(option) ? undefined : nextColor(next[options[i - 1]], i));
      if (color) next[option] = color;
    });
    if (Object.keys(next).length) f.optionColors = next;
    else delete f.optionColors;
  }
  return fields;
}

// The look options without a colour had before (#242 keeps it): a few
// fixed words in colour, everything else grey.
export function legacyOptionColor(value: string): "green" | "blue" | "red" | "yellow" | "gray" {
  if (["Erledigt", "Niedrig", "Done", "Low"].includes(value)) return "green";
  if (["In Arbeit", "Design", "In progress"].includes(value)) return "blue";
  if (["Hoch", "High"].includes(value)) return "red";
  if (["Mittel", "Produkt", "Medium", "Product"].includes(value)) return "yellow";
  return "gray";
}

// The classes of a value's chip (app/option-colors.css): its own colour,
// a tag's colour for tag-backed properties, otherwise the earlier look.
export function choiceChipClass(
  f: Pick<Field, "type" | "tagOptions" | "optionColors"> | undefined,
  value: string,
  tagColor?: (name: string) => OptionColor,
) {
  const color = f && isTagField(f) ? (tagColor?.(value) ?? "gray") : optionColor(f, value);
  return color ? `tag tag-choice tag-colored opt-${color}` : `tag tag-choice tag-${legacyOptionColor(value)}`;
}
