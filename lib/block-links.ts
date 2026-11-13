// Block links on the server (#88, lib/block-ids.ts): the preview of a
// pasted link ("Page › start of the block"), ids for blocks of older
// documents, the search of the "@" dialog over headings and blocks, and
// the block ids other texts link to (kept by the Markdown export).
// Everything answers only with what the person may read; end-to-end
// encrypted pages have no text on the server, so they have no preview.
import * as Y from "yjs";
import { Node as PMNode } from "@tiptap/pm/model";
import { Transform } from "@tiptap/pm/transform";
import { updateYFragment, yDocToProsemirrorJSON } from "y-prosemirror";
import { all, one, run, sql } from "./db";
import { HttpError } from "./auth";
import { requirePage } from "./permissions";
import { journalLocked } from "./journal-extras";
import { isEncryptedPage, PLAINTEXT_REFUSED } from "./e2ee-server";
import { requireRow } from "./row-documents";
import { cellText } from "./cell-text";
import { cleanHtml, htmlState, stateHtml, htmlJson } from "./document-server";
import { rewriteSchema } from "./document-rewrite";
import { documentKey, documentChanged, publishDocumentUpdate } from "./document-live";
import { searchWorkspace } from "./search-index";
import { blockText, findBlock, linkableBlocks, newBlockId, validBlockId } from "./block-ids";
import type { Field, Identity, Page } from "./types";

const htmlDoc = (html: string) => PMNode.fromJSON(rewriteSchema(), htmlJson(cleanHtml(html || "<p></p>")));

// The document a block link points to, if this person may read it.
async function readableDocument(user: Identity, pageId: string, rowId?: string | null) {
  if (rowId) {
    const { page, row } = await requireRow(user, pageId, rowId);
    const fields = JSON.parse((await one<{ fields: string }>("SELECT fields FROM databases WHERE page_id=?", page.id))?.fields || "[]") as Field[];
    const cells = typeof row.cells === "string" ? JSON.parse(row.cells) : row.cells;
    const html = (await one<{ html: string }>("SELECT html FROM row_documents WHERE row_id=?", row.id))?.html ?? (String(row.content || "").startsWith("<") ? String(row.content) : "");
    return { page, title: cellText(cells?.[fields[0]?.id || "title"]) || "", html };
  }
  const page = await requirePage(user, pageId);
  const html = page.kind === "document" && !(await journalLocked(user, page)) ? (await one<{ html: string }>("SELECT html FROM documents WHERE page_id=?", page.id))?.html || "" : "";
  return { page, title: page.title, html };
}

// For a pasted block link: the page's (record's) title and the start of the
// block's text. `found` is false for a block that is gone.
export async function blockPreview(user: Identity, pageId: string, blockId: string, rowId?: string | null) {
  if (!validBlockId(blockId)) throw new HttpError(400, "Ungültiger Blocklink.");
  const { page, title, html } = await readableDocument(user, pageId, rowId);
  const base = { pageId: page.id, ...(rowId ? { rowId } : {}), workspaceId: page.workspace_id, blockId };
  // Encrypted: neither title nor text exist in plain text here.
  if (await isEncryptedPage(page)) return { ...base, title: "", text: "", found: false, encrypted: true };
  const block = html ? findBlock(htmlDoc(html), blockId) : null;
  return { ...base, title, text: block ? blockText(block.node) : "", found: !!block, encrypted: false };
}

// Gives every linkable block of a stored document that has none an id,
// without counting as an edit (no new "changed" time). For people who only
// read a page and copy a link to a block of an older document; the block is
// the `index`-th linkable block, or the one with that text.
export async function ensureBlockIds(user: Identity, pageId: string, rowId: string | null, index: number, text: string) {
  const { page } = await readableDocument(user, pageId, rowId);
  if (await isEncryptedPage(page)) throw new HttpError(400, PLAINTEXT_REFUSED);
  if (!rowId && page.kind !== "document") throw new HttpError(400, "Kein Dokument.");
  if (!rowId && await journalLocked(user, page)) throw new HttpError(423, "Dieses Journal ist gesperrt.");
  const stored = rowId
    ? (await one<{ state: Uint8Array | null; html: string; generation: string }>("SELECT state,html,generation FROM row_documents WHERE row_id=?", rowId))
    : (await one<{ state: Uint8Array | null; html: string; generation: string }>("SELECT state,html,generation FROM documents WHERE page_id=?", page.id));
  if (!stored) throw new HttpError(404, "Dokument nicht gefunden.");
  const ydoc = new Y.Doc();
  try {
    Y.applyUpdate(ydoc, stored.state || htmlState(stored.html));
    const before = Y.encodeStateVector(ydoc);
    const doc = PMNode.fromJSON(rewriteSchema(), yDocToProsemirrorJSON(ydoc, "default"));
    const blocks = linkableBlocks(doc);
    const wanted = text.replace(/\s+/g, " ").trim();
    const matches = (b: (typeof blocks)[number]) => !wanted || blockText(b.node, 200) === wanted;
    const target = blocks[index] && matches(blocks[index]) ? blocks[index] : blocks.find(matches);
    if (!target) throw new HttpError(404, "Block nicht gefunden.");
    const existing = validBlockId(target.node.attrs.blockId);
    if (existing) return { blockId: existing };
    const taken = new Set(blocks.map((b) => b.node.attrs.blockId).filter(Boolean));
    const tr = new Transform(doc);
    let blockId = "";
    for (const block of blocks) {
      if (validBlockId(block.node.attrs.blockId)) continue;
      let id = newBlockId();
      while (taken.has(id)) id = newBlockId();
      taken.add(id);
      if (block === target) blockId = id;
      tr.setNodeAttribute(block.pos, "blockId", id);
    }
    ydoc.transact(() => updateYFragment(ydoc, ydoc.getXmlFragment("default"), tr.doc, { mapping: new Map(), isOMark: new Map() }));
    const state = Y.encodeStateAsUpdate(ydoc);
    const html = stateHtml(ydoc);
    if (rowId) {
      await run("UPDATE row_documents SET state=?,html=? WHERE row_id=?", state, html, rowId);
      await run("UPDATE rows SET content=? WHERE id=?", html, rowId);
    } else await run("UPDATE documents SET state=?,html=? WHERE page_id=?", state, html, page.id);
    const update = Buffer.from(Y.encodeStateAsUpdate(ydoc, before)).toString("base64");
    const key = documentKey(page.id, rowId, stored.generation);
    return {
      blockId,
      // After the transaction: open editors merge the ids.
      publish: () => {
        publishDocumentUpdate(key, update);
        documentChanged(page.id, rowId);
      },
    };
  } finally {
    ydoc.destroy();
  }
}

const CONTAINERS = ["bulletList", "orderedList", "taskList", "blockquote", "callout", "toggle", "columns", "tabs"];
export type BlockHit = { pageId: string; pageTitle: string; blockId: string | null; index: number; text: string; level: number | null };
// "@" in the editor: headings and blocks of other pages that match. "Page ›
// Heading" (or "Page#Heading") searches the headings of the pages whose
// title matches the first part; a single word the blocks' text, and the
// headings of pages whose title matches it.
export async function searchBlocks(user: Identity, workspaceId: string, raw: string, exclude?: string | null): Promise<BlockHit[]> {
  const query = raw.replace(/[\u0000-\u001f]/g, " ").trim().slice(0, 200);
  if ([...query].length < 2) return [];
  const split = /\s*(?:›|#|>)\s*/.exec(query);
  const pagePart = split ? query.slice(0, split.index).trim() : "";
  const blockPart = (split ? query.slice(split.index + split[0].length) : query).trim().toLowerCase();
  const pages = (await searchWorkspace(user, workspaceId, pagePart || query, { kind: "document" }))
    .filter((hit) => !hit.rowId && hit.id !== exclude)
    .slice(0, 15);
  const hits: BlockHit[] = [];
  const seen = new Set<string>();
  for (const hit of pages) {
    if (seen.has(hit.id)) continue;
    seen.add(hit.id);
    let page: Page;
    try {
      page = await requirePage(user, hit.id);
    } catch {
      continue;
    }
    if (page.kind !== "document" || await journalLocked(user, page) || await isEncryptedPage(page)) continue;
    const html = (await one<{ html: string }>("SELECT html FROM documents WHERE page_id=?", page.id))?.html || "";
    if (!html) continue;
    const titleHit = page.title.toLowerCase().includes((pagePart || query).toLowerCase());
    linkableBlocks(htmlDoc(html)).forEach((block, index) => {
      if (hits.length >= 40) return;
      const heading = block.node.type.name === "heading";
      // Boxes and lists hold blocks of their own, which are found instead.
      if (CONTAINERS.includes(block.node.type.name)) return;
      const text = blockText(block.node, 80);
      if (!text) return;
      const own = text.toLowerCase().includes(blockPart);
      // "Page › …": the headings (and with more text the blocks) of a
      // matching page; else blocks whose text matches and the headings of
      // a page whose title matches.
      const wanted = split ? titleHit && own && (heading || !!blockPart) : own || (heading && titleHit);
      if (!wanted) return;
      hits.push({
        pageId: page.id,
        pageTitle: page.title,
        blockId: validBlockId(block.node.attrs.blockId),
        index,
        text,
        level: heading ? Number(block.node.attrs.level) || 1 : null,
      });
    });
  }
  // Headings first, then the rest, each in the order of the search.
  return hits.sort((a, b) => Number(!a.level) - Number(!b.level)).slice(0, 30);
}

// The block ids texts of the workspace link to, by page (or record). The
// Markdown export writes markers ("^id") for these blocks only, so the
// links work again after a re-import and the rest stays clean.
const LINKED = /#page=([0-9a-f-]{36})(?:&(?:amp;)?row=([0-9a-f-]{36}))?&(?:amp;)?block=([\w-]{1,64})/gi;
export async function linkedBlockIds(workspaceId: string) {
  const found = new Map<string, Set<string>>();
  const sources = await all<{ html: string }>(
    `SELECT d.html FROM documents d JOIN pages p ON p.id=d.page_id
     WHERE p.workspace_id=? AND p.deleted_at IS NULL AND ${sql.instr("d.html", `'block='`)}>0
     UNION ALL
     SELECT d.html FROM row_documents d JOIN rows r ON r.id=d.row_id JOIN pages p ON p.id=r.page_id
     WHERE p.workspace_id=? AND p.deleted_at IS NULL AND ${sql.instr("d.html", `'block='`)}>0`,
    workspaceId,
    workspaceId,
  );
  for (const { html } of sources)
    for (const match of html.matchAll(LINKED)) {
      const key = match[2] || match[1];
      (found.get(key) ?? found.set(key, new Set()).get(key)!).add(match[3]);
    }
  return found;
}
