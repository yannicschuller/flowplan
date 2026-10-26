// "Rückgängig" (lib/undo.ts, components/toast.tsx): the inverse commands of
// destructive and bulk changes, and the toast that offers them – a button,
// Mod+Z while it shows (not while typing), a live region, about 6 seconds.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Window } from "happy-dom";
import { placeOf, undoFor, type UndoState } from "../lib/undo";
import type { Bootstrap, Database, Page, Row } from "../lib/types";

const page = (id: string, parent: string | null, extra: Partial<Page> = {}): Page =>
  ({ id, parent_id: parent, space_id: "s", title: id.toUpperCase(), kind: "document", deleted_at: null, position: 0, ...extra }) as Page;
const pages = [page("a", null), page("b", null), page("c", null), page("a1", "a"), page("a2", "a")];
const fields = [
  { id: "title", name: "Name", type: "text" },
  { id: "due", name: "Fällig", type: "date" },
  { id: "status", name: "Status", type: "select", options: ["Offen", "Erledigt"] },
] as Database["fields"];
const row = (id: string, cells: Record<string, unknown>, version = 1): Row => ({ id, page_id: "db", cells, version }) as Row;
const state = (rows: Row[] = [row("r1", { title: "Eins", due: "2026-11-01", status: "Offen" }), row("r2", { title: "Zwei" })]): UndoState => ({
  boot: { pages, spaces: [{ id: "s" }] } as unknown as Bootstrap,
  data: {
    page: page("db", null, { kind: "database" }),
    database: { page_id: "db", version: 4, fields, views: [] },
    rows,
  },
});

test("a page to the trash comes back with page.restore and reopens", () => {
  const plan = undoFor({ action: "page.delete", pageId: "a" }, state(), "a1")!;
  assert.equal(plan.message, "„A“ in den Papierkorb gelegt");
  assert.deepEqual(plan.commands(state()), [{ action: "page.restore", pageId: "a" }]);
  assert.equal(plan.reopen, "a1", "the open sub-page was trashed with it");
  assert.equal(undoFor({ action: "page.delete", pageId: "b" }, state(), "a")!.reopen, undefined);
  // Several pages: those inside another selected one come back with it.
  const bulk = undoFor({ action: "pages.bulk", operation: "delete", pageIds: ["a", "a1", "c"] }, state())!;
  assert.equal(bulk.message, "3 Seiten in den Papierkorb gelegt");
  assert.deepEqual(bulk.commands(state()), [
    { action: "page.restore", pageId: "a" },
    { action: "page.restore", pageId: "c" },
  ]);
});

test("a moved page goes back next to its old neighbour", () => {
  assert.deepEqual(placeOf(pages, "b"), { action: "page.move", pageId: "b", targetId: "a", placement: "after" });
  assert.deepEqual(placeOf(pages, "a"), { action: "page.move", pageId: "a", targetId: "b", placement: "before" });
  assert.deepEqual(placeOf([page("x", "p")], "x"), { action: "page.move", pageId: "x", parentId: "p", spaceId: "s" });
  const plan = undoFor({ action: "page.move", pageId: "a2", targetId: "c", placement: "after" }, state())!;
  assert.deepEqual(plan.commands(state()), [{ action: "page.move", pageId: "a2", targetId: "a1", placement: "after" }]);
  // Into another workspace (a space of another workspace): no undo here.
  assert.equal(undoFor({ action: "page.move", pageId: "a", spaceId: "elsewhere", workspaceId: "w" }, state()), null);
  assert.equal(undoFor({ action: "pages.bulk", operation: "move", pageIds: ["b", "c"], parentId: "a" }, state())!.commands(state()).length, 2);
});

test("deleted records come back from the record trash", () => {
  const one = undoFor({ action: "row.delete", pageId: "db", rowId: "r1" }, state())!;
  assert.equal(one.message, "„Eins“ in den Papierkorb gelegt");
  assert.deepEqual(one.commands(state()), [{ action: "row.trash.restore", trashId: "r1" }]);
  const many = undoFor({ action: "rows.bulk", pageId: "db", operation: "delete", rows: [{ id: "r1" }, { id: "r2" }] }, state())!;
  assert.equal(many.message, "2 Einträge in den Papierkorb gelegt");
  assert.equal(many.commands(state()).length, 2);
  assert.equal(undoFor({ action: "rows.bulk", pageId: "db", operation: "duplicate", rows: [{ id: "r1" }] }, state()), null);
});

test("a bulk edit and a cleared date are put back on the current version", () => {
  const bulk = undoFor(
    { action: "rows.bulk", pageId: "db", operation: "update", rows: [{ id: "r1" }, { id: "r2" }], cells: { status: "Erledigt" } },
    state(),
  )!;
  assert.equal(bulk.message, "2 Einträge geändert");
  // After the change and its reload: version 2, or 3 after an automation.
  const after = state([row("r1", { title: "Eins", status: "Erledigt", done: "x" }, 3), row("r2", { title: "Zwei", status: "Erledigt" }, 2)]);
  assert.deepEqual(bulk.commands(after), [
    { action: "row.update", pageId: "db", rowId: "r1", version: 3, cells: { status: "Offen" } },
    { action: "row.update", pageId: "db", rowId: "r2", version: 2, cells: { status: null } },
  ]);
  // Someone else changed the value since: the version right after the
  // change makes the server refuse instead of overwriting.
  const changed = state([row("r1", { status: "Offen" }, 5), row("r2", { status: "Erledigt" }, 2)]);
  assert.equal(bulk.commands(changed)[0].version, 2);
  const cleared = undoFor({ action: "row.update", pageId: "db", rowId: "r1", version: 1, cells: { due: null } }, state())!;
  assert.equal(cleared.message, "Datum „Fällig“ entfernt");
  assert.deepEqual(cleared.commands(state([row("r1", { due: null }, 2)])), [
    { action: "row.update", pageId: "db", rowId: "r1", version: 2, cells: { due: "2026-11-01" } },
  ]);
  // Ordinary edits offer no undo (the field shows the change).
  assert.equal(undoFor({ action: "row.update", pageId: "db", rowId: "r1", version: 1, cells: { title: "Neu" } }, state()), null);
});

test("a card moved to another column, a removed property, a resolved comment", () => {
  const move = undoFor({ action: "row.move", pageId: "db", viewId: "v", rowId: "r1", placement: "end", group: { from: '"Offen"', to: '"Erledigt"' } }, state())!;
  assert.equal(move.message, "„Eins“ verschoben");
  assert.deepEqual(move.commands(state([row("r1", { title: "Eins", due: "2026-11-01", status: "Erledigt" }, 2)])), [
    { action: "row.update", pageId: "db", rowId: "r1", version: 2, cells: { status: "Offen" } },
  ]);
  assert.equal(undoFor({ action: "row.move", pageId: "db", viewId: "v", rowId: "r1", placement: "end" }, state()), null, "order only");
  const removed = undoFor({ action: "database.update", pageId: "db", version: 4, fields: fields.slice(0, 2), views: [] }, state())!;
  assert.equal(removed.message, "Eigenschaft „Status“ entfernt");
  const now = state();
  now.data!.database!.version = 5;
  assert.deepEqual(removed.commands(now), [{ action: "database.update", pageId: "db", version: 5, fields, views: [] }]);
  assert.equal(undoFor({ action: "database.update", pageId: "db", version: 4, fields, views: [] }, state()), null, "nothing removed");
  const resolved = undoFor({ action: "comment.resolve", pageId: "db", commentId: "c", resolved: true }, state())!;
  assert.deepEqual(resolved.commands(state()), [{ action: "comment.resolve", pageId: "db", commentId: "c", resolved: false }]);
  assert.equal(undoFor({ action: "comment.resolve", pageId: "db", commentId: "c", resolved: false }, state()), null);
});

// ---------------------------------------------------------------- the toast
const win = new Window();
Object.assign(globalThis, {
  window: win,
  document: win.document,
  HTMLElement: win.HTMLElement,
  Element: win.Element,
  Node: win.Node,
  KeyboardEvent: win.KeyboardEvent,
});
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
(win as unknown as { matchMedia: unknown }).matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
(globalThis as unknown as { matchMedia: unknown }).matchMedia = (win as unknown as { matchMedia: unknown }).matchMedia;
const React = await import("react");
const { act } = React;
const { createRoot } = await import("react-dom/client");
const { Toaster, showToast, showUndo, dismissToast, undoShownSince, toastSerial } = await import("../components/toast");
const { isMacPlatform } = await import("../lib/keymap");
const mod = isMacPlatform() ? { metaKey: true } : { ctrlKey: true };
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
const press = (target: EventTarget, init: { key: string; code: string; ctrlKey?: boolean; metaKey?: boolean }) =>
  target.dispatchEvent(new win.KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }) as unknown as Event);

test("the undo toast: a focusable button, Mod+Z, live regions, not while typing", async () => {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  act(() => root.render(React.createElement(Toaster)));
  const polite = host.querySelector('[aria-live="polite"]')!,
    assertive = host.querySelector('[aria-live="assertive"]')!;
  assert.ok(polite && assertive, "both live regions exist before any toast");

  let undone = 0;
  const since = toastSerial();
  act(() => void showUndo("„Notizen“ in den Papierkorb gelegt", () => void undone++));
  assert.ok(undoShownSince(since));
  assert.match(polite.textContent || "", /„Notizen“ in den Papierkorb gelegt/);
  const button = [...polite.querySelectorAll("button")].find((b) => b.textContent?.startsWith("Rückgängig"))!;
  assert.ok(button, "a real button – reachable with Tab");
  assert.match(button.getAttribute("aria-keyshortcuts") || "", /Z$/);
  // Mod+Z in a text field belongs to the field.
  const input = document.createElement("input");
  document.body.append(input);
  input.focus();
  act(() => void press(input, { key: "z", code: "KeyZ", ...mod }));
  assert.equal(undone, 0);
  input.blur();
  act(() => void press(document.body, { key: "z", code: "KeyZ", ...mod }));
  assert.equal(undone, 1, "Mod+Z takes the change back");
  assert.equal(polite.textContent, "", "and the toast goes");
  // Pressing again does nothing more.
  act(() => void press(document.body, { key: "z", code: "KeyZ", ...mod }));
  assert.equal(undone, 1);

  // The button does the same; only once.
  act(() => void showUndo("2 Einträge geändert", () => void undone++));
  const again = [...polite.querySelectorAll("button")].find((b) => b.textContent?.startsWith("Rückgängig"))!;
  act(() => (again as unknown as HTMLElement).click());
  assert.equal(undone, 2);

  // Errors go to the assertive region; a toast goes after its time.
  act(() => void showToast({ text: "Nicht gespeichert", tone: "error", duration: 30 }));
  assert.match(assertive.textContent || "", /Nicht gespeichert/);
  assert.equal(polite.textContent, "");
  await act(() => sleep(80));
  assert.equal(assertive.textContent, "");
  // Dismissed by hand.
  act(() => void showToast({ text: "x", tone: "undo", action: { label: "Rückgängig", run: () => {} } }));
  assert.match(polite.textContent || "", /x/);
  act(() => dismissToast());
  assert.equal(polite.textContent, "");
  act(() => root.unmount());
});
