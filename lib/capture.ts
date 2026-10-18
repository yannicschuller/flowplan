// Capturing into a database (an inbox): share to Flowplan, the web clipper
// and quick capture create a record instead of a page. Each person can pick
// a default capture database per workspace; the database's default record
// template applies, so captured records land in the right view.
import { z } from "zod";
import { all, id, one, run } from "./db";
import { HttpError } from "./auth";
import { pageRole, requireMember, requirePage } from "./permissions";
import { journalLocked, lockedPageIds } from "./journal-extras";
import { cleanHtml } from "./document-server";
import { replaceRowDocument, selectedRowTemplate } from "./row-documents";
import { rowCreated } from "./automations";
import { autoDatabaseSnapshot } from "./database-operations";
import { ct } from "./content-locale";
import type { Field, Identity, Page } from "./types";

const rank: Record<string, number> = { viewer: 1, commenter: 1, editor: 2, owner: 3 };
const writable = (user: Identity, page: Page) =>
  !page.deleted_at && page.kind === "database" && !page.locked && rank[pageRole(user, page) || ""] >= 2 && !journalLocked(user, page);

// Databases of the workspace this person may add records to.
export function captureTargets(user: Identity, workspaceId: string) {
  requireMember(user, workspaceId);
  const locked = lockedPageIds(user, workspaceId);
  const spaces = new Map(
    all<{ id: string; name: string }>("SELECT id,name FROM spaces WHERE workspace_id=? AND deleted_at IS NULL", workspaceId).map((s) => [s.id, s.name]),
  );
  const databases = all<Page>(
    "SELECT * FROM pages WHERE workspace_id=? AND kind='database' AND deleted_at IS NULL AND synced=0 ORDER BY title COLLATE NOCASE",
    workspaceId,
  )
    .filter((page) => spaces.has(page.space_id) && !locked.has(page.id) && writable(user, page))
    .map((page) => ({ id: page.id, title: page.title, icon: page.icon, space: spaces.get(page.space_id) || "" }));
  const chosen = one<{ page_id: string }>("SELECT page_id FROM capture_targets WHERE user_id=? AND workspace_id=?", user.id, workspaceId)?.page_id;
  return { databases, default: databases.some((d) => d.id === chosen) ? chosen! : null };
}

export function setCaptureTarget(user: Identity, workspaceId: string, pageId: string | null) {
  requireMember(user, workspaceId);
  if (!pageId) {
    run("DELETE FROM capture_targets WHERE user_id=? AND workspace_id=?", user.id, workspaceId);
    return { default: null };
  }
  const page = requirePage(user, pageId, true);
  if (page.workspace_id !== workspaceId || !writable(user, page)) throw new HttpError(400, "In diese Datenbank kann nicht erfasst werden.");
  run(
    "INSERT INTO capture_targets(user_id,workspace_id,page_id) VALUES(?,?,?) ON CONFLICT(user_id,workspace_id) DO UPDATE SET page_id=excluded.page_id",
    user.id,
    workspaceId,
    page.id,
  );
  return { default: page.id };
}

const esc = (v: string) => v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
export const textHtml = (text: string) =>
  text
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => `<p>${esc(p).replace(/\n/g, "<br>")}</p>`)
    .join("");

const captureSchema = z.object({
  pageId: z.uuid(),
  rowId: z.uuid().optional(),
  title: z.string().max(300).optional(),
  text: z.string().max(20_000).optional(),
  url: z.string().max(2000).optional(),
  // Clipped article text (HTML from /api/clip).
  article: z.string().max(250_000).optional(),
});

// A captured item as a record: title, text and link; the link goes into the
// first URL property when there is one, otherwise into the text.
export function captureRecord(user: Identity, raw: unknown) {
  const input = captureSchema.parse(raw);
  const page = requirePage(user, input.pageId, true);
  if (!writable(user, page)) throw new HttpError(400, "In diese Datenbank kann nicht erfasst werden.");
  // Captured offline: a repeat after a lost answer creates nothing new.
  if (input.rowId) {
    const existing = one<{ page_id: string }>("SELECT page_id FROM rows WHERE id=?", input.rowId);
    if (existing?.page_id === page.id) return { id: page.id, rowId: input.rowId };
    if (existing || one("SELECT 1 FROM row_trash WHERE id=?", input.rowId)) throw new HttpError(409, "Diese Kennung ist bereits vergeben.");
  }
  const fields = JSON.parse(one<{ fields: string }>("SELECT fields FROM databases WHERE page_id=?", page.id)!.fields) as Field[];
  const template = selectedRowTemplate(page.id, undefined);
  const cells: Record<string, unknown> = template ? JSON.parse(template.cells) : {};
  const link = /^https?:\/\/\S+$/i.test(input.url?.trim() || "") ? input.url!.trim() : input.text?.match(/https?:\/\/\S+/)?.[0] || "";
  const text = (input.text || "").replace(link, "").trim();
  const title =
    input.title?.trim() || text.split("\n")[0].slice(0, 120) || (link ? new URL(link).hostname : "") || ct("Notiz", "Note");
  cells[fields[0]?.id || "title"] = title.slice(0, 1000);
  const urlField = fields.find((f) => f.type === "url");
  if (link && urlField) cells[urlField.id] = link;
  const parts = [
    textHtml(text),
    link && !urlField ? `<p><a href="${esc(link)}">${esc(link)}</a></p>` : "",
    input.article ? `${text || (link && !urlField) ? "<hr>" : ""}${cleanHtml(input.article)}` : "",
  ].join("");
  const rid = input.rowId || id();
  autoDatabaseSnapshot(user, page);
  run(
    "INSERT INTO rows(id,page_id,cells,position,created_by,updated_by) VALUES(?,?,?,?,?,?)",
    rid,
    page.id,
    JSON.stringify(cells),
    Date.now(),
    user.id,
    user.id,
  );
  const html = [template?.html || "", parts].filter(Boolean).join("");
  if (html) replaceRowDocument(rid, html, user.id);
  rowCreated(user, page, rid);
  return { id: page.id, rowId: rid };
}
