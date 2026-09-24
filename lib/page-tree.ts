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
        p.id === root?.id ? `${p.title} (Kopie)` : p.title,
        p.kind,
      ),
    );
    if (p.kind === "database") {
      const rs = all<Omit<Row, "cells"> & { cells: string }>(
        "SELECT * FROM rows WHERE page_id=? ORDER BY position",
        p.id,
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
          if (field?.type === "files" && typeof cell === "string")
            return [key, rewrite(cell)];
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
        "UPDATE pages SET parent_id=?,icon=?,cover=?,cover_position=?,position=?,full_width=?,font=? WHERE id=?",
        p.id === root?.id ? root.parent_id : pageIds.get(p.parent_id!) || null,
        rewrite(p.icon),
        rewrite(p.cover),
        p.cover_position ?? 50,
        p.id === root?.id ? p.position + 0.5 : p.position,
        p.full_width,
        p.font,
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
      if (p.kind === "document") {
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
        const source = one<{ fields: string; views: string }>(
          "SELECT fields,views FROM databases WHERE page_id=?",
          p.id,
        )!;
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
            "INSERT INTO rows(id,page_id,cells,position,created_by,updated_by,content,icon,cover) VALUES(?,?,?,?,?,?,?,?,?)",
            rowIds.get(r.id)!,
            target,
            rewriteCells(r.cells, fields),
            r.position,
            user.id,
            user.id,
            rewriteHtml(r.content || ""),
            rewrite(r.icon || ""),
            rewrite(r.cover || ""),
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
