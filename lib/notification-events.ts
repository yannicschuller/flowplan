// Builds the platform-independent notice (lib/notification-templates.ts)
// for a webhook event from the database: record and page titles, property
// names and readable values of what changed, the address in Flowplan, and
// the due records of a workspace for the daily digest.
import { all, one } from "./db";
import { cellText } from "./cell-text";
import { databaseSettings } from "./database-settings";
import { doneRule, isDone } from "./database-settings-schema";
import type { Notice, NoticeEvent, NoticeItem } from "./notification-templates";
import type { Field } from "./types";

type Cells = Record<string, unknown>;
const appUrl = () => (process.env.APP_URL || "http://localhost:3000").replace(/\/$/, "");
export const recordUrl = (pageId: string, rowId?: string | null) =>
  `${appUrl()}/#page=${pageId}${rowId ? `&row=${rowId}` : ""}`;

const fieldsOf = (pageId: string) => {
  const raw = one<{ fields: string }>("SELECT fields FROM databases WHERE page_id=?", pageId);
  return raw ? (JSON.parse(raw.fields) as Field[]) : [];
};
export const titleOf = (fields: Field[], cells: Cells) => cellText(cells[fields[0]?.id || "title"]).trim();

// A cell as people read it: names instead of user IDs, ✓ for checkboxes.
function display(field: Field, value: unknown): string {
  if (value === null || value === undefined || value === "") return "";
  if (field.type === "checkbox") return value === true ? "✓" : "✗";
  if (field.type === "person" || field.type === "created_by" || field.type === "updated_by") {
    const ids = (Array.isArray(value) ? value : [value]).filter((v): v is string => typeof v === "string").slice(0, 20);
    return ids.map((uid) => one<{ name: string }>("SELECT name FROM users WHERE id=?", uid)?.name || "?").join(", ");
  }
  if (field.type === "relation") {
    const ids = (Array.isArray(value) ? value : [value]).filter((v): v is string => typeof v === "string").slice(0, 10);
    const target = field.relationPage ? fieldsOf(field.relationPage) : [];
    return ids
      .map((rid) => {
        const row = one<{ cells: string }>("SELECT cells FROM rows WHERE id=?", rid);
        return row ? titleOf(target, JSON.parse(row.cells)) : "";
      })
      .filter(Boolean)
      .join(", ");
  }
  if (typeof value === "object" && !Array.isArray(value)) return "";
  return cellText(value);
}

export function buildNotice(event: NoticeEvent, data: Record<string, unknown>, actor?: string | null): Notice {
  const pageId = typeof data.pageId === "string" ? data.pageId : "";
  const rowId = typeof data.rowId === "string" ? data.rowId : null;
  const page = pageId ? one<{ title: string; parent_id: string | null }>("SELECT title,parent_id FROM pages WHERE id=?", pageId) : undefined;
  const notice: Notice = {
    event,
    title: page?.title || "",
    page: "",
    url: pageId ? recordUrl(pageId, rowId) : appUrl(),
    actor: actor || "",
    at: new Date().toISOString(),
    changes: [],
    text: typeof data.text === "string" ? data.text : undefined,
  };
  if (event === "page.created") {
    notice.title = typeof data.title === "string" ? data.title : notice.title;
    const parent = page?.parent_id ? one<{ title: string }>("SELECT title FROM pages WHERE id=?", page.parent_id) : undefined;
    notice.page = parent?.title || "";
    return notice;
  }
  notice.page = page?.title || "";
  if (!rowId) return notice;
  const fields = fieldsOf(pageId);
  const stored = one<{ cells: string }>("SELECT cells FROM rows WHERE id=?", rowId);
  const cells = (data.cells && typeof data.cells === "object" ? data.cells : stored ? JSON.parse(stored.cells) : {}) as Cells;
  notice.title = titleOf(fields, cells);
  const shown =
    event === "row.updated"
      ? fields.filter((f) => Array.isArray(data.changed) && data.changed.includes(f.id))
      : event === "row.created" || event === "form.submitted"
        ? fields.slice(1).filter((f) => display(f, cells[f.id]))
        : [];
  notice.changes = shown.slice(0, 20).map((f) => ({ name: f.name, value: display(f, cells[f.id]) }));
  return notice;
}

const dueField = (fields: Field[]) =>
  fields.find((f) => f.type === "date" && /fällig|due|deadline|frist|termin|bis/i.test(f.name)) || fields.find((f) => f.type === "date");

// Open records of the workspace (or one database) due on `day` or earlier,
// soonest first. Private records stay out: the channel is not a person.
export function dueItems(workspaceId: string, pageId: string | null, day: string, limit = 100) {
  const items: (NoticeItem & { pageId: string; rowId: string })[] = [];
  const pages = all<{ id: string; title: string }>(
    "SELECT p.id,p.title FROM pages p JOIN databases d ON d.page_id=p.id WHERE p.workspace_id=? AND p.deleted_at IS NULL AND (? IS NULL OR p.id=?)",
    workspaceId,
    pageId,
    pageId,
  );
  for (const page of pages) {
    const fields = fieldsOf(page.id);
    const due = dueField(fields);
    if (!due) continue;
    const rule = doneRule(fields, databaseSettings(page.id));
    for (const row of all<{ id: string; cells: string }>("SELECT id,cells FROM rows WHERE page_id=? AND access!='private'", page.id)) {
      const cells = JSON.parse(row.cells) as Cells;
      const value = cells[due.id];
      if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}/.test(value)) continue;
      const date = value.slice(0, 10);
      if (date > day || isDone(rule, cells)) continue;
      items.push({ pageId: page.id, rowId: row.id, title: titleOf(fields, cells), page: page.title, due: date, url: recordUrl(page.id, row.id), overdue: date < day });
    }
  }
  return items.sort((a, b) => a.due.localeCompare(b.due) || a.title.localeCompare(b.title)).slice(0, limit);
}

// Local day and time in a time zone ("2026-10-21", "08:05").
export function localClock(now: number, timeZone: string) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
      .formatToParts(new Date(now))
      .map((p) => [p.type, p.value]),
  );
  return { day: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}` };
}
