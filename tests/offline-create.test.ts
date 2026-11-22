import { test } from "node:test";
import assert from "node:assert/strict";
import {
  OFFLINE_UPLOAD_MAX,
  OFFLINE_UPLOADS_TOTAL,
  afterCreate,
  createCommand,
  discardPage,
  failChange,
  failedPageOf,
  localPageChange,
  offlineTemplate,
  pageChange,
  pendingPageIds,
  pendingRows,
  renamePending,
  retryFailed,
  uploadRoom,
  withLocalPages,
  type FailedChange,
} from "../lib/offline-create";
import { localDatabase } from "../lib/offline-local-database";
import { applyQueue, type OfflinePageChange, type QueuedChange } from "../lib/offline-queue";
import { templateCatalog } from "../lib/template-catalog";
import { databaseSetup } from "../lib/database-setup";
import type { Page } from "../lib/types";

// Issue #370: pages, databases, whiteboards, notebooks, pages from a
// template and uploads made offline wait in the ordered offline queue.
let n = 0;
const newId = () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
const de = (de: string) => de;
const page = (id: string, kind: OfflinePageChange["pageKind"] = "document", parentId: string | null = null, extra: Partial<Parameters<typeof pageChange>[0]> = {}) =>
  pageChange({ id, workspaceId: "w", spaceId: "s", parentId, kind, title: `Seite ${id}`, newId, key: `key-${id}`, at: 1000 + n, ...extra });
const record = (pageId: string, rowId = newId()): QueuedChange => ({ id: newId(), kind: "create", pageId, rowId, cells: { title: "Eintrag" }, at: 0 });
const upload = (pageId: string, size = 1000, fileId = newId()): QueuedChange => ({ id: newId(), kind: "upload", pageId, fileId, name: "bild.png", type: "image/png", size, at: 0 });

test("a page made offline becomes the create command with its own id", () => {
  const doc = page("p1");
  assert.equal(doc.kind, "page");
  assert.equal(doc.icon, "file");
  assert.deepEqual(createCommand(doc, false), { action: "page.create", workspaceId: "w", spaceId: "s", parentId: null, title: "Seite p1", kind: "document", pageId: "p1" });
  assert.equal(afterCreate(doc, true), null);
  const db = page("p2", "database", null, { databaseKind: "contacts" });
  assert.equal(createCommand(db, false).databaseKind, "contacts");
  // An unknown kind of database starts as tasks, like on the server.
  assert.equal(page("p3", "database", null, { databaseKind: "nonsense" }).databaseKind, "tasks");
  const board = page("p4", "whiteboard");
  assert.equal(board.icon, "whiteboard");
  const notebook = page("p5", "notebook");
  assert.ok(notebook.sheetId);
  assert.equal(createCommand(notebook, false).sheetId, notebook.sheetId);
});

test("templates: a document's text is sent as written, a database brings its record ids", () => {
  const meeting = page("t1", "document", null, { starter: { key: "meeting", template: templateCatalog.meeting } });
  assert.equal(meeting.icon, templateCatalog.meeting.icon);
  // Nothing written on the device: the server applies the template.
  assert.equal(createCommand(meeting, false).starterTemplate, "meeting");
  // Written on: the content holds the template's text; the template's icon follows.
  assert.equal(createCommand(meeting, true).starterTemplate, undefined);
  assert.deepEqual(afterCreate(meeting, true), { action: "page.update", pageId: "t1", patch: { icon: templateCatalog.meeting.icon } });
  const project = page("t2", "document", null, { starter: { key: "project", template: templateCatalog.project } });
  assert.equal(project.pageKind, "database");
  assert.equal(project.rowIds?.length, templateCatalog.project.rows?.length);
  assert.deepEqual(createCommand(project, false).rowIds, project.rowIds);
  const shown = localDatabase(project, de, templateCatalog.project);
  assert.deepEqual(shown.rows.map((r) => r.id), project.rowIds);
  assert.deepEqual(shown.fields, templateCatalog.project.fields);
  // Not offline: surveys, the shortcut cards, draw.io pages.
  assert.equal(offlineTemplate("survey", templateCatalog.survey), false);
  assert.equal(offlineTemplate("shortcuts", templateCatalog.shortcuts), false);
  assert.equal(offlineTemplate("diagram", templateCatalog.diagram), false);
  assert.equal(offlineTemplate("meeting", templateCatalog.meeting), true);
  assert.equal(offlineTemplate("nope", undefined), false);
});

test("a database made offline shows the fields the server will create", () => {
  for (const kind of ["tasks", "documents", "contacts", "empty", "flashcards"]) {
    const db = page(`d-${kind}`, "database", null, { databaseKind: kind });
    const shown = localDatabase(db, de);
    assert.deepEqual(shown.fields.map((f) => f.id), databaseSetup(kind as never, de).fields.map((f) => f.id));
    assert.deepEqual(shown.rows, []);
  }
});

test("uploads wait up to 25 MB per file and 200 MB in all", () => {
  assert.equal(uploadRoom([], [], OFFLINE_UPLOAD_MAX), "ok");
  assert.equal(uploadRoom([], [], OFFLINE_UPLOAD_MAX + 1), "file");
  const queue = Array.from({ length: 7 }, () => upload("p", OFFLINE_UPLOAD_MAX));
  assert.equal(uploadRoom(queue, [], OFFLINE_UPLOADS_TOTAL - 7 * OFFLINE_UPLOAD_MAX), "ok");
  assert.equal(uploadRoom([...queue, upload("p", OFFLINE_UPLOAD_MAX - 10)], [], 11), "total");
  // Failed uploads keep their blobs and count too.
  const failed: FailedChange[] = [{ change: upload("p", OFFLINE_UPLOAD_MAX), reason: "x", at: 0 }];
  assert.equal(uploadRoom(queue, failed, OFFLINE_UPLOAD_MAX), "total");
});

test("a refused page takes along what depends on it, in order; the rest stays", () => {
  const db = page("db", "database");
  const other = page("other");
  const sub = page("sub", "document", "db");
  const subsub = page("subsub", "document", "sub");
  const queue: QueuedChange[] = [db, record("db"), other, sub, upload("sub"), record("db"), subsub, upload("other"), record("existing")];
  assert.deepEqual([...pendingPageIds(queue)].sort(), ["db", "other", "sub", "subsub"]);
  const next = failChange(queue, [], 0, "Kein Zugriff auf Bereich.", 5);
  assert.deepEqual(next.queue.map((c) => c.pageId), ["other", "other", "existing"]);
  assert.deepEqual(next.failed.map((f) => f.change.pageId), ["db", "db", "sub", "sub", "db", "subsub"]);
  assert.equal(next.failed[0].reason, "Kein Zugriff auf Bereich.");
  assert.equal(next.failed[0].cause, undefined);
  assert.ok(next.failed.slice(1).every((f) => f.cause === "db" && f.reason === "Kein Zugriff auf Bereich."));
  // A change made later in the failed database fails along unsent.
  assert.equal(failedPageOf(record("db"), next.failed), "db");
  assert.equal(failedPageOf(page("late", "document", "sub"), next.failed), "sub");
  assert.equal(failedPageOf(record("other"), next.failed), null);
  // A refused upload alone takes nothing along.
  const lone = failChange(next.queue, next.failed, 1, "Zu groß", 6);
  assert.deepEqual(lone.queue.map((c) => c.kind), ["page", "create"]);
  assert.equal(lone.failed.length, next.failed.length + 1);
});

test("trying again puts the page and its dependents back in their order; discarding removes them", () => {
  const db = page("db2", "database");
  const sub = page("sub2", "document", "db2");
  const rows = [record("db2"), record("db2")];
  const queue: QueuedChange[] = [db, rows[0], sub, rows[1], record("keep")];
  const failed = failChange(queue, [], 0, "Fehler", 1);
  const retried = retryFailed(failed.queue, failed.failed, "db2");
  assert.deepEqual(retried.failed, []);
  assert.deepEqual(retried.queue.map((c) => c.id), [queue[4], db, rows[0], sub, rows[1]].map((c) => c.id));
  const gone = discardPage(failed.queue, failed.failed, "db2");
  assert.deepEqual(gone.failed, []);
  assert.deepEqual(gone.queue.map((c) => c.pageId), ["keep"]);
  assert.deepEqual(gone.removed.map((c) => c.pageId).sort(), ["db2", "db2", "db2", "sub2"]);
  // A waiting page can be discarded too (deleted before it was sent).
  const waiting = discardPage(queue, [], "sub2");
  assert.deepEqual(waiting.queue.map((c) => c.pageId), ["db2", "db2", "db2", "keep"]);
});

test("a new title goes along with the waiting page; the lists show it marked", () => {
  const doc = page("r1");
  const renamed = renamePending([doc], [], "r1", { title: "Neuer Titel", icon: "rocket" });
  assert.equal((renamed.queue[0] as OfflinePageChange).title, "Neuer Titel");
  assert.equal((renamed.queue[0] as OfflinePageChange).icon, "rocket");
  // An empty title keeps the old one.
  assert.equal((renamePending(renamed.queue, [], "r1", { title: "  " }).queue[0] as OfflinePageChange).title, "Neuer Titel");
  const server: Page[] = [{ ...(withLocalPages([], [page("srv")], [], "w", "u")[0]), offline: undefined }];
  const failedPage = page("f1");
  const shown = withLocalPages(server, [...renamed.queue, { ...page("srv"), created: true }, page("elsewhere", "document", null, { workspaceId: "other" })], [{ change: failedPage, reason: "x", at: 0 }], "w", "u");
  assert.deepEqual(shown.map((p) => [p.id, p.offline]), [["srv", "pending"], ["r1", "pending"], ["f1", "failed"]]);
  assert.equal(shown[1].title, "Neuer Titel");
  assert.equal(withLocalPages(server, [], [], "w", "u"), server);
  // Created on the server: no longer built on the device.
  assert.equal(localPageChange([{ ...doc, created: true }], [], "r1"), null);
  assert.equal(localPageChange([doc], [], "r1")?.state, "pending");
  assert.equal(localPageChange([], [{ change: doc, reason: "weg", at: 0 }], "r1")?.reason, "weg");
  // Pages and uploads are no records: the views skip them.
  assert.deepEqual(applyQueue([], [doc, upload("r1")], "r1"), []);
});

test("records made offline count as pending until sent, also when they failed with their page (#370)", () => {
  const db = page("db", "database");
  const a = record("db", "row-a"),
    b = record("existing", "row-b");
  const queue: QueuedChange[] = [db, a, b, upload("db")];
  assert.deepEqual(pendingRows(queue), [
    { pageId: "db", rowId: "row-a" },
    { pageId: "existing", rowId: "row-b" },
  ]);
  // The database refused: its record waits among the failed ones (content stays).
  const next = failChange(queue, [], 0, "Kein Zugriff.", 1);
  assert.deepEqual(pendingRows(next.queue, next.failed).map((r) => r.rowId).sort(), ["row-a", "row-b"]);
  // Created on the server (waiting for the views to have it): not pending.
  assert.deepEqual(pendingRows([{ ...a, sent: true } as QueuedChange, b]).map((r) => r.rowId), ["row-b"]);
  // Updates and deletes of records the server has are not pending records.
  assert.deepEqual(pendingRows([{ id: "u", kind: "update", pageId: "x", rowId: "r", version: 1, cells: {}, base: {}, at: 0 }, { id: "d", kind: "delete", pageId: "x", rowId: "r2", at: 0 }]), []);
});
