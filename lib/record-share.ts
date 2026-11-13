// Sharing and publishing a single record (#231): the record's own links –
// role, password and end date like a page's links (lib/share-links.ts) –
// and its publication on the web, kept in record_shares (lib/db.ts).
//
// The access model is deliberately narrow. A record token is never a token
// of the page tree: publicTree() and publicPage() (lib/publication.ts) do
// not know it and answer 404, so nothing that serves pages, databases,
// views, embeds, whiteboards, notebooks, ink, copies or custom domains can
// be reached with it. The few ways that do serve a shared record ask
// recordScope() explicitly and get exactly one record:
//
// - its title, icon, cover, document and the properties chosen for it
//   (recordShownFields; the rest of the database stays unknown),
// - files only when this record references them (recordFile): in its
//   document, its shown files properties, its icon or cover, or a guest
//   upload of this very link – never another record's attachments,
// - guest comments, edits and live editing of this record only
//   (lib/shared-content.ts, lib/share-presence.ts, lib/shared-uploads.ts);
//   links inside the document to other pages and records are removed for
//   visitors, as on a page shared without them.
//
// Access ends with the link (revoked, expired), when the record is deleted
// (foreign key), moved to another database, made private, or its database
// is deleted; a database in a journal with a PIN shares nothing.
//
// Sub-pages under records (#231, lib/record-pages.ts) join only with
// "Unterseiten einbeziehen" (include_children, recordSharePages): visitors
// then open them as pages of the share – nothing above or beside them.
import { z } from "zod";
import { all, audit, id, lockFor, one, run } from "./db";
import { HttpError } from "./auth";
import { pageRole, requirePage } from "./permissions";
import { assertRowAccess, rowRoleResolver } from "./row-access";
import { inPinJournal, lockedPageIds, pinJournalPageIds, PIN_JOURNAL_NOT_SHARED, requireUnlocked } from "./journal-extras";
import { privateRecordPageIds, recordSubPageIds, recordSubTree } from "./record-pages";
import { checkShareProtection, protectionChanges } from "./share-access";
import { publicHiddenFieldIds, readRestricted, stripCells } from "./field-access";
import { publicFieldIds } from "./shared-content";
import { imageFileId } from "./page-appearance";
import { cleanHtml } from "./document-server";
import { fileIdOf, fileUrls } from "./file-cells";
import { isEncryptedPage } from "./e2ee-server";
import { dropLiveProjections } from "./shared-live";
import { securityEvent } from "./security-events";
import { behindJournalPin, runnerIdentity } from "./workflows/runner";
import type { Field, Identity, Page, Row } from "./types";

export type RecordShareRole = "viewer" | "commenter" | "editor";
type ShareRow = {
  token: string;
  page_id: string;
  row_id: string;
  kind: "link" | "publication";
  name: string;
  role: RecordShareRole;
  include_children: number;
  password_hash: string | null;
  expires_at: number | null;
  created_by: string | null;
  created_at: number;
};
type StoredRow = Omit<Row, "cells"> & { cells: string };
export type RecordScope = {
  token: string;
  share: ShareRow;
  publication: boolean;
  // The database the record lives in: its fields, never its other records.
  page: Page;
  row: StoredRow;
  role: RecordShareRole;
  fields: Field[];
  // The title property (shown as the heading) and the properties visitors
  // see, in the database's order.
  titleField: Field | undefined;
  shown: Field[];
};
export const MAX_RECORD_LINKS = 50;

// ---- Properties visitors see ----

// Never shown: properties with a read rule and what the field rules hide
// from public readers (rollups read other records' values; lib/field-access.ts).
export function recordEligibleFields(fields: Field[]) {
  const hidden = publicHiddenFieldIds(fields);
  return fields.slice(1).filter((f) => !hidden.has(f.id) && !readRestricted(f) && f.type !== "rollup");
}
// Shown by default: the properties a publication shows anyway (no people,
// relations or formulas reading them) and the record's own files.
// Relations (the titles of other records) and people (member names) only
// when chosen.
export function recordDefaultField(f: Field, fields: Field[]) {
  return publicFieldIds(fields).has(f.id) || f.type === "files";
}
export function recordShownFields(fields: Field[], chosen: string[] | null) {
  const eligible = recordEligibleFields(fields);
  if (!chosen) return eligible.filter((f) => recordDefaultField(f, fields));
  const set = new Set(chosen);
  return eligible.filter((f) => set.has(f.id));
}
async function chosenFields(rowId: string) {
  const stored = await one<{ fields: string }>("SELECT fields FROM record_share_fields WHERE row_id=?", rowId);
  if (!stored) return null;
  try {
    const parsed = JSON.parse(stored.fields);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : null;
  } catch {
    return null;
  }
}
const databaseFields = async (pageId: string): Promise<Field[]> =>
  JSON.parse(String((await one<{ fields: string }>("SELECT fields FROM databases WHERE page_id=?", pageId))?.fields || "[]"));

// ---- Linked records ----

// The database a relation points to, if `who` may read it: in the same
// workspace, not deleted, not end-to-end encrypted and not in a journal
// with a PIN (shares have no unlocked session). null otherwise.
async function readableRelationTarget(who: Identity | null, workspaceId: string, pageId: string | undefined) {
  if (!who || !pageId) return null;
  const target = await one<Page>("SELECT * FROM pages WHERE id=? AND workspace_id=? AND deleted_at IS NULL", pageId, workspaceId);
  if (!target || !(await pageRole(who, target)) || (await behindJournalPin(target)) || (await isEncryptedPage(target))) return null;
  return target;
}
// Relations show the titles of other records, so a share shows them only
// as far as the person who made it may read them – loaded fresh, without
// admin rights (runnerIdentity); none when that person is unknown or gone.
async function withReadableRelations(createdBy: string | null, workspaceId: string, shown: Field[]) {
  if (!shown.some((f) => f.type === "relation")) return shown;
  const who = await runnerIdentity(createdBy);
  const kept: Field[] = [];
  for (const f of shown)
    if (f.type !== "relation" || (await readableRelationTarget(who, workspaceId, f.relationPage))) kept.push(f);
  return kept;
}

// ---- Visitors ----

// null: `token` is no record share (a page link, a publication or nothing).
// Otherwise the one record it opens, or an error: 404 when the record or
// its database is gone, moved or private; 410 or 401 for the link's end
// date and password (lib/share-access.ts).
export async function recordScope(token: string, options: { protect?: boolean } = {}): Promise<RecordScope | null> {
  if (!/^[0-9a-f-]{36}$/i.test(token)) return null;
  const share = await one<ShareRow>("SELECT * FROM record_shares WHERE token=?", token);
  if (!share) return null;
  const page = await one<Page>("SELECT * FROM pages WHERE id=? AND deleted_at IS NULL", share.page_id);
  const row = page?.kind === "database"
    ? await one<StoredRow>("SELECT * FROM rows WHERE id=? AND page_id=?", share.row_id, page.id)
    : undefined;
  if (!page || !row || row.access === "private" || await inPinJournal(page) || await isEncryptedPage(page))
    throw new HttpError(404, "Eintrag nicht gefunden.");
  if (options.protect !== false) checkShareProtection(token, share);
  const fields = await databaseFields(page.id);
  return {
    token,
    share,
    publication: share.kind === "publication",
    page,
    row,
    role: share.kind === "publication" ? "viewer" : share.role,
    fields,
    titleField: fields[0],
    shown: await withReadableRelations(share.created_by, page.workspace_id, recordShownFields(fields, await chosenFields(row.id))),
  };
}
// The record's cells as visitors may know them: the title and the shown
// properties, nothing else.
export function recordCells(scope: RecordScope): Record<string, unknown> {
  const all = stripCells(JSON.parse(scope.row.cells || "{}"), publicHiddenFieldIds(scope.fields)) as Record<string, unknown>;
  const keep = [scope.titleField, ...scope.shown].filter((f): f is Field => !!f).map((f) => f.id);
  return Object.fromEntries(keep.filter((k) => Object.hasOwn(all, k)).map((k) => [k, all[k]]));
}
// Pages of the share besides the record: with "Unterseiten einbeziehen"
// (record_shares.include_children, #231) the record's sub-pages and
// everything below them, as a page link with sub-pages has them – never a
// workflow page, a journal with a PIN or what sits below a private record
// further down; a page whose parent is left out stays out. Without it: none.
// Visitors open them at /share/<token>/<page id> (publicPage in
// lib/publication.ts), their files through publicFile.
export async function recordSharePages(scope: RecordScope): Promise<Page[]> {
  if (!scope.share.include_children) return [];
  const tree = await recordSubTree(scope.page.id, scope.row.id);
  if (!tree.length) return [];
  const pinned = await pinJournalPageIds(scope.page.workspace_id);
  const out = new Set([...pinned, ...(await privateRecordPageIds(tree))]);
  for (const p of tree) if (p.kind === "workflow") out.add(p.id);
  const shown = new Set<string>();
  let grown = true;
  while (grown) {
    grown = false;
    for (const p of tree)
      if (
        !shown.has(p.id) &&
        !out.has(p.id) &&
        ((p.parent_id === scope.page.id && p.parent_row_id === scope.row.id) || (!!p.parent_id && shown.has(p.parent_id)))
      ) {
        shown.add(p.id);
        grown = true;
      }
  }
  return tree.filter((p) => shown.has(p.id)).sort((a, b) => a.position - b.position || a.id.localeCompare(b.id));
}
// A sub-page of a shared record, for the page paths of a share (publicPage):
// the record stands in as the share's root – its title, never the
// database's – and a read-only record lets guest editors comment only.
export async function recordSubPage(scope: RecordScope, pageId: string | undefined) {
  const pages = await recordSharePages(scope);
  const page = pages.find((p) => p.id === pageId);
  if (!page) throw new HttpError(404, "Seite nicht veröffentlicht.");
  const root: Page = { ...scope.page, title: recordTitle(scope), icon: scope.row.icon || "", cover: "", public_token: null };
  const role: RecordShareRole = scope.row.access === "readonly" && scope.role === "editor" ? "commenter" : scope.role;
  return { root, page, role, pages };
}

// A file the shared record uses. Its own database's other records, the
// database page's files and anything else stay out.
export async function recordFile(scope: RecordScope, fileId: string) {
  const file = await one<{ id: string; page_id: string; name: string; mime: string }>(
    "SELECT * FROM files WHERE id=? AND deleted_at IS NULL",
    fileId,
  );
  if (!file || file.page_id !== scope.page.id) throw new HttpError(404, "Datei nicht veröffentlicht.");
  if (await one("SELECT 1 FROM share_uploads WHERE file_id=? AND token=?", fileId, scope.token)) return file;
  if ((await recordFileIds(scope)).has(fileId)) return file;
  throw new HttpError(404, "Datei nicht veröffentlicht.");
}
export async function recordFileIds(scope: RecordScope) {
  const ids = new Set<string>();
  for (const value of [scope.row.icon, scope.row.cover]) {
    const fid = imageFileId(value || "");
    if (fid) ids.add(fid);
  }
  const cells = recordCells(scope);
  for (const f of scope.shown)
    if (f.type === "files")
      for (const url of fileUrls(cells[f.id])) {
        const fid = fileIdOf(url);
        if (fid) ids.add(fid);
      }
  cleanHtml(await recordHtml(scope), (tagName, attribs) => {
    for (const attr of ["src", "href", "data-pdf"]) {
      const m = /^\/api\/files\/([\w-]+)$/.exec(attribs[attr] || "");
      if (m) ids.add(m[1]);
    }
    return { tagName, attribs };
  });
  return ids;
}
// The record's document as stored (before publishedHtml() cleans it).
export async function recordHtml(scope: RecordScope) {
  return String(
    (await one<{ html: string }>("SELECT html FROM row_documents WHERE row_id=?", scope.row.id))?.html || scope.row.content || "",
  );
}
// The record's title for the heading, the tab and the presence name.
export function recordTitle(scope: RecordScope) {
  const value = scope.titleField ? recordCells(scope)[scope.titleField.id] : "";
  return typeof value === "string" ? value : Array.isArray(value) ? value.join(", ") : value == null ? "" : String(value);
}
// Display values of relations and people that were chosen to be shown:
// titles of the linked records (not private ones, and only what the
// share's creator may read; no links) and the names of members of the
// workspace.
export async function recordReferenceNames(scope: RecordScope) {
  const cells = recordCells(scope);
  const creator = scope.shown.some((f) => f.type === "relation") ? await runnerIdentity(scope.share.created_by) : null;
  const relations: Record<string, string[]> = {};
  const people: Record<string, string[]> = {};
  for (const f of scope.shown) {
    const ids = (Array.isArray(cells[f.id]) ? cells[f.id] as unknown[] : cells[f.id] ? [cells[f.id]] : [])
      .filter((v): v is string => typeof v === "string")
      .slice(0, 50);
    if (!ids.length) continue;
    if (f.type === "relation" && f.relationPage) {
      const names: string[] = [];
      relations[f.id] = names;
      const targetPage = await readableRelationTarget(creator, scope.page.workspace_id, f.relationPage);
      if (!targetPage || !creator) continue;
      const mayRead = await rowRoleResolver(creator, targetPage);
      const target = await databaseFields(f.relationPage);
      const titleId = target[0]?.id || "title";
      for (const rid of ids) {
        const r = await one<{ id: string; access: string; created_by: string | null; cells: string }>(
          "SELECT id,access,created_by,cells FROM rows WHERE id=? AND page_id=? AND access!='private'",
          rid,
          targetPage.id,
        );
        if (!r || !mayRead(r)) continue;
        const title = (JSON.parse(r.cells) as Record<string, unknown>)[titleId];
        names.push(typeof title === "string" && title.trim() ? title : "—");
      }
    }
    if (["person", "created_by", "updated_by"].includes(f.type)) {
      const names: string[] = [];
      for (const uid of ids) {
        const u = await one<{ name: string }>(
          "SELECT u.name FROM users u JOIN members m ON m.user_id=u.id AND m.workspace_id=? WHERE u.id=?",
          scope.page.workspace_id,
          uid,
        );
        if (u) names.push(u.name);
      }
      people[f.id] = names;
    }
  }
  return { relations, people };
}

// ---- Members: the record's Share menu ----

export type RecordShareLink = {
  token: string;
  name: string;
  role: RecordShareRole;
  password: boolean;
  expires_at: number | null;
  includeChildren: boolean;
};
export type RecordShares = {
  links: RecordShareLink[];
  publication: { token: string; password: boolean; expiresAt: number | null; publishedAt: number; includeChildren: boolean } | null;
  // The record's sub-pages (#231): how many there are to include.
  subPages: number;
  // Every property that can be shown, with whether visitors see it now.
  fields: { id: string; name: string; type: string; shown: boolean; byDefault: boolean }[];
  chosen: boolean;
  private: boolean;
};

const target = z.object({ pageId: z.uuid(), rowId: z.uuid() }).passthrough();
// Who shares a record: whoever may edit it (database write access and an
// editing role on the record itself, lib/row-access.ts) – like page links.
async function requireRecordSharer(user: Identity, raw: unknown) {
  const b = target.parse(raw);
  const page = await requirePage(user, b.pageId, true);
  await requireUnlocked(user, page);
  if (page.kind !== "database") throw new HttpError(400, "Nur Einträge von Datenbanken lassen sich so teilen.");
  const row = await one<{ id: string; access: string; created_by: string | null }>(
    "SELECT id,access,created_by FROM rows WHERE id=? AND page_id=?",
    b.rowId,
    page.id,
  );
  if (!row) throw new HttpError(404, "Datensatz nicht gefunden.");
  await assertRowAccess(user, page, row, true);
  return { page, row, b };
}
// Sharing the record with its sub-pages: the person may edit each of them
// (as for a page link with sub-pages, lib/share-links.ts) and enters no
// journal behind a PIN they have not opened.
async function requireSubPagesShareable(user: Identity, page: Page, rowId: string) {
  const locked = await lockedPageIds(user, page.workspace_id);
  for (const p of await recordSubTree(page.id, rowId)) {
    await requirePage(user, p.id, true);
    if (locked.has(p.id)) throw new HttpError(423, "Dieses Journal ist gesperrt.");
  }
}
async function sharesOf(page: Page, rowId: string, access: string): Promise<RecordShares> {
  const list = await all<ShareRow>("SELECT * FROM record_shares WHERE row_id=? AND page_id=? ORDER BY created_at,token", rowId, page.id);
  const fields = await databaseFields(page.id);
  const chosen = await chosenFields(rowId);
  const shown = new Set(recordShownFields(fields, chosen).map((f) => f.id));
  const publication = list.find((s) => s.kind === "publication");
  return {
    links: list
      .filter((s) => s.kind === "link")
      .map((s) => ({ token: s.token, name: s.name, role: s.role, password: !!s.password_hash, expires_at: s.expires_at, includeChildren: !!s.include_children })),
    publication: publication
      ? { token: publication.token, password: !!publication.password_hash, expiresAt: publication.expires_at, publishedAt: publication.created_at, includeChildren: !!publication.include_children }
      : null,
    subPages: (await recordSubPageIds(page.id, rowId)).length,
    fields: recordEligibleFields(fields).map((f) => ({ id: f.id, name: f.name, type: f.type, shown: shown.has(f.id), byDefault: recordDefaultField(f, fields) })),
    chosen: !!chosen,
    private: access === "private",
  };
}
export async function recordShares(user: Identity, raw: unknown) {
  const { page, row } = await requireRecordSharer(user, raw);
  return await sharesOf(page, row.id, row.access);
}
// The commands of the record's Share menu (inside the command transaction).
export async function recordShareCommand(user: Identity, action: string, raw: unknown) {
  const { page, row, b } = await requireRecordSharer(user, raw);
  const revoking = action === "record.share.revoke" || (action === "record.publish" && b.enabled === false);
  if (!revoking) {
    // A journal with a PIN is never shared, private records stay with the
    // people they are shared with (lib/row-access.ts).
    if (await inPinJournal(page)) throw new HttpError(423, PIN_JOURNAL_NOT_SHARED);
    if (row.access === "private" && action !== "record.share.fields")
      throw new HttpError(409, "Private Einträge lassen sich nicht per Link teilen oder veröffentlichen.");
  }
  await lockFor(`record-shares:${row.id}`);
  switch (action) {
    case "record.share.create": {
      const protection = protectionChanges({ password: b.password, expiresAt: b.expiresAt });
      const role = z.enum(["viewer", "commenter", "editor"]).parse(b.role);
      const name = z.string().trim().min(1).max(100).parse(b.name);
      const includeChildren = z.boolean().default(false).parse(b.includeChildren);
      if (includeChildren) await requireSubPagesShareable(user, page, row.id);
      if (
        Number((await one<{ n: number }>("SELECT count(*) n FROM record_shares WHERE row_id=? AND kind='link'", row.id))?.n || 0) >=
        MAX_RECORD_LINKS
      )
        throw new HttpError(400, "Maximal 50 aktive Links pro Eintrag.");
      const token = id();
      await run(
        "INSERT INTO record_shares(token,page_id,row_id,kind,name,role,include_children,password_hash,expires_at,created_by,created_at) VALUES(?,?,?,'link',?,?,?,?,?,?,?)",
        token,
        page.id,
        row.id,
        name,
        role,
        includeChildren ? 1 : 0,
        protection.password_hash ?? null,
        protection.expires_at ?? null,
        user.id,
        Date.now(),
      );
      await audit(user.id, "record.share", page.id, `${row.id}:${role}`);
      return { token, ...(await sharesOf(page, row.id, row.access)) };
    }
    case "record.share.revoke": {
      const token = z.uuid().parse(b.token);
      if ((await run("DELETE FROM record_shares WHERE token=? AND row_id=? AND kind='link'", token, row.id)).changes)
        await dropLiveProjections([token]);
      return await sharesOf(page, row.id, row.access);
    }
    case "record.share.protect":
    case "record.publication.protect": {
      const share =
        action === "record.share.protect"
          ? await one<{ token: string }>("SELECT token FROM record_shares WHERE token=? AND row_id=? AND kind='link'", z.uuid().parse(b.token), row.id)
          : await one<{ token: string }>("SELECT token FROM record_shares WHERE row_id=? AND kind='publication'", row.id);
      if (!share) throw new HttpError(404, action === "record.share.protect" ? "Link nicht gefunden." : "Dieser Eintrag ist nicht veröffentlicht.");
      const changes = protectionChanges({ password: b.password, expiresAt: b.expiresAt });
      if (changes.password_hash !== undefined) await run("UPDATE record_shares SET password_hash=? WHERE token=?", changes.password_hash, share.token);
      if (changes.expires_at !== undefined) await run("UPDATE record_shares SET expires_at=? WHERE token=?", changes.expires_at, share.token);
      return await sharesOf(page, row.id, row.access);
    }
    case "record.publish": {
      const enabled = z.boolean().parse(b.enabled);
      const existing = await one<{ token: string }>("SELECT token FROM record_shares WHERE row_id=? AND kind='publication'", row.id);
      if (!enabled) {
        if (existing) {
          await run("DELETE FROM record_shares WHERE token=?", existing.token);
          await dropLiveProjections([existing.token]);
        }
      } else {
        if (page.locked) throw new HttpError(409, "Diese Seite ist gesperrt.");
        // "Unterseiten einbeziehen" (#231): kept unless given.
        const includeChildren = z.boolean().optional().parse(b.includeChildren);
        if (includeChildren) await requireSubPagesShareable(user, page, row.id);
        if (!existing) {
          await run(
            "INSERT INTO record_shares(token,page_id,row_id,kind,name,role,include_children,created_by,created_at) VALUES(?,?,?,'publication','','viewer',?,?,?)",
            id(),
            page.id,
            row.id,
            includeChildren ? 1 : 0,
            user.id,
            Date.now(),
          );
          securityEvent("share.public", { actorId: user.id, detail: `record ${row.id} of page ${page.id}` });
        } else if (includeChildren !== undefined) {
          await run("UPDATE record_shares SET include_children=? WHERE token=?", includeChildren ? 1 : 0, existing.token);
          // Visitors with a page open lose it at once when sub-pages leave.
          if (!includeChildren) await dropLiveProjections([existing.token]);
        }
      }
      return await sharesOf(page, row.id, row.access);
    }
    case "record.share.fields": {
      const fields = z.array(z.string().max(100)).max(500).nullable().parse(b.fields);
      if (fields === null) await run("DELETE FROM record_share_fields WHERE row_id=?", row.id);
      else {
        // Only what can be shown at all is stored – relations only to
        // databases this person may read.
        const eligible = new Set(
          (await withReadableRelations(user.id, page.workspace_id, recordEligibleFields(await databaseFields(page.id)))).map((f) => f.id),
        );
        const list = JSON.stringify([...new Set(fields)].filter((f) => eligible.has(f)));
        await run(
          "INSERT INTO record_share_fields(row_id,fields) VALUES(?,?) ON CONFLICT(row_id) DO UPDATE SET fields=excluded.fields",
          row.id,
          list,
        );
      }
      return await sharesOf(page, row.id, row.access);
    }
  }
  throw new HttpError(400, "Unbekannte Aktion.");
}

// ---- Ending access along with the record or its database ----

// The database page is deleted or leaves the workspace: every record share
// in it ends (like the page's own links, lib/workspace-lifecycle.ts).
export async function revokeRecordSharesOfPage(pageId: string) {
  const tokens = (await all<{ token: string }>("SELECT token FROM record_shares WHERE page_id=?", pageId)).map((s) => s.token);
  if (!tokens.length) return;
  await dropLiveProjections(tokens);
  await run("DELETE FROM record_shares WHERE page_id=?", pageId);
}
// A record moves to another database: its shares end (the foreign key
// removes them when it is deleted).
export async function revokeRecordSharesOfRow(rowId: string) {
  const tokens = (await all<{ token: string }>("SELECT token FROM record_shares WHERE row_id=?", rowId)).map((s) => s.token);
  if (!tokens.length) return;
  await dropLiveProjections(tokens);
  await run("DELETE FROM record_shares WHERE row_id=?", rowId);
}
