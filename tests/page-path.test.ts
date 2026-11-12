import { test } from "node:test";
import assert from "node:assert/strict";
import { collapsePath, isMore, structuralPath, type PathPage } from "../lib/page-path";
import { pageLocationHash, parsePageLocation, loginReturnPath } from "../lib/page-location";
import { stepOf } from "../lib/history-nav";

const id = (n: number) => `${String(n).padStart(8, "0")}-1111-4111-8111-111111111111`;
const row = "22222222-2222-4222-8222-222222222222";
const page = (n: number, parent: number | null, kind = "document"): PathPage => ({
  id: id(n),
  parent_id: parent === null ? null : id(parent),
  title: `Seite ${n}`,
  icon: "",
  kind,
});

test("a record's address as a page of its own (#231): &full=1, only with a record", () => {
  const target = { pageId: id(1), rowId: row, full: true };
  assert.equal(pageLocationHash(target), `#page=${id(1)}&row=${row}&full=1`);
  assert.deepEqual(parsePageLocation(pageLocationHash(target)), target);
  // Without the flag the address is as before.
  assert.equal(pageLocationHash({ pageId: id(1), rowId: row }), `#page=${id(1)}&row=${row}`);
  assert.deepEqual(parsePageLocation(`#page=${id(1)}&row=${row}`), { pageId: id(1), rowId: row });
  // A page without a record has nothing to show as a page.
  assert.equal(pageLocationHash({ pageId: id(1), full: true }), `#page=${id(1)}`);
  for (const bad of [`page=${id(1)}&full=1`, `page=${id(1)}&row=${row}&full=yes`, `page=${id(1)}&row=${row}&full=1&full=1`])
    assert.equal(parsePageLocation(bad), null, bad);
  // Signing in returns there; back and forward count it as its own place.
  assert.equal(loginReturnPath(`/#page=${id(1)}&row=${row}&full=1`), `/#page=${id(1)}&row=${row}&full=1`);
  assert.equal(stepOf(`page=${id(1)}&row=${row}&full=1&block=b1`), `page=${id(1)}&row=${row}&full=1`);
  assert.notEqual(stepOf(`page=${id(1)}&row=${row}&full=1`), stepOf(`page=${id(1)}&row=${row}`));
});

test("the path follows the structural parents up to the workspace", () => {
  const pages = [page(1, null), page(2, 1), page(3, 2, "database"), page(9, null)];
  const path = structuralPath(pages, pages[2], { rowId: row, title: "Anforderung", icon: "", full: true });
  assert.deepEqual(path.map((s) => s.title), ["Seite 1", "Seite 2", "Seite 3", "Anforderung"]);
  assert.deepEqual(path.map((s) => s.kind), ["document", "document", "database", "record"]);
  assert.equal(path[2].hash, `#page=${id(3)}`);
  assert.equal(path[3].hash, `#page=${id(3)}&row=${row}&full=1`);
  assert.equal(path[3].key, `${id(3)}:${row}`);
  assert.deepEqual(path.map((s) => !!s.current), [false, false, false, true]);
  // A record in its dialog links to the dialog.
  assert.equal(structuralPath(pages, pages[2], { rowId: row, title: "x", icon: "" }).at(-1)!.hash, `#page=${id(3)}&row=${row}`);
  // A top-level page is alone; the current page always shows, even when
  // the list does not contain it (another workspace, just created).
  assert.deepEqual(structuralPath([], page(5, null)).map((s) => s.title), ["Seite 5"]);
});

test("the path never shows pages the person cannot read (guests, private parents)", () => {
  // 1 (readable) > 2 (private, not in the list) > 3 (shared with a guest) > 4.
  const readable = [page(1, null), page(3, 2), page(4, 3)];
  const path = structuralPath(readable, readable[2]);
  // Starts at the first readable ancestor below the hidden one; nothing of
  // 2 – and nothing above it, even though 1 is readable.
  assert.deepEqual(path.map((s) => s.title), ["Seite 3", "Seite 4"]);
  assert.ok(path.every((s) => s.key !== id(2) && s.key !== id(1)));
  assert.ok(!JSON.stringify(path).includes(id(2)));
  // A guest who may only read the database sees database and record.
  const db = page(7, 2, "database");
  assert.deepEqual(structuralPath([db], db, { rowId: row, title: "R", icon: "" }).map((s) => s.title), ["Seite 7", "R"]);
});

test("broken data (a loop of parents) ends the walk", () => {
  const a = page(1, 2), b = page(2, 1);
  assert.deepEqual(structuralPath([a, b], a).map((s) => s.title), ["Seite 2", "Seite 1"]);
  assert.deepEqual(structuralPath([page(1, 1)], page(1, 1)).map((s) => s.title), ["Seite 1"]);
});

test("a long path folds its middle into one menu", () => {
  const pages = [1, 2, 3, 4, 5, 6].map((n) => page(n, n > 1 ? n - 1 : null));
  const path = structuralPath(pages, pages[5], { rowId: row, title: "R", icon: "" });
  assert.equal(path.length, 7);
  const titles = (room: number) =>
    collapsePath(path, room).shown.map((item) => (isMore(item) ? `…(${item.more.map((s) => s.title).join(",")})` : item.title));
  assert.deepEqual(titles(10), ["Seite 1", "Seite 2", "Seite 3", "Seite 4", "Seite 5", "Seite 6", "R"]);
  assert.deepEqual(titles(4), ["Seite 1", "…(Seite 2,Seite 3,Seite 4)", "Seite 5", "Seite 6", "R"]);
  // Phones: "…" and the current segment.
  assert.deepEqual(titles(2), ["…(Seite 1,Seite 2,Seite 3,Seite 4,Seite 5,Seite 6)", "R"]);
  assert.deepEqual(titles(1), titles(2));
  // Short paths stay whole.
  assert.deepEqual(collapsePath(path.slice(0, 2), 2).shown.length, 2);
  assert.deepEqual(collapsePath(path.slice(0, 4), 4).shown.map((s) => !isMore(s)), [true, true, true, true]);
  assert.deepEqual(collapsePath(path.slice(0, 5), 4).shown.map((s) => (isMore(s) ? s.more.length : 0)), [0, 1, 0, 0, 0]);
});
