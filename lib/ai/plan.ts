// Plans in "KI fragen" (#462): an instruction becomes a list of steps that
// the person checks and confirms. lib/ai/plan-read.ts lets the model read
// (read-only) and turns its answer into steps; this file checks them, runs
// the confirmed ones and takes them back.
//
// The plan is data, never trusted – neither from the model nor from the
// browser that sends it back:
//   1. preview – every step is parsed and checked as the person: edit
//      rights, the AI's access rules (aiMayRead / aiSpaceOpen: "Für KI
//      gesperrt", journals with a PIN, encrypted spaces, the person's own
//      rules), locked pages, existing targets, property values, no cycles
//      when moving. What fails is shown with the reason, greyed out.
//   2. run – the chosen steps come back and are checked again from scratch,
//      one after the other: local references ("$page1") are replaced by
//      what the earlier steps created, a step whose prerequisite did not run
//      is skipped. Every step goes through command() like an edit by the
//      person (versions, notifications, webhooks) and is audited "ai.plan"
//      (the tool, never contents).
//   3. undo – what a run returns to take each step back ("Alles
//      rückgängig"): created pages, databases and records to the trash,
//      renames, moves, links, appended text, properties and changed records
//      reverted, suggested changes withdrawn. Run as the person, newest
//      first, again through command().
// Existing text is never overwritten: "edit_text" puts suggested changes
// into the page (lib/ai/page-edits.ts, as "Als Änderungsvorschlag einfügen").
// Nothing is deleted.
import { z } from "zod";
import { EditorState } from "@tiptap/pm/state";
import type { Node as PMNode } from "@tiptap/pm/model";
import { HttpError } from "../auth";
import { audit, one } from "../db";
import { command, database } from "../api";
import { requireMember, requirePage, spaceRole } from "../permissions";
import { requireUnlocked } from "../journal-extras";
import { requireRow } from "../row-documents";
import { readOnlyFieldIds, readableDatabase } from "../field-access";
import { markdownToHtml } from "../markdown-import";
import { cleanHtml, htmlJson } from "../document-server";
import { rewriteDocument } from "../document-rewrite";
import { resolveSuggestions } from "../suggestions";
import { newBlockId } from "../block-ids";
import { ct } from "../content-locale";
import { contextProperties, contextTags, canCreateTags, pageMeta, parsePropertyValue } from "../page-properties-server";
import { foldName, propertyText } from "../page-properties";
import { proposalSchema, normalizeProposal } from "./database-fields";
import type { Field, Identity, Page, Space } from "../types";
import { AI_BLOCKED_MESSAGE, aiMayRead, aiSpaceOpen } from "./access";
import { requireAi } from "./run";
import { aiAnswerHref } from "./insert";
import { cellPlain, nameLookup, recordTitle } from "./sources";
import { ACTION_LIMITS, cellPatch, databaseTarget, documentTarget, editable, memberBy, members, storedCells, syncDocument, tasksHtml, validDay } from "./actions";
import { applyPageEdits, type BlockSnapshot } from "./page-edits";
import { parseMarkdown } from "./page-edit";
import { isRef, PLAN_LIMITS, PLAN_TOOLS, REF_PATTERN, type PlanPreview, type PlanStepResult, type PlanUndo, type PlanUndoResult, type PlanView } from "./plan-shared";

export { PLAN_LIMITS, PLAN_TOOLS };

// ---- The steps ----

const uuid = z.uuid();
const ref = z.string().regex(REF_PATTERN);
const idOrRef = z.union([uuid, ref]);
const title = z.string().trim().min(1).max(ACTION_LIMITS.title);
const cells = z.record(z.string().max(200), z.unknown());
const snapshot = z.object({
  handle: z.string().regex(/^B\d{1,6}$/),
  index: z.number().int().min(0).max(1_000_000),
  blockId: z.string().max(100).nullable(),
  text: z.string().max(ACTION_LIMITS.markdown),
  type: z.string().max(40),
});
export const planStepSchema = z.discriminatedUnion("tool", [
  z.object({ tool: z.literal("create_page"), ref: ref.optional(), spaceId: uuid, parentId: idOrRef.nullish(), title, markdown: z.string().max(ACTION_LIMITS.markdown).default("") }),
  z.object({ tool: z.literal("create_database"), ref: ref.optional(), spaceId: uuid, parentId: idOrRef.nullish(), title, proposal: proposalSchema }),
  z.object({
    tool: z.literal("create_tasks"),
    pageId: idOrRef,
    tasks: z
      .array(z.object({ text: z.string().trim().min(1).max(500), assignee: z.string().trim().max(200).nullish(), due: z.string().trim().max(40).nullish() }))
      .min(1)
      .max(ACTION_LIMITS.tasks),
  }),
  z.object({ tool: z.literal("append_text"), pageId: idOrRef, markdown: z.string().trim().min(1).max(ACTION_LIMITS.markdown) }),
  z.object({ tool: z.literal("create_record"), ref: ref.optional(), databaseId: idOrRef, cells }),
  z.object({ tool: z.literal("update_record"), databaseId: uuid, recordId: uuid, cells }),
  z.object({
    tool: z.literal("insert_link"),
    pageId: idOrRef,
    targetPageId: idOrRef,
    targetRowId: idOrRef.nullish(),
    heading: z.string().trim().max(200).nullish(),
  }),
  z.object({ tool: z.literal("set_relation"), databaseId: uuid, recordId: idOrRef, field: z.string().trim().min(1).max(200), targets: z.array(idOrRef).min(1).max(PLAN_LIMITS.targets) }),
  z.object({ tool: z.literal("rename_page"), pageId: uuid, title }),
  z.object({ tool: z.literal("move_page"), pageId: uuid, spaceId: uuid.nullish(), parentId: idOrRef.nullish() }),
  z.object({
    tool: z.literal("set_properties"),
    pageId: idOrRef,
    addTags: z.array(z.string().trim().min(1).max(100)).max(PLAN_LIMITS.tags).default([]),
    removeTags: z.array(z.string().trim().min(1).max(100)).max(PLAN_LIMITS.tags).default([]),
    values: z.record(z.string().max(200), z.unknown()).default({}),
  }),
  z.object({
    tool: z.literal("edit_text"),
    pageId: uuid,
    edits: z
      .array(z.object({ op: z.enum(["replace", "insert_after", "insert_before", "delete"]), handle: z.string().regex(/^B\d{1,6}$/), content: z.string().max(ACTION_LIMITS.markdown).default("") }))
      .min(1)
      .max(PLAN_LIMITS.edits),
    snapshots: z.array(snapshot).max(PLAN_LIMITS.edits),
  }),
]);
export type PlanStep = z.infer<typeof planStepSchema>;

// ---- Checking ----

// What a step creates, known to the later steps of the same plan before it
// exists ("$page1").
type Virtual = { index: number; kind: "page" | "database" | "record"; title: string; spaceId?: string; databaseId?: string; parentId?: string | null; fields?: { name: string; type: string }[] };
type Ctx = {
  user: Identity;
  workspaceId: string;
  refs: Map<string, Virtual>;
  // Where earlier moves of the plan put pages (cycle check).
  parents: Map<string, string | null>;
  // Pages the instruction names, the open page.
  mentioned: (page: Pick<Page, "id" | "title">) => boolean;
};
type Checked = { step: PlanStep; view: PlanView; needs: number[]; touches: Pick<Page, "id" | "title">[] };

const bad = (message: string): never => {
  throw new HttpError(400, message);
};
const REF_UNKNOWN = "Der Schritt verweist auf etwas, das kein früherer Schritt anlegt.";
const REF_KIND = "Der Verweis passt nicht zu diesem Schritt.";
const ENCRYPTED = "In verschlüsselten Bereichen ändert die KI nichts.";

function virtual(ctx: Ctx, value: string, kinds: Virtual["kind"][], needs: number[]) {
  const v = ctx.refs.get(value);
  if (!v) bad(REF_UNKNOWN);
  if (!kinds.includes(v!.kind)) bad(REF_KIND);
  if (!needs.includes(v!.index)) needs.push(v!.index);
  return v!;
}

async function writableSpace(ctx: Ctx, spaceId: string) {
  const space = await one<Space & { encrypted?: number }>("SELECT * FROM spaces WHERE id=? AND workspace_id=? AND deleted_at IS NULL", spaceId, ctx.workspaceId);
  if (!space || !editable(await spaceRole(ctx.user, space))) throw new HttpError(403, "Kein Zugriff auf Bereich.");
  if (space.encrypted) throw new HttpError(409, ENCRYPTED);
  if (!(await aiSpaceOpen(ctx.user, space.id, ctx.workspaceId))) throw new HttpError(403, "Dieser Bereich ist für die KI gesperrt.");
  return space;
}
// A page the person may change and the AI may read.
async function writablePage(ctx: Ctx, pageId: string) {
  const page = await requirePage(ctx.user, pageId, true);
  if (page.workspace_id !== ctx.workspaceId) throw new HttpError(404, "Seite nicht gefunden.");
  if (page.locked) throw new HttpError(409, "Diese Seite ist gesperrt.");
  await requireUnlocked(ctx.user, page);
  if (!(await aiMayRead(ctx.user, page.id))) throw new HttpError(403, AI_BLOCKED_MESSAGE);
  return page;
}
// The parent of a new page: an existing document of the space, or a page
// the plan creates there.
async function parentFor(ctx: Ctx, parentId: string | null | undefined, spaceId: string, needs: number[]) {
  if (!parentId) return { title: "" };
  if (isRef(parentId)) {
    const v = virtual(ctx, parentId, ["page"], needs);
    if (v.spaceId !== spaceId) bad("Übergeordnete Seite liegt in anderem Bereich.");
    return { title: v.title };
  }
  const parent = await writablePage(ctx, parentId);
  if (parent.space_id !== spaceId) bad("Übergeordnete Seite liegt in anderem Bereich.");
  if (parent.kind !== "document") bad("Unterseiten legt die KI nur unter Dokumenten an.");
  return { title: parent.title, page: parent };
}
// A document to write into: existing, or one the plan creates.
async function documentOrRef(ctx: Ctx, pageId: string, needs: number[]) {
  if (isRef(pageId)) return { title: virtual(ctx, pageId, ["page"], needs).title };
  const page = await documentTarget(ctx.user, ctx.workspaceId, pageId);
  return { title: page.title, page };
}

// Parents of a page as they will be: earlier moves of the plan first.
async function ancestors(ctx: Ctx, start: string | null) {
  const chain: string[] = [];
  for (let current = start; current && chain.length < 300; ) {
    if (chain.includes(current)) break;
    chain.push(current);
    if (ctx.parents.has(current)) current = ctx.parents.get(current)!;
    else if (isRef(current)) current = ctx.refs.get(current)?.parentId ?? null;
    else current = (await one<{ parent_id: string | null }>("SELECT parent_id FROM pages WHERE id=?", current))?.parent_id ?? null;
  }
  return chain;
}

const display = async (fields: Field[], values: Record<string, unknown>) => {
  const names = nameLookup();
  const out: { name: string; value: string }[] = [];
  for (const [fid, value] of Object.entries(values)) {
    const field = fields.find((f) => f.id === fid);
    if (field) out.push({ name: field.name, value: await cellPlain(field, value, {}, names) });
  }
  return out;
};
const shortText = (text: string, max = 600) => (text.length > max ? `${text.slice(0, max)} …` : text);

async function checkStep(ctx: Ctx, step: PlanStep): Promise<Checked> {
  const needs: number[] = [];
  const touches: Pick<Page, "id" | "title">[] = [];
  const { user, workspaceId } = ctx;
  switch (step.tool) {
    case "create_page":
    case "create_database": {
      const space = await writableSpace(ctx, step.spaceId);
      const parent = await parentFor(ctx, step.parentId, space.id, needs);
      const target = parent.title ? `${space.name} / ${parent.title}` : space.name;
      if (step.tool === "create_page")
        return { step: { ...step, parentId: step.parentId || null }, view: { target, title: step.title, markdown: step.markdown }, needs, touches };
      await requireMember(user, workspaceId, "editor");
      const proposal = normalizeProposal({ ...step.proposal, title: step.title });
      return {
        step: { ...step, parentId: step.parentId || null, proposal: proposal as unknown as z.infer<typeof proposalSchema> },
        view: { target, title: step.title, fields: proposal.fields.map((f) => ({ name: f.name, type: f.type })), records: proposal.rows.length },
        needs,
        touches,
      };
    }
    case "create_tasks": {
      const doc = await documentOrRef(ctx, step.pageId, needs);
      if (doc.page) touches.push(doc.page);
      const people = await members(workspaceId);
      const tasks = step.tasks.map((task) => ({ text: task.text, assignee: memberBy(people, task.assignee)?.id || null, due: validDay(task.due) || null }));
      return {
        step: { ...step, tasks },
        view: {
          target: doc.title,
          tasks: tasks.map((task) => ({
            text: task.text,
            ...(task.assignee ? { assignee: people.find((p) => p.id === task.assignee)!.name } : {}),
            ...(task.due ? { due: task.due } : {}),
          })),
        },
        needs,
        touches,
      };
    }
    case "append_text": {
      const doc = await documentOrRef(ctx, step.pageId, needs);
      if (doc.page) touches.push(doc.page);
      return { step, view: { target: doc.title, markdown: step.markdown }, needs, touches };
    }
    case "create_record": {
      if (isRef(step.databaseId)) {
        // A database the plan creates: values by the names of its properties.
        const v = virtual(ctx, step.databaseId, ["database"], needs);
        const names = new Map((v.fields || []).map((f) => [foldName(f.name), f.name]));
        const shown: { name: string; value: string }[] = [];
        for (const [key, value] of Object.entries(step.cells)) {
          const name = names.get(foldName(key));
          if (!name) bad(`Eigenschaft „${key}“ wurde nicht gefunden.`);
          shown.push({ name: name!, value: Array.isArray(value) ? value.join(", ") : String(value ?? "") });
        }
        return { step, view: { target: v.title, title: shown[0]?.value, cells: shown }, needs, touches };
      }
      const page = await databaseTarget(user, workspaceId, step.databaseId);
      if (page.locked) throw new HttpError(409, "Diese Seite ist gesperrt.");
      touches.push(page);
      const { cells: patch, fields } = await cellPatch(user, page, step.cells);
      return { step: { ...step, cells: patch }, view: { target: page.title, title: recordTitle(fields, patch), cells: await display(fields, patch) }, needs, touches };
    }
    case "update_record": {
      const page = await databaseTarget(user, workspaceId, step.databaseId);
      const { row } = await requireRow(user, page.id, step.recordId, true);
      if (!(await aiMayRead(user, page.id, row.id))) throw new HttpError(403, AI_BLOCKED_MESSAGE);
      touches.push(page);
      const { cells: patch, fields } = await cellPatch(user, page, step.cells);
      return { step: { ...step, cells: patch }, view: { target: `${page.title} / ${recordTitle(fields, storedCells(row.cells))}`, cells: await display(fields, patch) }, needs, touches };
    }
    case "insert_link": {
      const doc = await documentOrRef(ctx, step.pageId, needs);
      if (doc.page) touches.push(doc.page);
      // The page or record the link leads to: readable for the person.
      let to: string;
      if (step.targetRowId) {
        if (isRef(step.targetRowId)) to = virtual(ctx, step.targetRowId, ["record"], needs).title;
        else {
          if (isRef(step.targetPageId)) bad(REF_KIND);
          const { page, row } = await requireRow(user, step.targetPageId, step.targetRowId);
          const fields = (await readableDatabase(user, page, await database(page.id))).fields;
          to = `${page.title} / ${recordTitle(fields, storedCells(row.cells))}`;
        }
      } else if (isRef(step.targetPageId)) to = virtual(ctx, step.targetPageId, ["page", "database"], needs).title;
      else {
        const target = await requirePage(user, step.targetPageId);
        if (target.workspace_id !== workspaceId) throw new HttpError(404, "Seite nicht gefunden.");
        to = target.title;
      }
      // Under a heading of the page: it must be there (a new page has none yet).
      const heading = step.heading?.trim() || null;
      if (heading) {
        if (!doc.page) bad("Die Überschrift gibt es in der Seite nicht.");
        const html = (await one<{ html: string }>("SELECT html FROM documents WHERE page_id=?", doc.page!.id))?.html || "";
        const headings = [...html.matchAll(/<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>/gi)].map((m) => foldName(m[1].replace(/<[^>]+>/g, "")));
        if (!headings.includes(foldName(heading))) bad("Die Überschrift gibt es in der Seite nicht.");
      }
      return { step: { ...step, heading }, view: { target: doc.title, link: { to: to || ct("Ohne Titel", "Untitled"), ...(heading ? { heading } : {}) } }, needs, touches };
    }
    case "set_relation": {
      const page = await databaseTarget(user, workspaceId, step.databaseId);
      if (page.locked) throw new HttpError(409, "Diese Seite ist gesperrt.");
      touches.push(page);
      const fields = (await readableDatabase(user, page, await database(page.id))).fields;
      const field = fields.find((f) => f.id === step.field) || fields.find((f) => foldName(f.name) === foldName(step.field));
      if (!field || field.type !== "relation" || !field.relationPage) bad("Keine Relation dieser Datenbank.");
      if ((await readOnlyFieldIds(user, page, fields)).includes(field!.id)) throw new HttpError(403, `„${field!.name}“ ist nur für bestimmte Personen bearbeitbar.`);
      let record: string;
      if (isRef(step.recordId)) {
        const v = virtual(ctx, step.recordId, ["record"], needs);
        if (v.databaseId !== page.id) bad(REF_KIND);
        record = v.title;
      } else {
        const { row } = await requireRow(user, page.id, step.recordId, true);
        if (!(await aiMayRead(user, page.id, row.id))) throw new HttpError(403, AI_BLOCKED_MESSAGE);
        record = recordTitle(fields, storedCells(row.cells));
      }
      const relationPage = await requirePage(user, field!.relationPage!);
      const relationFields = (await readableDatabase(user, relationPage, await database(relationPage.id))).fields;
      const titles: string[] = [];
      for (const target of step.targets) {
        if (isRef(target)) {
          const v = virtual(ctx, target, ["record"], needs);
          if (v.databaseId !== relationPage.id) bad("Verknüpfter Eintrag fehlt.");
          titles.push(v.title);
        } else {
          const { row } = await requireRow(user, relationPage.id, target).catch(() => bad("Verknüpfter Eintrag fehlt."));
          titles.push(recordTitle(relationFields, storedCells(row.cells)));
        }
      }
      return {
        step: { ...step, field: field!.id, targets: [...new Set(step.targets)] },
        view: { target: `${page.title} / ${record}`, cells: [{ name: field!.name, value: `+ ${titles.join(", ")}` }] },
        needs,
        touches,
      };
    }
    case "rename_page": {
      const page = await writablePage(ctx, step.pageId);
      touches.push(page);
      return { step, view: { target: page.title, from: page.title, to: step.title }, needs, touches };
    }
    case "move_page": {
      const page = await writablePage(ctx, step.pageId);
      touches.push(page);
      if (page.synced) bad("Ungültiges Verschieben.");
      const fromSpace = await one<Space>("SELECT * FROM spaces WHERE id=?", page.space_id);
      const fromParent = page.parent_id ? (await one<Page>("SELECT * FROM pages WHERE id=?", page.parent_id)) : null;
      // Into a page (existing or new) or to the top of a space.
      let spaceId = step.spaceId || null;
      let parentTitle = "";
      if (step.parentId) {
        if (isRef(step.parentId)) {
          const v = virtual(ctx, step.parentId, ["page"], needs);
          spaceId = v.spaceId!;
          parentTitle = v.title;
        } else {
          const parent = await writablePage(ctx, step.parentId);
          if (parent.kind !== "document") bad("Unterseiten legt die KI nur unter Dokumenten an.");
          spaceId = parent.space_id;
          parentTitle = parent.title;
        }
        if (step.parentId === page.id || (await ancestors(ctx, step.parentId)).includes(page.id)) bad("Eine Seite lässt sich nicht unter sich selbst verschieben.");
      }
      spaceId ||= page.space_id;
      if (step.spaceId && step.spaceId !== spaceId) bad("Übergeordnete Seite liegt in anderem Bereich.");
      const space = await writableSpace(ctx, spaceId);
      if (fromSpace && (fromSpace as Space & { encrypted?: number }).encrypted) throw new HttpError(409, ENCRYPTED);
      if (!step.parentId && !page.parent_id && spaceId === page.space_id) bad("Die Seite liegt schon dort.");
      if (step.parentId && step.parentId === page.parent_id) bad("Die Seite liegt schon dort.");
      ctx.parents.set(page.id, step.parentId || null);
      return {
        step: { ...step, spaceId, parentId: step.parentId || null },
        view: {
          target: page.title,
          from: fromParent ? `${fromSpace?.name || ""} / ${fromParent.title}` : fromSpace?.name || "",
          to: parentTitle ? `${space.name} / ${parentTitle}` : space.name,
        },
        needs,
        touches,
      };
    }
    case "set_properties": {
      let spaceId: string;
      let page: Page | null = null;
      let title: string;
      if (isRef(step.pageId)) {
        const v = virtual(ctx, step.pageId, ["page", "database"], needs);
        spaceId = v.spaceId!;
        title = v.title;
      } else {
        page = await writablePage(ctx, step.pageId);
        touches.push(page);
        spaceId = page.space_id;
        title = page.title;
      }
      if (!step.addTags.length && !step.removeTags.length && !Object.keys(step.values).length) bad("Ungültige Eingabe.");
      const tags = await contextTags(workspaceId, spaceId);
      const mayCreate = await canCreateTags(user, workspaceId, spaceId);
      const addTags = [...new Set(step.addTags.map((name) => tags.find((t) => foldName(t.name) === foldName(name))?.name ?? name))];
      for (const name of addTags)
        if (!tags.some((t) => t.name === name) && !mayCreate) throw new HttpError(403, "Neue Tags legen nur Mitglieder mit Bearbeitungsrechten an.");
      const current = page ? new Set((await pageMeta(page.id)).tags) : new Set<string>();
      const removeTags = step.removeTags
        .map((name) => tags.find((t) => foldName(t.name) === foldName(name)))
        .filter((t): t is NonNullable<typeof t> => !!t && current.has(t.id))
        .map((t) => t.name);
      const defs = await contextProperties(workspaceId, spaceId);
      const values: Record<string, unknown> = {};
      const shown: { name: string; value: string }[] = [];
      const people = await members(workspaceId);
      for (const [key, raw] of Object.entries(step.values).slice(0, PLAN_LIMITS.values)) {
        const def = defs.find((d) => d.id === key) ?? defs.find((d) => foldName(d.name) === foldName(key));
        if (!def) bad(`Eigenschaft „${key}“ wurde nicht gefunden.`);
        // People by name, like in records.
        const input = def!.type === "person" && typeof raw === "string" ? memberBy(people, raw)?.id ?? raw : raw;
        values[def!.id] = await parsePropertyValue(def!, input, workspaceId);
        shown.push({ name: def!.name, value: values[def!.id] === null ? "–" : propertyText(def!, values[def!.id], (id) => people.find((p) => p.id === id)?.name) });
      }
      if (!addTags.length && !removeTags.length && !Object.keys(values).length) bad("Die Seite hat diese Tags und Werte schon.");
      return {
        step: { ...step, addTags, removeTags, values },
        view: { target: title, ...(addTags.length || removeTags.length ? { tags: { add: addTags, remove: removeTags } } : {}), ...(shown.length ? { cells: shown } : {}) },
        needs,
        touches,
      };
    }
    case "edit_text": {
      const page = await documentTarget(user, workspaceId, step.pageId);
      touches.push(page);
      const snapshots = new Map(step.snapshots.map((s) => [s.handle, s]));
      const diff = step.edits.map((edit) => {
        const before = snapshots.get(edit.handle);
        if (!before) bad("Die KI hat diese Stelle der Seite nicht gelesen.");
        if (edit.op !== "delete" && !edit.content.trim()) bad("Ungültige Eingabe.");
        return { op: edit.op, before: shortText(edit.op.startsWith("insert") ? "" : before!.text, 2000), after: shortText(edit.op === "delete" ? "" : edit.content, 4000) };
      });
      const used = new Set(step.edits.map((e) => e.handle));
      return { step: { ...step, snapshots: step.snapshots.filter((s) => used.has(s.handle)) }, view: { target: page.title, diff }, needs, touches };
    }
  }
}

// What a step creates, for the later steps.
function remember(ctx: Ctx, step: PlanStep, index: number, view: PlanView) {
  if (step.tool === "create_page" && step.ref) ctx.refs.set(step.ref, { index, kind: "page", title: step.title, spaceId: step.spaceId, parentId: step.parentId || null });
  if (step.tool === "create_database" && step.ref)
    ctx.refs.set(step.ref, { index, kind: "database", title: step.title, spaceId: step.spaceId, parentId: step.parentId || null, fields: step.proposal.fields });
  if (step.tool === "create_record" && step.ref) ctx.refs.set(step.ref, { index, kind: "record", title: view.title || ct("Ohne Titel", "Untitled"), databaseId: step.databaseId });
}

const reason = (error: unknown) =>
  error instanceof HttpError ? error.message : error instanceof z.ZodError ? "Ungültige Eingabe." : "Der Schritt ist nicht möglich.";
const toolOf = (raw: unknown) =>
  raw && typeof raw === "object" && typeof (raw as { tool?: unknown }).tool === "string" ? String((raw as { tool: string }).tool).slice(0, 40) : "";

export type PreviewOptions = { instruction?: string; currentPageId?: string | null };

// The checked preview of a whole plan. A step that refers to an impossible
// or invalid one is checked as if it were there – the browser deselects it
// with the reason (`needs`).
export async function previewPlan(user: Identity, workspaceId: string, raw: unknown[], options: PreviewOptions = {}): Promise<PlanPreview[]> {
  const words = foldName(options.instruction || "");
  const ctx: Ctx = {
    user,
    workspaceId,
    refs: new Map(),
    parents: new Map(),
    mentioned: (page) => page.id === options.currentPageId || (foldName(page.title).length >= 3 && words.includes(foldName(page.title))),
  };
  const out: PlanPreview[] = [];
  for (const [index, item] of raw.slice(0, PLAN_LIMITS.steps).entries()) {
    const tool = toolOf(item);
    const parsed = planStepSchema.safeParse(item);
    if (!parsed.success) {
      out.push({ index, tool, step: null, ok: false, problem: "Die KI hat einen ungültigen Schritt vorgeschlagen.", needs: [], view: { target: "" } });
      continue;
    }
    const step = parsed.data;
    if ("ref" in step && step.ref && ctx.refs.has(step.ref)) {
      out.push({ index, tool, step: null, ok: false, problem: "Die KI hat einen ungültigen Schritt vorgeschlagen.", needs: [], view: { target: "" } });
      continue;
    }
    try {
      const checked = await checkStep(ctx, step);
      remember(ctx, checked.step, index, checked.view);
      const unmentioned = checked.touches.some((page) => !ctx.mentioned(page));
      out.push({ index, tool, step: checked.step, ok: true, needs: checked.needs, view: checked.view, ...(unmentioned ? { unmentioned } : {}) });
    } catch (error) {
      if (!(error instanceof HttpError) && !(error instanceof z.ZodError)) console.error("KI-Plan:", (error as Error)?.message);
      // Later steps still know what it would have created (and wait for it).
      remember(ctx, step, index, { target: "", title: step.tool === "create_record" ? Object.values(step.cells).map(String)[0] : undefined });
      out.push({ index, tool, step: null, ok: false, problem: reason(error), needs: [], view: { target: "" } });
    }
  }
  return out;
}

// ---- Running ----

export const runPlanInput = z.object({
  workspaceId: z.uuid(),
  steps: z
    .array(z.object({ index: z.number().int().min(0).max(PLAN_LIMITS.steps - 1), step: z.unknown() }))
    .min(1)
    .max(PLAN_LIMITS.steps),
});
const DEPENDS = "Ein Schritt, von dem dieser abhängt, wurde nicht ausgeführt.";

type Created = { kind: Virtual["kind"]; id: string; databaseId?: string };
// The step with every local reference replaced by what was created.
function resolveRefs(step: PlanStep, created: Map<string, Created>): PlanStep {
  const page = (value: string) => {
    if (!isRef(value)) return value;
    const c = created.get(value);
    if (!c) throw new HttpError(409, DEPENDS);
    if (c.kind === "record") throw new HttpError(400, REF_KIND);
    return c.id;
  };
  const record = (value: string) => {
    if (!isRef(value)) return value;
    const c = created.get(value);
    if (!c) throw new HttpError(409, DEPENDS);
    if (c.kind !== "record") throw new HttpError(400, REF_KIND);
    return c.id;
  };
  const s = { ...step } as Record<string, unknown>;
  if (typeof s.parentId === "string") s.parentId = page(s.parentId);
  if (typeof s.pageId === "string") s.pageId = page(s.pageId);
  if (typeof s.databaseId === "string") s.databaseId = page(s.databaseId);
  if (step.tool === "insert_link") {
    // A record created by the plan: its database is the link's page.
    if (step.targetRowId && isRef(step.targetRowId)) {
      const c = created.get(step.targetRowId);
      if (!c) throw new HttpError(409, DEPENDS);
      s.targetPageId = c.databaseId;
    } else s.targetPageId = page(step.targetPageId);
    if (typeof s.targetRowId === "string") s.targetRowId = record(s.targetRowId);
  }
  if (typeof s.recordId === "string") s.recordId = record(s.recordId);
  if (Array.isArray(s.targets)) s.targets = (s.targets as string[]).map(record);
  return s as PlanStep;
}

// New top-level blocks get ids: undo removes exactly them.
function withIds(fragment: PMNode, ids: string[]) {
  const nodes: PMNode[] = [];
  fragment.forEach((node) => {
    if (node.type.spec.attrs && "blockId" in node.type.spec.attrs) {
      const blockId = newBlockId();
      ids.push(blockId);
      nodes.push(node.type.create({ ...node.attrs, blockId }, node.content, node.marks));
    } else nodes.push(node);
  });
  return nodes;
}
// HTML into a document as the person – at the end, or at the end of the
// section below a heading. Returns the ids of the new blocks.
export async function insertBlocks(user: Identity, pageId: string, html: string, heading?: string | null) {
  const ids: string[] = [];
  await syncDocument(user, pageId, (doc, schema) => {
    const added = withIds(schema.nodeFromJSON(htmlJson(cleanHtml(html) || "<p></p>")), ids);
    const children: PMNode[] = [];
    doc.forEach((node) => children.push(node));
    let at = children.length;
    if (heading) {
      const start = children.findIndex((n) => n.type.name === "heading" && foldName(n.textContent) === foldName(heading));
      if (start < 0) throw new HttpError(409, "Die Überschrift gibt es in der Seite nicht.");
      const level = Number(children[start].attrs.level) || 1;
      const next = children.findIndex((n, i) => i > start && n.type.name === "heading" && (Number(n.attrs.level) || 1) <= level);
      at = next < 0 ? children.length : next;
    }
    const empty = children.length === 1 && children[0].type.name === "paragraph" && !children[0].content.size;
    const list = empty ? added : [...children.slice(0, at), ...added, ...children.slice(at)];
    return doc.type.create(doc.attrs, list);
  });
  return ids;
}
// The blocks a step added, out again (only those, wherever they are now).
async function removeBlocks(user: Identity, pageId: string, blockIds: string[]) {
  const ids = new Set(blockIds);
  await syncDocument(user, pageId, (doc) => {
    const kept: PMNode[] = [];
    let removed = 0;
    doc.forEach((node) => {
      if (ids.has(String(node.attrs.blockId || ""))) removed++;
      else kept.push(node);
    });
    if (!removed) return null;
    if (!kept.length) kept.push(doc.type.schema.nodes.paragraph.create());
    return doc.type.create(doc.attrs, kept);
  });
}

const linkHtml = (title: string, pageId: string, rowId?: string | null) => {
  const href = `/#${new URLSearchParams(rowId ? { page: pageId, row: rowId } : { page: pageId })}`;
  const text = title.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return `<p><a href="${href}">${text}</a></p>`;
};

async function personName(user: Identity) {
  return (await one<{ name: string }>("SELECT name FROM users WHERE id=?", user.id))?.name || ct("Jemand", "Someone");
}

// Executes one checked step; returns what was done and how to undo it.
async function execute(user: Identity, workspaceId: string, step: PlanStep, view: PlanView): Promise<Omit<PlanStepResult, "index" | "tool" | "ok"> & { created?: Created }> {
  switch (step.tool) {
    case "create_page":
    case "create_database": {
      const { id } = (await command(user, {
        action: "page.create",
        workspaceId,
        spaceId: step.spaceId,
        ...(step.parentId ? { parentId: step.parentId } : {}),
        title: step.title,
        kind: step.tool === "create_page" ? "document" : "database",
        ...(step.tool === "create_database" ? { aiDatabase: step.proposal } : {}),
      })) as { id: string };
      if (step.tool === "create_page" && step.markdown.trim()) await insertBlocks(user, id, markdownToHtml(step.markdown, aiAnswerHref));
      return { pageId: id, title: step.title, undo: { kind: "trash_page", pageId: id }, created: { kind: step.tool === "create_page" ? "page" : "database", id } };
    }
    case "create_tasks": {
      const names = nameLookup();
      const blockIds = await insertBlocks(user, step.pageId, await tasksHtml(step.tasks, names));
      return { pageId: step.pageId, undo: { kind: "remove_blocks", pageId: step.pageId, blockIds } };
    }
    case "append_text": {
      const blockIds = await insertBlocks(user, step.pageId, markdownToHtml(step.markdown, aiAnswerHref));
      return { pageId: step.pageId, undo: { kind: "remove_blocks", pageId: step.pageId, blockIds } };
    }
    case "create_record": {
      const { id } = (await command(user, { action: "row.create", pageId: step.databaseId, cells: step.cells })) as { id: string };
      return { pageId: step.databaseId, rowId: id, title: view.title, undo: { kind: "trash_row", pageId: step.databaseId, rowId: id }, created: { kind: "record", id, databaseId: step.databaseId } };
    }
    case "update_record": {
      const { row } = await requireRow(user, step.databaseId, step.recordId, true);
      const before = storedCells(row.cells);
      await command(user, { action: "row.update", pageId: step.databaseId, rowId: row.id, version: row.version, cells: step.cells });
      return { pageId: step.databaseId, rowId: row.id, undo: { kind: "cells", pageId: step.databaseId, rowId: row.id, cells: Object.fromEntries(Object.keys(step.cells).map((k) => [k, before[k] ?? null])) } };
    }
    case "insert_link": {
      const target = step.targetRowId
        ? view.link?.to || ""
        : (await one<{ title: string }>("SELECT title FROM pages WHERE id=?", step.targetPageId))?.title || ct("Ohne Titel", "Untitled");
      const blockIds = await insertBlocks(user, step.pageId, linkHtml(target, step.targetPageId, step.targetRowId), step.heading);
      return { pageId: step.pageId, undo: { kind: "remove_blocks", pageId: step.pageId, blockIds } };
    }
    case "set_relation": {
      const { row } = await requireRow(user, step.databaseId, step.recordId, true);
      const before = storedCells(row.cells);
      const old = Array.isArray(before[step.field]) ? (before[step.field] as string[]) : [];
      await command(user, { action: "row.update", pageId: step.databaseId, rowId: row.id, version: row.version, cells: { [step.field]: [...new Set([...old, ...step.targets])] } });
      return { pageId: step.databaseId, rowId: row.id, undo: { kind: "cells", pageId: step.databaseId, rowId: row.id, cells: { [step.field]: old } } };
    }
    case "rename_page": {
      const page = await requirePage(user, step.pageId, true);
      await command(user, { action: "page.update", pageId: page.id, patch: { title: step.title } });
      return { pageId: page.id, title: step.title, undo: { kind: "rename", pageId: page.id, title: page.title } };
    }
    case "move_page": {
      const page = await requirePage(user, step.pageId, true);
      const before = await one<{ id: string }>(
        "SELECT id FROM pages WHERE space_id=? AND parent_id IS NOT DISTINCT FROM ? AND parent_row_id IS NULL AND deleted_at IS NULL AND id!=? AND position<=? ORDER BY position DESC,id DESC LIMIT 1",
        page.space_id,
        page.parent_id,
        page.id,
        page.position ?? 0,
      );
      await command(user, { action: "page.move", pageId: page.id, ...(step.parentId ? { parentId: step.parentId } : { spaceId: step.spaceId }), meta: "auto" });
      return { pageId: page.id, title: page.title, undo: { kind: "move", pageId: page.id, spaceId: page.space_id, parentId: page.parent_id, afterId: before?.id ?? null } };
    }
    case "set_properties": {
      const meta = await pageMeta(step.pageId);
      await command(user, { action: "page.properties", pageId: step.pageId, addTags: step.addTags, removeTags: step.removeTags, ...(Object.keys(step.values).length ? { values: step.values } : {}) });
      return {
        pageId: step.pageId,
        undo: { kind: "properties", pageId: step.pageId, tags: meta.tags, values: Object.fromEntries(Object.keys(step.values).map((k) => [k, meta.values[k] ?? null])) },
      };
    }
    case "edit_text": {
      const ids: string[] = [];
      const name = await personName(user);
      let result: ReturnType<typeof applyPageEdits> | null = null;
      const change = await rewriteDocument(step.pageId, null, user.id, (doc) => {
        result = applyPageEdits(doc, step.edits, step.snapshots as BlockSnapshot[], {
          parse: parseMarkdown,
          author: { id: user.id, name: ct(`${name} (KI)`, `${name} (AI)`) },
          newId: () => {
            const id = Math.random().toString(36).slice(2, 10);
            ids.push(id);
            return id;
          },
        });
        return result.applied ? result.doc : null;
      });
      change?.publish();
      const done = result as ReturnType<typeof applyPageEdits> | null;
      if (!done?.applied) throw new HttpError(409, "Die Seite hat sich inzwischen geändert – die Stellen gibt es so nicht mehr.");
      return { pageId: step.pageId, undo: { kind: "withdraw", pageId: step.pageId, suggestionIds: ids } };
    }
  }
}

// The chosen steps, each checked again and run on its own: one failure
// stops only the steps that depend on it.
export async function runPlan(user: Identity, raw: unknown): Promise<{ results: PlanStepResult[] }> {
  const input = runPlanInput.parse(raw);
  await requireMember(user, input.workspaceId);
  await requireAi(user, "actions", { workspaceId: input.workspaceId });
  const created = new Map<string, Created>();
  const results: PlanStepResult[] = [];
  const seen = new Set<number>();
  for (const { index, step: rawStep } of [...input.steps].sort((a, b) => a.index - b.index)) {
    if (seen.has(index)) continue;
    seen.add(index);
    const parsed = planStepSchema.safeParse(rawStep);
    const tool = parsed.success ? parsed.data.tool : toolOf(rawStep);
    if (!parsed.success) {
      results.push({ index, tool, ok: false, error: "Ungültige Eingabe." });
      continue;
    }
    try {
      let resolved: PlanStep;
      try {
        resolved = resolveRefs(parsed.data, created);
      } catch (error) {
        results.push({ index, tool, ok: false, skipped: true, error: reason(error) });
        continue;
      }
      // Checked again as the page is now (earlier steps have run).
      const ctx: Ctx = { user, workspaceId: input.workspaceId, refs: new Map(), parents: new Map(), mentioned: () => true };
      const checked = await checkStep(ctx, resolved);
      const done = await execute(user, input.workspaceId, checked.step, checked.view);
      const ref = "ref" in parsed.data ? parsed.data.ref : undefined;
      if (ref && done.created) created.set(ref, done.created);
      await audit(user.id, "ai.plan", done.rowId || done.pageId || "", tool);
      const { created: _created, ...rest } = done;
      results.push({ index, tool, ok: true, ...rest });
    } catch (error) {
      if (!(error instanceof HttpError) && !(error instanceof z.ZodError)) console.error("KI-Plan fehlgeschlagen:", (error as Error)?.message);
      results.push({ index, tool, ok: false, error: reason(error) });
    }
  }
  return { results };
}

// ---- Undo ----

const undoSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("trash_page"), pageId: uuid }),
  z.object({ kind: z.literal("trash_row"), pageId: uuid, rowId: uuid }),
  z.object({ kind: z.literal("rename"), pageId: uuid, title: z.string().max(ACTION_LIMITS.title) }),
  z.object({ kind: z.literal("move"), pageId: uuid, spaceId: uuid, parentId: uuid.nullable(), afterId: uuid.nullable() }),
  z.object({ kind: z.literal("properties"), pageId: uuid, tags: z.array(z.string().max(200)).max(200), values: z.record(z.string().max(200), z.unknown()) }),
  z.object({ kind: z.literal("remove_blocks"), pageId: uuid, blockIds: z.array(z.string().max(100)).max(100) }),
  z.object({ kind: z.literal("withdraw"), pageId: uuid, suggestionIds: z.array(z.string().max(100)).max(1000) }),
  z.object({ kind: z.literal("cells"), pageId: uuid, rowId: uuid, cells: z.record(z.string().max(200), z.unknown()) }),
]);
export const undoPlanInput = z.object({
  workspaceId: z.uuid(),
  undo: z.array(z.object({ index: z.number().int().min(0).max(PLAN_LIMITS.steps - 1), undo: z.unknown() })).min(1).max(PLAN_LIMITS.steps),
});

async function undoOne(user: Identity, workspaceId: string, op: PlanUndo) {
  const page = await requirePage(user, op.pageId, true, op.kind === "trash_page");
  if (page.workspace_id !== workspaceId) throw new HttpError(404, "Seite nicht gefunden.");
  switch (op.kind) {
    case "trash_page":
      if (!page.deleted_at) await command(user, { action: "page.delete", pageId: page.id });
      return;
    case "trash_row":
      if (await one("SELECT 1 FROM rows WHERE id=? AND page_id=?", op.rowId, page.id)) await command(user, { action: "row.delete", pageId: page.id, rowId: op.rowId });
      return;
    case "rename":
      await command(user, { action: "page.update", pageId: page.id, patch: { title: op.title } });
      return;
    case "move": {
      const back = op.parentId ? { parentId: op.parentId } : { spaceId: op.spaceId };
      // Next to the page it followed, else at the end of its old place.
      if (op.afterId && (await one("SELECT 1 FROM pages WHERE id=? AND deleted_at IS NULL", op.afterId)))
        try {
          await command(user, { action: "page.move", pageId: page.id, targetId: op.afterId, placement: "after", meta: "auto" });
          return;
        } catch (error) {
          if (!(error instanceof HttpError) || error.status !== 403) throw error;
        }
      await command(user, { action: "page.move", pageId: page.id, ...back, meta: "auto" });
      return;
    }
    case "properties":
      await command(user, { action: "page.properties", pageId: page.id, tags: op.tags, ...(Object.keys(op.values).length ? { values: op.values } : {}) });
      return;
    case "remove_blocks":
      if (page.locked) throw new HttpError(409, "Diese Seite ist gesperrt.");
      await requireUnlocked(user, page);
      await removeBlocks(user, page.id, op.blockIds);
      return;
    case "withdraw": {
      if (page.locked) throw new HttpError(409, "Diese Seite ist gesperrt.");
      await requireUnlocked(user, page);
      // Only suggestions of this person with these ids: rejected.
      const ids = new Set(op.suggestionIds);
      const change = await rewriteDocument(page.id, null, user.id, (doc) => {
        const tr = resolveSuggestions(EditorState.create({ doc }), false, (a) => ids.has(a.id) && a.author === user.id);
        return tr.docChanged ? tr.doc : null;
      });
      change?.publish();
      return;
    }
    case "cells": {
      const { row } = await requireRow(user, page.id, op.rowId, true);
      await command(user, { action: "row.update", pageId: page.id, rowId: row.id, version: row.version, cells: op.cells });
      return;
    }
  }
}

// "Alles rückgängig": the newest step first; each on its own.
export async function undoPlan(user: Identity, raw: unknown): Promise<{ results: PlanUndoResult[] }> {
  const input = undoPlanInput.parse(raw);
  await requireMember(user, input.workspaceId);
  const results: PlanUndoResult[] = [];
  for (const { index, undo } of [...input.undo].sort((a, b) => b.index - a.index)) {
    const parsed = undoSchema.safeParse(undo);
    if (!parsed.success) {
      results.push({ index, ok: false, error: "Ungültige Eingabe." });
      continue;
    }
    try {
      await undoOne(user, input.workspaceId, parsed.data);
      await audit(user.id, "ai.plan", parsed.data.pageId, `undo:${parsed.data.kind}`);
      results.push({ index, ok: true });
    } catch (error) {
      if (!(error instanceof HttpError) && !(error instanceof z.ZodError)) console.error("KI-Plan rückgängig:", (error as Error)?.message);
      results.push({ index, ok: false, error: reason(error) });
    }
  }
  return { results: results.sort((a, b) => a.index - b.index) };
}
