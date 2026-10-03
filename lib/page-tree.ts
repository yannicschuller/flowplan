import { ct } from "./content-locale";
import { copyWhiteboard } from "./whiteboard";
import { visibleRows } from "./row-access";
import { mapFileCell } from "./file-cells";
import { quotaCheckpoint } from "./instance-ops";
import { remapViewReferences } from "./view-references";
import { remapLinkedAttributes } from "./linked-view-references";
import { copyFileSync, mkdirSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import { all, one, run, id, onTransactionRollback } from "./db";
import { requirePage } from "./permissions";
import { createPage } from "./seed";
import { htmlState, cleanHtml } from "./document-server";
import { relationPairs, insertRelationPair } from "./relation-sync";
import type { Identity, Page, Field, Row } from "./types";
// Called inside the command transaction. Permission-check the complete source
// tree before copying anything; never silently copy a restricted descendant.
export function duplicatePageTree(user: Identity, root: Page) {
  const tree = all<Page & { depth: number }>(
    `WITH RECURSIVE tree(id,depth) AS (SELECT id,0 FROM pages WHERE id=? UNION ALL SELECT p.id,t.depth+1 FROM pages p JOIN tree t ON p.parent_id=t.id WHERE p.deleted_at IS NULL) SELECT p.*,t.depth FROM pages p JOIN tree t ON p.id=t.id ORDER BY t.depth,p.position`,
    root.id,
  );
  const copied = duplicatePages(
    user,
    tree,
    root.workspace_id,
    root.space_id,
    root,
  );
  return { id: copied.pageIds.get(root.id)!, pages: tree.length };
}
// All roots share one reference map, so links and relations between roots also copy.
// The caller owns the destination and SQL transaction; every source is read-checked.
export function duplicatePages(
  user: Identity,
  tree: Page[],
  workspaceId: string,
  spaceId: string,
  root?: Page,
) {
  tree.forEach((p) => requirePage(user, p.id));
  const quota = quotaCheckpoint(workspaceId);
  const pageIds = new Map<string, string>(),
    rowIds = new Map<string, string>(),
    fileIds = new Map<string, string>(),
    createdFiles: string[] = [];
  const sourceRows = new Map<
    string,
    (Omit<Row, "cells"> & { cells: string })[]
  >();
  for (const p of tree) {
    pageIds.set(
      p.id,
      createPage(
        workspaceId,
        spaceId,
        user.id,
        p.id === root?.id ? `${p.title} ${ct("(Kopie)", "(copy)")}` : p.title,
        p.kind,
      ),
    );
    if (p.journal_date)
      run(
        "UPDATE pages SET journal_date=? WHERE id=?",
        p.journal_date,
        pageIds.get(p.id)!,
      );
    if (p.kind === "database") {
      // Records hidden from the copier are not copied.
      const rs = visibleRows(
        user,
        p,
        all<Omit<Row, "cells"> & { cells: string }>(
          "SELECT * FROM rows WHERE page_id=? ORDER BY position",
          p.id,
        ),
      );
      sourceRows.set(p.id, rs);
      for (const r of rs) rowIds.set(r.id, id());
    }
    for (const f of all<{ id: string }>(
      "SELECT id FROM files WHERE page_id=?",
      p.id,
    ))
      fileIds.set(f.id, id());
  }
  const rewrite = (value: string) =>
    value
      .replace(/(\/api\/files\/)([\w-]+)/g, (match, prefix, fid) =>
        fileIds.has(fid) ? prefix + fileIds.get(fid) : match,
      )
      .replace(/(\/?#page=)([\w-]+)/g, (match, prefix, pid) =>
        pageIds.has(pid) ? prefix + pageIds.get(pid) : match,
      );
  const rewriteCells = (value: string, fields: Field[]) =>
    JSON.stringify(
      Object.fromEntries(
        Object.entries(JSON.parse(value)).map(([key, cell]) => {
          const field = fields.find((f) => f.id === key);
          if (field?.type === "relation" && Array.isArray(cell))
            return [key, cell.map((rid) => rowIds.get(rid) || rid)];
          if (field?.type === "files") return [key, mapFileCell(cell, rewrite)];
          return [key, cell];
        }),
      ),
    );
  const rewriteHtml = (value: string) =>
    cleanHtml(value, (tagName, attributes) => {
      const attribs = remapLinkedAttributes(
        { ...attributes },
        pageIds,
        rowIds,
        (source) => {
          const d = one<{ fields: string }>(
            "SELECT fields FROM databases WHERE page_id=?",
            source,
          );
          return d
            ? {
                fields: JSON.parse(d.fields),
                rows: sourceRows.get(source) || [],
              }
            : undefined;
        },
      );
      for (const key of ["href", "src"])
        if (attribs[key]) attribs[key] = rewrite(attribs[key]);
      return { tagName, attribs };
    });
  onTransactionRollback(() => {
    for (const path of createdFiles) {
      try {
        unlinkSync(path);
      } catch {}
    }
  });
  try {
    for (const p of tree) {
      const target = pageIds.get(p.id)!;
      run(
        "UPDATE pages SET parent_id=?,icon=?,cover=?,cover_position=?,position=?,full_width=?,font=?,icon_size=? WHERE id=?",
        p.id === root?.id ? root.parent_id : pageIds.get(p.parent_id!) || null,
        rewrite(p.icon),
        rewrite(p.cover),
        p.cover_position ?? 50,
        p.id === root?.id ? p.position + 0.5 : p.position,
        p.full_width,
        p.font,
        p.icon_size || "",
        target,
      );
      for (const f of all<{
        id: string;
        name: string;
        mime: string;
        size: number;
      }>("SELECT * FROM files WHERE page_id=?", p.id)) {
        const fid = fileIds.get(f.id)!,
          dir = resolve(process.env.FLOWPLAN_DATA_DIR || "./data", "uploads");
        mkdirSync(dir, { recursive: true });
        const destination = resolve(dir, fid);
        copyFileSync(resolve(dir, f.id), destination);
        createdFiles.push(destination);
        run(
          "INSERT INTO files(id,page_id,name,mime,size,created_by) VALUES(?,?,?,?,?,?)",
          fid,
          target,
          f.name,
          f.mime,
          f.size,
          user.id,
        );
      }
      if (p.kind === "whiteboard") {
        copyWhiteboard(p.id, target, pageIds, rewrite);
      } else if (p.kind === "document" || p.kind === "journal") {
        const source = one<{ html: string }>(
          "SELECT html FROM documents WHERE page_id=?",
          p.id,
        );
        const html = rewriteHtml(source?.html || "");
        run(
          "UPDATE documents SET html=?,state=? WHERE page_id=?",
          html,
          htmlState(html),
          target,
        );
      } else {
        const source = one<{
          fields: string;
          views: string;
          record_layout: string;
        }>(
          "SELECT fields,views,record_layout FROM databases WHERE page_id=?",
          p.id,
        )!;
        run(
          "UPDATE databases SET record_layout=? WHERE page_id=?",
          source.record_layout || "{}",
          target,
        );
        const fields = JSON.parse(source.fields) as Field[];
        run(
          "UPDATE databases SET fields=?,views=? WHERE page_id=?",
          JSON.stringify(
            fields.map((f) => ({
              ...f,
              ...(f.relationPage
                ? {
                    relationPage: pageIds.get(f.relationPage) || f.relationPage,
                  }
                : {}),
            })),
          ),
          JSON.stringify(
            remapViewReferences(
              JSON.parse(source.views),
              JSON.parse(source.fields),
              rowIds,
              sourceRows.get(p.id) || [],
            ),
          ),
          target,
        );
        for (const r of sourceRows.get(p.id) || []) {
          run(
            "INSERT INTO rows(id,page_id,cells,position,created_by,updated_by,content,icon,cover,recurrence,access) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
            rowIds.get(r.id)!,
            target,
            rewriteCells(r.cells, fields),
            r.position,
            user.id,
            user.id,
            rewriteHtml(r.content || ""),
            rewrite(r.icon || ""),
            rewrite(r.cover || ""),
            r.recurrence || "",
            r.access || "inherit",
          );
          if (workspaceId === p.workspace_id)
            run(
              "INSERT INTO row_grants(row_id,user_id,group_id,role) SELECT ?,user_id,group_id,role FROM row_grants WHERE row_id=?",
              rowIds.get(r.id)!,
              r.id,
            );
        }
        for (const t of all<{
          name: string;
          cells: string;
          html: string;
          is_default: number;
        }>("SELECT * FROM row_templates WHERE page_id=?", p.id))
          run(
            "INSERT INTO row_templates(id,page_id,name,cells,html,is_default,created_by) VALUES(?,?,?,?,?,?,?)",
            id(),
            target,
            t.name,
            rewriteCells(t.cells, fields),
            rewriteHtml(t.html),
            t.is_default,
            user.id,
          );
        const form = one<{
          config: string;
          internal: number;
          anonymous: number;
        }>("SELECT config,internal,anonymous FROM forms WHERE page_id=?", p.id);
        if (form)
          run(
            "INSERT INTO forms(page_id,token,enabled,internal,anonymous,config) VALUES(?,?,0,?,?,?)",
            target,
            id(),
            form.internal,
            form.anonymous,
            form.config,
          );
      }
    }
    for (const pair of relationPairs())
      if (pageIds.has(pair.left_page) && pageIds.has(pair.right_page)) {
        const copied = {
          ...pair,
          id: id(),
          left_page: pageIds.get(pair.left_page)!,
          right_page: pageIds.get(pair.right_page)!,
        };
        insertRelationPair(copied);
      }
    quota();
    return { pageIds, pages: tree.length };
  } catch (error) {
    for (const path of createdFiles) {
      try {
        unlinkSync(path);
      } catch {}
    }
    throw error;
  }
}
