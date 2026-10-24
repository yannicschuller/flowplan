import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-ai-database-"));
process.env.APP_URL = "https://flowplan.example.test";
process.env.FLOWPLAN_AI_REQUESTS_PER_HOUR = "100000";
delete process.env.FLOWPLAN_AI;
const { run, one, id } = await import("../lib/db");
const { createWorkspace, createPage } = await import("../lib/seed");
const { identityFromToken } = await import("../lib/auth");
const { command, database } = await import("../lib/api");
const { identityFromApiToken } = await import("../lib/api-tokens");
const { renderAiPrompt, constrainAiValue, INVALID, normalizeProposal, promptReferences, aiInputHash } = await import("../lib/ai/database-fields");
const { runAiCell, queueAiCells, processAiCellJobs, processAutoDirty, proposeDatabase, aiDatabaseStatus } = await import("../lib/ai/database");
const { startOllamaMock } = await import("./helpers/ai-mock");
import type { Field, Identity } from "../lib/types";

function person(name: string): Identity {
  const uid = id();
  run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, name, `${name.toLowerCase()}@example.test`);
  const token = randomBytes(16).toString("hex");
  run("INSERT INTO sessions(token,user_id,groups_json,expires) VALUES(?,?,?,?)", createHash("sha256").update(token).digest("hex"), uid, "[]", Date.now() + 3600_000);
  return identityFromToken(token)!;
}
const admin = { ...person("Ada"), isAdmin: true };
const ben = person("Ben"),
  vic = person("Vic"),
  gus = person("Gus"),
  eva = person("Eva");
const wid = createWorkspace(admin.id, "Team");
run("INSERT INTO members VALUES(?,?,?)", wid, ben.id, "editor");
run("INSERT INTO members VALUES(?,?,?)", wid, vic.id, "viewer");
run("INSERT INTO members VALUES(?,?,?)", wid, gus.id, "editor");
run("INSERT INTO members VALUES(?,?,?)", wid, eva.id, "editor");
run("INSERT INTO workspace_guests VALUES(?,?)", wid, gus.id);
const space = one<{ id: string }>("SELECT id FROM spaces WHERE workspace_id=?", wid)!.id;

const mock = await startOllamaMock();
after(() => mock.close());
const setAi = (settings: Record<string, unknown>) => command(admin, { action: "admin.ai", settings });

// Books with a description, a category (AI select) and a summary (AI text).
const books = createPage(wid, space, admin.id, "Bücher", "database");
run("INSERT INTO grants(resource_id,user_id,role) VALUES(?,?,?)", books, gus.id, "editor");
const base: Field[] = [
  { id: "title", name: "Titel", type: "text" },
  { id: "desc", name: "Beschreibung", type: "text" },
  { id: "author", name: "Autor", type: "text" },
  { id: "genre", name: "Genre", type: "select", options: ["Roman", "Sachbuch", "Krimi"] },
  { id: "tags", name: "Tags", type: "multiselect", options: ["Spannend", "Lustig", "Lang"] },
  { id: "pages", name: "Seiten", type: "number" },
];
function schema(user: Identity, fields: Field[]) {
  const d = database(books);
  return command(user, { action: "database.update", pageId: books, version: d.version, fields, views: d.views });
}
const row = (cells: Record<string, unknown>, user: Identity = admin) => (command(user, { action: "row.create", pageId: books, cells }) as { id: string }).id;
const cells = (rowId: string) => JSON.parse(one<{ cells: string }>("SELECT cells FROM rows WHERE id=?", rowId)!.cells) as Record<string, unknown>;
const field = (fid: string) => database(books).fields.find((f) => f.id === fid)!;
const context = { names: () => "", relationTitles: () => [], content: () => "Inhalt des Eintrags" };
// The debounce and the queue on one clock. processAutoDirty queues its jobs
// due at the `now` it is given; the queue must then run at that time, not at
// its own Date.now(), which can still be the millisecond before.
let clock = 0;
const later = () => (clock = Math.max(Date.now(), clock) + 1);
const settle = () => processAutoDirty(0, later());
const work = () => processAiCellJobs(50, Math.max(Date.now(), clock));

// ---- Templates and constraints ----

test("prompt templates: values by property name, content, emptiness", () => {
  const fields: Field[] = [...base, { id: "summary", name: "Kurz", type: "text", ai: { prompt: "x" } }];
  assert.deepEqual(promptReferences("Fasse {Beschreibung} und { Autor } zusammen"), ["Beschreibung", "Autor"]);
  const rendered = renderAiPrompt("Fasse {Beschreibung} von {autor} in einem Satz zusammen. {Unbekannt} {Inhalt}", fields, { desc: "Ein Wal.", author: "Melville" }, { id: "r" }, context);
  assert.equal(rendered.text, "Fasse Ein Wal. von Melville in einem Satz zusammen. {Unbekannt} Inhalt des Eintrags");
  assert.equal(rendered.empty, false);
  assert.equal(renderAiPrompt("Kategorie aus {Titel}", fields, {}, { id: "r" }, context).empty, true);
  assert.equal(renderAiPrompt("Erfinde einen Namen", fields, {}, { id: "r" }, context).empty, false);
  assert.equal(renderAiPrompt("{Genre}/{Tags}/{Seiten}", fields, { genre: "Roman", tags: ["Lang", "Spannend"], pages: 635 }, { id: "r" }, context).text, "Roman/Lang, Spannend/635");
  // The hash changes with inputs and with the prompt.
  const f = fields[fields.length - 1];
  assert.notEqual(aiInputHash(f, "a"), aiInputHash(f, "b"));
  assert.notEqual(aiInputHash(f, "a"), aiInputHash({ ...f, ai: { prompt: "y" } }, "a"));
});

test("values are constrained to what the property allows", () => {
  const genre = base[3],
    tags = base[4],
    pages = base[5];
  assert.equal(constrainAiValue(genre, "Krimi"), "Krimi");
  assert.equal(constrainAiValue(genre, " „krimi“. "), "Krimi");
  assert.equal(constrainAiValue(genre, ["Roman"]), "Roman");
  assert.equal(constrainAiValue(genre, "Fantasy"), INVALID, "no invented options");
  assert.equal(constrainAiValue(genre, 3), INVALID);
  assert.equal(constrainAiValue(genre, null), null);
  assert.deepEqual(constrainAiValue(tags, ["spannend", "Lang", "Neu", "Lang"]), ["Spannend", "Lang"]);
  assert.deepEqual(constrainAiValue(tags, "Lustig, Lang"), ["Lustig", "Lang"]);
  assert.equal(constrainAiValue(tags, ["Neu"]), INVALID);
  assert.deepEqual(constrainAiValue(tags, []), []);
  assert.equal(constrainAiValue(pages, "1.234,5"), 1234.5);
  assert.equal(constrainAiValue(pages, "ca. 300"), INVALID);
  assert.equal(constrainAiValue(pages, "300 Seiten"), 300);
  assert.equal(constrainAiValue(pages, Infinity), INVALID);
  assert.equal(constrainAiValue({ ...pages, rollupDisplay: "rating", rollupMax: 5 }, 7.6), 5);
  assert.equal(constrainAiValue({ ...pages, decimals: 1 }, 2.345), 2.3);
  assert.equal(constrainAiValue({ id: "c", name: "c", type: "checkbox" }, "ja"), true);
  assert.equal(constrainAiValue({ id: "d", name: "d", type: "date" }, "2026-02-30"), INVALID);
  assert.equal(constrainAiValue({ id: "d", name: "d", type: "date" }, "2026-02-28"), "2026-02-28");
  assert.equal(constrainAiValue({ id: "u", name: "u", type: "url" }, "javascript:alert(1)"), INVALID);
  assert.equal(constrainAiValue({ id: "e", name: "e", type: "email" }, "a@b.de"), "a@b.de");
  assert.equal(constrainAiValue(base[1], { nested: true }), INVALID);
  assert.equal((constrainAiValue(base[1], "x".repeat(10_000)) as string).length, 4000);
});

test("AI properties are checked when saved; automatic updates run as the person who switches them on", () => {
  setAi({ enabled: true, provider: { kind: "ollama", baseUrl: mock.base, model: "chat", embeddingModel: "" } });
  const ai = (prompt: string, extra: Partial<Field> = {}): Field => ({ id: "summary", name: "Zusammenfassung", type: "text", ai: { prompt }, ...extra });
  assert.throws(() => schema(admin, [...base, ai("Fasse {Klappentext} zusammen")]), /Unbekannte Eigenschaft/);
  assert.throws(() => schema(admin, [...base, ai("Fasse {Zusammenfassung} zusammen")]), /eigene Eigenschaft/);
  assert.throws(() => schema(admin, [...base, ai("x", { type: "date" })]), /Text, eine Auswahl/);
  assert.throws(() => schema(admin, [...base, ai("x", { type: "select", options: [] })]), /Optionen/);
  assert.throws(
    () =>
      schema(admin, [
        ...base,
        { id: "a1", name: "Eins", type: "text", ai: { prompt: "{Zwei}" } },
        { id: "a2", name: "Zwei", type: "text", ai: { prompt: "{Eins}" } },
      ]),
    /im Kreis/,
  );
  // autoBy from the browser is ignored: the person saving it is set.
  schema(ben, [...base, ai("Fasse {Beschreibung} in einem Satz zusammen", { ai: { prompt: "Fasse {Beschreibung} in einem Satz zusammen", auto: true, autoBy: admin.id } })]);
  assert.equal(field("summary").ai?.autoBy, ben.id);
  // Someone else saving other properties keeps it; changing the prompt takes it over.
  schema(admin, [...database(books).fields.map((f) => (f.id === "author" ? { ...f, name: "Autor" } : f))]);
  assert.equal(field("summary").ai?.autoBy, ben.id);
  schema(eva, database(books).fields.map((f) => (f.id === "summary" ? { ...f, ai: { ...f.ai!, prompt: "Fasse {Beschreibung} kurz zusammen" } } : f)));
  assert.equal(field("summary").ai?.autoBy, eva.id);
  // Off: no autoBy stays behind.
  schema(admin, database(books).fields.map((f) => (f.id === "summary" ? { ...f, ai: { prompt: f.ai!.prompt, auto: false, autoBy: eva.id } } : f)));
  assert.equal(field("summary").ai?.autoBy, undefined);
  // Guests cannot switch automatic updates on.
  assert.throws(() => schema(gus, database(books).fields.map((f) => (f.id === "summary" ? { ...f, ai: { ...f.ai!, auto: true } } : f))), /Gäste/);
  // Without AI for the person, no automatic updates in their name.
  command(eva, { action: "ai.settings", features: { database: false } });
  assert.throws(() => schema(eva, database(books).fields.map((f) => (f.id === "summary" ? { ...f, ai: { ...f.ai!, auto: true } } : f))), /ausgeschaltet/);
  command(eva, { action: "ai.settings", features: { database: true } });
  schema(admin, [
    ...database(books).fields.filter((f) => f.id !== "summary"),
    { id: "summary", name: "Zusammenfassung", type: "text", ai: { prompt: "Fasse {Beschreibung} in einem Satz zusammen" } },
    { id: "category", name: "Kategorie", type: "select", options: ["Roman", "Sachbuch", "Krimi"], ai: { prompt: "Kategorie aus {Titel}: eine von Roman, Sachbuch, Krimi" } },
  ]);
});

test("one value: computed, constrained, written like an edit, with metadata", async () => {
  const moby = row({ title: "Moby Dick", desc: "Ein Kapitän jagt einen weißen Wal." });
  mock.answer = (request) => (request.system.includes("Kategorie") ? '{"value": "roman"}' : '```json\n{"value": "Ahab jagt den Wal."}\n```');
  const before = mock.chats.length;
  const result = await runAiCell(ben, books, "summary", moby, "compute");
  assert.deepEqual(result, { status: "ok", value: "Ahab jagt den Wal." });
  assert.match(mock.chats[before].prompt, /Fasse Ein Kapitän jagt einen weißen Wal\. in einem Satz zusammen/);
  assert.equal(cells(moby).summary, "Ahab jagt den Wal.");
  const meta = one<{ model: string; provider: string; computed_by: string; status: string }>("SELECT * FROM ai_cell_meta WHERE row_id=? AND field_id='summary'", moby)!;
  assert.deepEqual([meta.model, meta.provider, meta.computed_by, meta.status], ["chat", "ollama", ben.id, "ok"]);
  assert.equal(one<{ updated_by: string }>("SELECT updated_by FROM rows WHERE id=?", moby)!.updated_by, ben.id);
  // Select: the answer is matched to an option.
  assert.equal((await runAiCell(ben, books, "category", moby, "compute")).value, "Roman");
  const status = aiDatabaseStatus(vic, books);
  assert.equal(status.meta[moby].summary.model, "chat");
});

test("invalid JSON or an invented option gets one retry, then nothing is written", async () => {
  const dune = row({ title: "Dune" });
  mock.answer = (_r, i) => (i % 2 === 0 ? "Das ist sicher ein Roman!" : '{"value": "Roman"}');
  mock.chats.length = 0;
  assert.equal((await runAiCell(ben, books, "category", dune, "compute")).value, "Roman");
  assert.equal(mock.chats.length, 2, "one retry");
  assert.match(mock.chats[1].prompt, /kein gültiges JSON/);
  mock.answer = () => '{"value": "Fantasy"}';
  mock.chats.length = 0;
  await assert.rejects(runAiCell(ben, books, "category", dune, "compute"), /keine verwertbare Antwort/);
  assert.equal(mock.chats.length, 2);
  assert.match(mock.chats[1].prompt, /genau eine dieser Optionen/);
  assert.equal(cells(dune).category, "Roman", "the old value stays");
});

test("empty inputs give an empty value without asking the model", async () => {
  const empty = row({ title: "Leer" });
  mock.chats.length = 0;
  const result = await runAiCell(ben, books, "summary", empty, "compute");
  assert.equal(result.status, "cleared");
  assert.equal(mock.chats.length, 0);
});

test("who may compute: viewers, guests, API tokens, switched-off AI, private and closed records", async () => {
  const it = row({ title: "Es", desc: "Ein Clown." });
  await assert.rejects(runAiCell(vic, books, "summary", it, "compute"), /Berechtigung/);
  await assert.rejects(runAiCell(gus, books, "summary", it, "compute"), /Gäste|ausgeschaltet/);
  const { token } = command(ben, { action: "token.create", name: "Skript", scope: "write" }) as { token: string };
  await assert.rejects(runAiCell(identityFromApiToken(`Bearer ${token}`)!, books, "summary", it, "compute"), /API-Token/);
  setAi({ features: { database: false } });
  await assert.rejects(runAiCell(ben, books, "summary", it, "compute"), /ausgeschaltet/);
  setAi({ features: { database: true } });
  // Another person's private record.
  const secret = row({ title: "Privat", desc: "GEHEIM" });
  run("UPDATE rows SET access='private' WHERE id=?", secret);
  mock.chats.length = 0;
  await assert.rejects(runAiCell(ben, books, "summary", secret, "compute"), /nicht gefunden|schreibgeschützt/);
  // The person excluded the database from the AI.
  command(ben, { action: "ai.rule", targetId: books, mode: "exclude" });
  await assert.rejects(runAiCell(ben, books, "summary", it, "compute"), /für die KI gesperrt/);
  command(ben, { action: "ai.rule", targetId: books, mode: null });
  assert.ok(!mock.chats.some((c) => c.prompt.includes("GEHEIM")));
  // Queueing checks the same way: viewers and guests cannot.
  assert.throws(() => queueAiCells(vic, { pageId: books, fieldId: "summary", mode: "compute" }), /Berechtigung/);
  assert.throws(() => queueAiCells(gus, { pageId: books, fieldId: "summary", mode: "compute" }), /Gäste/);
});

test("Für alle ausfüllen: queued, processed in the background, private records skipped", async () => {
  mock.answer = (request) => `{"value": "Zusammenfassung: ${request.prompt.length}"}`;
  const queued = queueAiCells(ben, { pageId: books, fieldId: "summary", mode: "compute" });
  const total = one<{ n: number }>("SELECT count(*) n FROM rows WHERE page_id=?", books)!.n;
  assert.equal(queued.queued, total - 1, "the private record is skipped");
  assert.equal(aiDatabaseStatus(ben, books).pending, queued.queued);
  while (aiDatabaseStatus(ben, books).pending) await work();
  const filled = (await import("../lib/db")).all<{ cells: string }>("SELECT cells FROM rows WHERE page_id=? AND access!='private'", books);
  // Records with a description got a summary; without one there is nothing to summarize.
  for (const r of filled.map((x) => JSON.parse(x.cells))) assert.equal(typeof r.summary === "string" && r.summary.startsWith("Zusammenfassung"), !!r.desc, JSON.stringify(r));
});

test("Mit KI ausfüllen: only empty cells of the chosen property, constrained to its options", async () => {
  const a = row({ title: "Witzebuch", desc: "Lauter Witze" });
  const b = row({ title: "Schon getaggt", tags: ["Lang"] });
  mock.answer = () => '{"value": ["Lustig", "Erfunden"]}';
  const queued = queueAiCells(ben, { pageId: books, fieldId: "tags", rowIds: [a, b], mode: "fill" });
  assert.deepEqual(queued, { queued: 1, skipped: 1 });
  await work();
  assert.deepEqual(cells(a).tags, ["Lustig"]);
  assert.deepEqual(cells(b).tags, ["Lang"], "filled cells stay");
  assert.match(mock.chats[mock.chats.length - 1].prompt, /Gesucht: Tags/);
  await assert.rejects(runAiCell(ben, books, "nope", a, "fill"), /Eigenschaft fehlt/);
});

test("over the rate limit, queued values wait instead of failing", async () => {
  const limited = person("Lia");
  run("INSERT INTO members VALUES(?,?,?)", wid, limited.id, "editor");
  const r = row({ title: "Warten", desc: "Text" });
  queueAiCells(limited, { pageId: books, fieldId: "summary", rowIds: [r], mode: "compute" });
  process.env.FLOWPLAN_AI_REQUESTS_PER_HOUR = "1";
  const { limitAi } = await import("../lib/action-limits");
  try {
    limitAi(limited.id);
  } catch {}
  await work();
  const job = one<{ next_at: number }>("SELECT next_at FROM ai_cell_jobs WHERE row_id=?", r);
  assert.ok(job && job.next_at > Date.now() + 30_000, "postponed by a minute");
  process.env.FLOWPLAN_AI_REQUESTS_PER_HOUR = "100000";
});

test("automatic updates: debounced, only when inputs change, stop when the person loses access", async (t) => {
  schema(ben, database(books).fields.map((f) => (f.id === "summary" ? { ...f, ai: { ...f.ai!, auto: true } } : f)));
  const r = row({ title: "Faust", desc: "Ein Gelehrter wettet." });
  mock.answer = (request) => `{"value": "Kurz: ${request.prompt.includes("Teufel") ? "Teufel" : "Gelehrter"}"}`;
  assert.ok(one("SELECT 1 FROM ai_auto_dirty WHERE row_id=?", r), "new records are marked");
  assert.equal(processAutoDirty(60_000), 0, "debounced: too recent");
  assert.equal(settle(), 1);
  assert.equal(one<{ user_id: string; mode: string }>("SELECT user_id,mode FROM ai_cell_jobs WHERE row_id=?", r)?.user_id, ben.id);
  await work();
  assert.equal(cells(r).summary, "Kurz: Gelehrter");
  // Its own write and changes elsewhere do not recompute.
  settle();
  const v = one<{ version: number }>("SELECT version FROM rows WHERE id=?", r)!.version;
  command(admin, { action: "row.update", pageId: books, rowId: r, version: v, cells: { author: "Goethe" } });
  assert.equal(settle(), 0, "the author is no input");
  // A referenced property changes: recomputed as Ben.
  const v2 = one<{ version: number }>("SELECT version FROM rows WHERE id=?", r)!.version;
  command(admin, { action: "row.update", pageId: books, rowId: r, version: v2, cells: { desc: "Ein Gelehrter wettet mit dem Teufel." } });
  assert.equal(settle(), 1);
  await work();
  assert.equal(cells(r).summary, "Kurz: Teufel");
  assert.equal(one<{ computed_by: string }>("SELECT computed_by FROM ai_cell_meta WHERE row_id=? AND field_id='summary'", r)!.computed_by, ben.id);
  // Ben becomes a viewer: the next run stops automatic updates.
  run("UPDATE members SET role='viewer' WHERE workspace_id=? AND user_id=?", wid, ben.id);
  // Restored even if an assertion fails, so later tests keep Ben as editor.
  t.after(() => run("UPDATE members SET role='editor' WHERE workspace_id=? AND user_id=?", wid, ben.id));
  const v3 = one<{ version: number }>("SELECT version FROM rows WHERE id=?", r)!.version;
  command(admin, { action: "row.update", pageId: books, rowId: r, version: v3, cells: { desc: "Neu." } });
  settle();
  await work();
  assert.equal(field("summary").ai?.auto, undefined, "switched off");
  assert.equal(cells(r).summary, "Kurz: Teufel", "nothing written in his name");
});

test("automatic values never take 'Zuletzt geändert' as input: refused when saved, left out of the hash", async (t) => {
  const withChanged: Field[] = [...database(books).fields.filter((f) => f.id !== "summary"), { id: "changed", name: "Geändert", type: "updated_at" }];
  const stamped = (ai: Partial<Field["ai"]> = {}): Field => ({ id: "summary", name: "Zusammenfassung", type: "text", ai: { prompt: "Fasse {Beschreibung} zusammen, Stand {Geändert}", ...ai } });
  assert.throws(() => schema(ben, [...withChanged, stamped({ auto: true })]), /jedem Schreiben der KI/);
  // Without automatic updates the reference is fine.
  schema(ben, [...withChanged, stamped()]);
  // A property switched on before this check existed: its own write must
  // not queue it again once the minute changes.
  run("UPDATE databases SET fields=? WHERE page_id=?", JSON.stringify([...withChanged, stamped({ auto: true, autoBy: ben.id })]), books);
  // Switched off again even if an assertion fails: later schema saves would be refused.
  t.after(() => schema(admin, [...withChanged, stamped()]));
  let calls = 0;
  mock.answer = () => `{"value": "Antwort ${++calls}"}`;
  // Only this record's prompts (jobs of earlier tests may still be waiting).
  const asked = () => mock.chats.filter((c) => c.prompt.includes("Briefe"));
  const r = row({ title: "Werther", desc: "Briefe eines Unglücklichen." });
  assert.equal(settle(), 1);
  await work();
  assert.equal(asked().length, 1);
  assert.match(asked()[0].prompt, /Stand \d{4}-\d{2}-\d{2}/, "the prompt itself carries the timestamp");
  assert.ok(one("SELECT 1 FROM ai_auto_dirty WHERE row_id=?", r), "marked dirty by its own write");
  run("UPDATE rows SET cells=cells,updated_at=datetime('now','+2 minutes') WHERE id=?", r);
  assert.equal(settle(), 0, "a later minute is no new input");
  await work();
  assert.equal(asked().length, 1);
  // A referenced property changing still recomputes.
  const v = one<{ version: number }>("SELECT version FROM rows WHERE id=?", r)!.version;
  command(admin, { action: "row.update", pageId: books, rowId: r, version: v, cells: { desc: "Briefe an Lotte." } });
  assert.equal(settle(), 1);
  await work();
  assert.equal(asked().length, 2);
});

test("removing an AI property removes its bookkeeping", () => {
  assert.ok(one("SELECT 1 FROM ai_cell_meta WHERE page_id=? AND field_id='category'", books));
  schema(admin, database(books).fields.filter((f) => f.id !== "category"));
  assert.equal(one("SELECT 1 FROM ai_cell_meta WHERE page_id=? AND field_id='category'", books), undefined);
});

// ---- A database from a description ----

test("proposals are validated strictly and normalized", () => {
  assert.throws(() => normalizeProposal({ fields: [{ name: "X", type: "formula" }] }));
  assert.throws(() => normalizeProposal({ fields: [] }));
  assert.throws(() => normalizeProposal({ fields: Array.from({ length: 26 }, (_, i) => ({ name: `F${i}`, type: "text" })) }));
  assert.throws(() => normalizeProposal({ fields: [{ name: "x".repeat(61), type: "text" }] }));
  assert.throws(() => normalizeProposal({ fields: [{ name: "A", type: "select", options: Array.from({ length: 31 }, (_, i) => `o${i}`) }] }));
  const p = normalizeProposal({
    title: "Leseliste",
    fields: [
      { name: "Bewertung", type: "number", options: ["unnötig"] },
      { name: "Titel", type: "text" },
      { name: "Genre", type: "select", options: ["Roman", "Roman", "Krimi"] },
      { name: "genre", type: "text" },
      { name: "Status", type: "select", options: [] },
      { name: "Gelesen", type: "checkbox", extra: "wird ignoriert" },
    ],
    rows: [
      { Titel: "Dune", Genre: "Science-Fiction", Bewertung: "5", Gelesen: true, Unbekannt: "x" },
      { Titel: "Emil", Genre: "roman", Bewertung: 4 },
      { Nichts: "da" },
    ],
  });
  assert.deepEqual(
    p.fields.map((f) => [f.name, f.type, f.options]),
    [
      ["Titel", "text", undefined],
      ["Bewertung", "number", undefined],
      ["Genre", "select", ["Roman", "Krimi"]],
      ["genre 2", "text", undefined],
      ["Status", "text", undefined],
      ["Gelesen", "checkbox", undefined],
    ],
  );
  assert.deepEqual(p.rows, [
    { Titel: "Dune", Bewertung: 5, Gelesen: true },
    { Titel: "Emil", Genre: "Roman", Bewertung: 4 },
  ]);
  const noText = normalizeProposal({ fields: [{ name: "Datum", type: "date" }] });
  assert.deepEqual(noText.fields[0], { name: "Name", type: "text" });
});

test("create from a description: proposed by the AI (with one retry), created only on confirmation", async () => {
  let call = 0;
  mock.answer = () =>
    call++ === 0
      ? '{"fields": [{"name": "Titel", "type": "rating"}]}'
      : JSON.stringify({
          title: "Leseliste",
          fields: [
            { name: "Titel", type: "text" },
            { name: "Autor", type: "text" },
            { name: "Genre", type: "select", options: ["Roman", "Sachbuch"] },
            { name: "Status", type: "select", options: ["Offen", "Gelesen"] },
            { name: "Bewertung", type: "number" },
          ],
          rows: [{ Titel: "Dune", Autor: "Herbert", Genre: "Roman", Status: "Gelesen", Bewertung: 5 }],
        });
  const pagesBefore = one<{ n: number }>("SELECT count(*) n FROM pages")!.n;
  const proposal = await proposeDatabase(ben, wid, "Leseliste mit Autor, Genre, Status, Bewertung");
  assert.equal(call, 2, "the invalid type got one retry");
  assert.equal(one<{ n: number }>("SELECT count(*) n FROM pages")!.n, pagesBefore, "nothing created yet");
  await assert.rejects(proposeDatabase(vic, wid, "Leseliste"), /Berechtigung/);
  // The person removes a property and confirms.
  const reviewed = { ...proposal, fields: proposal.fields.filter((f) => f.name !== "Bewertung") };
  const created = command(ben, { action: "page.create", workspaceId: wid, spaceId: space, title: "Leseliste", kind: "database", aiDatabase: reviewed }) as { id: string };
  const d = database(created.id);
  assert.deepEqual(
    d.fields.map((f) => [f.name, f.type]),
    [
      ["Titel", "text"],
      ["Autor", "text"],
      ["Genre", "select"],
      ["Status", "select"],
    ],
  );
  assert.equal(d.fields[0].id, "title");
  assert.ok(d.views.some((v) => v.type === "board" && v.groupBy === d.fields[2].id));
  const records = (await import("../lib/db")).all<{ cells: string }>("SELECT cells FROM rows WHERE page_id=?", created.id).map((r) => JSON.parse(r.cells));
  assert.equal(records.length, 1);
  assert.equal(records[0].title, "Dune");
  assert.equal(Object.keys(records[0]).length, 4, "the removed property's value is gone");
  // Whatever the browser sends is checked again.
  assert.throws(() => command(ben, { action: "page.create", workspaceId: wid, spaceId: space, title: "X", kind: "database", aiDatabase: { fields: [{ name: "Code", type: "formula" }] } }));
  assert.throws(() => command(ben, { action: "page.create", workspaceId: wid, spaceId: space, title: "X", kind: "document", aiDatabase: reviewed }), /neue, leere Datenbank/);
});
