import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Identity } from "../lib/types";
process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-search-"));
const { one, run, id } = await import("../lib/db");
const { createWorkspace } = await import("../lib/seed");
const { command, bootstrap, database } = await import("../lib/api");
const { searchWorkspace, processSearchIndex, htmlText, MARK_START, MARK_END } =
  await import("../lib/search-index");

async function account(name: string) {
  const uid = id();
  await run(
    "INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)",
    uid,
    uid,
    name,
    `${name}@example.test`,
  );
  return {
    id: uid,
    name,
    email: `${name}@example.test`,
    groups: [],
    isAdmin: false,
    disabled: 0,
    created_at: "",
  } as Identity;
}
const owner = await account("search-owner"),
  member = await account("search-member");
const wid = await createWorkspace(owner.id, "Suche");
await run("INSERT INTO members VALUES(?,?,?)", wid, member.id, "editor");
const team = (await bootstrap(owner, wid)).spaces[0];
const act = async (input: Record<string, unknown>, as = owner) =>
  (await command(as, input)) as { id: string };
const privateSpace = (await act({
  action: "space.create",
  workspaceId: wid,
  name: "Privat",
  private: true,
})).id;
const page = async (title: string, kind = "document", spaceId = team.id) =>
  (await act({ action: "page.create", workspaceId: wid, spaceId, title, kind })).id;
const setHtml = async (pageId: string, html: string) =>
  await run(
    "INSERT INTO documents(page_id,html) VALUES(?,?) ON CONFLICT(page_id) DO UPDATE SET html=excluded.html",
    pageId,
    html,
  );
const find = async (q: string, as = member, options = {}) =>
  await searchWorkspace(as, wid, q, options);

const doc = await page("Quartalsbericht");
await setHtml(
  doc,
  "<h1>Übersicht</h1><p>Die Projektplanung für den Umzug &amp; die Übergänge.</p>",
);
const db = await page("Aufgaben", "database");
await command(owner, {
  action: "database.update",
  pageId: db,
  version: (await database(db)).version,
  fields: [
    { id: "title", name: "Name", type: "text" },
    { id: "note", name: "Notiz", type: "text" },
    { id: "tags", name: "Tags", type: "multiselect", options: ["Kühlschrank"] },
    { id: "link", name: "Link", type: "relation", relationPage: db },
  ],
  views: [{ id: "t", name: "Tabelle", type: "table", filters: [], sorts: [] }],
});
const row = (await act({
  action: "row.create",
  pageId: db,
  cells: {
    title: "Angebot einholen",
    note: "Lieferant anrufen",
    tags: ["Kühlschrank"],
  },
})).id;
const linked = (await act({
  action: "row.create",
  pageId: db,
  cells: { title: "Folgeaufgabe", link: [row] },
})).id;
const secret = await page("Gehaltsliste", "document", privateSpace);
await setHtml(secret, "<p>Vertraulicher Projektplanungsstand</p>");

test("html text strips markup and decodes entities", () => {
  assert.equal(
    htmlText("<p>A &amp; B</p><script>alert(1)</script><b>C&nbsp;D</b>"),
    "A & B C D",
  );
});

test("indexed search finds compound parts, ignores case and diacritics and highlights snippets", async () => {
  const hits = await find("planung");
  assert.deepEqual(
    hits.map((h) => h.title),
    ["Quartalsbericht"],
  );
  assert.equal(hits[0].kind, "document");
  assert.ok(hits[0].snippet.includes(`${MARK_START}planung${MARK_END}`));
  assert.equal((await find("UBERGANGE"))[0]?.id, doc);
  assert.equal((await find("kuhlschrank"))[0]?.rowId, row);
  // Titles rank before body matches.
  assert.equal((await find("aufgabe"))[0]?.id, db);
});

test("record hits carry row ids and database titles; ids of related records are not indexed", async () => {
  const [hit] = await find("Lieferant");
  assert.equal(hit.id, db);
  assert.equal(hit.rowId, row);
  assert.equal(hit.title, "Angebot einholen");
  assert.equal(hit.pageTitle, "Aufgaben");
  assert.equal(hit.kind, "row");
  assert.deepEqual(
    (await find(row.slice(0, 13))).map((h) => h.rowId),
    [],
  );
  assert.ok((await find("Folgeaufgabe")).some((h) => h.rowId === linked));
});

test("results respect permissions, trash, kind and space filters", async () => {
  assert.deepEqual(
    (await find("Projektplanung")).map((h) => h.id),
    [doc],
  );
  assert.deepEqual(
    (await find("Projektplanungsstand", owner)).map((h) => h.id),
    [secret],
  );
  assert.deepEqual(
    (await find("a", member, { kind: "row" })).every((h) => h.kind === "row"),
    true,
  );
  assert.deepEqual(
    (await find("Aufgaben", member, { kind: "database" })).map((h) => h.id),
    [db],
  );
  assert.deepEqual(
    (await find("Projektplanung", owner, { spaceId: privateSpace })).map((h) => h.id),
    [secret],
  );
  await command(owner, { action: "page.delete", pageId: doc });
  assert.deepEqual(await find("Projektplanung"), []);
  await command(owner, { action: "page.restore", pageId: doc });
  assert.deepEqual(
    (await find("Projektplanung")).map((h) => h.id),
    [doc],
  );
});

test("edits, deletions and record documents update the index incrementally", async () => {
  await command(owner, {
    action: "row.update",
    pageId: db,
    rowId: row,
    version: 1,
    cells: { note: "Handwerker beauftragen" },
  });
  assert.deepEqual(await find("Lieferant"), []);
  assert.equal((await find("Handwerker"))[0]?.rowId, row);
  await run(
    "INSERT INTO row_documents(row_id,state,html,generation) VALUES(?,?,?,?)",
    row,
    new Uint8Array(),
    "<p>Rückfrage zur Montage</p>",
    "1",
  );
  assert.equal((await find("montage"))[0]?.rowId, row);
  await command(owner, { action: "row.delete", pageId: db, rowId: row });
  assert.deepEqual(await find("montage"), []);
  assert.equal((await one<{ n: number }>("SELECT COUNT(*) n FROM search_dirty"))!.n, 0);
});

test("query syntax is literal and short queries still work", async () => {
  for (const q of ['"', "AND OR NOT", "*", "planung*", "a:b", "(", "NEAR("])
    await assert.doesNotReject(async () => await find(q));
  assert.equal((await find("Qu"))[0]?.id, doc);
  assert.equal((await find("%")).length, 0);
  // Empty queries list recent accessible pages but no records.
  assert.ok((await find("")).some((h) => h.id === doc));
  assert.ok(!(await find("")).some((h) => h.id === secret));
  assert.deepEqual(await find("", member, { kind: "row" }), []);
});

test("a rebuilt index covers existing data and large backlogs drain in batches", async () => {
  await run("DELETE FROM search_state");
  assert.ok((await processSearchIndex(1)) >= 1);
  let rounds = 0;
  while (await processSearchIndex(2)) rounds++;
  assert.ok(rounds > 0);
  assert.equal((await find("Projektplanung"))[0]?.id, doc);
});

test("comments, text comments and attachment names are searchable with the page's permissions", async () => {
  await command(owner, {
    action: "comment.create",
    pageId: doc,
    body: "Budgetfreigabe bis Freitag",
  });
  const recordRow = (await act({
    action: "row.create",
    pageId: db,
    cells: { title: "Kommentierter Eintrag" },
  })).id;
  await command(owner, {
    action: "comment.create",
    pageId: db,
    rowId: recordRow,
    body: "Lieferschein prüfen",
  });
  await run(
    "INSERT INTO files(id,page_id,name,mime,size,created_by) VALUES(?,?,?,?,?,?)",
    id(),
    doc,
    "Vertragsentwurf.pdf",
    "application/pdf",
    10,
    owner.id,
  );
  await run(
    "INSERT INTO files(id,page_id,name,mime,size,created_by) VALUES(?,?,?,?,?,?)",
    id(),
    secret,
    "Gehaltsdaten.xlsx",
    "application/octet-stream",
    10,
    owner.id,
  );
  const [comment] = await find("budgetfreigabe", member, { kind: "comment" });
  assert.equal(comment.kind, "comment");
  assert.equal(comment.id, doc);
  assert.match(comment.title, /^Kommentar von search-owner/);
  const [recordComment] = await find("Lieferschein", member, { kind: "comment" });
  assert.equal(recordComment.rowId, recordRow);
  const [file] = await find("vertragsentwurf", member, { kind: "file" });
  assert.equal(file.kind, "file");
  assert.equal(file.title, "Vertragsentwurf.pdf");
  assert.deepEqual(await find("Gehaltsdaten", member), []);
  assert.equal((await find("Gehaltsdaten", owner, { kind: "file" })).length, 1);
  // Text comment messages are indexed through their thread's page.
  const thread = id(),
    message = id();
  await run(
    "INSERT INTO inline_threads(id,page_id,anchor) VALUES(?,?,?)",
    thread,
    doc,
    "{}",
  );
  await run(
    "INSERT INTO inline_messages(id,thread_id,author_name,body) VALUES(?,?,?,?)",
    message,
    thread,
    "search-owner",
    "Rückfragezettel anhängen",
  );
  assert.match(
    (await find("rückfragezettel", member))[0]?.title || "",
    /^Textkommentar/,
  );
  await run("UPDATE inline_messages SET deleted=1 WHERE id=?", message);
  assert.deepEqual(await find("rückfragezettel", member), []);
  // Deleting the comment removes it from the index.
  await run("DELETE FROM comments WHERE body=?", "Budgetfreigabe bis Freitag");
  assert.deepEqual(await find("budgetfreigabe", member), []);
  assert.deepEqual(await find("", member, { kind: "comment" }), []);
});

test("PDF attachments are searchable by their text with the page's permissions", async () => {
  const { writeFileSync, mkdirSync } = await import("node:fs");
  const { samplePdf } = await import("./helpers/pdf");
  const { extractPendingFileTexts } = await import("../lib/file-text");
  const dir = join(process.env.FLOWPLAN_DATA_DIR!, "uploads");
  mkdirSync(dir, { recursive: true });
  const attach = async (pageId: string, name: string, data: Buffer) => {
    const fid = id();
    writeFileSync(join(dir, fid), data);
    await run(
      "INSERT INTO files(id,page_id,name,mime,size,created_by) VALUES(?,?,?,?,?,?)",
      fid,
      pageId,
      name,
      "application/pdf",
      data.length,
      owner.id,
    );
    return fid;
  };
  const visible = await attach(
    doc,
    "anlage.pdf",
    samplePdf(["Deckblatt", "Wartungsintervall der Kaeltemaschine"]),
  );
  await attach(secret, "intern.pdf", samplePdf(["Gehaltsband Stufe vier"]));
  const broken = await attach(doc, "kaputt.pdf", Buffer.from("%PDF-1.4 kaputt"));
  while (await extractPendingFileTexts());
  const [hit] = await find("wartungsintervall", member, { kind: "file" });
  assert.equal(hit.title, "anlage.pdf");
  assert.equal(hit.id, doc);
  // The snippet comes from the PDF text, not only the file name.
  assert.ok(hit.snippet.includes(`${MARK_START}Wartu`));
  // Private pages keep their attachments private.
  assert.deepEqual(await find("gehaltsband", member), []);
  assert.equal((await find("gehaltsband", owner)).length, 1);
  // Broken files are recorded once and not retried.
  assert.equal(
    (await one<{ status: string }>(
      "SELECT status FROM file_texts WHERE file_id=?",
      broken,
    ))?.status,
    "error",
  );
  assert.equal(await extractPendingFileTexts(), 0);
  // Deleting the file removes its text from the index.
  await run("DELETE FROM files WHERE id=?", visible);
  assert.deepEqual(await find("wartungsintervall", member), []);
});
