import { z } from "zod";

// Sections of a record page's properties (#646): named groups, set per
// database in its record layout (database.recordLayout → sections, beside
// `order` and `hidden`, lib/record-layout.ts). Properties in no section stay
// at the top, unnamed, as before; the sections follow in their order, each
// with its properties in its own order. Deleting a section puts its
// properties back at the end of the top group. Forms, views and the rows'
// data know nothing of sections.
export const RECORD_SECTIONS_MAX = 30;
export const RECORD_SECTION_NAME_MAX = 80;
export const recordSectionIdPattern = /^[A-Za-z0-9_-]{1,40}$/;
// No control characters (line breaks, tabs …) in a heading.
// eslint-disable-next-line no-control-regex
const controls = /[\u0000-\u001f\u007f]/;

export const recordSectionSchema = z.object({
  id: z.string().regex(recordSectionIdPattern),
  name: z
    .string()
    .trim()
    .min(1)
    .max(RECORD_SECTION_NAME_MAX)
    .refine((name) => !controls.test(name), "No control characters"),
  // The section's properties in its order: field ids without the title.
  fields: z.array(z.string().min(1).max(100)).max(500).default([]),
});
export type RecordSection = z.infer<typeof recordSectionSchema>;
export const recordSectionsSchema = z
  .array(recordSectionSchema)
  .max(RECORD_SECTIONS_MAX)
  .superRefine((sections, ctx) => {
    const seen = new Set<string>();
    for (const [index, section] of sections.entries()) {
      if (seen.has(section.id)) ctx.addIssue({ code: "custom", path: [index, "id"], message: "Duplicate section id" });
      seen.add(section.id);
    }
  });

// The sections as the server keeps them for these fields: known properties
// only (not the title), each in one section at most (the first that lists
// it); none when there are none.
export function cleanRecordSections(
  sections: readonly RecordSection[] | undefined,
  fields: readonly { id: string }[],
): RecordSection[] | undefined {
  if (!sections?.length) return undefined;
  const known = new Set(fields.slice(1).map((f) => f.id));
  const placed = new Set<string>(),
    ids = new Set<string>();
  const clean: RecordSection[] = [];
  for (const section of sections) {
    if (ids.has(section.id)) continue;
    ids.add(section.id);
    const own = section.fields.filter((fid) => known.has(fid) && !placed.has(fid) && (placed.add(fid), true));
    clean.push({ id: section.id, name: section.name, fields: own });
  }
  return clean.length ? clean : undefined;
}

// The arrangement of a record page's properties: the top group (no
// section) and the sections, each a list of field ids in its order.
export type RecordArrangement = {
  top: string[];
  sections: RecordSection[];
};
type Layout = { order?: readonly string[]; sections?: readonly RecordSection[] };

// The fields (the title first) arranged by a layout: the title is left out;
// properties listed in no section form the top group in the record order
// (`order`, then the database's order), unknown ids are ignored.
export function recordArrangement(fields: readonly { id: string }[], layout: Layout): RecordArrangement {
  const rest = fields.slice(1).map((f) => f.id);
  const known = new Set(rest);
  const placed = new Set<string>();
  const sections = (layout.sections || []).map((s) => ({
    id: s.id,
    name: s.name,
    fields: s.fields.filter((fid) => known.has(fid) && !placed.has(fid) && (placed.add(fid), true)),
  }));
  const rank = new Map<string, number>();
  for (const fid of layout.order || []) if (!rank.has(fid)) rank.set(fid, rank.size);
  const listed = rest.filter((fid) => rank.has(fid)).sort((a, b) => rank.get(a)! - rank.get(b)!);
  const top = [...listed, ...rest.filter((fid) => !rank.has(fid))].filter((fid) => !placed.has(fid));
  return { top, sections };
}

// What a layout stores for an arrangement: `order` lists every property as
// shown (the top group, then each section) – the order exports and shared
// records follow – and `sections` the groups.
export function arrangementLayout(a: RecordArrangement): { order: string[]; sections: RecordSection[] } {
  return {
    order: [...a.top, ...a.sections.flatMap((s) => s.fields)],
    sections: a.sections.map((s) => ({ id: s.id, name: s.name, fields: [...s.fields] })),
  };
}

const same = (a: RecordArrangement, b: RecordArrangement) => JSON.stringify(a) === JSON.stringify(b);
const copy = (a: RecordArrangement): RecordArrangement => ({
  top: [...a.top],
  sections: a.sections.map((s) => ({ ...s, fields: [...s.fields] })),
});
// The list of a group: null is the top group.
function groupOf(a: RecordArrangement, section: string | null): string[] | null {
  if (section === null) return a.top;
  return a.sections.find((s) => s.id === section)?.fields ?? null;
}
export function sectionOfField(a: RecordArrangement, fieldId: string): string | null | undefined {
  if (a.top.includes(fieldId)) return null;
  return a.sections.find((s) => s.fields.includes(fieldId))?.id;
}

// Where a property goes: into a group (null: the top one) before or after
// another property of it, or at its start or end.
export type RecordPropertyTarget =
  | { section: string | null; place: "start" | "end" }
  | { section?: undefined; target: string; place: "before" | "after" };

// A property moved; null when nothing changes or the move names something
// unknown.
export function moveRecordProperty(
  a: RecordArrangement,
  fieldId: string,
  to: RecordPropertyTarget,
): RecordArrangement | null {
  if (sectionOfField(a, fieldId) === undefined) return null;
  if ("target" in to && to.target === fieldId) return null;
  const next = copy(a);
  const from = groupOf(next, sectionOfField(next, fieldId)!)!;
  const targetSection = "target" in to ? sectionOfField(next, to.target) : to.section;
  const into = targetSection === undefined ? null : groupOf(next, targetSection);
  if (!into) return null;
  from.splice(from.indexOf(fieldId), 1);
  if ("target" in to) {
    const at = into.indexOf(to.target);
    into.splice(to.place === "after" ? at + 1 : at, 0, fieldId);
  } else if (to.place === "start") into.unshift(fieldId);
  else into.push(fieldId);
  return same(a, next) ? null : next;
}

// One step up or down, past the next property shown (`shown`: the ids on
// the page; hidden or empty ones are passed over). At the edge of a group it
// leaves it: up to the end of the group above, down to the start of the
// group below.
export function stepRecordProperty(
  a: RecordArrangement,
  fieldId: string,
  direction: -1 | 1,
  shown: ReadonlySet<string>,
): RecordArrangement | null {
  const section = sectionOfField(a, fieldId);
  if (section === undefined) return null;
  const group = groupOf(a, section)!;
  const visible = group.filter((fid) => fid === fieldId || shown.has(fid));
  const neighbour = visible[visible.indexOf(fieldId) + direction];
  if (neighbour) return moveRecordProperty(a, fieldId, { target: neighbour, place: direction < 0 ? "before" : "after" });
  const groups: (string | null)[] = [null, ...a.sections.map((s) => s.id)];
  const other = groups[groups.indexOf(section) + direction];
  if (other === undefined) return null;
  return moveRecordProperty(a, fieldId, { section: other, place: direction < 0 ? "end" : "start" });
}

// A new section at the end, empty. null for a name that is empty or too
// long, a taken id or one too many.
export function addRecordSection(a: RecordArrangement, id: string, name: string): RecordArrangement | null {
  const clean = name.trim();
  if (!clean || clean.length > RECORD_SECTION_NAME_MAX || controls.test(clean)) return null;
  if (!recordSectionIdPattern.test(id) || a.sections.some((s) => s.id === id)) return null;
  if (a.sections.length >= RECORD_SECTIONS_MAX) return null;
  const next = copy(a);
  next.sections.push({ id, name: clean, fields: [] });
  return next;
}

export function renameRecordSection(a: RecordArrangement, id: string, name: string): RecordArrangement | null {
  const clean = name.trim();
  if (!clean || clean.length > RECORD_SECTION_NAME_MAX || controls.test(clean)) return null;
  const next = copy(a);
  const section = next.sections.find((s) => s.id === id);
  if (!section || section.name === clean) return null;
  section.name = clean;
  return next;
}

// A section removed: its properties go back to the end of the top group,
// in their order – nothing is lost.
export function removeRecordSection(a: RecordArrangement, id: string): RecordArrangement | null {
  const section = a.sections.find((s) => s.id === id);
  if (!section) return null;
  return {
    top: [...a.top, ...section.fields],
    sections: copy(a).sections.filter((s) => s.id !== id),
  };
}

// A section moved one place up or down, or to an index.
export function moveRecordSection(a: RecordArrangement, id: string, to: number): RecordArrangement | null {
  const from = a.sections.findIndex((s) => s.id === id);
  if (from < 0 || to < 0 || to >= a.sections.length || to === from) return null;
  const next = copy(a);
  const [section] = next.sections.splice(from, 1);
  next.sections.splice(to, 0, section);
  return next;
}

// A fresh section id (s_ and ten letters or digits), also outside secure
// contexts (getRandomValues, unlike randomUUID, works over plain http).
export function newRecordSectionId(taken: readonly { id: string }[] = []): string {
  const letters = "abcdefghijklmnopqrstuvwxyz0123456789";
  for (;;) {
    const bytes = new Uint8Array(10);
    crypto.getRandomValues(bytes);
    const id = `s_${[...bytes].map((b) => letters[b % letters.length]).join("")}`;
    if (!taken.some((s) => s.id === id)) return id;
  }
}
