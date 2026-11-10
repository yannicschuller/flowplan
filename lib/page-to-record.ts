// Moves a document page into a database: the page becomes a record with the
// same content, files, comments and versions. Links to the page are
// rewritten to the record, sub-pages move up to the page's parent, and
// sharing that only applied to the page (grants, share links, publication)
// ends; the record follows the database's permissions. The old page goes
// to the trash, so nothing is lost if the move was a mistake.
import { aliasField, pageAliases } from "./aliases";
import { Transform } from "@tiptap/pm/transform";
import type { Node as PMNode } from "@tiptap/pm/model";
import { all, id, one, run, nowText, sql } from "./db";
import { HttpError } from "./auth";
import { requirePage } from "./permissions";
import { requireUnlocked } from "./journal-extras";
import { rewriteDocument } from "./document-rewrite";
import { htmlState } from "./document-server";
import { selectedRowTemplate } from "./row-documents";
import { fillTemplateCells } from "./record-template-apply";
import { rowCreated } from "./automations";
import { autoDatabaseSnapshot } from "./database-operations";
import { captureTargets } from "./capture";
import type { Field, Identity } from "./types";
import { hiddenFieldsFor, readOnlyFieldIds, stripCells, unwritableFieldIds } from "./field-access";
import { pageTagNames } from "./page-properties-server";
import { isTagField } from "./page-properties";
import { findAsync } from "./each-async";
import { dropLiveProjectionsOfRoot } from "./shared-live";

// What the move changes, for the confirmation.
export async function pageToRecordPlan(user: Identity, pageId: string) {
  const page = await requirePage(user, pageId, true);
  await requireUnlocked(user, page);
  if (page.kind !== "document" || page.synced || page.journal_date)
    throw new HttpError(400, "Nur Dokumentseiten lassen sich in eine Datenbank verschieben.");
  const count = async (sql: string, ...args: string[]) => (await one<{ n: number }>(sql, ...args))!.n;
  return {
    page,
    subpages: await count("SELECT COUNT(*) n FROM pages WHERE parent_id=? AND deleted_at IS NULL AND synced=0", page.id),
    grants: await count("SELECT COUNT(*) n FROM grants WHERE resource_id=?", page.id),
    shareLinks: (await count(
      "SELECT COUNT(*) n FROM share_links WHERE root_id=?",
      page.id,
    )) + (await count("SELECT COUNT(DISTINCT token) n FROM share_link_pages WHERE page_id=? AND token NOT IN (SELECT token FROM share_links WHERE root_id=?)", page.id, page.id)),
    published: !!(await one("SELECT 1 FROM publications WHERE page_id=?", page.id)) || !!page.public_token,
    comments: await count("SELECT COUNT(*) n FROM comments WHERE page_id=? AND row_id IS NULL", page.id),
    versions: await count("SELECT COUNT(*) n FROM snapshots WHERE page_id=?", page.id),
    databases: (await captureTargets(user, page.workspace_id)).databases,
  };
}

const address = /^(.*#page=)([0-9a-f-]{36})((?:&block=[\w-]{1,64})?)$/i;
// Changes the href of link marks (page and record links, @ links); `href`
// returns the new address or null to keep a link as it is.
export function relinkDocument(doc: PMNode, href: (current: string) => string | null) {
  const changes: { from: number; to: number; href: string; mark: PMNode["marks"][number] }[] = [];
  doc.descendants((node, pos) => {
    if (!node.isText) return true;
    for (const mark of node.marks) {
      if (mark.type.name !== "link" || typeof mark.attrs.href !== "string") continue;
      const next = href(mark.attrs.href.trim());
      if (next !== null) changes.push({ from: pos, to: pos + node.nodeSize, href: next, mark });
    }
    return false;
  });
  if (!changes.length) return null;
  const tr = new Transform(doc);
  for (const change of changes)
    tr.removeMark(change.from, change.to, change.mark).addMark(change.from, change.to, change.mark.type.create({ ...change.mark.attrs, href: change.href }));
  return tr.doc;
}
// Links to the page (not to one of its records) now point to the record.
function relinked(doc: PMNode, pageId: string, target: string) {
  return relinkDocument(doc, (href) => {
    const match = address.exec(href);
    // A block link (#88) keeps its block: it moves along into the record.
    return match && match[2] === pageId ? `${match[1]}${target}${match[3]}` : null;
  });
}

export async function pageToRecord(user: Identity, pageId: string, databaseId: string) {
  const plan = await pageToRecordPlan(user, pageId);
  const page = plan.page;
  const database = await requirePage(user, databaseId, true);
  if (!plan.databases.some((d) => d.id === database.id) || database.workspace_id !== page.workspace_id)
    throw new HttpError(400, "In diese Datenbank kann nicht verschoben werden.");
  // Runs inside the command's transaction; the updates for open editors go
  // out once it is stored.
  const publish: (() => void)[] = [];
  const rowId = await (async () => {
    await autoDatabaseSnapshot(user, database);
    const fields = JSON.parse((await one<{ fields: string }>("SELECT fields FROM databases WHERE page_id=?", database.id))!.fields) as Field[];
    const template = await selectedRowTemplate(database.id, undefined);
    // Only properties this person may change (lib/field-access.ts).
    const fromTemplate: Record<string, unknown> = template ? stripCells(JSON.parse(template.cells), await unwritableFieldIds(user, database, fields)) : {};
    const titleId = fields[0]?.id || "title";
    fromTemplate[titleId] = page.title;
    // Placeholders in the template's text properties get this record's values.
    const cells = await fillTemplateCells(database, fromTemplate, Object.keys(fromTemplate).filter((k) => k !== titleId), user);
    // The page's aliases go to the aliases property, when the database has one.
    const aliasProperty = aliasField(fields);
    if (aliasProperty && pageAliases(page).length) cells[aliasProperty.id] = pageAliases(page);
    // The page's tags go to the database's (first) tag-backed property the
    // person may change (#79).
    const tagged = await pageTagNames(page.id);
    const tagProperty = await findAsync(fields, async (f) => isTagField(f) && !(await readOnlyFieldIds(user, database, fields)).includes(f.id) && !(await hiddenFieldsFor(user, database, fields)).has(f.id));
    if (tagProperty && tagged.length) {
      const current = Array.isArray(cells[tagProperty.id]) ? (cells[tagProperty.id] as string[]) : [];
      cells[tagProperty.id] = [...current, ...tagged.filter((n) => !current.some((c) => c.toLocaleLowerCase() === n.toLocaleLowerCase()))].slice(0, 100);
    }
    const doc = await one<{ state: Uint8Array | null; html: string; generation: string | null }>("SELECT state,html,generation FROM documents WHERE page_id=?", page.id);
    const html = doc?.html || "";
    const rid = id();
    await run(
      `INSERT INTO rows(id,page_id,cells,position,created_by,updated_by,content,icon,cover)
       VALUES(?,?,?,?,?,?,?,?,?)`,
      rid,
      database.id,
      JSON.stringify(cells),
      Date.now(),
      page.created_by,
      user.id,
      html,
      page.icon && page.icon !== "file" ? page.icon : "",
      page.cover || "",
    );
    await run(
      "INSERT INTO row_documents(row_id,state,html,generation) VALUES(?,?,?,?)",
      rid,
      doc?.state || htmlState(html),
      html,
      // The same generation keeps text comments anchored.
      doc?.generation || id(),
    );
    // Files stay the same files; they now belong to the database.
    await run("UPDATE files SET page_id=? WHERE page_id=?", database.id, page.id);
    // Comments, text comments, tasks and notifications follow the content.
    for (const table of ["comments", "inline_threads", "shared_comments", "doc_tasks", "notifications"])
      await run(`UPDATE ${table} SET page_id=?,row_id=? WHERE page_id=? AND row_id IS NULL`, database.id, rid, page.id);
    // The page's versions become versions of the record.
    for (const snapshot of await all<{ state: Uint8Array; html: string; created_by: string | null; created_at: string; kind: string }>(
      "SELECT state,html,created_by,created_at,kind FROM snapshots WHERE page_id=? ORDER BY created_at,seq",
      page.id,
    ))
      await run(
        "INSERT INTO row_snapshots(id,row_id,state,html,created_by,created_at,kind) VALUES(?,?,?,?,?,?,?)",
        id(),
        rid,
        snapshot.state,
        snapshot.html,
        snapshot.created_by,
        snapshot.created_at,
        snapshot.kind,
      );
    // Favourites become record favourites.
    await run("INSERT INTO row_favorites(user_id,row_id,page_id) SELECT user_id,?,? FROM favorites WHERE page_id=? ON CONFLICT DO NOTHING", rid, database.id, page.id);
    await run("DELETE FROM favorites WHERE page_id=?", page.id);
    // Sub-pages move up; synced blocks of the text go with it into the database.
    // Sharing set on the page kept applying to them: it stays theirs, so that
    // moving up neither opens them to more people nor closes them.
    for (const child of await all<{ id: string }>("SELECT id FROM pages WHERE parent_id=? AND synced=0", page.id))
      await run(
        `INSERT INTO grants(resource_id,user_id,group_id,role)
         SELECT ?,g.user_id,g.group_id,g.role FROM grants g WHERE g.resource_id=?
         AND NOT EXISTS (SELECT 1 FROM grants c WHERE c.resource_id=? AND c.user_id IS NOT DISTINCT FROM g.user_id AND c.group_id IS NOT DISTINCT FROM g.group_id)`,
        child.id,
        page.id,
        child.id,
      );
    await run("UPDATE pages SET parent_id=? WHERE parent_id=? AND synced=0", page.parent_id, page.id);
    await run("UPDATE pages SET parent_id=? WHERE parent_id=? AND synced=1", database.id, page.id);
    // Sharing of the page ends; the record follows the database.
    await run("DELETE FROM grants WHERE resource_id=?", page.id);
    await run("DELETE FROM share_link_pages WHERE page_id=?", page.id);
    await dropLiveProjectionsOfRoot(page.id);
    await run("DELETE FROM share_links WHERE root_id=?", page.id);
    await run("DELETE FROM publication_pages WHERE page_id=? OR root_id=?", page.id, page.id);
    await run("DELETE FROM publications WHERE page_id=?", page.id);
    await run("DELETE FROM page_follows WHERE page_id=?", page.id);
    await run("UPDATE pages SET deleted_at=?,public_token=NULL WHERE id=?", nowText(), page.id);
    // Links to the page in all texts of the workspace point to the record.
    const target = `${database.id}&row=${rid}`;
    for (const source of [
      ...await all<{ page_id: string; row_id: null }>(
        `SELECT d.page_id,NULL row_id FROM documents d JOIN pages p ON p.id=d.page_id
         WHERE p.workspace_id=? AND p.id!=? AND ${sql.instr("d.html", "?")}>0`,
        page.workspace_id,
        page.id,
        page.id,
      ),
      ...await all<{ page_id: string; row_id: string }>(
        `SELECT r.page_id,r.id row_id FROM row_documents d JOIN rows r ON r.id=d.row_id JOIN pages p ON p.id=r.page_id
         WHERE p.workspace_id=? AND ${sql.instr("d.html", "?")}>0`,
        page.workspace_id,
        page.id,
      ),
    ]) {
      const result = await rewriteDocument(source.page_id, source.row_id, user.id, (d) => relinked(d, page.id, target));
      if (result) publish.push(result.publish);
    }
    await rowCreated(user, database, rid);
    return rid;
  })();
  return { result: { id: database.id, rowId }, publish };
}
