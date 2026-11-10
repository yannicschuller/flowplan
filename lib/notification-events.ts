// Builds the platform-independent notice (lib/notification-templates.ts)
// for a webhook event from the database: record and page titles, property
// names and readable values of what changed, the address in Flowplan, and
// the due records of a workspace for the daily digest.
import { all, one } from "./db";
import { cellText } from "./cell-text";
import { databaseSettings } from "./database-settings";
import { doneRule, isDone } from "./database-settings-schema";
import type { Notice, NoticeEvent, NoticeItem } from "./notification-templates";
import { pageRole } from "./permissions";
import { journalLocked } from "./journal-extras";
import { visibleRows } from "./row-access";
import type { Field, Identity, Page } from "./types";
import { filterAsync, mapAsync } from "./each-async";

type Cells = Record<string, unknown>;
const appUrl = () => (process.env.APP_URL || "http://localhost:3000").replace(/\/$/, "");
export const recordUrl = (pageId: string, rowId?: string | null) =>
  `${appUrl()}/#page=${pageId}${rowId ? `&row=${rowId}` : ""}`;

const fieldsOf = async (pageId: string) => {
  const raw = await one<{ fields: string }>("SELECT fields FROM databases WHERE page_id=?", pageId);
  return raw ? (JSON.parse(raw.fields) as Field[]) : [];
};
export const titleOf = (fields: Field[], cells: Cells) => cellText(cells[fields[0]?.id || "title"]).trim();

// Titles of related records as `reader` (the person a webhook speaks for)
// may read them: records of the relation's database only, a database they
// may open (not behind a PIN they have not entered), never private records
// (the channel is not a person) nor records hidden from them.
async function relatedTitles(field: Field, ids: string[], reader: Identity | null | undefined) {
  if (!reader || !field.relationPage || !ids.length) return [];
  const page = await one<Page>("SELECT * FROM pages WHERE id=? AND deleted_at IS NULL", field.relationPage);
  if (!page || !(await pageRole(reader, page)) || (await journalLocked(reader, page))) return [];
  const stored = (await mapAsync(ids, async (rid) =>
    await one<{ id: string; cells: string; access: string; created_by: string | null }>(
      "SELECT id,cells,access,created_by FROM rows WHERE id=? AND page_id=? AND access!='private'",
      rid,
      page.id,
    ))).filter((r): r is NonNullable<typeof r> => !!r);
  const target = await fieldsOf(page.id);
  return (await visibleRows(reader, page, stored)).map((r) => titleOf(target, JSON.parse(r.cells)));
}

// A cell as people read it: names instead of user IDs, ✓ for checkboxes.
async function display(field: Field, value: unknown, reader?: Identity | null): Promise<string> {
  if (value === null || value === undefined || value === "") return "";
  if (field.type === "checkbox") return value === true ? "✓" : "✗";
  if (field.type === "person" || field.type === "created_by" || field.type === "updated_by") {
    const ids = (Array.isArray(value) ? value : [value]).filter((v): v is string => typeof v === "string").slice(0, 20);
    return (await mapAsync(ids, async (uid) => (await one<{ name: string }>("SELECT name FROM users WHERE id=?", uid))?.name || "?")).join(", ");
  }
  if (field.type === "relation") {
    const ids = (Array.isArray(value) ? value : [value]).filter((v): v is string => typeof v === "string").slice(0, 10);
    return (await relatedTitles(field, ids, reader)).filter(Boolean).join(", ");
  }
  if (typeof value === "object" && !Array.isArray(value)) return "";
  return cellText(value);
}

// `reader`: the person the notice goes out for (titles of related records
// only as far as they may read them).
export async function buildNotice(event: NoticeEvent, data: Record<string, unknown>, actor?: string | null, reader?: Identity | null): Promise<Notice> {
  const pageId = typeof data.pageId === "string" ? data.pageId : "";
  const rowId = typeof data.rowId === "string" ? data.rowId : null;
  const page = pageId ? (await one<{ title: string; parent_id: string | null }>("SELECT title,parent_id FROM pages WHERE id=?", pageId)) : undefined;
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
    const parent = page?.parent_id ? (await one<{ title: string }>("SELECT title FROM pages WHERE id=?", page.parent_id)) : undefined;
    notice.page = parent?.title || "";
    return notice;
  }
  notice.page = page?.title || "";
  if (!rowId) return notice;
  const fields = await fieldsOf(pageId);
  const stored = await one<{ cells: string }>("SELECT cells FROM rows WHERE id=?", rowId);
  const cells = (data.cells && typeof data.cells === "object" ? data.cells : stored ? JSON.parse(stored.cells) : {}) as Cells;
  notice.title = titleOf(fields, cells);
  const shown =
    event === "row.updated"
      ? fields.filter((f) => Array.isArray(data.changed) && data.changed.includes(f.id))
      : event === "row.created" || event === "form.submitted"
        ? (await filterAsync(fields.slice(1), async (f) => await display(f, cells[f.id], reader)))
        : [];
  notice.changes = await mapAsync(shown.slice(0, 20), async (f) => ({ name: f.name, value: await display(f, cells[f.id], reader) }));
  return notice;
}

const dueField = (fields: Field[]) =>
  fields.find((f) => f.type === "date" && /fällig|due|deadline|frist|termin|bis/i.test(f.name)) || fields.find((f) => f.type === "date");

// Open records of the workspace (or one database) due on `day` or earlier,
// soonest first. Private records stay out: the channel is not a person.
// With a `reader` (the person a webhook speaks for) only databases and
// records they may read, without properties hidden from them.
export async function dueItems(workspaceId: string, pageId: string | null, day: string, limit = 100, reader?: Identity) {
  const items: (NoticeItem & { pageId: string; rowId: string })[] = [];
  const pages = await all<Page>(
    "SELECT p.* FROM pages p JOIN databases d ON d.page_id=p.id WHERE p.workspace_id=? AND p.deleted_at IS NULL AND (? IS NULL OR p.id=?)",
    workspaceId,
    pageId,
    pageId,
  );
  for (const page of pages) {
    if (reader && !(await pageRole(reader, page))) continue;
    const fields = await fieldsOf(page.id);
    const due = dueField(fields);
    if (!due) continue;
    const rule = doneRule(fields, await databaseSettings(page.id));
    const stored = await all<{ id: string; cells: string; access: string; created_by: string | null }>(
      "SELECT id,cells,access,created_by FROM rows WHERE page_id=? AND access!='private'",
      page.id,
    );
    for (const row of reader ? (await visibleRows(reader, page, stored)) : stored) {
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
