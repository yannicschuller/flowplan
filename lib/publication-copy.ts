import { copyFileSync, mkdirSync, unlinkSync } from "node:fs";
import { quotaCheckpoint } from "./instance-ops";
import { resolve } from "node:path";
import { z } from "zod";
import { all, id, one, onTransactionRollback, run } from "./db";
import { HttpError } from "./auth";
import { requireMember, spaceRole } from "./permissions";
import { publicFile, publicTree } from "./publication";
import { publicField } from "./shared-content";
import { cleanHtml, htmlState } from "./document-server";
import { ensureRowDocument } from "./row-documents";
import { createPage } from "./seed";
import { imageFileId } from "./page-appearance";
import { fileIdOf } from "./file-cells";
import type { Field, Identity, Page, Row, Space, View } from "./types";

// Visitors may copy a publication into their own workspace. Only what the
// publication shows is copied: published pages, public properties, published
// files and record documents. Relations, people, computed properties, private
// linked views, comments, versions and share settings stay behind.
export function copyPublication(user: Identity, input: unknown) {
  const b = z
    .object({
      token: z.string().min(1).max(200),
      workspaceId: z.string().uuid(),
      spaceId: z.string().uuid(),
    })
    .parse(input);
  const publication = one<{ allow_copy: number }>(
    "SELECT p.allow_copy FROM publications p JOIN pages g ON g.id=p.page_id WHERE g.public_token=? AND g.deleted_at IS NULL",
    b.token,
  );
  if (!publication || !publication.allow_copy)
    throw new HttpError(
      403,
      "Diese Veröffentlichung darf nicht kopiert werden.",
    );
  const { root, pages } = publicTree(b.token);
  requireMember(user, b.workspaceId, "editor");
  const quota = quotaCheckpoint(b.workspaceId);
  const space = one<Space>(
    "SELECT * FROM spaces WHERE id=? AND workspace_id=? AND deleted_at IS NULL",
    b.spaceId,
    b.workspaceId,
  );
  if (!space || !["editor", "owner"].includes(spaceRole(user, space) || ""))
    throw new HttpError(403, "Keine Schreibrechte im Zielbereich.");
  const pageIds = new Map<string, string>(),
    fileIds = new Map<string, string>();
  const dir = resolve(process.env.FLOWPLAN_DATA_DIR || "./data", "uploads");
  // Copies a file only when the publication itself serves it.
  const copyFile = (url: string) => {
    const fid = fileIdOf(url) || imageFileId(url);
    if (!fid) return url;
    if (fileIds.has(fid)) return `/api/files/${fileIds.get(fid)}`;
    let file: { page_id: string; name: string; mime: string; size: number };
    try {
      file = publicFile(b.token, fid) as unknown as typeof file;
    } catch {
      return "";
    }
    const target = pageIds.get(file.page_id);
    if (!target) return "";
    const nid = id();
    mkdirSync(dir, { recursive: true });
    copyFileSync(resolve(dir, fid), resolve(dir, nid));
    onTransactionRollback(() => unlinkSync(resolve(dir, nid)));
    const meta = one<{ name: string; mime: string; size: number }>(
      "SELECT name,mime,size FROM files WHERE id=?",
      fid,
    )!;
    run(
      "INSERT INTO files(id,page_id,name,mime,size,created_by) VALUES(?,?,?,?,?,?)",
      nid,
      target,
      meta.name,
      meta.mime,
      meta.size,
      user.id,
    );
    fileIds.set(fid, nid);
    return `/api/files/${nid}`;
  };
  const rewriteHtml = (html: string) =>
    cleanHtml(html, (tagName, attribs) => {
      const attrs = { ...attribs };
      // Linked database blocks point at sources the visitor cannot read.
      if (attrs["data-linked-database"]) {
        delete attrs["data-linked-source"];
        delete attrs["data-linked-views"];
        delete attrs["data-linked-version"];
      }
      for (const key of ["src", "href"]) {
        if (!attrs[key]) continue;
        if (fileIdOf(attrs[key])) {
          const copied = copyFile(attrs[key]);
          if (copied) attrs[key] = copied;
          else delete attrs[key];
        }
        const link = /^\/?#page=([\w-]+)$/.exec(attrs[key] || "");
        if (link) {
          if (pageIds.has(link[1]))
            attrs[key] = `/#page=${pageIds.get(link[1])}`;
          else delete attrs[key];
        }
      }
      return { tagName, attribs: attrs };
    });
  // Parents before children, so every copy can be attached immediately.
  const ordered: Page[] = [];
  const visit = (parent: string | null) => {
    for (const p of pages.filter((x) =>
      parent === null ? x.id === root.id : x.parent_id === parent,
    )) {
      ordered.push(p);
      visit(p.id);
    }
  };
  visit(null);
  for (const p of ordered) {
    const copy = createPage(
      b.workspaceId,
      b.spaceId,
      user.id,
      p.id === root.id ? `${p.title} (Kopie)` : p.title,
      p.kind,
      p.id === root.id ? null : pageIds.get(p.parent_id!) || null,
    );
    pageIds.set(p.id, copy);
  }
  for (const p of ordered) {
    const copy = pageIds.get(p.id)!;
    const icon = imageFileId(p.icon) ? copyFile(p.icon) : p.icon;
    const cover = imageFileId(p.cover) ? copyFile(p.cover) : p.cover;
    run(
      "UPDATE pages SET icon=?,cover=?,cover_position=?,full_width=?,font=?,position=? WHERE id=?",
      icon || "file",
      cover,
      p.cover_position ?? 50,
      p.full_width,
      p.font,
      p.position,
      copy,
    );
    if (p.kind === "document") {
      const html = rewriteHtml(
        one<{ html: string }>(
          "SELECT html FROM documents WHERE page_id=?",
          p.id,
        )?.html || "",
      );
      run(
        "UPDATE documents SET html=?,state=?,generation=? WHERE page_id=?",
        html,
        htmlState(html),
        id(),
        copy,
      );
      continue;
    }
    const stored = one<{ fields: string; views: string }>(
      "SELECT fields,views FROM databases WHERE page_id=?",
      p.id,
    )!;
    const fields = (JSON.parse(stored.fields) as Field[]).filter(publicField);
    const kept = new Set(fields.map((f) => f.id));
    // Layouts may reference removed properties; the copy starts with a table.
    const views: View[] = [
      {
        id: id(),
        name: "Tabelle",
        type: "table",
        filters: [],
        sorts: [],
      },
    ];
    run(
      "UPDATE databases SET fields=?,views=? WHERE page_id=?",
      JSON.stringify(fields),
      JSON.stringify(views),
      copy,
    );
    for (const row of all<Row & { cells: string }>(
      "SELECT * FROM rows WHERE page_id=? ORDER BY position",
      p.id,
    )) {
      const cells = Object.fromEntries(
        Object.entries(JSON.parse(row.cells) as Record<string, unknown>).filter(
          ([key]) => kept.has(key),
        ),
      );
      const content = rewriteHtml(
        ensureRowDocument({ ...row, cells: JSON.parse(row.cells) }).html,
      );
      const rid = id();
      run(
        "INSERT INTO rows(id,page_id,cells,position,created_by,updated_by,content,icon,cover) VALUES(?,?,?,?,?,?,?,?,?)",
        rid,
        copy,
        JSON.stringify(cells),
        row.position,
        user.id,
        user.id,
        content,
        imageFileId(row.icon || "") ? copyFile(row.icon!) : row.icon || "",
        imageFileId(row.cover || "") ? copyFile(row.cover!) : row.cover || "",
      );
      run(
        "INSERT INTO row_documents(row_id,state,html,generation) VALUES(?,?,?,?)",
        rid,
        htmlState(content),
        content,
        id(),
      );
    }
  }
  quota();
  return { id: pageIds.get(root.id)!, pages: ordered.length };
}
