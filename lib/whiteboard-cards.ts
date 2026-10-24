// Database records shown as cards on a whiteboard: title and a few
// properties, read live (only records the person may see). Dates and numbers
// go out as raw values with their format, so the browser writes them in the
// person's language and time zone (components/whiteboard/render.tsx); an
// empty title stays empty and the card says "Untitled" in their language.
import { all, one } from "./db";
import { pageRole } from "./permissions";
import { hiddenRowIds } from "./row-access";
import { visibleFields } from "./field-access";
import { cellText } from "./cell-text";
import type { Field, Identity, Page } from "./types";

const shown: Field["type"][] = ["select", "multiselect", "date", "person", "number", "checkbox", "text", "url"];

export type RowCardProp = {
  name: string;
  value: string;
  // Dates and numbers: the stored value and how the property formats it.
  raw?: string | number;
  format?: Pick<Field, "type" | "format" | "timeFormat" | "decimals">;
};
export type RowCardData = { title: string; database: string; props: RowCardProp[] };

export function whiteboardRowCards(user: Identity, refs: { pageId: string; rowId: string }[]) {
  const out: Record<string, RowCardData> = {};
  const pages = new Map<string, { page: Page; fields: Field[]; hidden: Set<unknown> } | null>();
  const names = new Map(all<{ id: string; name: string }>("SELECT id,name FROM users").map((u) => [u.id, u.name]));
  for (const ref of refs.slice(0, 200)) {
    if (!pages.has(ref.pageId)) {
      const page = one<Page>("SELECT * FROM pages WHERE id=? AND deleted_at IS NULL AND kind='database'", ref.pageId);
      pages.set(
        ref.pageId,
        page && pageRole(user, page)
          ? {
              page,
              // Without properties hidden from this person (lib/field-access.ts).
              fields: visibleFields(user, page, JSON.parse(one<{ fields: string }>("SELECT fields FROM databases WHERE page_id=?", page.id)?.fields || "[]")),
              hidden: hiddenRowIds(user, page),
            }
          : null,
      );
    }
    const db = pages.get(ref.pageId);
    if (!db || db.hidden.has(ref.rowId)) continue;
    const row = one<{ cells: string }>("SELECT cells FROM rows WHERE id=? AND page_id=?", ref.rowId, ref.pageId);
    if (!row) continue;
    const cells = JSON.parse(row.cells) as Record<string, unknown>;
    const [titleField, ...rest] = db.fields;
    const props: RowCardProp[] = [];
    for (const field of rest) {
      if (props.length >= 3 || !shown.includes(field.type)) continue;
      const value = cells[field.id];
      if (value === undefined || value === null || value === "" || (Array.isArray(value) && !value.length)) continue;
      if ((field.type === "date" && typeof value === "string") || (field.type === "number" && typeof value === "number")) {
        const { type, format, timeFormat, decimals } = field;
        props.push({ name: field.name, value: cellText(value), raw: value, format: { type, format, timeFormat, decimals } });
        continue;
      }
      const text =
        field.type === "checkbox"
          ? value
            ? `✓ ${field.name}`
            : ""
          : field.type === "person"
            ? (Array.isArray(value) ? value : [value]).map((id) => names.get(String(id)) || "").filter(Boolean).join(", ")
            : cellText(value);
      if (text) props.push({ name: field.name, value: text.slice(0, 60) });
    }
    out[ref.rowId] = {
      title: cellText(cells[titleField?.id || ""]),
      database: db.page.title,
      props,
    };
  }
  return out;
}
