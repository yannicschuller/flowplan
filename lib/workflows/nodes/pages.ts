// Page actions (docs/specs/workflows.md §6.2): create, append, tag, move.
// Appending writes through the documents' Yjs path ("document.sync", as
// append_to_page in lib/mcp.ts does), so open editors see the change live;
// values become text nodes, never HTML or Markdown (§7.4) – page values
// become real page links.
import * as Y from "yjs";
import { Node as PMNode, type Schema } from "@tiptap/pm/model";
import { updateYFragment, yDocToProsemirrorJSON } from "y-prosemirror";
import { one } from "../../db";
import { pageRole, requirePage } from "../../permissions";
import { htmlState } from "../../document-server";
import { documentSchema } from "../../document-schema";
import { isEncryptedPage } from "../../e2ee-server";
import { ensurePersonalTaskPage, personalTaskPage } from "../../personal-tasks";
import { appendTask, taskItemJson } from "../../task-append";
import type { Field, Identity, Page } from "../../types";
import type { WorkflowBlock } from "../catalog";
import { evaluatePlaceholder, isEmpty, parseTemplate, renderText, renderValue, valueText, type RenderScope } from "../placeholders";
import { coerceToField } from "../values";
import { behindJournalPin } from "../runner";
import { pageValue, personValue, refId } from "./data";
import { recipients } from "./notify";
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
  let count = 0;
  await changeDocument(ctx, page, (doc, schema) => {
    if (skipIfLinked.length) {
      let linked = false;
      doc.descendants((node) => {
        if (node.marks.some((m) => m.type.name === "link" && skipIfLinked.some((id) => String(m.attrs.href || "").includes(`#page=${id}`)))) linked = true;
        return !linked;
      });
      if (linked) return null;
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
    count = added.length;
    return doc.type.create(doc.attrs, nextChildren);
  });
  return count;
}
// One change of a document as the runner, through "document.sync" (locks,
// journal PINs, encrypted spaces and tasks as every save); `change`
// returning null writes nothing.
async function changeDocument(ctx: NodeRun, page: Page, change: (doc: PMNode, schema: Schema) => PMNode | null) {
  if (page.kind !== "document") throw new StepError("Kein Dokument.", "validation");
  const stored = await one<{ state: Uint8Array | null; html: string; generation: string }>("SELECT state,html,generation FROM documents WHERE page_id=?", page.id);
  if (!stored) throw new StepError("Dokument nicht gefunden.", "validation");
  const schema = documentSchema();
  const ydoc = new Y.Doc();
  try {
    Y.applyUpdate(ydoc, stored.state || htmlState(stored.html));
    const before = Y.encodeStateVector(ydoc);
    const doc = PMNode.fromJSON(schema, yDocToProsemirrorJSON(ydoc, "default"));
    const next = change(doc, schema);
    if (!next) return false;
    ydoc.transact(() => updateYFragment(ydoc, ydoc.getXmlFragment("default"), next, { mapping: new Map(), isOMark: new Map() }));
    const update = stored.state ? Y.encodeStateAsUpdate(ydoc, before) : Y.encodeStateAsUpdate(ydoc);
    await asCommand(ctx, { action: "document.sync", pageId: page.id, generation: stored.generation, update: Buffer.from(update).toString("base64") });
    return true;
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
  const title = renderText(c.title, ctx.scope).trim().slice(0, 500) || "Ohne Titel";
  if (dryRun(ctx)) return { port: "out", output: { wouldCreate: { parent: parent.id, title, blocks: c.blocks.length } } };
  const created = (await asCommand(ctx, {
    action: "page.create",
    workspaceId: parent.workspace_id,
    spaceId: parent.space_id,
    parentId: parent.id,
    title,
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

// "Aufgabe erstellen" (#208): one task – text with placeholders, a person,
// a due date – in a chosen page or in the own task page of the person the
// workflow runs as (lib/personal-tasks.ts; made there on first use). As
// that person and with their rights: their page only for themselves (it is
// private), a person only who may open the target page, no locked pages,
// no journal behind a PIN, no encrypted space. A dry run changes nothing,
// not even the own page is made.
export const taskCreate: NodeImpl = async (ctx) => {
  const c = ctx.config as { target?: "page" | "personal"; page?: string; text: string; assignee?: string[]; due?: string; heading?: string };
  if (!ctx.runner) throw new StepError("Keine ausführende Person.", "permission");
  const runner = ctx.runner;
  const personal = (c.target || "page") === "personal";
  const line = inlineContent(c.text || "", ctx.scope)
    .map((n) => ({ ...n, text: (n.text || "").replace(/\s+/g, " ") }))
    .filter((n) => n.text);
  const text = line.map((n) => n.text).join("").trim();
  if (!text) throw new StepError("Die Aufgabe hat keinen Text.", "validation");
  // The person: one member of the workspace.
  const trigger = ctx.scope.values[ctx.run.triggerNodeId] as { record?: { fields?: Record<string, unknown>; createdBy?: { id: string } } } | undefined;
  const people = await recipients(ctx, c.assignee || [], trigger?.record?.fields || {}, trigger?.record?.createdBy?.id ?? null);
  if (people.length > 1) throw new StepError("Eine Aufgabe bekommt höchstens eine Person.", "validation");
  let assignee: Identity | null = null;
  if (people[0]) {
    const member = await one<Identity>(
      "SELECT u.* FROM users u JOIN members m ON m.user_id=u.id AND m.workspace_id=? WHERE u.id=? AND COALESCE(u.disabled,0)=0",
      ctx.run.workspaceId,
      people[0],
    );
    if (!member) throw new StepError("Die Person ist kein Mitglied dieses Arbeitsbereichs.", "validation");
    assignee = { ...member, groups: [], isAdmin: false } as Identity;
  }
  const due = dueDay(ctx, c.due || "");
  // Where: the chosen page, or the own task page (not made yet: null).
  let page: Page | null;
  if (personal) {
    if (assignee && assignee.id !== runner.id)
      throw new StepError("Die eigene Aufgabenseite ist privat: Der Workflow schreibt nur in die der Person, als die er läuft. Wähle für andere eine Seite, die sie öffnen können.", "permission");
    page = await personalTaskPage(runner, ctx.run.workspaceId);
  } else page = await targetPage(ctx, c.page, true);
  if (page) {
    if (page.kind !== "document") throw new StepError("Kein Dokument.", "validation");
    if (page.locked) throw new StepError("Diese Seite ist gesperrt.", "validation");
    if (await isEncryptedPage(page)) throw new StepError("Die Seite liegt in einem verschlüsselten Bereich, dort kann der Server nichts schreiben.", "validation");
    if (await behindJournalPin(page)) throw new StepError("Dieses Journal ist gesperrt.", "permission");
    if (assignee && assignee.id !== runner.id && !(await pageRole(assignee, page)))
      throw new StepError(`${assignee.name || assignee.email} kann die Seite „${page.title || "Ohne Titel"}“ nicht öffnen.`, "validation");
  }
  const task = { text, due, assignee: assignee ? await personValue(assignee.id, ctx.run.workspaceId) : null };
  if (dryRun(ctx))
    return {
      port: "out",
      output: { wouldCreate: { page: page?.id ?? null, newPage: !page, heading: c.heading || "", text, due, assignee: assignee?.id ?? null }, page: page ? await pageValue(page.id) : null, task },
    };
  if (!page) {
    try {
      page = (await ensurePersonalTaskPage(runner, ctx.run.workspaceId)).page;
    } catch (e) {
      throw new StepError((e as Error).message, (e as { status?: number }).status === 403 ? "permission" : "validation");
    }
  }
  // In the own page the runner's own tasks need no name: they are theirs.
  const mention = assignee && !(personal && assignee.id === runner.id) ? { id: assignee.id, name: assignee.name || assignee.email } : null;
  const item = taskItemJson(line, { due, assignee: mention });
  await changeDocument(ctx, page, (doc, schema) => appendTask(doc, schema, item, c.heading || ""));
  return { port: "out", output: { page: await pageValue(page.id), task } };
};
// A due date from a date, a moment (its day in the workflow's time zone)
// or a placeholder on one; empty: none.
function dueDay(ctx: NodeRun, raw: string): string | null {
  if (!raw.trim()) return null;
  const value = renderValue(raw, ctx.scope);
  if (isEmpty(value)) return null;
  let day: unknown;
  try {
    day = coerceToField(typeof value === "string" ? value.trim() : value, { id: "due", name: "Fällig am", type: "date" } as Field, ctx.scope.locale, ctx.scope.timeZone);
  } catch (e) {
    throw new StepError((e as Error).message, "validation");
  }
  const s = String(day || "");
  if (!s || /^\d{4}-\d{2}-\d{2}$/.test(s)) return s || null;
  return new Intl.DateTimeFormat("en-CA", { timeZone: ctx.scope.timeZone || "UTC", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(s));
}
