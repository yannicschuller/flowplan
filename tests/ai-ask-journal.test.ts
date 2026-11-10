// Ask AI about a journal: "the last …" questions find the newest day that
// is about the question – typed, as a person mention, in handwriting (a
// drawing block or a notebook below the day) – and handwriting and PDF text
// of notebooks reach the AI. Rights checks as everywhere (PIN journals,
// trash, blocked pages).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-ai-ask-journal-"));
process.env.APP_URL = "https://flowplan.example.test";
process.env.FLOWPLAN_AI_REQUESTS_PER_HOUR = "100000";
delete process.env.FLOWPLAN_AI;
const { run, one, id } = await import("../lib/db");
const { createWorkspace, createPage } = await import("../lib/seed");
const { identityFromToken } = await import("../lib/auth");
const { command } = await import("../lib/api");
const { prepareAsk } = await import("../lib/ai/ask");
const { sourceText } = await import("../lib/ai/sources");
const { writeSurface } = await import("../lib/page-ink-store");
const { emptyInk, withPage } = await import("../lib/ink/model");
const { createNotebook, notebookSheets } = await import("../lib/notebook");
const { startOllamaMock } = await import("./helpers/ai-mock");
import type { Identity } from "../lib/types";

async function person(name: string): Promise<Identity> {
  const uid = id();
  await run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, name, `${name.toLowerCase()}@example.test`);
  const token = randomBytes(16).toString("hex");
  await run("INSERT INTO sessions(token,user_id,groups_json,expires) VALUES(?,?,?,?)", createHash("sha256").update(token).digest("hex"), uid, "[]", Date.now() + 3600_000);
  return (await identityFromToken(token))!;
}
const admin = { ...(await person("Ada")), isAdmin: true };
const batu = await person("Batu");
const wid = await createWorkspace(admin.id, "Nachhilfe");
const space = (await one<{ id: string }>("SELECT id FROM spaces WHERE workspace_id=?", wid))!.id;
const html = async (page: string, body: string) => await run("UPDATE documents SET html=? WHERE page_id=?", body, page);
const mock = await startOllamaMock();
after(() => mock.close());
await command(admin, { action: "admin.ai", settings: { enabled: true, semanticSearch: false, provider: { kind: "ollama", baseUrl: mock.base, model: "chat", embeddingModel: "" } } });
const ask = (question: string) => prepareAsk(admin, { workspaceId: wid, question });
const mention = (user: Identity) => `<span data-mention="${user.id}" class="mention">@${user.name}</span>`;
const text = (surface: string, value: string) => withPage(emptyInk(), surface, [{ id: "t1", type: "text", color: "#000", size: 14, x: 10, y: 10, text: value }]);

let journal = "";
const day = async (date: string, body: string) => {
  const pageId = await createPage(wid, space, admin.id, date, "document", journal);
  await run("UPDATE pages SET journal_date=? WHERE id=?", date, pageId);
  await html(pageId, body);
  return pageId;
};
const datesIn = (prompt: string) => [...prompt.matchAll(/datum="(\d{4}-\d{2}-\d{2})"/g)].map((m) => m[1]);

test("the last topics with a person: many older days do not crowd out the newest one", async () => {
  journal = await createPage(wid, space, admin.id, "Tagebuch", "journal");
  // A year of lessons: short entries that say "Batu" a lot (BM25 likes them).
  for (let w = 0; w < 40; w++) {
    const d = new Date(Date.UTC(2025, 9, 1 + 7 * w)).toISOString().slice(0, 10);
    await day(d, `<p>Batu Batu: Nachhilfe mit Batu, Thema ${w}. Batu hat Hausaufgaben.</p>`);
  }
  await day("2026-09-26", `<p>Mit Batu Bruchrechnung und Dezimalzahlen geübt.</p>`);
  // Newer, but not about Batu: the topic word only.
  await day("2026-10-12", "<p>Neue Themen für den Elternabend gesammelt.</p>");
  // The newest day: one mention of Batu in a long entry.
  const filler = Array.from({ length: 30 }, (_, i) => `<p>Absatz ${i}: Einkaufen, Sport, Garten und andere Dinge des Tages.</p>`).join("");
  const newest = await day("2026-11-08", `${filler}<p>Nachmittags mit ${mention(batu)}: lineare Funktionen und Steigungsdreiecke.</p>`);
  const prepared = await ask("Was waren die letzten Themen die ich mit Batu behandelt habe?");
  const prompt = prepared.messages.at(-1)!.content;
  assert.ok(prepared.sources.some((s) => s.pageId === newest), "the newest day with Batu is a source");
  assert.match(prompt, /Steigungsdreiecke/);
  // The newest day about Batu comes first, before the newer day that only
  // shares the word "Themen"; the day before it is there too.
  assert.equal(datesIn(prompt)[0], "2026-11-08", datesIn(prompt).join(" "));
  assert.ok(datesIn(prompt).includes("2026-09-26"), datesIn(prompt).join(" "));
  assert.match(prepared.system, /Heute ist \d{4}-\d{2}-\d{2}\./);
});

test("a day written by hand: the recognised text of a drawing block reaches the AI", async () => {
  journal = await createPage(wid, space, admin.id, "Handschrift-Journal", "journal");
  await day("2026-09-26", "<p>Mit Kemal Vokabeln gelernt.</p>");
  const inked = await day("2026-11-08", '<div data-ink-block="blk1"></div>');
  await writeSurface(inked, "blk1", text("blk1", "Kemal Stunde"), "Kemal: Satz des Pythagoras und Hypotenuse");
  // A drawing block removed from the document is not read any more.
  await writeSurface(inked, "gone", text("gone", "Kemal ALTERBLOCK"), "");
  const source = await sourceText(inked);
  assert.ok(source?.chunks.some((c) => c.includes("Pythagoras")), JSON.stringify(source?.chunks));
  assert.ok(!source?.chunks.some((c) => c.includes("ALTERBLOCK")));
  const prepared = await ask("Was habe ich zuletzt mit Kemal gemacht?");
  const prompt = prepared.messages.at(-1)!.content;
  assert.match(prompt, /Pythagoras/);
  assert.equal(datesIn(prompt)[0], "2026-11-08");
});

test("a notebook below a journal day: its handwriting has the day's date", async () => {
  journal = await createPage(wid, space, admin.id, "Heft-Journal", "journal");
  await day("2026-09-26", "<p>Mit Leonie Grammatik.</p>");
  const parent = await day("2026-11-08", "<p>Notizen im Heft.</p>");
  const notebook = await createPage(wid, space, admin.id, "Heft", "notebook", parent);
  await createNotebook(notebook);
  const [sheet] = await notebookSheets(notebook);
  await writeSurface(notebook, sheet.id, text(sheet.id, "Leonie"), "Leonie: Kommasetzung bei Nebensätzen");
  const prepared = await ask("Was war das letzte Thema mit Leonie?");
  const prompt = prepared.messages.at(-1)!.content;
  assert.match(prompt, /Kommasetzung/);
  assert.equal(datesIn(prompt)[0], "2026-11-08");
});

test("handwriting in a PIN journal never reaches the AI", async () => {
  journal = await createPage(wid, space, admin.id, "Geheim-Journal", "journal");
  const inked = await day("2026-11-09", '<div data-ink-block="blk2"></div>');
  await writeSurface(inked, "blk2", text("blk2", "Zora"), "Zora GEHEIMEHANDSCHRIFT");
  await run("INSERT INTO journal_settings(page_id,lock_hash) VALUES(?,?)", journal, "pin-hash");
  const prepared = await ask("Was war zuletzt mit Zora?");
  assert.doesNotMatch(prepared.messages.at(-1)?.content || "", /GEHEIMEHANDSCHRIFT/);
  assert.ok(!prepared.sources.some((s) => s.pageId === inked));
});

const file = async (pageId: string, name: string, mime: string, text: string) => {
  const fid = crypto.randomUUID();
  await run("INSERT INTO files(id,page_id,name,mime,size,created_by) VALUES(?,?,?,?,?,?)", fid, pageId, name, mime, 1, admin.id);
  await run("INSERT INTO file_texts(file_id,text,status) VALUES(?,?,?)", fid, text, "ocr");
  return fid;
};

test("text of files (a photo read by OCR, a PDF in a notebook) reaches the AI with its page", async () => {
  journal = await createPage(wid, space, admin.id, "Foto-Journal", "journal");
  await day("2026-09-26", "<p>Mit Malik Englisch.</p>");
  const photo = await day("2026-11-08", '<p><img src="/api/files/x"></p>');
  await file(photo, "tafel.jpg", "image/jpeg", "Malik Tafelbild: Bruchgleichungen");
  const prepared = await ask("Was habe ich zuletzt mit Malik gemacht?");
  const prompt = prepared.messages.at(-1)!.content;
  assert.match(prompt, /Bruchgleichungen/);
  assert.equal(datesIn(prompt)[0], "2026-11-08");
  // A notebook made from a PDF: the PDF's text is part of the notebook.
  const notebook = await createPage(wid, space, admin.id, "Skript", "notebook");
  await createNotebook(notebook);
  await file(notebook, "skript.pdf", "application/pdf", "Kapitel 3: Thermodynamik und Entropie");
  assert.ok((await sourceText(notebook))?.chunks.some((c) => c.includes("Entropie")));
  assert.ok((await ask("Was steht im Skript zur Entropie?")).sources.some((s) => s.pageId === notebook));
  // A file that was deleted is not read.
  const gone = await file(notebook, "alt.pdf", "application/pdf", "GELOESCHTEDATEI Entropie");
  await run("UPDATE files SET deleted_at=? WHERE id=?", new Date().toISOString(), gone);
  assert.ok(!(await sourceText(notebook))?.chunks.some((c) => c.includes("GELOESCHTEDATEI")));
});

test("file texts follow the page's rights: a private page stays out for others", async () => {
  const other = await person("Olga");
  await run("INSERT INTO members VALUES(?,?,?)", wid, other.id, "editor");
  const privateSpace = id();
  await run("INSERT INTO spaces(id,workspace_id,name,visibility,owner_id) VALUES(?,?,?,?,?)", privateSpace, wid, "Privat", "private", admin.id);
  const secret = await createPage(wid, privateSpace, admin.id, "Scan");
  await file(secret, "scan.png", "image/png", "Quittung PRIVATERSCAN Steuerberater");
  const prepared = await prepareAsk(other, { workspaceId: wid, question: "Wo ist die Quittung vom Steuerberater?" });
  assert.doesNotMatch(prepared.messages.at(-1)?.content || "", /PRIVATERSCAN/);
  assert.ok(!prepared.sources.some((s) => s.pageId === secret));
  // The owner finds it.
  assert.match((await ask("Wo ist die Quittung vom Steuerberater?")).messages.at(-1)!.content, /PRIVATERSCAN/);
});

test("new handwriting or file text marks the page for meaning search again", async () => {
  const { processSearchIndex } = await import("../lib/search-index");
  while (await processSearchIndex()) {}
  const notebook = await createPage(wid, space, admin.id, "Neues Heft", "notebook");
  await createNotebook(notebook);
  while (await processSearchIndex()) {}
  await run("DELETE FROM ai_embed_dirty");
  const [sheet] = await notebookSheets(notebook);
  await writeSurface(notebook, sheet.id, text(sheet.id, "Neu"), "neu erkannt");
  while (await processSearchIndex()) {}
  assert.ok(await one("SELECT 1 FROM ai_embed_dirty WHERE page_id=? AND row_id=''", notebook));
});
