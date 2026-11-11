// Ticket numbers on the server: one ID property per database, prefixes are
// unique in a workspace, and "WEB-123" resolves to its record for whoever
// may read it (links in text, Git commits).
import { all, one, run } from "./db";
import { HttpError } from "./auth";
import { requirePage } from "./permissions";
import { hiddenRowIds } from "./row-access";
import { journalLocked } from "./journal-extras";
import { cellText } from "./cell-text";
import { ticketId } from "./ticket-ids";
import type { Field, Identity, Page } from "./types";
import { filterAsync } from "./each-async";

export async function validateTicketPrefix(page: Page, fields: Field[]) {
  const ids = fields.filter((f) => f.type === "id");
  if (ids.length > 1) throw new HttpError(400, "Eine Datenbank hat höchstens eine ID-Eigenschaft.");
  const prefix = ids[0]?.prefix;
  if (!ids.length) return;
  if (!prefix) throw new HttpError(400, "Die ID-Eigenschaft braucht ein Präfix, z. B. WEB.");
  // An unchanged prefix stays editable, even if another database shares it.
  const stored = await one<{ fields: string }>("SELECT fields FROM databases WHERE page_id=?", page.id);
  if (stored && (JSON.parse(stored.fields) as Field[]).some((f) => f.type === "id" && f.prefix === prefix)) return;
  for (const other of await prefixes(page.workspace_id))
    if (other.prefix === prefix && other.pageId !== page.id)
      throw new HttpError(409, `Das Präfix ${prefix} nutzt schon „${other.title}“.`);
}

// A copied or restored database whose prefix another live database already
// uses gets a free one (WEB → WEB2, WEB3, …), so prefixes stay unique.
export async function claimTicketPrefix(pageId: string) {
  const page = await one<{ workspace_id: string; fields: string }>(
    "SELECT p.workspace_id,d.fields FROM pages p JOIN databases d ON d.page_id=p.id WHERE p.id=? AND p.deleted_at IS NULL",
    pageId,
  );
  if (!page) return;
  const fields = JSON.parse(page.fields) as Field[];
  const field = fields.find((f) => f.type === "id" && f.prefix);
  if (!field) return;
  const taken = new Set((await prefixes(page.workspace_id)).filter((p) => p.pageId !== pageId).map((p) => p.prefix));
  if (!taken.has(field.prefix!)) return;
  const base = field.prefix!.replace(/\d+$/, "");
  let n = 2,
    prefix = "";
  do prefix = base.slice(0, 10 - String(n).length) + n++;
  while (taken.has(prefix));
  await run(
    "UPDATE databases SET fields=?,version=version+1 WHERE page_id=?",
    JSON.stringify(fields.map((f) => (f === field ? { ...f, prefix } : f))),
    pageId,
  );
}

// Databases with an ID property in a workspace.
export async function prefixes(workspaceId: string) {
  return (await all<{ id: string; title: string; fields: string }>(
    "SELECT p.id,p.title,d.fields FROM pages p JOIN databases d ON d.page_id=p.id WHERE p.workspace_id=? AND p.deleted_at IS NULL AND d.fields LIKE '%\"type\":\"id\"%'",
    workspaceId,
  )).flatMap((p) => {
    const field = (JSON.parse(p.fields) as Field[]).find((f) => f.type === "id" && f.prefix);
    return field ? [{ pageId: p.id, title: p.title, prefix: field.prefix!, field }] : [];
  });
}
// The prefixes a person can resolve (for highlighting references).
export async function readablePrefixes(user: Identity, workspaceId: string) {
  return (await filterAsync(await prefixes(workspaceId), async (p) => {
      try {
        return !(await journalLocked(user, await requirePage(user, p.pageId)));
      } catch {
        return false;
      }
    }))
    .map((p) => ({ prefix: p.prefix, pageId: p.pageId, title: p.title }));
}

// "WEB-123" → the record, or null when it does not exist or is not visible.
export async function resolveTicket(user: Identity | null, workspaceId: string, key: string) {
  const match = /^([A-Z][A-Z0-9]{0,9})-(\d{1,7})$/.exec(key.trim().toUpperCase());
  if (!match) return null;
  const target = (await prefixes(workspaceId)).find((p) => p.prefix === match[1]);
  if (!target) return null;
  const row = await one<{ id: string; cells: string; number: number }>(
    "SELECT id,cells,number FROM rows WHERE page_id=? AND number=?",
    target.pageId,
    Number(match[2]),
  );
  if (!row) return null;
  let page: Page;
  if (user) {
    try {
      page = await requirePage(user, target.pageId);
    } catch {
      return null;
    }
    if (await journalLocked(user, page) || (await hiddenRowIds(user, page)).has(row.id)) return null;
  } else page = (await one<Page>("SELECT * FROM pages WHERE id=?", target.pageId))!;
  const fields = JSON.parse((await one<{ fields: string }>("SELECT fields FROM databases WHERE page_id=?", page.id))!.fields) as Field[];
  const cells = JSON.parse(row.cells) as Record<string, unknown>;
  const title = fields.find((f) => f.type !== "id");
  const status = fields.find((f) => f.type === "select" && /status|stand|zustand/i.test(f.name));
  return {
    key: ticketId(target.field, row.number),
    pageId: page.id,
    rowId: row.id,
    database: page.title,
    title: cellText(cells[title?.id || "title"]).slice(0, 300),
    status: status ? cellText(cells[status.id]) : "",
  };
}
