// A space as a library (#329): books, chapters and pages from the page tree
// (lib/library.ts), the reading order, "Weiterlesen", the setting on the
// space (space.update) and the server's library of what a person may see
// (lib/library-server.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Identity, Space } from "../lib/types";
process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-library-"));
const { id, run, one } = await import("../lib/db");
const { command, bootstrap } = await import("../lib/api");
const { createWorkspace } = await import("../lib/seed");
const { spaceLibrary } = await import("../lib/library-server");
const { bookNavigation, bookOf, continueReading, firstPage, libraryBooks, libraryHash, overviewHash, parseLibraryHash } = await import("../lib/library");
const { isSidebarKey, pruneSidebarKeys } = await import("../lib/sidebar-folds");
const { stepOf } = await import("../lib/history-nav");

// ---- The tree as a library (pure) ----

const S = "11111111-1111-4111-8111-111111111111";
let n = 0;
const page = (pageId: string, parent: string | null, position: number, extra: Record<string, unknown> = {}) => ({
  id: pageId,
  parent_id: parent,
  space_id: S,
  title: pageId,
  icon: "file",
  kind: "document",
  position,
  updated_at: `2026-11-0${(n++ % 9) + 1} 10:00:00`,
  deleted_at: null as string | null,
  ...extra,
});
// Two books: "manual" with chapters "install" (pages a, b – b with a
// sub-page b1) and "use"; "notes" without chapters. Given out of order.
const tree = [
  page("use", "manual", 2),
  page("notes", null, 2, { updated_at: "2026-10-01 08:00:00" }),
  page("b", "install", 2),
  page("manual", null, 1),
  page("install", "manual", 1),
  page("a", "install", 1),
  page("b1", "b", 1, { updated_at: "2026-11-15 12:00:00" }),
  page("gone", "manual", 3, { deleted_at: "2026-11-10 00:00:00" }),
  page("elsewhere", null, 0, { space_id: "22222222-2222-4222-8222-222222222222" }),
];

test("books are the top-level pages in tree order, chapters their sub-pages with their pages", () => {
  const books = libraryBooks(tree, S);
  assert.deepEqual(books.map((b) => b.page.id), ["manual", "notes"]);
  const [manual, notes] = books;
  assert.deepEqual(manual.chapters.map((c) => c.page.id), ["install", "use"]);
  assert.deepEqual(manual.chapters[0].pages.map((e) => e.page.id), ["a", "b"]);
  // Counts: the book's pages with its own page, below a chapter or page without it.
  assert.equal(manual.pages, 6);
  assert.equal(manual.chapters[0].below, 3);
  assert.deepEqual(manual.chapters[0].pages.map((e) => e.below), [0, 1]);
  assert.equal(manual.chapters[1].below, 0);
  // The latest change anywhere in the book; trashed pages do not count.
  assert.equal(manual.updatedAt, "2026-11-15 12:00:00");
  assert.equal(notes.pages, 1);
  assert.deepEqual(notes.chapters, []);
  assert.equal(notes.updatedAt, "2026-10-01 08:00:00");
});

test("equal positions keep the given order; a page whose parent is not visible is a book", () => {
  const books = libraryBooks([page("x", null, 1), page("y", null, 1), page("z", "hidden", 0)], S);
  assert.deepEqual(books.map((b) => b.page.id), ["z", "x", "y"]);
});

test("journal days stay out of the library", () => {
  const books = libraryBooks([page("journal", null, 1, { kind: "journal" }), page("day", "journal", 1, { journal_date: "2026-11-01" })], S);
  assert.equal(books[0].pages, 1);
  assert.deepEqual(books[0].chapters, []);
  assert.equal(bookNavigation([page("day", null, 1, { journal_date: "2026-11-01" })], S, "day"), null);
});

test("previous and next follow the reading order: the pages, not the book's and chapters' overviews", () => {
  // manual and its chapters install and use are documents: directories.
  const order = ["a", "b", "b1"];
  order.forEach((pageId, i) => {
    const nav = bookNavigation(tree, S, pageId)!;
    assert.equal(nav.book.id, "manual");
    assert.equal(nav.position, i + 1);
    assert.equal(nav.total, order.length);
    assert.equal(nav.previous?.id ?? null, order[i - 1] ?? null, `before ${pageId}`);
    assert.equal(nav.next?.id ?? null, order[i + 1] ?? null, `after ${pageId}`);
  });
  // The way down: book › chapter › page › sub-page.
  assert.deepEqual(bookNavigation(tree, S, "b1")!.path.map((p) => p.id), ["manual", "install", "b", "b1"]);
  // A book's or chapter's own text in the editor: the way, no place.
  for (const pageId of ["manual", "install", "use", "notes"]) {
    const nav = bookNavigation(tree, S, pageId)!;
    assert.equal(nav.position, 0, pageId);
    assert.equal(nav.previous, null);
    assert.equal(nav.next, null);
  }
  assert.deepEqual(bookNavigation(tree, S, "install")!.path.map((p) => p.id), ["manual", "install"]);
  // A book or chapter of another kind is read as a page.
  const mixed = [page("db", null, 1, { kind: "database" }), page("board", "db", 1, { kind: "whiteboard" }), page("p", "board", 1)];
  assert.deepEqual(["db", "board", "p"].map((id) => bookNavigation(mixed, S, id)!.position), [1, 2, 3]);
  assert.equal(bookNavigation(tree, S, "elsewhere"), null);
  assert.equal(bookNavigation(tree, S, "gone"), null);
  assert.equal(bookOf(tree, S, "b1")?.id, "manual");
});

test("what opens as overview and what in the editor; where reading starts", () => {
  const spaces = [{ id: S, library: 1 }];
  // Books and chapters (documents) open as their overview.
  assert.equal(overviewHash(tree, spaces, "manual"), libraryHash(S, "manual"));
  assert.equal(overviewHash(tree, spaces, "notes"), libraryHash(S, "notes"));
  assert.equal(overviewHash(tree, spaces, "install"), libraryHash(S, "manual", "install"));
  assert.equal(overviewHash(tree, spaces, "use"), libraryHash(S, "manual", "use"));
  // Pages further down, other kinds, trashed pages, other spaces: the page itself.
  for (const id of ["a", "b", "b1", "gone", "elsewhere", "unknown"]) assert.equal(overviewHash(tree, spaces, id), null, id);
  assert.equal(overviewHash([page("db", null, 1, { kind: "database" })], spaces, "db"), null);
  assert.equal(overviewHash([page("db", null, 1), page("board", "db", 1, { kind: "whiteboard" })], spaces, "board"), null);
  // Not a library (or switched off, or in the trash): unchanged.
  assert.equal(overviewHash(tree, [{ id: S, library: 0 }], "manual"), null);
  assert.equal(overviewHash(tree, [{ id: S, library: 1, deleted_at: "2026-11-01" }], "manual"), null);
  assert.equal(overviewHash(tree, [], "manual"), null);
  // "Lesen beginnen": the first page of the book or chapter.
  assert.equal(firstPage(tree, S, "manual")?.id, "a");
  assert.equal(firstPage(tree, S, "install")?.id, "a");
  assert.equal(firstPage(tree, S, "use"), null);
  assert.equal(firstPage(tree, S, "notes"), null);
  assert.equal(firstPage(tree, S, "unknown"), null);
});

test("a parent cycle does not hang", () => {
  const cyclic = [page("p", "q", 1), page("q", "p", 1)];
  assert.deepEqual(libraryBooks(cyclic, S), []);
  assert.equal(bookNavigation(cyclic, S, "p"), null);
});

test("Weiterlesen: the page of the book visited last", () => {
  const visits = [
    { pageId: "a", seenAt: 10 },
    { pageId: "b1", seenAt: 30 },
    { pageId: "notes", seenAt: 50 },
    { pageId: "elsewhere", seenAt: 90 },
  ];
  assert.equal(continueReading(tree, S, "manual", visits)?.id, "b1");
  // A book's own text edited is not reading.
  assert.equal(continueReading(tree, S, "notes", visits), null);
  assert.equal(continueReading(tree, S, "manual", [{ pageId: "install", seenAt: 99 }]), null);  assert.equal(continueReading(tree, S, "manual", []), null);
  assert.equal(continueReading(tree, S, "unknown", visits), null);
});

test("addresses: #library/<space>[/<book>], history steps and the sidebar key", () => {
  const book = "33333333-3333-4333-8333-333333333333";
  const chapter = "44444444-4444-4444-8444-444444444444";
  assert.deepEqual(parseLibraryHash(libraryHash(S)), { spaceId: S, bookId: null, chapterId: null });
  assert.deepEqual(parseLibraryHash(libraryHash(S, book)), { spaceId: S, bookId: book, chapterId: null });
  assert.deepEqual(parseLibraryHash(libraryHash(S, book, chapter)), { spaceId: S, bookId: book, chapterId: chapter });
  assert.equal(libraryHash(S, null, chapter), `library/${S}`);
  assert.equal(stepOf(`#library/${S}/${book}/${chapter}`), `library/${S}/${book}/${chapter}`);
  for (const bad of ["library", "library/x", `library/${S}/x`, `library/${S}/${book}/x`, `library/${S}/${book}/${chapter}/${book}`, `collection/${S}`])
    assert.equal(parseLibraryHash(bad), null, bad);
  assert.equal(stepOf(`#library/${S.toUpperCase()}/${book}`), `library/${S}/${book}`);
  assert.equal(stepOf(`#library/${S}/nope`), null);
  // "so:<space>": a library's tree unfolded by hand, kept while the space exists.
  assert.ok(isSidebarKey(`so:${S}`));
  assert.equal(isSidebarKey("so:nope"), false);
  const known = { pages: new Set<string>(), parents: new Set<string>(), spaces: new Set([S]) };
  assert.deepEqual(pruneSidebarKeys([`so:${S}`, `so:${book}`], known), [`so:${S}`]);
});

// ---- The setting and the server's library ----

async function user(name: string): Promise<Identity> {
  const uid = id();
  await run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, name, `${uid}@example.test`);
  return { id: uid, name, email: `${uid}@example.test`, groups: [], isAdmin: false, disabled: 0, created_at: "" };
}
const act = (actor: Identity, input: Record<string, unknown>): Promise<any> => command(actor, input);
const space = async (sid: string) => (await one<Space>("SELECT * FROM spaces WHERE id=?", sid))!;

async function fixture() {
  const owner = await user("Owner"),
    member = await user("Member"),
    outsider = await user("Outsider"),
    wid = await createWorkspace(owner.id, "Docs");
  await run("INSERT INTO members VALUES(?,?,?)", wid, member.id, "editor");
  await createWorkspace(outsider.id, "Other");
  const sid = (await act(owner, { action: "space.create", workspaceId: wid, name: "Handbook", private: true })).id as string;
  const create = async (title: string, parentId?: string) =>
    (await act(owner, { action: "page.create", workspaceId: wid, spaceId: sid, title, kind: "document", ...(parentId ? { parentId } : {}) })).id as string;
  const guide = await create("Guide");
  const setup = await create("Setup", guide);
  const linux = await create("Linux", setup);
  const internal = await create("Internal", guide);
  return { owner, member, outsider, wid, sid, guide, setup, linux, internal };
}

test("space.update stores the library setting, keeps it when not sent and refuses other values", async () => {
  const f = await fixture();
  assert.equal((await space(f.sid)).library, 0);
  const update = async (actor: Identity, extra: Record<string, unknown>) =>
    await act(actor, { action: "space.update", spaceId: f.sid, name: "Handbook", private: true, ...extra });
  await update(f.owner, { library: true });
  assert.equal((await space(f.sid)).library, 1);
  // Sent without it (an older client, the API): left as it is.
  await update(f.owner, { icon: "📚" });
  assert.equal((await space(f.sid)).library, 1);
  await assert.rejects(update(f.owner, { library: "yes" }));
  assert.equal((await space(f.sid)).library, 1);
  // Only those who may manage the space.
  await assert.rejects(update(f.member, { library: false }), /verwalten|Kein Zugriff|nicht gefunden/);
  await update(f.owner, { library: false });
  assert.equal((await space(f.sid)).library, 0);
  // The bootstrap carries it to the sidebar.
  await update(f.owner, { library: true });
  assert.equal((await bootstrap(f.owner, f.wid)).spaces.find((s) => s.id === f.sid)?.library, 1);
});

test("a new book, chapter and page from the library land at the end of their level", async () => {
  const f = await fixture();
  const create = async (title: string, parentId: string | null) =>
    (await act(f.owner, { action: "page.create", workspaceId: f.wid, spaceId: f.sid, parentId, title, kind: "document" })).id as string;
  const pages = async () => (await bootstrap(f.owner, f.wid)).pages;
  // "Neues Buch": a page at the top of the space, after the others.
  const book = await create("Second book", null);
  // "Neues Kapitel": below the book; "Neue Seite": below the chapter.
  const chapter = await create("Getting started", f.guide);
  const pageId = await create("First steps", f.setup);
  const books = libraryBooks(await pages(), f.sid);
  assert.deepEqual(books.map((b) => b.page.id), [f.guide, book]);
  assert.deepEqual(books[0].chapters.map((c) => c.page.id), [f.setup, f.internal, chapter]);
  assert.deepEqual(books[0].chapters[0].pages.map((e) => e.page.id), [f.linux, pageId]);
  // The new book and chapter open as overviews, the page in the editor.
  await act(f.owner, { action: "space.update", spaceId: f.sid, name: "Handbook", private: true, library: true });
  const boot = await bootstrap(f.owner, f.wid);
  assert.equal(overviewHash(boot.pages, boot.spaces, book), libraryHash(f.sid, book));
  assert.equal(overviewHash(boot.pages, boot.spaces, chapter), libraryHash(f.sid, f.guide, chapter));
  assert.equal(overviewHash(boot.pages, boot.spaces, pageId), null);
});

test("the server's library lists only pages the person may read", async () => {
  const f = await fixture();
  const all = await spaceLibrary(f.owner, f.sid);
  assert.equal(all.space.name, "Handbook");
  assert.deepEqual(all.books.map((b) => b.title), ["Guide"]);
  assert.equal(all.books[0].pages, 4);
  assert.deepEqual(all.books[0].chapters.map((c) => [c.title, c.below, c.pages.map((p) => p.title)]), [
    ["Setup", 1, ["Linux"]],
    ["Internal", 0, []],
  ]);
  // The member cannot open the private space; a chapter shared with them
  // is their book, with its pages – nothing else of the space.
  await assert.rejects(spaceLibrary(f.member, f.sid), /nicht gefunden/);
  await act(f.owner, { action: "grant.set", resourceId: f.setup, userId: f.member.id, role: "viewer" });
  const shared = await spaceLibrary(f.member, f.sid);
  assert.deepEqual(shared.books.map((b) => [b.title, b.pages]), [["Setup", 2]]);
  assert.deepEqual(shared.books[0].chapters.map((c) => c.title), ["Linux"]);
  assert.equal(JSON.stringify(shared).includes("Internal"), false);
  // Not a member: refused.
  await assert.rejects(spaceLibrary(f.outsider, f.sid));
  // A page in the trash leaves the library.
  await act(f.owner, { action: "page.delete", pageId: f.linux });
  assert.deepEqual((await spaceLibrary(f.owner, f.sid)).books[0].chapters[0].pages, []);
});
