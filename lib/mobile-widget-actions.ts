// What widgets, Live Activities and Shortcuts of the mobile apps do
// (POST /api/mobile/widgets/action, lib/mobile-widgets.ts). Every action
// goes through the command of the web app where one exists (lib/api.ts
// command()), so permissions, locks, versions, the activity log, webhooks,
// automations and notifications behave exactly as after a click in the
// browser. The device token gets writing rights only for these actions.
import { mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import { Fragment } from "@tiptap/pm/model";
import { audit, id, one, onTransactionRollback, run, transaction } from "./db";
import { HttpError } from "./auth";
import { command } from "./api";
import { ct } from "./content-locale";
import { doneRule } from "./database-settings-schema";
import { cleanHtml, escaped, htmlState } from "./document-server";
import { rewriteDocument, rewriteSchema } from "./document-rewrite";
import { indexPageTasks, syncDocTasks } from "./doc-tasks";
import { enforceQuota } from "./instance-ops";
import { dayTitle } from "./journal";
import { recordPageEdit } from "./page-activity";
import { requirePage } from "./permissions";
import { requireRow } from "./row-documents";
import { transcribe, transcriptionEnabled } from "./transcribe";
import { sanitizeFileName, stripLocation, verifiedMime } from "./upload-safety";
import { enforceUserStorage, maxUploadMbFor } from "./user-limits";
import { visibleFields } from "./field-access";
import {
  ensureWidgetTables,
  finishFocus,
  focusRow,
  focusState,
  habitDay,
  pageAccess,
  runningTimer,
  writableJournals,
  writerOf,
} from "./mobile-widgets";
import type { Field, Identity, Page } from "./types";
import { actionSchemas, widgetActions } from "./mobile-widget-schema";
import { markLiveActivity } from "./live-activity-queue";

export { actionSchemas, widgetActions, type WidgetAction } from "./mobile-widget-schema";
const url = (pageId: string, rowId?: string | null) => `/#page=${pageId}${rowId ? `&row=${rowId}` : ""}`;
const rank: Record<string, number> = { viewer: 1, editor: 2, owner: 3 };
const fieldsOf = (pageId: string) => JSON.parse(one<{ fields: string }>("SELECT fields FROM databases WHERE page_id=?", pageId)?.fields || "[]") as Field[];

// ---- Capture ----

// A target the person may add to: readable for writing, not read-only, not
// behind a PIN, not end-to-end encrypted (the server would see plaintext).
export function captureTarget(user: Identity, pageId: string) {
  const access = pageAccess(user, pageId);
  if (!access) throw new HttpError(404, ct("Seite nicht gefunden.", "Page not found."));
  if (access.encrypted) throw new HttpError(409, ct("Für verschlüsselte Seiten nicht verfügbar.", "Not available for encrypted pages."));
  if (access.locked) throw new HttpError(423, ct("Dieses Journal ist gesperrt.", "This journal is locked."));
  if (rank[access.role] < 2) throw new HttpError(403, ct("Keine Berechtigung für diese Seite.", "No permission for this page."));
  if (access.page.locked) throw new HttpError(409, ct("Diese Seite ist gesperrt.", "This page is locked."));
  if (access.page.kind !== "database" && access.page.kind !== "document")
    throw new HttpError(400, ct("Hierhin kann nicht erfasst werden.", "Cannot capture here."));
  return access;
}
const textHtml = (text: string) =>
  text
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => `<p>${escaped(p).replace(/\n/g, "<br>")}</p>`)
    .join("");

// The first date property the person may write: where a due date goes.
function dueField(user: Identity, page: Page) {
  return visibleFields(user, page, fieldsOf(page.id)).find((f) => f.type === "date" && !f.access?.write);
}

// A sub page of a document with the given content (inside a transaction).
export function subPage(writer: Identity, target: Page, title: string, html: string) {
  const created = command(
    writer,
    { action: "page.create", workspaceId: target.workspace_id, spaceId: target.space_id, parentId: target.id, title: title.slice(0, 300), kind: "document" },
    true,
  ) as { id: string };
  if (html) {
    const safe = cleanHtml(html);
    run("UPDATE documents SET html=?,state=? WHERE page_id=?", safe, htmlState(safe), created.id);
    indexPageTasks(created.id, false);
  }
  return created.id;
}

// A task at the end of a document, as if typed there.
function appendTask(writer: Identity, page: Page, text: string, due?: string) {
  const node = rewriteSchema().nodeFromJSON({
    type: "taskList",
    content: [{ type: "taskItem", attrs: { checked: false, ...(due ? { due } : {}) }, content: [{ type: "paragraph", content: [{ type: "text", text }] }] }],
  });
  const result = rewriteDocument(page.id, null, writer.id, (doc) => doc.type.create(doc.attrs, doc.content.append(Fragment.from(node)), doc.marks))!;
  syncDocTasks(writer, page, null, result.ydoc);
  recordPageEdit(writer, page.id);
  audit(writer.id, "task.create", page.id);
  return result.publish;
}

function captureText(user: Identity, action: "capture.note" | "capture.task", input: z.infer<(typeof actionSchemas)["capture.note"]>) {
  const writer = writerOf(user);
  const { page } = captureTarget(user, input.targetId);
  if (page.kind === "database") {
    return transaction(() => {
      const created = command(writer, { action: "capture.record", pageId: page.id, title: input.title, text: input.text || "" }, true) as { rowId: string };
      const due = input.due ? dueField(user, page) : undefined;
      if (input.due && due) {
        const version = one<{ version: number }>("SELECT version FROM rows WHERE id=?", created.rowId)!.version;
        command(writer, { action: "row.update", pageId: page.id, rowId: created.rowId, version, cells: { [due.id]: input.due } }, true);
      }
      return { pageId: page.id, rowId: created.rowId, url: url(page.id, created.rowId) };
    }, writer);
  }
  if (action === "capture.task") {
    // The text of a task is its first line; more text becomes a sub page.
    requirePage(writer, page.id, true);
    let publish: () => void = () => {};
    transaction(() => {
      publish = appendTask(writer, page, input.title.replace(/\s+/g, " ").slice(0, 500), input.due);
    }, writer);
    publish();
    return { pageId: page.id, url: url(page.id) };
  }
  const pageId = transaction(() => subPage(writer, page, input.title, textHtml(input.text || "")), writer);
  return { pageId, url: url(pageId) };
}

export type UploadFile = { name: string; type: string; bytes: Buffer };
async function captureUpload(user: Identity, input: z.infer<(typeof actionSchemas)["capture.upload"]>, file: UploadFile | null) {
  if (!file || !file.bytes.length) throw new HttpError(400, ct("Datei fehlt.", "File missing."));
  const writer = writerOf(user);
  const { page } = captureTarget(user, input.targetId);
  const maxMb = maxUploadMbFor(user);
  if (file.bytes.length > maxMb * 1024 * 1024) throw new HttpError(413, ct(`Maximal ${maxMb} MB pro Datei.`, `At most ${maxMb} MB per file.`));
  const mime = verifiedMime(file.type, file.bytes);
  if (input.type === "photo" ? !/^image\/(png|jpeg|gif|webp|avif|heic|heif)$/.test(mime) : !/^audio\//.test(mime))
    throw new HttpError(400, input.type === "photo" ? ct("Bitte ein Foto senden.", "Please send a photo.") : ct("Bitte eine Sprachnotiz senden.", "Please send a voice memo."));
  enforceQuota(page.workspace_id, file.bytes.length);
  enforceUserStorage(user, file.bytes.length);
  const content = input.type === "photo" ? stripLocation(file.bytes, mime) : file.bytes;
  const name = sanitizeFileName(file.name || (input.type === "photo" ? "foto.jpg" : "sprachnotiz.m4a"));
  // Voice memos become text where the instance has a transcription service;
  // without one (or when it fails) the recording is kept on its own.
  let transcript = "";
  let transcribed: boolean | null = null;
  if (input.type === "voice" && input.transcribe && transcriptionEnabled()) {
    try {
      transcript = (await transcribe(new Blob([new Uint8Array(content)], { type: mime }), name)).text;
      transcribed = true;
    } catch {
      transcribed = false;
    }
  }
  const title =
    input.title ||
    transcript.split(/(?<=[.!?])\s/)[0]?.slice(0, 120) ||
    (input.type === "photo" ? ct("Foto", "Photo") : ct("Sprachnotiz", "Voice memo"));
  const dir = resolve(process.env.FLOWPLAN_DATA_DIR || "./data", "uploads");
  mkdirSync(dir, { recursive: true });
  const fileId = id();
  const fileUrl = `/api/files/${fileId}`;
  const media = input.type === "photo" ? `<p><img src="${fileUrl}" alt="${escaped(name)}"></p>` : `<audio src="${fileUrl}" controls></audio>`;
  const result = transaction(() => {
    const store = (ownerId: string) => {
      const path = resolve(dir, fileId);
      writeFileSync(path, content);
      onTransactionRollback(() => unlinkSync(path));
      run("INSERT INTO files(id,page_id,name,mime,size,created_by) VALUES(?,?,?,?,?,?)", fileId, ownerId, name, mime, content.length, user.id);
      audit(user.id, "file.upload", ownerId, name);
    };
    if (page.kind === "database") {
      // Files of records belong to their database (like e-mail capture).
      store(page.id);
      const created = command(writer, { action: "capture.record", pageId: page.id, title, text: transcript, article: media }, true) as { rowId: string };
      const filesField = visibleFields(user, page, fieldsOf(page.id)).find((f) => f.type === "files" && !f.access?.write);
      if (filesField) {
        const version = one<{ version: number }>("SELECT version FROM rows WHERE id=?", created.rowId)!.version;
        command(writer, { action: "row.update", pageId: page.id, rowId: created.rowId, version, cells: { [filesField.id]: [fileUrl] } }, true);
      }
      return { pageId: page.id, rowId: created.rowId, url: url(page.id, created.rowId) };
    }
    const pageId = subPage(writer, page, title, "");
    store(pageId);
    const html = cleanHtml(media + textHtml(transcript));
    run("UPDATE documents SET html=?,state=? WHERE page_id=?", html, htmlState(html), pageId);
    return { pageId, url: url(pageId) };
  }, writer);
  return { ...result, file: fileUrl, transcribed, ...(transcript ? { text: transcript.slice(0, 500) } : {}) };
}

// "Share" from another app: text, a link and files at once. Photos and PDFs
// only (what the share targets of the apps accept); a database gets a record
// (files in its files property when it has one), a document a sub page.
export const SHARE_MAX_FILES = 10;
const SHARE_TYPES = /^(image\/(png|jpeg|gif|webp|avif|heic|heif)|application\/pdf)$/;
async function captureShare(user: Identity, input: z.infer<(typeof actionSchemas)["capture.share"]>, files: UploadFile[]) {
  const text = (input.text || "").trim();
  // Apps often put the link into the text as well (or only there).
  const link = /^https?:\/\/\S+$/i.test(input.url || "") ? input.url! : text.match(/https?:\/\/\S+/)?.[0] || "";
  if (!text && !link && !files.length && !input.title)
    throw new HttpError(400, ct("Es wurde nichts geteilt.", "Nothing was shared."));
  if (files.length > SHARE_MAX_FILES)
    throw new HttpError(413, ct(`Höchstens ${SHARE_MAX_FILES} Dateien auf einmal.`, `At most ${SHARE_MAX_FILES} files at once.`));
  const writer = writerOf(user);
  const { page } = captureTarget(user, input.targetId);
  const maxMb = maxUploadMbFor(user);
  const kept = files.map((file) => {
    if (!file.bytes.length) throw new HttpError(400, ct("Datei fehlt.", "File missing."));
    if (file.bytes.length > maxMb * 1024 * 1024) throw new HttpError(413, ct(`Maximal ${maxMb} MB pro Datei.`, `At most ${maxMb} MB per file.`));
    const mime = verifiedMime(file.type, file.bytes);
    if (!SHARE_TYPES.test(mime)) throw new HttpError(400, ct("Nur Fotos und PDFs können geteilt werden.", "Only photos and PDFs can be shared."));
    const pdf = mime === "application/pdf";
    return { name: sanitizeFileName(file.name || (pdf ? "dokument.pdf" : "foto.jpg")), mime, bytes: pdf ? file.bytes : stripLocation(file.bytes, mime) };
  });
  const total = kept.reduce((sum, file) => sum + file.bytes.length, 0);
  if (total) {
    enforceQuota(page.workspace_id, total);
    enforceUserStorage(user, total);
  }
  const title = (
    input.title ||
    text.replace(link, "").trim().split("\n")[0].trim().slice(0, 120) ||
    (link ? new URL(link).hostname : "") ||
    kept[0]?.name ||
    ct("Geteilt", "Shared")
  ).slice(0, 300);
  const dir = resolve(process.env.FLOWPLAN_DATA_DIR || "./data", "uploads");
  if (kept.length) mkdirSync(dir, { recursive: true });
  const stored = kept.map((file) => {
    const fileId = id();
    return { ...file, id: fileId, url: `/api/files/${fileId}` };
  });
  // Photos show in the text, PDFs as a preview of their first page.
  const media = stored
    .map((file) =>
      file.mime === "application/pdf"
        ? `<div data-pdf="${file.url}" data-title="${escaped(file.name)}"><a href="${file.url}">${escaped(file.name)}</a></div>`
        : `<p><img src="${file.url}" alt="${escaped(file.name)}"></p>`,
    )
    .join("");
  const result = transaction(() => {
    const store = (ownerId: string) => {
      for (const file of stored) {
        const path = resolve(dir, file.id);
        writeFileSync(path, file.bytes);
        onTransactionRollback(() => unlinkSync(path));
        run("INSERT INTO files(id,page_id,name,mime,size,created_by) VALUES(?,?,?,?,?,?)", file.id, ownerId, file.name, file.mime, file.bytes.length, user.id);
        audit(user.id, "file.upload", ownerId, file.name);
      }
    };
    if (page.kind === "database") {
      store(page.id);
      const created = command(
        writer,
        { action: "capture.record", pageId: page.id, title, text, url: link, ...(media ? { article: media } : {}) },
        true,
      ) as { rowId: string };
      const filesField = visibleFields(user, page, fieldsOf(page.id)).find((f) => f.type === "files" && !f.access?.write);
      if (filesField && stored.length) {
        const version = one<{ version: number }>("SELECT version FROM rows WHERE id=?", created.rowId)!.version;
        command(writer, { action: "row.update", pageId: page.id, rowId: created.rowId, version, cells: { [filesField.id]: stored.map((f) => f.url) } }, true);
      }
      return { pageId: page.id, rowId: created.rowId, url: url(page.id, created.rowId) };
    }
    const body = text.replace(link, "").trim();
    const pageId = subPage(writer, page, title, "");
    store(pageId);
    const html = cleanHtml(textHtml(body) + (link ? `<p><a href="${escaped(link)}">${escaped(link)}</a></p>` : "") + media);
    run("UPDATE documents SET html=?,state=? WHERE page_id=?", html, htmlState(html), pageId);
    return { pageId, url: url(pageId) };
  }, writer);
  return { ...result, files: stored.map((file) => file.url) };
}

// ---- Tasks and habits ----

function completeTask(user: Identity, input: z.infer<(typeof actionSchemas)["task.complete"]>) {
  const writer = writerOf(user);
  if (input.source === "doc") {
    if (input.index === undefined || (input.key === undefined && input.text === undefined)) throw new HttpError(400, ct("Ungültige Anfrage.", "Invalid request."));
    const identity = input.key !== undefined ? { key: input.key } : { text: input.text };
    command(writer, { action: "task.update", pageId: input.pageId, rowId: input.rowId || null, index: input.index, ...identity, checked: input.done });
    return { done: input.done };
  }
  if (!input.rowId) throw new HttpError(400, ct("Ungültige Anfrage.", "Invalid request."));
  const { page, row } = requireRow(writer, input.pageId, input.rowId, true);
  const raw = one<{ fields: string; settings: string | null }>("SELECT fields,settings FROM databases WHERE page_id=?", page.id)!;
  const fields = JSON.parse(raw.fields) as Field[];
  const rule = doneRule(fields, raw.settings ? JSON.parse(raw.settings) : undefined);
  if (!rule || !visibleFields(user, page, fields).includes(rule.field))
    throw new HttpError(400, ct("Diese Datenbank kennt kein „Erledigt“.", "This database has no “done” state."));
  const value =
    rule.field.type === "checkbox"
      ? input.done
      : input.done
        ? rule.values[0]
        : (rule.field.options || []).find((o) => !rule.values.includes(o)) || "";
  command(writer, { action: "row.update", pageId: page.id, rowId: row.id, version: row.version, cells: { [rule.field.id]: value } });
  return { done: input.done };
}

function checkHabit(user: Identity, input: z.infer<(typeof actionSchemas)["habit.check"]>) {
  const writer = writerOf(user);
  const page = requirePage(writer, input.pageId, true);
  const { fields, checks, dateField, row } = habitDay(user, page, input.today);
  const field = checks.find((f) => f.id === input.fieldId);
  if (!field || !dateField) throw new HttpError(400, ct("Eigenschaft fehlt.", "Property missing."));
  if (row) {
    const version = one<{ version: number }>("SELECT version FROM rows WHERE id=?", row.id)!.version;
    command(writer, { action: "row.update", pageId: page.id, rowId: row.id, version, cells: { [field.id]: input.done } });
    return { rowId: row.id, done: input.done };
  }
  const title = fields[0] && fields[0].type === "text" ? { [fields[0].id]: dayTitle(input.today) } : {};
  const created = command(writer, { action: "row.create", pageId: page.id, cells: { ...title, [dateField.id]: input.today, [field.id]: input.done } }) as { id: string };
  return { rowId: created.id, done: input.done };
}

function trackJournal(user: Identity, input: z.infer<(typeof actionSchemas)["journal.track"]>) {
  const writer = writerOf(user);
  const { dayId } = command(writer, { action: "journal.roll", pageId: input.journalId, date: input.today, write: true }) as { dayId: string };
  const entry = command(writer, { action: "journal.entry", pageId: dayId, entry: { values: { [input.trackerId]: input.value } } }) as { values: Record<string, unknown> };
  return { dayId, value: entry.values[input.trackerId] ?? null };
}

// ---- Timer and focus ----

function startTimer(user: Identity, input: z.infer<(typeof actionSchemas)["timer.start"]>) {
  command(writerOf(user), { action: "time.start", ...input });
  return { timer: runningTimer(user) };
}
function stopTimer(user: Identity) {
  const running = one<{ page_id: string; row_id: string; field_id: string }>(
    "SELECT page_id,row_id,field_id FROM time_entries WHERE user_id=? AND end IS NULL ORDER BY start DESC LIMIT 1",
    user.id,
  );
  if (running) command(writerOf(user), { action: "time.stop", pageId: running.page_id, rowId: running.row_id, fieldId: running.field_id });
  // A focus session ends with its timer.
  ensureWidgetTables();
  if (run("DELETE FROM widget_focus WHERE user_id=?", user.id).changes) markLiveActivity(user.id, "focus");
  return { timer: null };
}

function startFocus(user: Identity, input: z.infer<(typeof actionSchemas)["focus.start"]>, now = Date.now()) {
  ensureWidgetTables();
  finishFocus(user, now);
  const target = input.pageId && input.rowId && input.fieldId ? { pageId: input.pageId, rowId: input.rowId, fieldId: input.fieldId } : null;
  if ((input.pageId || input.rowId || input.fieldId) && !target) throw new HttpError(400, ct("Ungültige Anfrage.", "Invalid request."));
  // Time is recorded like with the timer (one running timer per person).
  if (target) command(writerOf(user), { action: "time.start", ...target });
  run(
    `INSERT INTO widget_focus(user_id,started_at,focus_ms,break_ms,page_id,row_id,field_id,timer,stopped_at) VALUES(?,?,?,?,?,?,?,?,NULL)
     ON CONFLICT(user_id) DO UPDATE SET started_at=excluded.started_at,focus_ms=excluded.focus_ms,break_ms=excluded.break_ms,
       page_id=excluded.page_id,row_id=excluded.row_id,field_id=excluded.field_id,timer=excluded.timer,stopped_at=NULL`,
    user.id,
    now,
    input.minutes * 60_000,
    input.breakMinutes * 60_000,
    target?.pageId ?? null,
    target?.rowId ?? null,
    target?.fieldId ?? null,
    target ? 1 : 0,
  );
  // The focus Live Activity: now, and again when the focus time and the
  // break are over (lib/live-activity-push.ts).
  const focusEnd = now + input.minutes * 60_000;
  markLiveActivity(user.id, "focus", [now, focusEnd + 1000, focusEnd + input.breakMinutes * 60_000 + 1000]);
  return focusState(user, now);
}
function stopFocus(user: Identity, now = Date.now()) {
  finishFocus(user, now);
  const focus = focusRow(user);
  if (focus && !focus.stopped_at) {
    const running = one<{ row_id: string }>("SELECT row_id FROM time_entries WHERE user_id=? AND end IS NULL", user.id);
    if (focus.timer && running && running.row_id === focus.row_id)
      command(writerOf(user), { action: "time.stop", pageId: focus.page_id, rowId: focus.row_id, fieldId: focus.field_id });
  }
  // Also ends a running break.
  if (run("DELETE FROM widget_focus WHERE user_id=?", user.id).changes) markLiveActivity(user.id, "focus", [now]);
  return focusState(user, now);
}

// ---- Mentions ----

function readMention(user: Identity, input: z.infer<(typeof actionSchemas)["mention.read"]>) {
  if (!one("SELECT 1 FROM notifications WHERE id=? AND user_id=? AND kind='mention'", input.notificationId, user.id))
    throw new HttpError(404, ct("Benachrichtigung nicht gefunden.", "Notification not found."));
  command(writerOf(user), { action: "notification.mark", notificationId: input.notificationId, read: input.read });
  return { read: input.read };
}
function readAllMentions(user: Identity) {
  const changed = run(
    "UPDATE notifications SET read_at=? WHERE user_id=? AND kind='mention' AND read_at IS NULL",
    new Date().toISOString().replace("T", " ").slice(0, 19),
    user.id,
  ).changes;
  return { changed: Number(changed) };
}

// ---- Meeting notes ----

function meetingNote(user: Identity, input: z.infer<(typeof actionSchemas)["meeting.note"]>) {
  const writer = writerOf(user);
  const { page } = requireRow(user, input.pageId, input.rowId);
  const journals = writableJournals(user, page.workspace_id);
  const journal = input.journalId ? journals.find((j) => j.id === input.journalId) : journals.find((j) => j.created_by === user.id) || journals[0];
  if (!journal) throw new HttpError(404, ct("Kein Journal, in dem die Notiz entstehen kann.", "No journal to create the note in."));
  const { dayId } = command(writer, { action: "journal.roll", pageId: journal.id, date: input.date, write: true }) as { dayId: string };
  const note = command(writer, {
    action: "meeting.note",
    pageId: dayId,
    zone: input.zone,
    event: { title: "", start: input.start, end: input.end, timed: input.timed, pageId: page.id, rowId: input.rowId },
  }) as { id: string; existing: boolean };
  return { noteId: note.id, existing: note.existing, url: url(note.id) };
}

// ---- Dispatch ----

export async function widgetAction(
  user: Identity,
  input: unknown,
  file: UploadFile | null = null,
  files: UploadFile[] = file ? [file] : [],
): Promise<Record<string, unknown>> {
  const { action } = z.object({ action: z.enum(widgetActions) }).passthrough().parse(input);
  const body = actionSchemas[action].parse(input) as never;
  let result: Record<string, unknown>;
  switch (action) {
    case "capture.note":
    case "capture.task":
      result = captureText(user, action, body);
      break;
    case "capture.upload":
      result = await captureUpload(user, body, file);
      break;
    case "capture.share":
      result = await captureShare(user, body, files);
      break;
    case "task.complete":
      result = completeTask(user, body);
      break;
    case "habit.check":
      result = checkHabit(user, body);
      break;
    case "journal.track":
      result = trackJournal(user, body);
      break;
    case "timer.start":
      result = startTimer(user, body);
      break;
    case "timer.stop":
      result = stopTimer(user);
      break;
    case "focus.start":
      result = { focus: startFocus(user, body) };
      break;
    case "focus.stop":
      result = { focus: stopFocus(user) };
      break;
    case "mention.read":
      result = readMention(user, body);
      break;
    case "mention.readAll":
      result = readAllMentions(user);
      break;
    case "meeting.note":
      result = meetingNote(user, body);
      break;
  }
  return { ok: true, action, ...result };
}
