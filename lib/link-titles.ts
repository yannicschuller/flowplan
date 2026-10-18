// Link texts follow renames: a link to a page or record whose text is the
// old title gets the new title. Links with their own wording stay as they
// are. Only documents the person may edit are changed.
import { Transform } from "@tiptap/pm/transform";
import type { Mark, Node as PMNode } from "@tiptap/pm/model";
import { all } from "./db";
import { requirePage } from "./permissions";
import { journalLocked } from "./journal-extras";
import { rewriteDocument } from "./document-rewrite";
import { assertRowAccess } from "./row-access";
import type { Identity, Page } from "./types";

type Target = { pageId: string; rowId?: string };
const address = /#page=([0-9a-f-]{36})(?:&row=([0-9a-f-]{36}))?$/i;

export function linksTo(href: string, target: Target) {
  const match = address.exec(href.trim());
  return !!match && match[1] === target.pageId && (match[2] || undefined) === target.rowId;
}

// Runs of text in one block that carry the same link to the target.
export function retitleLinks(doc: PMNode, target: Target, before: string, after: string) {
  const ranges: { from: number; to: number; marks: readonly Mark[] }[] = [];
  doc.descendants((block, blockPos) => {
    if (!block.isTextblock) return true;
    let run: { from: number; to: number; text: string; href: string; marks: readonly Mark[] } | null = null;
    const close = () => {
      if (run && run.text.trim() === before.trim()) ranges.push(run);
      run = null;
    };
    block.forEach((child, offset) => {
      const link = child.isText ? child.marks.find((mark) => mark.type.name === "link") : undefined;
      const href = typeof link?.attrs.href === "string" ? link.attrs.href : "";
      if (!link || !linksTo(href, target)) return close();
      const from = blockPos + 1 + offset;
      if (run && run.href === href && run.to === from) {
        run.to = from + child.nodeSize;
        run.text += child.text;
      } else {
        close();
        run = { from, to: from + child.nodeSize, text: child.text || "", href, marks: child.marks };
      }
    });
    close();
    return false;
  });
  if (!ranges.length) return null;
  const tr = new Transform(doc);
  for (const range of ranges.reverse()) tr.replaceWith(range.from, range.to, doc.type.schema.text(after, range.marks));
  return tr.doc;
}

// Called when a page or record is renamed; returns the updates to send to
// open editors once the transaction is stored.
export function followRename(user: Identity, workspaceId: string, target: Target, before: string, after: string) {
  const publish: (() => void)[] = [];
  if (!before.trim() || !after.trim() || before === after) return publish;
  const id = target.rowId || target.pageId;
  const sources = [
    ...all<{ page_id: string; row_id: null }>(
      `SELECT d.page_id,NULL row_id FROM documents d JOIN pages p ON p.id=d.page_id
       WHERE p.workspace_id=? AND p.deleted_at IS NULL AND instr(d.html, ?)>0 LIMIT 200`,
      workspaceId,
      id,
    ),
    ...all<{ page_id: string; row_id: string }>(
      `SELECT r.page_id,r.id row_id FROM row_documents d JOIN rows r ON r.id=d.row_id JOIN pages p ON p.id=r.page_id
       WHERE p.workspace_id=? AND p.deleted_at IS NULL AND instr(d.html, ?)>0 LIMIT 200`,
      workspaceId,
      id,
    ),
  ];
  const pages = new Map<string, Page | null>();
  for (const source of sources) {
    try {
      if (!pages.has(source.page_id)) {
        const page = requirePage(user, source.page_id, true);
        pages.set(source.page_id, page.locked || journalLocked(user, page) ? null : page);
      }
      const page = pages.get(source.page_id);
      if (!page) continue;
      if (source.row_id) {
        const row = all<{ id: string; access: string; created_by: string }>(
          "SELECT id,access,created_by FROM rows WHERE id=?",
          source.row_id,
        )[0];
        assertRowAccess(user, page, row, true);
      } else if (page.kind !== "document") continue;
      const result = rewriteDocument(page.id, source.row_id, user.id, (doc) => retitleLinks(doc, target, before, after));
      if (result) publish.push(result.publish);
    } catch {
      // No permission or no document: that text keeps its wording.
      if (!pages.has(source.page_id)) pages.set(source.page_id, null);
    }
  }
  return publish;
}
