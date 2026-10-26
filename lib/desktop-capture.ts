// Quick capture of the desktop app (flowplan-desktop), with the person's
// browser session like the web app:
//
//   GET  /api/capture/targets  where a capture can go: the inbox, every
//                              database and document the person may add
//                              to, today's journal entry – with the
//                              properties the shorthand can fill and what
//                              the instance offers (voice notes, AI)
//   POST /api/capture/preview  the shorthand of a text as chips for a target
//                              (lib/capture-parse.ts, nothing is saved)
//   POST /api/capture/save     text (parsed again), a link with its preview,
//                              images, PDFs, text files and a voice note as a
//                              record, appended to a page or today's journal
//   POST /api/capture/undo     takes a capture back within a few minutes:
//                              a record or sub page to the trash (row.delete,
//                              page.delete), appended blocks removed again
//
// Saving goes through the same commands and target checks as the mobile
// apps' capture (lib/mobile-capture.ts, captureTarget): pages of end-to-end
// encrypted spaces are never targets – the server cannot write into them,
// and the desktop window has no keys – nor journals behind a PIN.
// Idempotency-Key (lib/idempotency.ts) makes the offline queue's retries safe.
import { createHash } from "node:crypto";
import { z } from "zod";
import { Fragment, type Node as PMNode } from "@tiptap/pm/model";
import { generateJSON } from "@tiptap/html/server";
import { all, one, transaction } from "./db";
import { HttpError } from "./auth";
import { command, database } from "./api";
import { ct } from "./content-locale";
import { cleanHtml, escaped } from "./document-server";
import { rewriteDocument, rewriteSchema } from "./document-rewrite";
import { documentExtensions } from "./document-schema";
import { readableDatabase, readOnlyFieldIds, visibleFields } from "./field-access";
import { enforceQuota } from "./instance-ops";
import { localToInstant, validZone } from "./date-values";
import { markdownToHtml } from "./markdown-import";
import { captureTarget, type UploadFile } from "./mobile-widget-actions";
import { captureTargetList, pageAccess, writableJournals, writerOf } from "./mobile-widgets";
import { contentNodes, inboxTarget, MAX_CAPTURE_FILES, mediaHtml, prepareCaptureFiles, storeCaptureFiles, type Prepared } from "./mobile-capture";
import { recordPageEdit } from "./page-activity";
import { pageLocationHash } from "./page-location";
import { rowTemplates } from "./row-documents";
import { syncDocTasks } from "./doc-tasks";
import { transcribe, transcriptionEnabled } from "./transcribe";
import { enforceUserStorage, maxUploadMbFor } from "./user-limits";
import { parseCapture, type CaptureMember, type CaptureProperty } from "./capture-parse";
import { captureSuggestMode } from "./ai/capture-suggest";
import type { Field, Identity, Page } from "./types";

const url = (pageId: string, rowId?: string | null) => `/${pageLocationHash({ pageId, ...(rowId ? { rowId } : {}) })}`;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
// Text and Markdown files dropped into the capture window: their text.
export const MAX_TEXT_FILE = 1_000_000;
const PROPERTY_TYPES = ["date", "select", "multiselect", "person", "url", "files"];

// ---- Targets ----

// The properties of a database the shorthand may fill: those the person may write.
export function captureProperties(user: Identity, page: Page): CaptureProperty[] {
  const fields = readableDatabase(user, page, database(page.id)).fields;
  const readOnly = new Set(readOnlyFieldIds(user, page, fields));
  return fields
    .filter((f) => PROPERTY_TYPES.includes(f.type) && !readOnly.has(f.id) && !f.ai)
    .map((f) => ({ id: f.id, name: f.name, type: f.type, ...(f.options ? { options: f.options.slice(0, 200) } : {}) }));
}
function members(workspaceId: string): CaptureMember[] {
  return all<CaptureMember>(
    "SELECT u.id,u.name,u.email FROM members m JOIN users u ON u.id=m.user_id WHERE m.workspace_id=? AND COALESCE(u.disabled,0)=0 ORDER BY u.name LIMIT 500",
    workspaceId,
  );
}
const encryptedCount = (user: Identity) =>
  one<{ n: number }>(
    `SELECT COUNT(*) n FROM pages p JOIN spaces s ON s.id=p.space_id JOIN members m ON m.workspace_id=p.workspace_id AND m.user_id=?
     WHERE p.deleted_at IS NULL AND s.deleted_at IS NULL AND COALESCE(s.encrypted,0)=1 AND p.kind IN ('database','document','journal')`,
    user.id,
  )?.n || 0;

export function desktopCaptureTargets(user: Identity) {
  const inbox = inboxTarget(user);
  const targets = captureTargetList(user).map((t) => {
    if (t.kind !== "database") return t;
    const page = one<Page>("SELECT * FROM pages WHERE id=?", t.id)!;
    const properties = captureProperties(user, page);
    const named = (type: string) => properties.find((p) => p.type === type)?.name || null;
    return {
      ...t,
      // What the shorthand can fill here (the chips say it per text).
      fills: { date: named("date"), tags: properties.some((p) => p.type === "multiselect" || p.type === "select"), person: named("person") },
      templates: rowTemplates(t.id).slice(0, 20).map((r) => ({ id: r.id, name: r.name, default: !!r.is_default })),
    };
  });
  const journals = writableJournals(user).map((j) => ({ id: j.id, name: j.title || ct("Journal", "Journal"), icon: j.icon || "", kind: "journal" as const, space: j.space_name, workspace: j.workspace_name }));
  return {
    inbox,
    targets: [...targets, ...journals],
    // Pages of end-to-end encrypted spaces are left out (and how many).
    encryptedExcluded: encryptedCount(user),
    voice: transcriptionEnabled(),
    suggest: captureSuggestMode(user),
    maxFiles: MAX_CAPTURE_FILES,
    maxUploadMb: maxUploadMbFor(user),
  };
}

// "inbox", "journal:<id>" or a page id → the page to write to.
type Resolved = { page: Page; journal: Page | null; properties: CaptureProperty[] };
function resolveTarget(user: Identity, targetId: string, today: string, create: boolean): Resolved {
  if (targetId === "inbox") {
    const inbox = inboxTarget(user);
    if (!inbox) throw new HttpError(409, ct("Kein Eingang festgelegt. Bitte wähle, wohin.", "No inbox set. Please choose where to save."));
    targetId = inbox.id;
  }
  const access = pageAccess(user, targetId);
  if (access?.page.kind === "journal") {
    if (access.encrypted) throw new HttpError(409, ct("Für verschlüsselte Seiten nicht verfügbar.", "Not available for encrypted pages."));
    if (access.locked) throw new HttpError(423, ct("Dieses Journal ist gesperrt.", "This journal is locked."));
    if (!writableJournals(user).some((j) => j.id === access.page.id)) throw new HttpError(403, ct("Keine Berechtigung für diese Seite.", "No permission for this page."));
    if (!create) return { page: access.page, journal: access.page, properties: [] };
    const { dayId } = command(writerOf(user), { action: "journal.roll", pageId: access.page.id, date: today }, true) as { dayId: string };
    return { page: captureTarget(user, dayId).page, journal: access.page, properties: [] };
  }
  const { page } = captureTarget(user, targetId);
  return { page, journal: null, properties: page.kind === "database" ? captureProperties(user, page) : [] };
}

// ---- Preview ----

const literalSchema = z.array(z.string().max(300)).max(50).default([]);
export const previewSchema = z.object({
  targetId: z.union([z.uuid(), z.literal("inbox")]).default("inbox"),
  text: z.string().max(20_000),
  today: z.string().regex(DAY),
  literal: literalSchema,
  task: z.boolean().default(false),
  locale: z.enum(["de", "en", "fr"]).optional(),
});

export function capturePreview(user: Identity, raw: unknown) {
  const input = previewSchema.parse(raw);
  const { page, properties } = resolveTarget(user, input.targetId, input.today, false);
  const parsed = parseCapture(input.text, {
    today: input.today,
    locale: input.locale,
    literal: input.literal,
    properties,
    members: members(page.workspace_id),
    task: input.task,
  });
  return {
    target: { id: page.id, kind: page.kind },
    title: parsed.title,
    text: parsed.text,
    chips: parsed.chips.map((c) => ({ id: c.id, kind: c.kind, raw: c.raw, start: c.start, end: c.end, label: c.label, field: c.field, applies: !!c.field })),
  };
}

// ---- Saving ----

// Multipart fields arrive as text.
const flag = z.union([z.boolean(), z.string().transform((v) => v === "1" || v === "true")]);
const jsonList = z.union([literalSchema, z.string().transform((v, ctx) => {
  try {
    return literalSchema.parse(JSON.parse(v || "[]"));
  } catch {
    ctx.addIssue({ code: "custom", message: "literal" });
    return z.NEVER;
  }
})]);
export const desktopSaveSchema = z.object({
  targetId: z.union([z.uuid(), z.literal("inbox")]).default("inbox"),
  text: z.string().max(20_000).default(""),
  // The text as it is, without the shorthand.
  parse: flag.default(true),
  literal: jsonList.default([]),
  task: flag.default(false),
  // The capturing computer's day and time zone (the queue may send later).
  today: z.string().regex(DAY),
  timeZone: z.string().max(100).optional(),
  locale: z.enum(["de", "en", "fr"]).optional(),
  // A link and what its preview (GET /api/embed) said about it.
  url: z.string().trim().max(2000).optional(),
  linkTitle: z.string().trim().max(300).optional(),
  linkDescription: z.string().trim().max(500).optional(),
  linkProvider: z.string().trim().max(100).optional(),
  linkImage: z.string().trim().max(2000).optional(),
  // A record template of the target database (quick actions); "none": none.
  templateId: z.union([z.uuid(), z.literal("none")]).optional(),
  // A recording among the files: its transcript becomes the text.
  transcribe: flag.default(false),
  // Property values the person accepted from the AI suggestion (by property id).
  cells: z
    .union([
      z.record(z.string().max(200), z.unknown()),
      z.string().max(20_000).transform((v) => z.record(z.string().max(200), z.unknown()).parse(JSON.parse(v || "{}"))),
    ])
    .optional(),
});

const isHttps = (value: string | undefined) => !!value && /^https:\/\/\S+$/i.test(value);
const taskHtml = (title: string, due: string, mention: { id: string; name: string } | null) =>
  `<ul data-type="taskList"><li data-type="taskItem" data-checked="false" data-due="${due}"><p>${escaped(title)}${
    mention ? ` <span data-mention="${mention.id}" class="mention">@${escaped(mention.name)}</span>` : ""
  }</p></li></ul>`;
const paragraphs = (text: string) =>
  text
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => `<p>${escaped(p).replace(/\n/g, "<br>")}</p>`)
    .join("");
const digest = (nodes: PMNode[]) => createHash("sha256").update(JSON.stringify(nodes.map((n) => n.toJSON()))).digest("hex").slice(0, 32);

type TextFile = { name: string; html: string; text: string };
// Markdown and plain text files: their content, not a file.
function textFiles(files: UploadFile[]) {
  const texts: TextFile[] = [];
  const rest: UploadFile[] = [];
  for (const file of files) {
    const kind = /\.(md|markdown)$/i.test(file.name) || /markdown/.test(file.type) ? "markdown" : /\.txt$/i.test(file.name) || file.type === "text/plain" ? "text" : null;
    if (!kind) {
      rest.push(file);
      continue;
    }
    if (file.bytes.length > MAX_TEXT_FILE) throw new HttpError(413, ct("Textdateien bis 1 MB.", "Text files up to 1 MB."));
    const value = file.bytes.toString("utf8");
    if (value.includes("\u0000")) throw new HttpError(400, ct("Das ist keine Textdatei.", "This is not a text file."));
    texts.push({ name: file.name, text: value, html: kind === "markdown" ? markdownToHtml(value) : paragraphs(value) });
  }
  return { texts, rest };
}

export async function desktopCaptureSave(user: Identity, raw: unknown, files: UploadFile[] = []) {
  const input = desktopSaveSchema.parse(raw);
  const writer = writerOf(user);
  const { texts, rest } = textFiles(files);
  if (texts.length + rest.length > MAX_CAPTURE_FILES)
    throw new HttpError(413, ct(`Höchstens ${MAX_CAPTURE_FILES} Dateien auf einmal.`, `At most ${MAX_CAPTURE_FILES} files at once.`));
  const prepared = prepareCaptureFiles(user, rest, { audio: true });
  // A voice note: the transcript is the text; without a service (or when it
  // fails) the recording is kept on its own.
  let text = input.text.replace(/\r\n?/g, "\n");
  let transcribed: boolean | null = null;
  const recording = prepared.find((f) => f.audio);
  if (recording && input.transcribe && transcriptionEnabled()) {
    try {
      const transcript = (await transcribe(new Blob([new Uint8Array(recording.content)], { type: recording.mime }), recording.name)).text.trim();
      if (transcript) text = text.trim() ? `${text.trim()}\n\n${transcript}` : transcript;
      transcribed = true;
    } catch {
      transcribed = false;
    }
  }
  const link = isHttps(input.url) || /^http:\/\/\S+$/i.test(input.url || "") ? input.url! : "";
  if (!text.trim() && !link && !prepared.length && !texts.length) throw new HttpError(400, ct("Nichts zum Speichern.", "Nothing to save."));
  const size = prepared.reduce((sum, f) => sum + f.content.length, 0);

  let publish: () => void = () => {};
  const result = transaction(() => {
    const { page, journal, properties } = resolveTarget(user, input.targetId, input.today, true);
    if (size) {
      enforceQuota(page.workspace_id, size);
      enforceUserStorage(user, size);
    }
    const parsed = input.parse
      ? parseCapture(text, { today: input.today, locale: input.locale, literal: input.literal, properties, members: members(page.workspace_id), task: input.task })
      : { chips: [], cells: {}, title: text.trim().split("\n")[0].trim().slice(0, 300), text: text.trim().split("\n").slice(1).join("\n").trim(), due: undefined, assignee: undefined };
    // Times as the instant they mean in the capturing computer's zone.
    const zone = input.timeZone && validZone(input.timeZone) ? input.timeZone : null;
    const cells: Record<string, unknown> = {};
    // Accepted suggestions first; what the text itself says wins.
    for (const [key, value] of Object.entries(input.cells || {}).slice(0, 30)) if (properties.some((p) => p.id === key && p.type !== "files")) cells[key] = value;
    for (const [key, value] of Object.entries(parsed.cells)) {
      if (typeof value === "string" && /T\d{2}:\d{2}$/.test(value)) {
        try {
          cells[key] = zone ? localToInstant(value, zone, "earlier") : value.slice(0, 10);
        } catch {
          cells[key] = value.slice(0, 10);
        }
      } else cells[key] = value;
    }
    const title =
      parsed.title ||
      input.linkTitle ||
      (link ? new URL(link).hostname : "") ||
      texts[0]?.name.replace(/\.[a-z0-9]+$/i, "") ||
      (recording ? ct("Sprachnotiz", "Voice note") : prepared[0]?.name.replace(/\.[a-z0-9]+$/i, "")) ||
      ct("Notiz", "Note");
    const body = parsed.text;
    const people = members(page.workspace_id);
    const assignee = parsed.assignee ? people.find((m) => m.id === parsed.assignee) || null : null;
    // The task's day: the parsed date (of the page, or the record's date property), else today.
    const dateCell = properties.find((p) => p.type === "date" && typeof parsed.cells[p.id] === "string");
    const due = parsed.due || (dateCell ? String(parsed.cells[dateCell.id]).slice(0, 10) : input.today);
    const me = people.find((m) => m.id === user.id);
    const card =
      link && isHttps(link) && input.linkTitle
        ? `<div data-link-card="${escaped(link)}" data-link-title="${escaped(input.linkTitle)}" data-link-provider="${escaped(input.linkProvider || new URL(link).hostname)}" data-link-description="${escaped(input.linkDescription || "")}" data-link-image="${isHttps(input.linkImage) ? escaped(input.linkImage!) : ""}"></div>`
        : "";
    const extraHtml = texts.map((t) => t.html).join("");

    if (page.kind === "database") {
      storeCaptureFiles(user, prepared, page.id);
      const article = [
        input.task ? taskHtml(title, due, assignee || (me ? { id: me.id, name: me.name } : null)) : "",
        input.task ? paragraphs(body) : "",
        card,
        extraHtml,
        mediaHtml(prepared),
      ].join("");
      const created = command(
        writer,
        {
          action: "capture.record",
          pageId: page.id,
          title,
          text: input.task ? "" : body,
          url: link || undefined,
          article: article || undefined,
          ...(input.templateId ? { templateId: input.templateId === "none" ? null : input.templateId } : {}),
        },
        true,
      ) as { rowId: string };
      const filesField = visibleFields(user, page, JSON.parse(one<{ fields: string }>("SELECT fields FROM databases WHERE page_id=?", page.id)!.fields) as Field[]).find(
        (f) => f.type === "files" && !f.access?.write,
      );
      const patch = { ...cells, ...(filesField && prepared.length ? { [filesField.id]: prepared.map((f) => f.url) } : {}) };
      if (Object.keys(patch).length) {
        const version = one<{ version: number }>("SELECT version FROM rows WHERE id=?", created.rowId)!.version;
        command(writer, { action: "row.update", pageId: page.id, rowId: created.rowId, version, cells: patch }, true);
      }
      return { kind: "record" as const, pageId: page.id, rowId: created.rowId, url: url(page.id, created.rowId), title, target: page.title };
    }

    // A page or today's journal entry: the content appended as blocks.
    storeCaptureFiles(user, prepared, page.id);
    const schema = rewriteSchema();
    const html = cleanHtml(
      [
        input.task ? taskHtml(title, due, assignee) : paragraphs([title, body].filter(Boolean).join("\n\n")),
        input.task ? paragraphs(body) : "",
        card,
        !card && link ? `<p><a href="${escaped(link)}">${escaped(link)}</a></p>` : "",
        extraHtml,
      ].join(""),
    );
    const nodes: PMNode[] = [...htmlNodes(html, schema), ...contentNodes("", "", prepared)];
    const changed = rewriteDocument(page.id, null, writer.id, (doc) => doc.type.create(doc.attrs, doc.content.append(Fragment.fromArray(nodes)), doc.marks));
    if (changed) {
      publish = changed.publish;
      if (input.task) syncDocTasks(writer, page, null, changed.ydoc);
    }
    recordPageEdit(writer, page.id);
    return {
      kind: "append" as const,
      pageId: page.id,
      url: url(page.id),
      title,
      target: journal ? journal.title : page.title,
      undo: { blocks: nodes.length, digest: digest(nodes) },
    };
  }, writer);
  publish();
  return { ok: true, ...result, transcribed, files: prepared.map((f) => f.url), at: Date.now() };
}

// Sanitized HTML as top-level nodes of the document schema.
function htmlNodes(html: string, schema: ReturnType<typeof rewriteSchema>): PMNode[] {
  if (!html) return [];
  const json = generateJSON(html, documentExtensions) as { content?: Record<string, unknown>[] };
  return (json.content || []).map((node) => schema.nodeFromJSON(node));
}

// ---- Undo ----

export const undoSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("record"), pageId: z.uuid(), rowId: z.uuid() }),
  z.object({ kind: z.literal("append"), pageId: z.uuid(), blocks: z.number().int().min(1).max(200), digest: z.string().regex(/^[a-f0-9]{32}$/) }),
]);

// A record goes to the trash (row.delete – "Rückgängig" in the trash brings
// it back); appended blocks are removed while they are still the last ones,
// unchanged. Anything edited since stays.
export function captureUndo(user: Identity, raw: unknown) {
  const input = undoSchema.parse(raw);
  const writer = writerOf(user);
  if (input.kind === "record") {
    const { page } = captureTarget(user, input.pageId);
    const row = one<{ created_by: string; created_at: string }>("SELECT created_by,created_at FROM rows WHERE id=? AND page_id=?", input.rowId, page.id);
    if (!row) return { undone: false, reason: "gone" as const };
    if (row.created_by !== user.id) throw new HttpError(403, ct("Nur eigene Einträge.", "Only your own records."));
    command(writer, { action: "row.delete", pageId: page.id, rowId: input.rowId });
    return { undone: true };
  }
  const { page } = captureTarget(user, input.pageId);
  let undone = false;
  let publish: () => void = () => {};
  transaction(() => {
    const changed = rewriteDocument(page.id, null, writer.id, (doc) => {
      if (doc.childCount < input.blocks) return null;
      const tail: PMNode[] = [];
      for (let i = doc.childCount - input.blocks; i < doc.childCount; i++) tail.push(doc.child(i));
      if (digest(tail) !== input.digest) return null;
      const kept: PMNode[] = [];
      for (let i = 0; i < doc.childCount - input.blocks; i++) kept.push(doc.child(i));
      // A document keeps at least an empty paragraph.
      if (!kept.length) kept.push(rewriteSchema().nodes.paragraph.create());
      undone = true;
      return doc.type.create(doc.attrs, Fragment.fromArray(kept), doc.marks);
    });
    if (changed) {
      publish = changed.publish;
      syncDocTasks(writer, page, null, changed.ydoc);
      recordPageEdit(writer, page.id);
    }
  }, writer);
  publish();
  return undone ? { undone: true } : { undone: false, reason: "changed" as const };
}

export type { Prepared };
