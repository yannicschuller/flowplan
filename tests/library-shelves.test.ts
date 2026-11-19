// The workspace's library (#329 follow-up): every library space a shelf,
// the person's own and the shared ones (lib/library.ts libraryShelves),
// "Weiterlesen" (readingNow), the place of a page in its book
// (libraryIndex), GET /api/library (libraryOverview) and the search over
// all shelves grouped by level (searchLibrary) – with the permissions of
// spaces, groups and shared pages – and a seeded library of 1,000 pages
// read with a bounded number of statements (no query per page or book).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Identity } from "../lib/types";
process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-library-shelves-"));
// Counts the statements (lib/runtime-metrics.ts) for the 1,000-page test.
process.env.FLOWPLAN_METRICS_LOOP = "1";
const { id, run } = await import("../lib/db");
const { command } = await import("../lib/api");
const { createWorkspace } = await import("../lib/seed");
const { withReadMemo } = await import("../lib/read-memo");
const { startRuntimeMetrics } = await import("../lib/runtime-metrics");
const { libraryOverview, searchLibrary, spaceLibrary, LIBRARY_GROUP_LIMIT } = await import("../lib/library-server");
const { refreshSearchIndex } = await import("../lib/search-index");
const { libraryIndex, libraryShelves, readingNow, LIBRARY_HOME } = await import("../lib/library");
const { stepOf } = await import("../lib/history-nav");
startRuntimeMetrics();
// Statements are counted where runtime metrics run (FLOWPLAN_METRICS_LOOP=1);
// elsewhere (the PostgreSQL job) only the results are checked.
const metrics = () => (globalThis as unknown as { flowplanRuntimeMetrics?: { sqlCount: number } }).flowplanRuntimeMetrics;
const statements = () => metrics()?.sqlCount ?? 0;
const bounded = (count: number, max: number, message: string) => {
  if (metrics()) assert.ok(count < max, message);
};

// ---- Pure ----

const A = "11111111-1111-4111-8111-111111111111",
  B = "22222222-2222-4222-8222-222222222222",
  C = "33333333-3333-4333-8333-333333333333";
const page = (pageId: string, spaceId: string, parent: string | null, position: number) => ({
  id: pageId,
  parent_id: parent,
  space_id: spaceId,
  title: pageId,
  icon: "file",
  kind: "document",
  position,
  deleted_at: null,
});
const pages = [
  page("manual", A, null, 1),
  page("install", A, "manual", 1),
  page("linux", A, "install", 1),
  page("deep", A, "linux", 1),
  page("faq", A, null, 2),
  page("notes", B, null, 1),
  page("plain", C, null, 1),
];
const space = (sid: string, name: string, visibility: "team" | "private", owner: string, library = 1) => ({ id: sid, name, visibility, owner_id: owner, library });

test("shelves: library spaces only, the person's private ones apart from the shared ones", () => {
  const spaces = [space(A, "Handbuch", "team", "x"), space(B, "Meine Notizen", "private", "me"), space(C, "Kein Regal", "team", "me", 0), space("44444444-4444-4444-8444-444444444444", "Geteilt privat", "private", "x")];
  const { personal, shared } = libraryShelves(spaces, pages, "me");
  assert.deepEqual(personal.map((s) => s.space.name), ["Meine Notizen"]);
  assert.deepEqual(shared.map((s) => s.space.name), ["Handbuch", "Geteilt privat"]);
  assert.deepEqual(shared[0].books.map((b) => [b.page.id, b.pages]), [["manual", 4], ["faq", 1]]);
  assert.equal(shared[0].pages, 5);
  // A shelf without a visible page is still a shelf (its space is given).
  assert.deepEqual(shared[1].books, []);
});

test("the place of a page: book, chapter, deeper pages, position in reading order", () => {
  const { places } = libraryIndex(pages, A);
  assert.deepEqual([...places.keys()], ["manual", "install", "linux", "deep", "faq"]);
  const deep = places.get("deep")!;
  assert.equal(deep.level, 3);
  assert.equal(deep.book.id, "manual");
  assert.equal(deep.chapter?.id, "install");
  assert.deepEqual(deep.path.map((p) => p.id), ["manual", "install", "linux", "deep"]);
  assert.deepEqual([deep.position, deep.total], [4, 4]);
  assert.equal(places.get("manual")!.level, 0);
  assert.equal(places.get("install")!.level, 1);
});

test("continue reading: per book the page visited last, newest first", () => {
  const visits = [
    { pageId: "install", seenAt: 10 },
    { pageId: "linux", seenAt: 30 },
    { pageId: "notes", seenAt: 20 },
    { pageId: "plain", seenAt: 40 },
    { pageId: "faq", seenAt: 5 },
  ];
  const list = readingNow(pages, [A, B], visits);
  assert.deepEqual(list.map((r) => [r.book.id, r.page.id, r.position]), [["manual", "linux", 3], ["notes", "notes", 1], ["faq", "faq", 1]]);
  assert.equal(readingNow(pages, [A, B], visits, 1).length, 1);
});

test("addresses: #library is a step of its own", () => {
  assert.equal(LIBRARY_HOME, "library");
  assert.equal(stepOf("#library"), "library");
});

// ---- The server ----

async function user(name: string): Promise<Identity> {
  const uid = id();
  await run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, name, `${uid}@example.test`);
  return { id: uid, name, email: `${uid}@example.test`, groups: [], isAdmin: false, disabled: 0, created_at: "" };
}
const act = (actor: Identity, input: Record<string, unknown>): Promise<any> => command(actor, input);
const write = async (pageId: string, html: string) =>
  await run("INSERT INTO documents(page_id,html) VALUES(?,?) ON CONFLICT(page_id) DO UPDATE SET html=excluded.html", pageId, html);

async function fixture() {
  const owner = await user("Owner"),
    member = await user("Member"),
    wid = await createWorkspace(owner.id, "Wissen");
  await run("INSERT INTO members VALUES(?,?,?)", wid, member.id, "editor");
  const shelf = async (actor: Identity, name: string, isPrivate: boolean) => {
    const sid = (await act(actor, { action: "space.create", workspaceId: wid, name, private: isPrivate })).id as string;
    await act(actor, { action: "space.update", spaceId: sid, name, private: isPrivate, library: true });
    return sid;
  };
  const create = async (actor: Identity, spaceId: string, title: string, parentId?: string) =>
    (await act(actor, { action: "page.create", workspaceId: wid, spaceId, title, kind: "document", ...(parentId ? { parentId } : {}) })).id as string;
  // A team shelf, the member's own private one, the owner's private one
  // with a single book shared with the member, one opened to a group.
  const team = await shelf(owner, "Handbuch", false);
  const guide = await create(owner, team, "Betriebshandbuch");
  const backup = await create(owner, team, "Datensicherung", guide);
  const restore = await create(owner, team, "Wiederherstellung testen", backup);
  await write(restore, "<p>Die Sicherung wird jeden Monat mit einer Probewiederherstellung geprüft.</p>");
  const mine = await shelf(member, "Meine Rezepte", true);
  const bread = await create(member, mine, "Brot backen");
  const secret = await shelf(owner, "Vorstand", true);
  const minutes = await create(owner, secret, "Protokolle");
  await write(minutes, "<p>Sicherung der Gehälter für das nächste Jahr.</p>");
  const policy = await create(owner, secret, "Richtlinien");
  await act(owner, { action: "grant.set", resourceId: policy, userId: member.id, role: "viewer" });
  const grouped = await shelf(owner, "Vertrieb", true);
  const sales = await create(owner, grouped, "Sicherung der Kundendaten");
  const group = (await act(owner, { action: "group.create", workspaceId: wid, name: "Vertrieb" })).id as string;
  // Not a library: never a shelf, never searched by the library.
  const plain = (await act(owner, { action: "space.create", workspaceId: wid, name: "Sicherungen", private: false })).id as string;
  await create(owner, plain, "Sicherung außerhalb");
  return { owner, member, wid, team, guide, backup, restore, mine, bread, secret, minutes, policy, grouped, sales, group, plain };
}

test("the overview: own and shared shelves with what the person may read", async () => {
  const f = await fixture();
  const owner = await libraryOverview(f.owner, f.wid);
  assert.deepEqual(owner.personal.map((s) => s.name), ["Vorstand", "Vertrieb"]);
  assert.deepEqual(owner.shared.map((s) => s.name), ["Handbuch"]);
  assert.equal(owner.shared[0].books[0].title, "Betriebshandbuch");
  assert.equal(owner.shared[0].books[0].pages, 3);
  assert.equal(owner.shared[0].books[0].chapters, 1);
  assert.equal(owner.shared[0].canManage, true);

  // The member: their own shelf, the team's, and of the board's shelf only
  // the book shared with them – not the group's shelf yet.
  const member = await libraryOverview(f.member, f.wid);
  assert.deepEqual(member.personal.map((s) => s.name), ["Meine Rezepte"]);
  assert.deepEqual(member.shared.map((s) => [s.name, s.books.map((b) => b.title)]), [
    ["Handbuch", ["Betriebshandbuch"]],
    ["Vorstand", ["Richtlinien"]],
  ]);
  assert.equal(member.shared[0].canManage, false);
  assert.equal(member.personal[0].canManage, true);
  assert.equal(JSON.stringify(member).includes("Protokolle"), false);

  // Group access to the space (groups are what SSO/SCIM/LDAP mappings fill).
  await act(f.owner, { action: "grant.set", resourceId: f.grouped, groupId: f.group, role: "viewer" });
  await act(f.owner, { action: "group.member", groupId: f.group, userId: f.member.id, enabled: true });
  assert.deepEqual((await libraryOverview(f.member, f.wid)).shared.map((s) => s.name), ["Handbuch", "Vorstand", "Vertrieb"]);
  // Out of the group, the shelf is gone again.
  await act(f.owner, { action: "group.member", groupId: f.group, userId: f.member.id, enabled: false });
  assert.deepEqual((await libraryOverview(f.member, f.wid)).shared.map((s) => s.name), ["Handbuch", "Vorstand"]);
});

test("continue reading on the server: from the person's own visits", async () => {
  const f = await fixture();
  await run("INSERT INTO page_visits(user_id,page_id,seen_at) VALUES(?,?,?)", f.member.id, f.backup, Date.now() - 1000);
  await run("INSERT INTO page_visits(user_id,page_id,seen_at) VALUES(?,?,?)", f.member.id, f.bread, Date.now());
  // A page of a space that is no library does not count.
  const { continueReading } = await libraryOverview(f.member, f.wid);
  assert.deepEqual(continueReading.map((r) => [r.book.title, r.page.title, r.position, r.total]), [
    ["Brot backen", "Brot backen", 1, 1],
    ["Betriebshandbuch", "Datensicherung", 2, 3],
  ]);
  assert.deepEqual((await libraryOverview(f.owner, f.wid)).continueReading, []);
});

test("the library search groups by level and respects permissions", async () => {
  const f = await fixture();
  await act(f.owner, { action: "grant.set", resourceId: f.grouped, groupId: f.group, role: "viewer" });
  // The shelf's name, the chapter's title, the text of a page further down.
  const owner = await searchLibrary(f.owner, f.wid, "Sicherung");
  assert.deepEqual(owner.shelves, []);
  assert.deepEqual(owner.books.map((h) => h.title), ["Sicherung der Kundendaten"]);
  assert.deepEqual(owner.chapters.map((h) => [h.title, h.level, h.path.map((p) => p.title)]), [["Datensicherung", 1, ["Handbuch", "Betriebshandbuch"]]]);
  const restore = owner.pages.find((h) => h.id === f.restore)!;
  assert.equal(restore.level, 2);
  assert.deepEqual(restore.path.map((p) => p.title), ["Handbuch", "Betriebshandbuch", "Datensicherung"]);
  assert.match(restore.snippet || "", /\u0002Sicherung\u0003/);
  assert.ok(owner.pages.some((h) => h.id === f.minutes && h.snippet));
  // Spaces that are no library stay out.
  assert.equal(JSON.stringify(owner).includes("außerhalb"), false);
  assert.deepEqual(owner.total, { shelves: 0, books: 1, chapters: 1, pages: owner.pages.length });

  // The member: neither the board's minutes nor the group's shelf.
  const member = await searchLibrary(f.member, f.wid, "Sicherung");
  assert.deepEqual(member.books, []);
  assert.deepEqual(member.chapters.map((h) => h.title), ["Datensicherung"]);
  assert.equal(member.pages.some((h) => h.id === f.minutes), false);
  assert.equal(JSON.stringify(member).includes("Gehälter"), false);
  // In the group, the group's shelf is searched as well.
  await act(f.owner, { action: "group.member", groupId: f.group, userId: f.member.id, enabled: true });
  assert.deepEqual((await searchLibrary(f.member, f.wid, "Sicherung")).books.map((h) => h.title), ["Sicherung der Kundendaten"]);

  // Shelves by name; a title found once, with its text's snippet.
  const shelves = await searchLibrary(f.member, f.wid, "rezept");
  assert.deepEqual(shelves.shelves.map((h) => [h.title, h.id]), [["Meine Rezepte", f.mine]]);
  assert.deepEqual((await searchLibrary(f.member, f.wid, "Vorstand")).shelves.map((h) => h.title), ["Vorstand"]);
  assert.deepEqual((await searchLibrary(f.member, f.wid, "Protokolle")).books, []);
  const once = await searchLibrary(f.owner, f.wid, "Wiederherstellung");
  assert.equal(once.pages.filter((h) => h.id === f.restore).length, 1);
  assert.deepEqual(await searchLibrary(f.owner, f.wid, "  "), { query: "", shelves: [], books: [], chapters: [], pages: [], total: { shelves: 0, books: 0, chapters: 0, pages: 0 } });
});

test("a library of 1,000 pages on several shelves: bounded statements, fast", async () => {
  const owner = await user("Librarian"),
    reader = await user("Reader"),
    wid = await createWorkspace(owner.id, "Archiv");
  await run("INSERT INTO members VALUES(?,?,?)", wid, reader.id, "viewer");
  // Four shelves of 250 pages: 10 books × 4 chapters × 5 pages + the books
  // and chapters (10 + 40 + 200 = 250).
  const shelves: string[] = [];
  let shared = "";
  for (let s = 0; s < 4; s++) {
    const sid = (await act(owner, { action: "space.create", workspaceId: wid, name: `Regal ${s}`, private: s === 3 })).id as string;
    await act(owner, { action: "space.update", spaceId: sid, name: `Regal ${s}`, private: s === 3, library: true });
    shelves.push(sid);
    let position = 0;
    const insert = async (title: string, parent: string | null) => {
      const pid = id();
      await run(
        "INSERT INTO pages(id,workspace_id,space_id,parent_id,title,kind,position,created_by) VALUES(?,?,?,?,?,?,?,?)",
        pid, wid, sid, parent, title, "document", position++, owner.id,
      );
      return pid;
    };
    for (let b = 0; b < 10; b++) {
      const book = await insert(`Buch ${s}.${b}`, null);
      for (let c = 0; c < 4; c++) {
        const chapter = await insert(`Kapitel ${s}.${b}.${c}`, book);
        for (let p = 0; p < 5; p++) {
          const leaf = await insert(`Seite ${s}.${b}.${c}.${p}`, chapter);
          if (p === 0) await write(leaf, `<p>Eintrag über Leuchttürme in Kapitel ${s}.${b}.${c}.</p>`);
          // A book of the private shelf shared with the reader.
          if (s === 3 && b === 0 && c === 0 && p === 0) shared = book;
        }
      }
    }
  }
  await act(owner, { action: "grant.set", resourceId: shared, userId: reader.id, role: "viewer" });
  await refreshSearchIndex();
  const measure = async <T,>(fn: () => Promise<T>) => {
    const before = statements();
    const start = performance.now();
    // As in an API request (lib/content-locale.ts): one read memo.
    const value = await withReadMemo(fn);
    return { value, statements: statements() - before, ms: performance.now() - start };
  };
  const overview = await measure(() => libraryOverview(owner, wid));
  assert.equal(overview.value.shared.length + overview.value.personal.length, 4);
  assert.equal(overview.value.shared[0].books.length, 10);
  assert.equal(overview.value.shared.reduce((n, s) => n + s.pages, 0) + overview.value.personal.reduce((n, s) => n + s.pages, 0), 1000);
  // Not one per page or book: a handful for the whole library.
  bounded(overview.statements, 40, `overview: ${overview.statements} statements`);
  const readerView = await measure(() => libraryOverview(reader, wid));
  assert.deepEqual(readerView.value.shared.map((s) => [s.name, s.books.length]), [["Regal 0", 10], ["Regal 1", 10], ["Regal 2", 10], ["Regal 3", 1]]);
  assert.equal(readerView.value.shared[3].pages, 25);
  bounded(readerView.statements, 40, `reader overview: ${readerView.statements} statements`);
  const one = await measure(() => spaceLibrary(owner, shelves[0]));
  assert.equal(one.value.books.length, 10);
  bounded(one.statements, 30, `one shelf: ${one.statements} statements`);
  // The search: titles of every level and content hits, grouped.
  const found = await measure(() => searchLibrary(reader, wid, "Kapitel 3.0"));
  assert.ok(found.value.chapters.length >= 4);
  assert.equal(found.value.chapters.every((h) => h.title.startsWith("Kapitel 3.0.")), true);
  bounded(found.statements, 200, `search: ${found.statements} statements`);
  const content = await measure(() => searchLibrary(reader, wid, "Leuchttürme"));
  // 3 team shelves × 40 + 4 pages of the shared book have the word; the
  // full-text search hands over its best 50 (SEARCH_LIMIT).
  assert.equal(content.value.pages.length, Math.min(LIBRARY_GROUP_LIMIT, 50));
  assert.equal(content.value.pages.every((h) => h.snippet?.includes("\u0002") && h.level === 2), true);
  // Of the private shelf only the shared book's pages.
  assert.equal(content.value.pages.filter((h) => h.path[0].title === "Regal 3").every((h) => h.path[1].id === shared), true);
  console.log(
    `library of 1,000 pages: overview ${overview.ms.toFixed(0)} ms / ${overview.statements} statements, reader ${readerView.ms.toFixed(0)} ms / ${readerView.statements}, one shelf ${one.ms.toFixed(0)} ms / ${one.statements}, title search ${found.ms.toFixed(0)} ms / ${found.statements}, content search ${content.ms.toFixed(0)} ms / ${content.statements}`,
  );
  assert.ok(overview.ms < 2000 && found.ms < 3000 && content.ms < 3000);
});
