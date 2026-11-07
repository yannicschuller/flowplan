// "Turn into page": the reverse of moving a page into a database. A record
// becomes a document page with the same title, icon, cover, content, files,
// comments and versions. Links to the record are rewritten to the page, the
// properties can stay as a short list at the top of the text, and the new
// page follows the permissions of the place it goes to. The record goes to
// the trash, so nothing is lost if the change was a mistake.
import { hiddenFieldsFor } from "./field-access";
import { recordAliases, storedAliases } from "./aliases";
import { copyFileSync, existsSync, mkdirSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import { generateJSON } from "@tiptap/html/server";
import { Fragment, Node as PMNode } from "@tiptap/pm/model";
import { all, id, one, onTransactionRollback, run, nowText, sql, updateIgnoringConflicts } from "./db";
import { SPACE_ORDER } from "./space-order";
import { HttpError } from "./auth";
import { quotaCheckpoint } from "./instance-ops";
import { pageRole, requireMember, requirePage, spaceRole } from "./permissions";
import { lockedPageIds, requireUnlocked } from "./journal-extras";
import { requireRow } from "./row-documents";
import { hiddenRowIds } from "./row-access";
import { trashRow } from "./row-trash";
import { maintainRowOrders } from "./row-order-server";
import { autoDatabaseSnapshot } from "./database-operations";
import { cleanHtml, escaped, htmlState } from "./document-server";
import { documentExtensions } from "./document-schema";
import { rewriteDocument, rewriteReferences, rewriteSchema, rewriteStoredDocument } from "./document-rewrite";
import { relinkDocument } from "./page-to-record";
import { createPage } from "./seed";
import { cellText } from "./cell-text";
import { fileUrls } from "./file-cells";
import { ct } from "./content-locale";
import type { Field, Identity, Page, Space } from "./types";
import { applyPortableMeta } from "./page-properties-server";
import { isTagField } from "./page-properties";
import { filterAsync, mapAsync } from "./each-async";

// Values the database computes (or that only make sense inside it) do not
// become text.
const COMPUTED = new Set<Field["type"]>(["formula", "rollup", "created_at", "updated_at", "created_by", "updated_by", "id", "progress", "sprint", "time"]);
const FILE_URL = /\/api\/files\/([0-9a-f-]{36})/gi;
const writes = (role: string | null) => role === "editor" || role === "owner";

export type PageTarget = { spaceId: string; parentId: string | null; title: string; space: string };

// Where a new page may go: the top level of a space or below a page, both
// with write access.
async function pageTargets(user: Identity, workspaceId: string): Promise<PageTarget[]> {
  const spaces = await all<Space>(`SELECT * FROM spaces WHERE workspace_id=? AND deleted_at IS NULL ORDER BY ${SPACE_ORDER}`, workspaceId);
  const names = new Map(spaces.map((s) => [s.id, s.name]));
  const locked = await lockedPageIds(user, workspaceId);
  const pages = await filterAsync(await all<Page>(
    `SELECT * FROM pages WHERE workspace_id=? AND deleted_at IS NULL AND synced=0 AND journal_date IS NULL
     AND kind!='database' AND COALESCE(locked,0)=0 ORDER BY lower(title)`,
    workspaceId,
  ), async (p) => names.has(p.space_id) && !locked.has(p.id) && writes(await pageRole(user, p)));
  return [
    ...(await filterAsync(spaces, async (s) => writes(await spaceRole(user, s)))).map((s) => ({ spaceId: s.id, parentId: null, title: s.name, space: "" })),
    ...pages.map((p) => ({ spaceId: p.space_id, parentId: p.id, title: p.title, space: names.get(p.space_id) || "" })),
  ];
}

type Property = { name: string; text: string; html: string };
// The record's properties as readable text (and HTML with links).
async function recordProperties(user: Identity, database: Page, fields: Field[], cells: Record<string, unknown>): Promise<Property[]> {
  const out: Property[] = [];
  const link = (href: string, label: string) => `<a href="${escaped(href)}">${escaped(label)}</a>`;
  for (const field of fields.slice(1)) {
    if (COMPUTED.has(field.type)) continue;
    const value = cells[field.id];
    if (value === undefined || value === null || value === "" || value === "#ACCESS") continue;
    const list = Array.isArray(value) ? value : [value];
    if (!list.length) continue;
    let parts: { text: string; html: string }[] = [];
    if (field.type === "checkbox") {
      const text = value === true ? ct("Ja", "Yes") : ct("Nein", "No");
      parts = [{ text, html: escaped(text) }];
    } else if (field.type === "checklist")
      parts = (list as { text?: string; done?: boolean }[]).map((item) => {
        const text = `[${item?.done ? "x" : " "}] ${item?.text || ""}`;
        return { text, html: escaped(text) };
      });
    else if (field.type === "person")
      parts = await mapAsync(list, async (uid) => {
        const text = (await one<{ name: string }>("SELECT name FROM users WHERE id=?", String(uid)))?.name || ct("Unbekannt", "Unknown");
        return { text, html: escaped(text) };
      });
    else if (field.type === "relation") {
      // Only what the person may read becomes text.
      const target = field.relationPage || "";
      let related: Page;
      try {
        related = await requirePage(user, target);
      } catch {
        continue;
      }
      const hidden = await hiddenRowIds(user, related);
      const titleField =
        (JSON.parse((await one<{ fields: string }>("SELECT fields FROM databases WHERE page_id=?", related.id))?.fields || "[]") as Field[])[0]?.id || "title";
      parts = (await mapAsync(list, async (rid) => (hidden.has(String(rid)) ? undefined : (await one<{ id: string; cells: string }>("SELECT id,cells FROM rows WHERE id=? AND page_id=?", String(rid), related.id)))))
        .filter((r): r is { id: string; cells: string } => !!r)
        .map((r) => {
          const text = cellText(JSON.parse(r.cells)[titleField]) || ct("Ohne Titel", "Untitled");
          return { text, html: link(`/#page=${related.id}&row=${r.id}`, text) };
        });
    } else if (field.type === "files")
      parts = await mapAsync(fileUrls(value), async (url) => {
        const fid = /^\/api\/files\/([0-9a-f-]{36})$/i.exec(url)?.[1];
        const text = fid ? (await one<{ name: string }>("SELECT name FROM files WHERE id=? AND page_id=?", fid, database.id))?.name || ct("Datei", "File") : url;
        return { text, html: link(url, text) };
      });
    else if (field.type === "date") {
      const text = typeof value === "string" ? value.replace("T", " ").replace(/( \d{2}:\d{2}):\d{2}(?:\.\d+)?/, "$1") : cellText(value);
      parts = [{ text, html: escaped(text) }];
    } else if (field.type === "url" && /^https?:\/\//i.test(String(value))) parts = [{ text: String(value), html: link(String(value), String(value)) }];
    else if (field.type === "email") parts = [{ text: String(value), html: link(`mailto:${value}`, String(value)) }];
    else {
      const text = cellText(value);
      parts = text ? [{ text, html: escaped(text) }] : [];
    }
    if (!parts.length) continue;
    out.push({ name: field.name, text: parts.map((p) => p.text).join(", "), html: parts.map((p) => p.html).join(", ") });
  }
  return out;
}

// What turning the record into a page changes, for the confirmation.
export async function recordToPagePlan(user: Identity, databaseId: string, rowId: string) {
  const { page: database, row } = await requireRow(user, databaseId, rowId, true);
  await requireUnlocked(user, database);
  // Creating pages is for full members (as "New page").
  await requireMember(user, database.workspace_id, "editor");
  const fields = JSON.parse((await one<{ fields: string }>("SELECT fields FROM databases WHERE page_id=?", database.id))!.fields) as Field[];
  // The page would show (and the record lose) properties hidden from this
  // person (lib/field-access.ts).
  if ((await hiddenFieldsFor(user, database, fields)).size)
    throw new HttpError(403, "Dieser Eintrag hat Eigenschaften, die du nicht sehen darfst.");
  const cells = (typeof row.cells === "string" ? JSON.parse(row.cells) : row.cells) as Record<string, unknown>;
  const count = async (sql: string, ...args: string[]) => (await one<{ n: number }>(sql, ...args))!.n;
  const targets = await pageTargets(user, database.workspace_id);
  // By default the page goes where the database is.
  const fallback =
    targets.find((t) => t.parentId === database.parent_id && t.spaceId === database.space_id) ||
    targets.find((t) => t.parentId === null && t.spaceId === database.space_id) ||
    targets[0];
  return {
    database,
    row,
    cells,
    title: cellText(cells[fields[0]?.id || "title"]),
    properties: await recordProperties(user, database, fields, cells),
    comments: await count("SELECT COUNT(*) n FROM comments WHERE page_id=? AND row_id=?", database.id, row.id),
    versions: await count("SELECT COUNT(*) n FROM row_snapshots WHERE row_id=?", row.id),
    // Access set on the record itself ends; the page follows its place.
    restricted: (row.access && row.access !== "inherit") || (await count("SELECT COUNT(*) n FROM row_grants WHERE row_id=?", row.id)) > 0,
    // Relations from other records to this one end with the record.
    relations: await count(
      `SELECT COUNT(*) n FROM rows r JOIN pages p ON p.id=r.page_id WHERE p.workspace_id=? AND r.id!=? AND ${sql.instr("r.cells", "?")}>0`,
      database.workspace_id,
      row.id,
      row.id,
    ),
    targets,
    target: fallback ? { spaceId: fallback.spaceId, parentId: fallback.parentId } : null,
  };
}

// The properties as a list at the top of the document.
function withProperties(doc: PMNode, properties: Property[]) {
  const html = `<ul>${properties.map((p) => `<li><p><strong>${escaped(p.name)}:</strong> ${p.html}</p></li>`).join("")}</ul>`;
  const list = PMNode.fromJSON(rewriteSchema(), generateJSON(cleanHtml(html), documentExtensions));
  // An empty record keeps no empty paragraph below the list.
  const rest = doc.childCount === 1 && doc.firstChild?.type.name === "paragraph" && !doc.firstChild.content.size ? Fragment.empty : doc.content;
  return doc.type.create(doc.attrs, list.content.append(rest));
}

const recordAddress = /^(.*#page=)([0-9a-f-]{36})&row=([0-9a-f-]{36})((?:&thread=[0-9a-f-]{36}|&block=[\w-]{1,64})?)$/i;
const uploadsDir = () => resolve(process.env.FLOWPLAN_DATA_DIR || "./data", "uploads");

// The page gets its own copies of the database's files the record refers
// to (new rows, copies of the uploads; the S3 mirror follows the new rows).
// The originals stay with the database: the record in the trash still shows
// them after "Wiederherstellen", and versions of other records that refer to
// them keep working. A file without a local upload keeps its reference.
async function copyFiles(fileIds: string[], database: Page, pageId: string, userId: string) {
  const copies = new Map<string, string>();
  const dir = uploadsDir();
  for (const fid of fileIds) {
    const file = await one<{ name: string; mime: string; size: number }>("SELECT name,mime,size FROM files WHERE id=? AND page_id=?", fid, database.id);
    const from = resolve(dir, fid);
    if (!file || !existsSync(from)) continue;
    const fresh = id(),
      destination = resolve(dir, fresh);
    mkdirSync(dir, { recursive: true });
    copyFileSync(from, destination);
    onTransactionRollback(() => {
      try {
        unlinkSync(destination);
      } catch {}
    });
    await run("INSERT INTO files(id,page_id,name,mime,size,created_by) VALUES(?,?,?,?,?,?)", fresh, pageId, file.name, file.mime, file.size, userId);
    copies.set(fid, fresh);
  }
  return copies;
}

export async function recordToPage(
  user: Identity,
  databaseId: string,
  rowId: string,
  options: { spaceId: string; parentId: string | null; keepProperties: boolean },
) {
  const plan = await recordToPagePlan(user, databaseId, rowId);
  const { database, row } = plan;
  const target = plan.targets.find((t) => t.spaceId === options.spaceId && t.parentId === options.parentId);
  if (!target) throw new HttpError(400, "An diesen Ort kann nicht verschoben werden.");
  // Runs inside the command's transaction; the updates for open editors go
  // out once it is stored.
  const publish: (() => void)[] = [];
  // The copies of the files count against the workspace quota, like a page copy.
  const quota = await quotaCheckpoint(database.workspace_id);
  await autoDatabaseSnapshot(user, database);
  const pageId = await createPage(database.workspace_id, target.spaceId, user.id, plan.title, "document", target.parentId);
  // The record's aliases stay the page's aliases.
  {
    const fields = JSON.parse((await one<{ fields: string }>("SELECT fields FROM databases WHERE page_id=?", database.id))!.fields) as Field[];
    const cells = (typeof row.cells === "string" ? JSON.parse(row.cells) : row.cells) as Record<string, unknown>;
    const aliases = recordAliases(fields, cells);
    if (aliases.length) await run("UPDATE pages SET aliases=? WHERE id=?", storedAliases(aliases), pageId);
    // The tags of its tag-backed properties (those the person reads) become
    // the page's tags (#79).
    const hidden = await hiddenFieldsFor(user, database, fields);
    const tags = fields
      .filter((f) => isTagField(f) && !hidden.has(f.id))
      .flatMap((f) => (Array.isArray(cells[f.id]) ? (cells[f.id] as unknown[]) : []))
      .filter((v): v is string => typeof v === "string");
    if (tags.length) {
      const page = (await one<Page>("SELECT * FROM pages WHERE id=?", pageId))!;
      await applyPortableMeta(user, page, { tags: tags.map((name) => ({ name })) }, { createTags: false });
    }
  }
  const creator = row.created_by && await one("SELECT 1 FROM users WHERE id=?", row.created_by) ? row.created_by : user.id;
  // The same document: its Yjs state and generation stay, so text comments
  // and authorship keep their places.
  const doc = await one<{ state: Uint8Array | null; html: string; generation: string }>(
    "SELECT state,html,generation FROM row_documents WHERE row_id=?",
    row.id,
  );
  const html = doc?.html ?? row.content ?? "";
  // The page refers to its own copies of the files; the record keeps the originals.
  const comments = await all<{ id: string; body: string }>("SELECT id,body FROM comments WHERE page_id=? AND row_id=?", database.id, row.id);
  const fileIds = [
    ...new Set(
      [...[JSON.stringify(plan.cells), row.icon || "", row.cover || "", html, ...comments.map((c) => c.body)].join(" ").matchAll(FILE_URL)].map((m) =>
        m[1].toLowerCase(),
      ),
    ),
  ];
  const copies = await copyFiles(fileIds, database, pageId, user.id);
  const swap = (text: string) =>
    copies.size ? text.replace(FILE_URL, (match, fid: string) => (copies.has(fid.toLowerCase()) ? `/api/files/${copies.get(fid.toLowerCase())}` : match)) : text;
  await run("UPDATE pages SET icon=?,cover=?,created_by=? WHERE id=?", swap(row.icon || "file"), swap(row.cover || ""), creator, pageId);
  await run("UPDATE documents SET state=?,html=?,generation=? WHERE page_id=?", doc?.state || htmlState(html), html, doc?.generation || id(), pageId);
  const result = await rewriteDocument(pageId, null, user.id, (d) => {
    const listed = options.keepProperties && plan.properties.length ? withProperties(d, plan.properties) : d;
    const next = rewriteReferences(listed, swap) || listed;
    return next === d ? null : next;
  });
  if (result) publish.push(result.publish);
  for (const comment of comments) if (swap(comment.body) !== comment.body) await run("UPDATE comments SET body=? WHERE id=?", swap(comment.body), comment.id);
  // Comments, text comments, tasks, authorship and notifications follow the content.
  for (const table of ["comments", "inline_threads", "shared_comments", "notifications"])
    await run(`UPDATE ${table} SET page_id=?,row_id=NULL WHERE page_id=? AND row_id=?`, pageId, database.id, row.id);
  for (const table of ["doc_tasks", "document_authors"])
    await updateIgnoringConflicts(table, "page_id=?,row_id=''", "page_id=? AND row_id=?", [pageId], [database.id, row.id]);
  // The record's versions become versions of the page (referring to the page's files).
  for (const snapshot of await all<{ state: Uint8Array; html: string; created_by: string | null; created_at: string; kind: string }>(
    "SELECT state,html,created_by,created_at,kind FROM row_snapshots WHERE row_id=? ORDER BY created_at",
    row.id,
  )) {
    const rewritten =
      copies.size && snapshot.html.includes("/api/files/") ? rewriteStoredDocument(snapshot.state, snapshot.html, (d) => rewriteReferences(d, swap)) : null;
    await run(
      "INSERT INTO snapshots(id,page_id,state,html,title,created_by,created_at,kind) VALUES(?,?,?,?,?,?,?,?)",
      id(),
      pageId,
      rewritten?.state || snapshot.state,
      rewritten?.html || snapshot.html,
      plan.title,
      snapshot.created_by,
      snapshot.created_at,
      snapshot.kind,
    );
  }
  // Record favourites become page favourites.
  await run("INSERT INTO favorites(user_id,page_id) SELECT user_id,? FROM row_favorites WHERE row_id=? ON CONFLICT DO NOTHING", pageId, row.id);
  // The record goes to the trash (restorable, under the same id).
  await trashRow(user, database, row.id);
  await maintainRowOrders(database.id);
  await run("UPDATE pages SET updated_at=? WHERE id=?", nowText(), database.id);
  // Links to the record in all texts of the workspace point to the page.
  const relink = (d: PMNode) =>
    relinkDocument(d, (href) => {
      const match = recordAddress.exec(href);
      return match && match[2] === database.id && match[3] === row.id ? `${match[1]}${pageId}${match[4]}` : null;
    });
  for (const source of [
    ...await all<{ page_id: string; row_id: null }>(
      `SELECT d.page_id,NULL row_id FROM documents d JOIN pages p ON p.id=d.page_id
       WHERE p.workspace_id=? AND ${sql.instr("d.html", "?")}>0`,
      database.workspace_id,
      row.id,
    ),
    ...await all<{ page_id: string; row_id: string }>(
      `SELECT r.page_id,r.id row_id FROM row_documents d JOIN rows r ON r.id=d.row_id JOIN pages p ON p.id=r.page_id
       WHERE p.workspace_id=? AND ${sql.instr("d.html", "?")}>0`,
      database.workspace_id,
      row.id,
    ),
  ]) {
    const result = await rewriteDocument(source.page_id, source.row_id, user.id, relink);
    if (result) publish.push(result.publish);
  }
  quota();
  return { result: { id: pageId }, publish };
}
