// Moves a document page into a database: the page becomes a record with the
// same content, files, comments and versions. Links to the page are
// rewritten to the record, sub-pages move up to the page's parent, and
// sharing that only applied to the page (grants, share links, publication)
// ends; the record follows the database's permissions. The old page goes
// to the trash, so nothing is lost if the move was a mistake.
import { Transform } from "@tiptap/pm/transform";
import type { Node as PMNode } from "@tiptap/pm/model";
import { all, id, one, run } from "./db";
import { HttpError } from "./auth";
import { requirePage } from "./permissions";
import { requireUnlocked } from "./journal-extras";
import { rewriteDocument } from "./document-rewrite";
import { htmlState } from "./document-server";
import { selectedRowTemplate } from "./row-documents";
import { rowCreated } from "./automations";
import { autoDatabaseSnapshot } from "./database-operations";
import { captureTargets } from "./capture";
import type { Field, Identity, Page } from "./types";

// What the move changes, for the confirmation.
export function pageToRecordPlan(user: Identity, pageId: string) {
  const page = requirePage(user, pageId, true);
  requireUnlocked(user, page);
  if (page.kind !== "document" || page.synced || page.journal_date)
    throw new HttpError(400, "Nur Dokumentseiten lassen sich in eine Datenbank verschieben.");
  const count = (sql: string, ...args: string[]) => one<{ n: number }>(sql, ...args)!.n;
  return {
    page,
    subpages: count("SELECT COUNT(*) n FROM pages WHERE parent_id=? AND deleted_at IS NULL AND synced=0", page.id),
    grants: count("SELECT COUNT(*) n FROM grants WHERE resource_id=?", page.id),
    shareLinks: count(
      "SELECT COUNT(*) n FROM share_links WHERE root_id=?",
      page.id,
    ) + count("SELECT COUNT(DISTINCT token) n FROM share_link_pages WHERE page_id=? AND token NOT IN (SELECT token FROM share_links WHERE root_id=?)", page.id, page.id),
    published: !!one("SELECT 1 FROM publications WHERE page_id=?", page.id) || !!page.public_token,
    comments: count("SELECT COUNT(*) n FROM comments WHERE page_id=? AND row_id IS NULL", page.id),
    versions: count("SELECT COUNT(*) n FROM snapshots WHERE page_id=?", page.id),
    databases: captureTargets(user, page.workspace_id).databases,
  };
}

const address = /^(.*#page=)([0-9a-f-]{36})$/i;
// Links to the page (not to one of its records) now point to the record.
function relinked(doc: PMNode, pageId: string, target: string) {
  const changes: { from: number; to: number; href: string; mark: PMNode["marks"][number] }[] = [];
  doc.descendants((node, pos) => {
    if (!node.isText) return true;
    for (const mark of node.marks) {
      if (mark.type.name !== "link" || typeof mark.attrs.href !== "string") continue;
      const match = address.exec(mark.attrs.href.trim());
      if (match && match[2] === pageId) changes.push({ from: pos, to: pos + node.nodeSize, href: `${match[1]}${target}`, mark });
    }
    return false;
  });
  if (!changes.length) return null;
  const tr = new Transform(doc);
  for (const change of changes)
    tr.removeMark(change.from, change.to, change.mark).addMark(change.from, change.to, change.mark.type.create({ ...change.mark.attrs, href: change.href }));
  return tr.doc;
}

export function pageToRecord(user: Identity, pageId: string, databaseId: string) {
  const plan = pageToRecordPlan(user, pageId);
  const page = plan.page;
  const database = requirePage(user, databaseId, true);
  if (!plan.databases.some((d) => d.id === database.id) || database.workspace_id !== page.workspace_id)
    throw new HttpError(400, "In diese Datenbank kann nicht verschoben werden.");
  // Runs inside the command's transaction; the updates for open editors go
  // out once it is stored.
  const publish: (() => void)[] = [];
  const rowId = (() => {
    autoDatabaseSnapshot(user, database);
    const fields = JSON.parse(one<{ fields: string }>("SELECT fields FROM databases WHERE page_id=?", database.id)!.fields) as Field[];
    const template = selectedRowTemplate(database.id, undefined);
    const cells: Record<string, unknown> = template ? JSON.parse(template.cells) : {};
    cells[fields[0]?.id || "title"] = page.title;
    const doc = one<{ state: Uint8Array | null; html: string }>("SELECT state,html FROM documents WHERE page_id=?", page.id);
    const html = doc?.html || "";
    const rid = id();
    run(
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
    run(
      "INSERT INTO row_documents(row_id,state,html,generation) VALUES(?,?,?,?)",
      rid,
      doc?.state || htmlState(html),
      html,
      id(),
    );
    // Files stay the same files; they now belong to the database.
    run("UPDATE files SET page_id=? WHERE page_id=?", database.id, page.id);
    // Comments, text comments, tasks and notifications follow the content.
    for (const table of ["comments", "inline_threads", "shared_comments", "doc_tasks", "notifications"])
      run(`UPDATE ${table} SET page_id=?,row_id=? WHERE page_id=? AND row_id IS NULL`, database.id, rid, page.id);
    // The page's versions become versions of the record.
    for (const snapshot of all<{ state: Uint8Array; html: string; created_by: string | null; created_at: string; kind: string }>(
      "SELECT state,html,created_by,created_at,kind FROM snapshots WHERE page_id=? ORDER BY created_at",
      page.id,
    ))
      run(
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
    run("INSERT OR IGNORE INTO row_favorites(user_id,row_id,page_id) SELECT user_id,?,? FROM favorites WHERE page_id=?", rid, database.id, page.id);
    run("DELETE FROM favorites WHERE page_id=?", page.id);
    // Sub-pages move up; synced blocks of the text go with it into the database.
    // Sharing set on the page kept applying to them: it stays theirs, so that
    // moving up neither opens them to more people nor closes them.
    for (const child of all<{ id: string }>("SELECT id FROM pages WHERE parent_id=? AND synced=0", page.id))
      run(
        `INSERT INTO grants(resource_id,user_id,group_id,role)
         SELECT ?,g.user_id,g.group_id,g.role FROM grants g WHERE g.resource_id=?
         AND NOT EXISTS (SELECT 1 FROM grants c WHERE c.resource_id=? AND c.user_id IS g.user_id AND c.group_id IS g.group_id)`,
        child.id,
        page.id,
        child.id,
      );
    run("UPDATE pages SET parent_id=? WHERE parent_id=? AND synced=0", page.parent_id, page.id);
    run("UPDATE pages SET parent_id=? WHERE parent_id=? AND synced=1", database.id, page.id);
    // Sharing of the page ends; the record follows the database.
    run("DELETE FROM grants WHERE resource_id=?", page.id);
    run("DELETE FROM share_link_pages WHERE page_id=?", page.id);
    run("DELETE FROM share_links WHERE root_id=?", page.id);
    run("DELETE FROM publication_pages WHERE page_id=? OR root_id=?", page.id, page.id);
    run("DELETE FROM publications WHERE page_id=?", page.id);
    run("DELETE FROM page_follows WHERE page_id=?", page.id);
    run("UPDATE pages SET deleted_at=CURRENT_TIMESTAMP,public_token=NULL WHERE id=?", page.id);
    // Links to the page in all texts of the workspace point to the record.
    const target = `${database.id}&row=${rid}`;
    for (const source of [
      ...all<{ page_id: string; row_id: null }>(
        `SELECT d.page_id,NULL row_id FROM documents d JOIN pages p ON p.id=d.page_id
         WHERE p.workspace_id=? AND p.id!=? AND instr(d.html, ?)>0`,
        page.workspace_id,
        page.id,
        page.id,
      ),
      ...all<{ page_id: string; row_id: string }>(
        `SELECT r.page_id,r.id row_id FROM row_documents d JOIN rows r ON r.id=d.row_id JOIN pages p ON p.id=r.page_id
         WHERE p.workspace_id=? AND instr(d.html, ?)>0`,
        page.workspace_id,
        page.id,
      ),
    ]) {
      const result = rewriteDocument(source.page_id, source.row_id, user.id, (d) => relinked(d, page.id, target));
      if (result) publish.push(result.publish);
    }
    rowCreated(user, database, rid);
    return rid;
  })();
  return { result: { id: database.id, rowId }, publish };
}
