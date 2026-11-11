// Page actions (docs/specs/workflows.md §6.2): create, append, tag, move.
// Appending writes through the documents' Yjs path ("document.sync", as
// append_to_page in lib/mcp.ts does), so open editors see the change live;
// values become text nodes, never HTML or Markdown (§7.4) – page values
// become real page links.
import * as Y from "yjs";
import { Node as PMNode } from "@tiptap/pm/model";
import { updateYFragment, yDocToProsemirrorJSON } from "y-prosemirror";
import { one } from "../../db";
import { requirePage } from "../../permissions";
import { htmlState } from "../../document-server";
import { documentSchema } from "../../document-schema";
import type { Page } from "../../types";
import type { WorkflowBlock } from "../catalog";
import { evaluatePlaceholder, parseTemplate, renderText, renderValue, valueText, type RenderScope } from "../placeholders";
import { pageValue, refId } from "./data";
import { asCommand } from "./records";
import { dryRun, StepError, type NodeImpl, type NodeRun } from "./types";

type Json = { type: string; attrs?: Record<string, unknown>; content?: Json[]; text?: string; marks?: { type: string; attrs?: Record<string, unknown> }[] };
const pageHref = (pageId: string) => `/#page=${pageId}`;

// A page value (or a reference to one) as a link, else null.
function pageLinkOf(value: unknown): { id: string; title: string } | null {
  if (!value || typeof value !== "object") return null;
  const v = value as { type?: unknown; id?: unknown; title?: unknown; link?: unknown };
  if (v.type === "page" && typeof v.id === "string") return { id: v.id, title: String(v.title || "") };
  if (v.link && typeof v.link === "object") return pageLinkOf(v.link);
  return null;
}
// Inline content of a block's text: text nodes, page links for page values.
export function inlineContent(text: string, scope: RenderScope): Json[] {
  const out: Json[] = [];
  const push = (t: string, href?: string) => {
    const clean = t.replace(/[\u0000-\u0008\u000b-\u001f]/g, "");
    if (!clean) return;
    out.push({ type: "text", text: clean, ...(href ? { marks: [{ type: "link", attrs: { href } }] } : {}) });
  };
  for (const s of parseTemplate(text)) {
    if (typeof s === "string") push(s);
    else {
      const value = evaluatePlaceholder(s, scope);
      const link = pageLinkOf(value);
      if (link) push(link.title || link.id, pageHref(link.id));
      else push(valueText(value, scope.locale, scope.timeZone));
    }
  }
  return out;
}
export function blockNodes(blocks: WorkflowBlock[], scope: RenderScope): Json[] {
  const nodes: Json[] = [];
  for (const b of blocks) {
    const content = inlineContent(b.text || "", scope);
    const paragraph: Json = { type: "paragraph", ...(content.length ? { content } : {}) };
    if (b.type === "divider") nodes.push({ type: "horizontalRule" });
    else if (b.type === "heading") nodes.push({ type: "heading", attrs: { level: b.level || 2 }, ...(content.length ? { content } : {}) });
    else if (b.type === "bullet") nodes.push({ type: "bulletList", content: [{ type: "listItem", content: [paragraph] }] });
    else if (b.type === "task") nodes.push({ type: "taskList", content: [{ type: "taskItem", attrs: { checked: !!b.checked }, content: [paragraph] }] });
    else if (b.type === "link") {
      const target = refId(b.page ? renderValue(b.page, scope) : null);
      if (target) {
        const label = content.length ? content.map((c) => c.text).join("") : target;
        nodes.push({ type: "paragraph", content: [{ type: "text", text: label, marks: [{ type: "link", attrs: { href: pageHref(target) } }] }] });
      } else nodes.push(paragraph);
    } else nodes.push(paragraph);
  }
  return nodes;
}

async function targetPage(ctx: NodeRun, ref: unknown, write: boolean): Promise<Page> {
  const id = refId(typeof ref === "string" ? renderValue(ref, ctx.scope) : ref);
  if (!id) throw new StepError("Keine Seite angegeben.", "validation");
  if (!ctx.runner) throw new StepError("Keine ausführende Person.", "permission");
  try {
    return await requirePage(ctx.runner, id, write);
  } catch (e) {
    throw new StepError((e as Error).message, (e as { status?: number }).status === 404 ? "validation" : "permission");
  }
}

// Writes blocks into a document as one change through "document.sync".
// `where`: end, start, or below the first heading with that text (else the end).
async function writeBlocks(ctx: NodeRun, page: Page, blocks: Json[], where: { kind: string; heading?: string }, skipIfLinked: string[] = []) {
  if (page.kind !== "document") throw new StepError("Kein Dokument.", "validation");
  const stored = await one<{ state: Uint8Array | null; html: string; generation: string }>("SELECT state,html,generation FROM documents WHERE page_id=?", page.id);
  if (!stored) throw new StepError("Dokument nicht gefunden.", "validation");
  const schema = documentSchema();
  const ydoc = new Y.Doc();
  try {
    Y.applyUpdate(ydoc, stored.state || htmlState(stored.html));
    const before = Y.encodeStateVector(ydoc);
    const doc = PMNode.fromJSON(schema, yDocToProsemirrorJSON(ydoc, "default"));
    if (skipIfLinked.length) {
      let linked = false;
      doc.descendants((node) => {
        if (node.marks.some((m) => m.type.name === "link" && skipIfLinked.some((id) => String(m.attrs.href || "").includes(`#page=${id}`)))) linked = true;
        return !linked;
      });
      if (linked) return 0;
    }
    const added = blocks.map((b) => PMNode.fromJSON(schema, b));
    const children: PMNode[] = [];
    doc.content.forEach((n) => children.push(n));
    const empty = children.length === 1 && children[0].type.name === "paragraph" && !children[0].content.size;
    let index = empty ? 0 : children.length;
    if (where.kind === "start") index = 0;
    else if (where.kind === "heading" && where.heading) {
      const wanted = where.heading.trim().toLowerCase();
      const at = children.findIndex((n) => n.type.name === "heading" && n.textContent.trim().toLowerCase() === wanted);
      if (at >= 0) {
        // Below the heading's section: before the next heading of the same or a higher level.
        const level = Number(children[at].attrs.level || 1);
        let end = at + 1;
        while (end < children.length && !(children[end].type.name === "heading" && Number(children[end].attrs.level || 1) <= level)) end++;
        index = end;
      }
    }
    const kept = empty ? [] : children;
    const nextChildren = [...kept.slice(0, Math.min(index, kept.length)), ...added, ...kept.slice(Math.min(index, kept.length))];
    const next = doc.type.create(doc.attrs, nextChildren);
    ydoc.transact(() => updateYFragment(ydoc, ydoc.getXmlFragment("default"), next, { mapping: new Map(), isOMark: new Map() }));
    const update = stored.state ? Y.encodeStateAsUpdate(ydoc, before) : Y.encodeStateAsUpdate(ydoc);
    await asCommand(ctx, { action: "document.sync", pageId: page.id, generation: stored.generation, update: Buffer.from(update).toString("base64") });
    return added.length;
  } finally {
    ydoc.destroy();
  }
}

export const pageAppend: NodeImpl = async (ctx) => {
  const c = ctx.config as { page: string; where: { kind: string; heading?: string }; blocks: WorkflowBlock[]; noDuplicate?: boolean };
  const page = await targetPage(ctx, c.page, true);
  const nodes = blockNodes(c.blocks, ctx.scope);
  // "Not twice": the pages these blocks link to.
  const linked: string[] = [];
  if (c.noDuplicate)
    JSON.stringify(nodes, (key, value) => {
      if (key === "href" && typeof value === "string") {
        const m = /#page=([0-9a-f-]{36})/.exec(value);
        if (m) linked.push(m[1]);
      }
      return value;
    });
  if (dryRun(ctx)) return { port: "out", output: { wouldAppend: { page: page.id, blocks: nodes.length }, page: await pageValue(page.id), appended: 0 } };
  const appended = await writeBlocks(ctx, page, nodes, c.where || { kind: "end" }, linked);
  return { port: "out", output: { page: await pageValue(page.id), appended } };
};

export const pageCreate: NodeImpl = async (ctx) => {
  const c = ctx.config as { parent: string; title: string; blocks: WorkflowBlock[]; template?: string; tags: string[] };
  const parent = await targetPage(ctx, c.parent, true);
  // The configured title (placeholders filled) wins over a template's name;
  // the template's name only when it comes out empty (#213).
  const rendered = renderText(c.title, ctx.scope).trim().slice(0, 500);
  const title = rendered || (c.template ? undefined : "Ohne Titel");
  if (dryRun(ctx)) return { port: "out", output: { wouldCreate: { parent: parent.id, title: title ?? null, ...(c.template ? { template: c.template } : {}), blocks: c.blocks.length } } };
  const created = (await asCommand(ctx, {
    action: "page.create",
    workspaceId: parent.workspace_id,
    spaceId: parent.space_id,
    parentId: parent.id,
    ...(title ? { title } : {}),
    kind: "document",
    ...(c.template ? { templateId: c.template } : {}),
  })) as { id: string };
  const page = await requirePage(ctx.runner!, created.id, true);
  if (c.blocks?.length) await writeBlocks(ctx, page, blockNodes(c.blocks, ctx.scope), { kind: "end" });
  if (c.tags?.length) await asCommand(ctx, { action: "page.properties", pageId: page.id, addTags: c.tags });
  return { port: "out", output: { page: await pageValue(page.id) } };
};

export const pageTag: NodeImpl = async (ctx) => {
  const c = ctx.config as { page: string; op: "add" | "remove"; tags: string[] };
  const page = await targetPage(ctx, c.page, true);
  if (dryRun(ctx)) return { port: "out", output: { wouldTag: { page: page.id, [c.op]: c.tags }, page: await pageValue(page.id, { text: false }) } };
  await asCommand(ctx, { action: "page.properties", pageId: page.id, ...(c.op === "remove" ? { removeTags: c.tags } : { addTags: c.tags }) });
  return { port: "out", output: { page: await pageValue(page.id) } };
};

export const pageMove: NodeImpl = async (ctx) => {
  const c = ctx.config as { page: string; parent: string; position: "start" | "end" };
  const page = await targetPage(ctx, c.page, true);
  const parent = await targetPage(ctx, c.parent, true);
  if (dryRun(ctx)) return { port: "out", output: { wouldMove: { page: page.id, parent: parent.id, position: c.position } } };
  const first =
    c.position === "start"
      ? await one<{ id: string }>("SELECT id FROM pages WHERE parent_id=? AND deleted_at IS NULL AND id!=? ORDER BY position,id LIMIT 1", parent.id, page.id)
      : undefined;
  await asCommand(ctx, first ? { action: "page.move", pageId: page.id, targetId: first.id, placement: "before" } : { action: "page.move", pageId: page.id, targetId: parent.id, placement: "inside" });
  return { port: "out", output: { page: await pageValue(page.id) } };
};
