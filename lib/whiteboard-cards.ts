// Database records shown as cards on a whiteboard: title and a few
// properties, read live (only records the person may see).
import { all, one } from "./db";
import { pageRole } from "./permissions";
import { hiddenRowIds } from "./row-access";
import { cellText } from "./cell-text";
import { displayText } from "./field-format";
import type { Field, Identity, Page } from "./types";

const shown: Field["type"][] = ["select", "multiselect", "date", "person", "number", "checkbox", "text", "url"];

export function whiteboardRowCards(user: Identity, refs: { pageId: string; rowId: string }[]) {
  const out: Record<string, { title: string; database: string; props: { name: string; value: string }[] }> = {};
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
              fields: JSON.parse(one<{ fields: string }>("SELECT fields FROM databases WHERE page_id=?", page.id)?.fields || "[]"),
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
    const props: { name: string; value: string }[] = [];
    for (const field of rest) {
      if (props.length >= 3 || !shown.includes(field.type)) continue;
      const value = cells[field.id];
      if (value === undefined || value === null || value === "" || (Array.isArray(value) && !value.length)) continue;
      const text =
        field.type === "checkbox"
          ? value
            ? `✓ ${field.name}`
            : ""
          : field.type === "person"
            ? (Array.isArray(value) ? value : [value]).map((id) => names.get(String(id)) || "").filter(Boolean).join(", ")
            : displayText(field, value) || cellText(value);
      if (text) props.push({ name: field.name, value: text.slice(0, 60) });
    }
    out[ref.rowId] = {
      title: cellText(cells[titleField?.id || ""]) || "Ohne Titel",
      database: db.page.title,
      props,
    };
  }
  return out;
}
