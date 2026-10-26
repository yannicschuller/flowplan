// Optimistic changes (lib/optimistic.ts, lib/optimistic-commands.ts): shown
// at once, taken back when the server refuses, concurrent changes of the
// same thing do not undo each other, and the command layers show what the
// server will store.
import { test } from "node:test";
import assert from "node:assert/strict";
import { applyOverlays, createOverlays, optimistic, withOverlay } from "../lib/optimistic";
import { applyRowMove, commandOverlay, movePages, type PageLike } from "../lib/optimistic-commands";
import type { Bootstrap, Database, Page, Row } from "../lib/types";

const deferred = <T>() => {
  let resolve!: (v: T) => void, reject!: (e: unknown) => void;
  const promise = new Promise<T>((a, b) => ((resolve = a), (reject = b)));
  return { promise, resolve, reject };
};

test("apply shows at once, commit resolves, a failure rolls back and reports", async () => {
  let value = "old";
  const ok = await optimistic({ apply: () => (value = "new"), commit: async () => "saved", rollback: () => (value = "old") });
  assert.equal(ok, "saved");
  assert.equal(value, "new");

  const errors: unknown[] = [];
  const request = deferred<string>();
  const pending = optimistic({
    apply: () => (value = "newer"),
    commit: () => request.promise,
    rollback: () => (value = "new"),
    onError: (e) => errors.push(e),
  });
  assert.equal(value, "newer", "visible before the server answered");
  request.reject(new Error("Datensatz wurde geändert. Bitte neu laden."));
  assert.equal(await pending, undefined);
  assert.equal(value, "new", "rolled back");
  assert.equal((errors[0] as Error).message, "Datensatz wurde geändert. Bitte neu laden.");

  // Without onError the failure is thrown (after the rollback).
  await assert.rejects(
    optimistic({ apply: () => (value = "x"), commit: () => Promise.reject(new Error("nein")), rollback: () => (value = "new") }),
    /nein/,
  );
  assert.equal(value, "new");
});

test("concurrent changes of the same key: an older failure does not undo a newer change", async () => {
  let shown = "a";
  const first = deferred<void>(),
    second = deferred<void>();
  const one = optimistic({ key: "cell", apply: () => (shown = "b"), commit: () => first.promise, rollback: () => (shown = "a"), onError: () => {} });
  const two = optimistic({ key: "cell", apply: () => (shown = "c"), commit: () => second.promise, rollback: () => (shown = "b"), onError: () => {} });
  first.reject(new Error("409"));
  await one;
  assert.equal(shown, "c", "the newer change stays on screen");
  second.reject(new Error("409"));
  await two;
  assert.equal(shown, "b", "the newest one rolls back to what it replaced");
  // Different keys roll back independently.
  let x = 0,
    y = 0;
  await Promise.all([
    optimistic({ key: "x", apply: () => (x = 1), commit: () => Promise.reject(new Error()), rollback: () => (x = 0), onError: () => {} }),
    optimistic({ key: "y", apply: () => (y = 1), commit: () => Promise.resolve(), rollback: () => (y = 0), onError: () => {} }),
  ]);
  assert.deepEqual([x, y], [0, 1]);
});

test("overlays stack in order, each goes when its request is done, a broken one is skipped", async () => {
  const overlays = createOverlays<number[]>();
  let changes = 0;
  overlays.subscribe(() => changes++);
  const a = deferred<void>(),
    b = deferred<void>();
  const runA = withOverlay(overlays, (s) => [...s, 1], () => a.promise);
  const runB = withOverlay(overlays, (s) => [...s, 2], () => b.promise);
  assert.deepEqual(overlays.view([0]), [0, 1, 2]);
  a.reject(new Error("refused"));
  await assert.rejects(runA);
  assert.deepEqual(overlays.view([0]), [0, 2], "the refused layer is gone, the other stays");
  b.resolve();
  await runB;
  assert.deepEqual(overlays.view([0]), [0]);
  assert.equal(changes, 4);
  assert.deepEqual(
    applyOverlays([0], [
      { id: 1, apply: () => { throw new Error("gone"); } },
      { id: 2, apply: (s) => [...s, 3] },
    ]),
    [0, 3],
  );
});

// ---------------------------------------------------------------- commands
const page = (id: string, parent: string | null, position: number, extra: Partial<Page> = {}): Page => ({
  id,
  workspace_id: "w",
  space_id: "s",
  parent_id: parent,
  title: id.toUpperCase(),
  icon: "file",
  cover: "",
  kind: "document",
  position,
  deleted_at: null,
  created_by: "u",
  updated_at: "",
  locked: 0,
  public_token: null,
  full_width: 0,
  font: "sans",
  ...extra,
});
const boot = (pages: Page[]): Bootstrap =>
  ({
    user: { id: "u", name: "Ada" },
    pages,
    favorites: [],
    favoriteRows: [],
    spaces: [{ id: "s" }],
    notifications: [
      { id: "n1", body: "x", read_at: null, created_at: "", page_id: null, row_id: null, thread_id: null },
      { id: "n2", body: "y", read_at: null, created_at: "", page_id: null, row_id: null, thread_id: null },
    ],
  }) as unknown as Bootstrap;
const ctx = { userId: "u", userName: "Ada", now: new Date("2026-10-25T10:00:00Z") };
const level = (pages: Page[], parent: string | null) => pages.filter((p) => p.parent_id === parent && !p.deleted_at).map((p) => p.id);

test("page tree: rename, favourite, trash with sub-pages, move like the server", () => {
  const pages = [page("a", null, 0), page("b", null, 1), page("c", null, 2), page("a1", "a", 0), page("a2", "a", 1)];
  const rename = commandOverlay({ action: "page.update", pageId: "b", patch: { title: "Neu", locked: true } }, ctx)!;
  const renamed = rename.boot!(boot(pages)).pages.find((p) => p.id === "b")!;
  assert.equal(renamed.title, "Neu");
  assert.equal(renamed.locked, 1, "booleans as the server stores them");
  assert.equal(commandOverlay({ action: "page.update", pageId: "b", patch: { title: "  " } }, ctx), null, "an empty title is refused anyway");
  const fav = commandOverlay({ action: "favorite", pageId: "c", value: true }, ctx)!.boot!(boot(pages));
  assert.deepEqual(fav.favorites, ["c"]);
  assert.deepEqual(commandOverlay({ action: "favorite", pageId: "c", value: false }, ctx)!.boot!(fav).favorites, []);
  const trashed = commandOverlay({ action: "page.delete", pageId: "a" }, ctx)!.boot!(boot(pages)).pages;
  assert.deepEqual(trashed.filter((p) => p.deleted_at).map((p) => p.id), ["a", "a1", "a2"]);
  assert.equal(trashed[0].deleted_at, "2026-10-25 10:00:00");
  const restored = commandOverlay({ action: "page.restore", pageId: "a" }, ctx)!.boot!({ ...boot(trashed) }).pages;
  assert.equal(restored.filter((p) => p.deleted_at).length, 0);
  // Moves: before, after, inside, to the end of another parent.
  assert.deepEqual(level(movePages(pages, { pageId: "c", targetId: "a", placement: "before" }), null), ["c", "a", "b"]);
  assert.deepEqual(level(movePages(pages, { pageId: "a", targetId: "b", placement: "after" }), null), ["b", "a", "c"]);
  const inside = movePages(pages, { pageId: "c", targetId: "a", placement: "inside" });
  assert.deepEqual(level(inside, "a"), ["a1", "a2", "c"]);
  assert.deepEqual(level(inside, null), ["a", "b"]);
  assert.deepEqual(level(movePages(pages, { pageId: "a2", targetId: "a1", placement: "before" }), "a"), ["a2", "a1"]);
  // Never into itself.
  assert.deepEqual(movePages(pages, { pageId: "a", targetId: "a1", placement: "inside" }), pages);
  const bulk = commandOverlay({ action: "pages.bulk", operation: "move", pageIds: ["b", "c"], parentId: "a" }, ctx)!.boot!(boot(pages));
  assert.deepEqual(level(bulk.pages, "a"), ["a1", "a2", "b", "c"]);
});

test("inbox: mark one, all, remove", () => {
  const b = boot([]);
  const one = commandOverlay({ action: "notification.mark", notificationId: "n1", read: true }, ctx)!.boot!(b);
  assert.deepEqual(one.notifications.map((n) => !!n.read_at), [true, false]);
  const all = commandOverlay({ action: "notification.read" }, ctx)!.boot!(b);
  assert.ok(all.notifications.every((n) => n.read_at));
  const gone = commandOverlay({ action: "notification.delete", notificationId: "n2" }, ctx)!.boot!(b);
  assert.deepEqual(gone.notifications.map((n) => n.id), ["n1"]);
});

const row = (id: string, cells: Record<string, unknown>, position: number): Row => ({
  id,
  page_id: "db",
  cells,
  position,
  created_at: "",
  updated_at: "",
  created_by: "u",
  updated_by: "u",
  version: 1,
});
const database = (): Database => ({
  page_id: "db",
  version: 3,
  fields: [
    { id: "title", name: "Name", type: "text" },
    { id: "status", name: "Status", type: "select", options: ["Offen", "Erledigt"] },
    { id: "due", name: "Fällig", type: "date" },
  ],
  views: [
    { id: "board", name: "Board", type: "board", groupBy: "status", filters: [], sorts: [] },
    { id: "table", name: "Tabelle", type: "table", filters: [], sorts: [{ field: "title", dir: "asc" }] },
  ] as unknown as Database["views"],
});
const pageData = (): PageLike => ({
  page: page("db", null, 0, { kind: "database" }),
  database: database(),
  rows: [row("r1", { title: "Eins", status: "Offen" }, 1), row("r2", { title: "Zwei", status: "Offen" }, 2), row("r3", { title: "Drei", status: "Erledigt" }, 3)],
  comments: [{ id: "c1", page_id: "db", row_id: null, author_id: "x", name: "Bo", body: "Hi", resolved: 0, created_at: "", reactions: [] }],
});

test("records: edit cells, delete, bulk change, a property removed", () => {
  const data = pageData();
  const edit = commandOverlay<PageLike>({ action: "row.update", pageId: "db", rowId: "r1", version: 1, cells: { status: "Erledigt" } }, ctx)!;
  assert.equal(edit.page!(data).rows![0].cells.status, "Erledigt");
  assert.equal(edit.page!(data).rows![0].cells.title, "Eins", "other cells stay");
  // Another page is untouched.
  const other = { ...data, page: { ...data.page, id: "other" } };
  assert.equal(edit.page!(other), other);
  const del = commandOverlay<PageLike>({ action: "row.delete", pageId: "db", rowId: "r2" }, ctx)!.page!(data);
  assert.deepEqual(del.rows!.map((r) => r.id), ["r1", "r3"]);
  const bulk = commandOverlay<PageLike>(
    { action: "rows.bulk", pageId: "db", operation: "update", rows: [{ id: "r1", version: 1 }, { id: "r3", version: 1 }], cells: { due: "2026-11-01" } },
    ctx,
  )!.page!(data);
  assert.deepEqual(bulk.rows!.map((r) => r.cells.due), ["2026-11-01", undefined, "2026-11-01"]);
  const bulkDelete = commandOverlay<PageLike>({ action: "rows.bulk", pageId: "db", operation: "delete", rows: [{ id: "r1" }, { id: "r3" }] }, ctx)!.page!(data);
  assert.deepEqual(bulkDelete.rows!.map((r) => r.id), ["r2"]);
  assert.equal(commandOverlay({ action: "rows.bulk", pageId: "db", operation: "duplicate", rows: [{ id: "r1" }] }, ctx), null, "copies wait for their ids");
  const schema = commandOverlay<PageLike>(
    { action: "database.update", pageId: "db", version: 3, fields: database().fields.slice(0, 2), views: database().views },
    ctx,
  )!.page!(data);
  assert.deepEqual(schema.database!.fields.map((f) => f.id), ["title", "status"]);
  assert.equal(schema.database!.version, 3, "the version stays the server's");
  assert.equal(commandOverlay({ action: "database.update", pageId: "db", fields: [], views: [], relation: { fieldId: "x" } }, ctx), null);
});

test("board: a card dragged into another column changes its group and column order", () => {
  const data = pageData();
  const moved = applyRowMove(data, { viewId: "board", rowId: "r1", targetId: "r3", placement: "after", group: { from: '"Offen"', to: '"Erledigt"' } });
  assert.equal(moved.rows!.find((r) => r.id === "r1")!.cells.status, "Erledigt");
  const board = moved.database!.views[0];
  assert.deepEqual(board.groupRowOrder?.['"Erledigt"'], ["r3", "r1"]);
  assert.deepEqual(board.groupRowOrder?.['"Offen"'], ["r2"]);
  assert.deepEqual(board.rowOrder, ["r2", "r3", "r1"]);
  // Within one column only the order changes.
  const reordered = applyRowMove(data, { viewId: "board", rowId: "r2", placement: "start", group: { from: '"Offen"', to: '"Offen"' } });
  assert.deepEqual(reordered.database!.views[0].groupRowOrder?.['"Offen"'], ["r2", "r1"]);
  assert.equal(reordered.rows, data.rows, "no cell changed");
  // A sorted view refuses manual order on the server: nothing changes here.
  assert.equal(applyRowMove(data, { viewId: "table", rowId: "r1", placement: "end" }), data);
  assert.ok(commandOverlay({ action: "row.move", pageId: "db", viewId: "board", rowId: "r1", placement: "end" }, ctx));
});

test("comments: posted at once with the author, resolved, reactions toggled", () => {
  const data = pageData();
  const posted = commandOverlay<PageLike>({ action: "comment.create", pageId: "db", body: "  Neu  " }, ctx)!.page!(data);
  const mine = posted.comments!.at(-1)!;
  assert.equal(mine.body, "Neu");
  assert.equal(mine.author_id, "u");
  assert.equal(mine.name, "Ada");
  assert.match(mine.id, /^pending-/);
  assert.equal(commandOverlay({ action: "comment.create", pageId: "db", body: "   " }, ctx), null);
  const resolved = commandOverlay<PageLike>({ action: "comment.resolve", pageId: "db", commentId: "c1", resolved: true }, ctx)!.page!(data);
  assert.equal(resolved.comments![0].resolved, 1);
  const react = (d: PageLike, active: boolean) =>
    commandOverlay<PageLike>({ action: "comment.react", pageId: "db", commentId: "c1", emoji: "👍", active }, ctx)!.page!(d);
  const liked = react(data, true);
  assert.deepEqual(liked.comments![0].reactions, [{ emoji: "👍", count: 1, mine: true, names: ["Ada"] }]);
  assert.deepEqual(react(liked, true).comments![0].reactions, liked.comments![0].reactions, "twice is once");
  assert.deepEqual(react(liked, false).comments![0].reactions, []);
});

test("unknown or incomplete commands get no layer", () => {
  assert.equal(commandOverlay({ action: "page.duplicate", pageId: "a" }, ctx), null);
  assert.equal(commandOverlay({ action: "row.update", pageId: "db" }, ctx), null);
  assert.equal(commandOverlay({ action: "favorite" }, ctx), null);
});
