// AI on whiteboards (lib/ai/whiteboard.ts) with a mocked provider, the pure
// layouts and limits (lib/whiteboard-ai.ts) and the command that turns
// notes into records (lib/whiteboard-to-records.ts).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Y from "yjs";

process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-wb-ai-"));
process.env.APP_URL = "https://flowplan.example.test";
process.env.FLOWPLAN_AI_REQUESTS_PER_HOUR = "100000";
delete process.env.FLOWPLAN_AI;
delete process.env.FLOWPLAN_AI_FEATURES;
const { run, one, all, id } = await import("../lib/db");
const { createWorkspace, createPage } = await import("../lib/seed");
const { identityFromToken } = await import("../lib/auth");
const { command } = await import("../lib/api");
const { writeWhiteboard } = await import("../lib/whiteboard");
const { clusterNotes, summarizeBoard, generateStructure, splitNotes, boardText, CLUSTER_SYSTEM } = await import("../lib/ai/whiteboard");
const wbAi = await import("../lib/whiteboard-ai");
const { aiStatus } = await import("../lib/ai/resolve");
const { startOllamaMock } = await import("./helpers/ai-mock");
import type { Identity } from "../lib/types";
import type { WhiteboardItem } from "../lib/whiteboard-model";

function person(name: string): Identity {
  const uid = id();
  run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, name, `${name.toLowerCase()}@example.test`);
  const token = randomBytes(16).toString("hex");
  run("INSERT INTO sessions(token,user_id,groups_json,expires) VALUES(?,?,?,?)", createHash("sha256").update(token).digest("hex"), uid, "[]", Date.now() + 3600_000);
  return identityFromToken(token)!;
}
const admin = { ...person("Ada"), isAdmin: true };
const ben = person("Ben"),
  vic = person("Vic");
const wid = createWorkspace(admin.id, "Team");
run("INSERT INTO members VALUES(?,?,?)", wid, ben.id, "editor");
run("INSERT INTO members VALUES(?,?,?)", wid, vic.id, "viewer");
const space = one<{ id: string }>("SELECT id FROM spaces WHERE workspace_id=?", wid)!.id;
const folder = createPage(wid, space, admin.id, "Workshops");

type Note = Partial<WhiteboardItem> & { id: string };
function board(title: string, items: Note[], parent: string | null = folder) {
  const pid = createPage(wid, space, admin.id, title, "whiteboard", parent);
  const doc = new Y.Doc();
  const map = doc.getMap<Y.Map<unknown>>("items");
  items.forEach((item, z) => {
    const m = new Y.Map<unknown>();
    for (const [key, value] of Object.entries({ z, w: 160, h: 120, x: 0, y: 0, ...item })) if (key !== "id") m.set(key, value);
    map.set(item.id, m);
  });
  writeWhiteboard(pid, Y.encodeStateAsUpdate(doc));
  return pid;
}
const sticky = (n: number, text: string, extra: Partial<WhiteboardItem> = {}): Note => ({ id: `s${n}`, type: "sticky", text, x: n * 180, y: 0, fill: "#fff6b6", author: ben.id, ...extra });

const mock = await startOllamaMock();
after(() => mock.close());
const setAi = (settings: Record<string, unknown>) => command(admin, { action: "admin.ai", settings });

const retro = board("Retro", [
  sticky(1, "Deployments dauern zu lange"),
  sticky(2, "Tests sind langsam"),
  sticky(3, "Tolles Teamevent"),
  sticky(4, "Mehr Pairing"),
  sticky(5, "Geheimer Zettel", { covered: true }),
  sticky(6, ""),
  { id: "f1", type: "frame", text: "Was lief gut?", x: -50, y: 300, w: 600, h: 400 },
  sticky(7, "Kaffee war gut", { x: 100, y: 400 }),
]);

// ---- Pure parts ----

test("themes: unknown references are dropped, every note lands once, the rest gets a group", () => {
  const ids = ["a", "b", "c", "d"];
  const groups = wbAi.assignGroups(
    ids,
    { groups: [{ theme: "Tempo", notes: ["n1", "N2", "n9", "n1"] }, { theme: "tempo", notes: [3] }, { theme: "Leer", notes: ["x"] }] },
    "Sonstiges",
  );
  assert.deepEqual(groups, [
    { label: "Tempo", ids: ["a", "b", "c"] },
    { label: "Sonstiges", ids: ["d"] },
  ]);
  // Too many themes: the largest stay, the others join the rest.
  const many = wbAi.assignGroups(
    Array.from({ length: 20 }, (_, i) => `i${i}`),
    { groups: Array.from({ length: 20 }, (_, i) => ({ theme: `T${i}`, notes: i === 0 ? ["n1", "n2"] : [`n${i + 1}`] })) },
    "Rest",
  );
  assert.equal(many.length, wbAi.WB_AI_LIMITS.groups);
  assert.equal(many.at(-1)!.label, "Rest");
  assert.equal(many.flatMap((g) => g.ids).length, 20);
  assert.equal(new Set(many.flatMap((g) => g.ids)).size, 20);
});

test("theme layout: labelled columns that do not overlap", () => {
  const list = Array.from({ length: 9 }, (_, i) => ({ id: `n${i}`, x: 500 + i * 7, y: 200 - i, w: 160, h: 120 }));
  const { positions, labels } = wbAi.themeLayout(list, [
    { label: "A", ids: ["n0", "n1", "n2", "n3", "n4", "n5"] },
    { label: "B", ids: ["n6", "n7"] },
    { label: "C", ids: ["n8", "gone"] },
  ]);
  assert.equal(labels.length, 3);
  assert.equal(positions.length, 9);
  assert.deepEqual({ x: labels[0].x, y: labels[0].y }, { x: 500, y: 192 }, "starts where the notes are");
  for (const a of positions)
    for (const b of positions)
      if (a !== b) assert.ok(Math.abs(a.x - b.x) >= 160 || Math.abs(a.y - b.y) >= 120, `${a.id} overlaps ${b.id}`);
  // Notes sit below their heading.
  for (const p of positions) assert.ok(labels.some((l) => p.x >= l.x && p.y >= l.y + 40));
});

test("mind maps and flowcharts stay within the limits and are laid out", () => {
  const deep = { text: "Root", children: Array.from({ length: 30 }, (_, i) => ({ text: `Ast ${i}`, children: [{ text: `Blatt ${i}`, children: [{ text: "x", children: [{ text: "zu tief" }] }] }] })) };
  const map = wbAi.mindmapStructure(wbAi.mindmapAnswerSchema.parse({ root: deep }).root);
  assert.equal(map.nodes.length, wbAi.WB_AI_LIMITS.mindmapNodes);
  assert.ok(map.dropped > 0);
  assert.ok(!map.nodes.some((n) => n.text === "zu tief"));
  assert.equal(map.links.length, map.nodes.length - 1);
  const placed = wbAi.structureItems(map, { x: 1000, y: 500 });
  const root = placed.shapes[0].item;
  assert.ok(placed.shapes.slice(1).every((s) => s.item.x > root.x), "branches to the right of the centre");
  const xs = placed.shapes.map((s) => [s.item.x, s.item.x + s.item.w]).flat();
  assert.ok(Math.abs((Math.min(...xs) + Math.max(...xs)) / 2 - 1000) <= 1, "centred on the view");

  const chart = wbAi.flowchartStructure(
    wbAi.flowchartAnswerSchema.parse({
      nodes: [
        { id: 1, text: "Start", type: "start" },
        { id: "2", text: "Antrag prüfen", type: "step" },
        { id: "3", text: "Genehmigt?", type: "decision" },
        { id: "4", text: "Ende", type: "end" },
        { id: "5", text: "Unbekannter Typ", type: "wolke" },
        { id: "2", text: "Doppelt", type: "step" },
      ],
      edges: [
        { from: "1", to: "2" },
        { from: "2", to: "3" },
        { from: "3", to: "4", label: "ja" },
        { from: "3", to: "2", label: "nein" },
        { from: "3", to: "99" },
        { from: "1", to: "2" },
      ],
    }),
  );
  assert.deepEqual(chart.nodes.map((n) => n.shape), ["ellipse", "rounded", "diamond", "ellipse", "rounded"]);
  assert.equal(chart.links.length, 4, "edges to unknown nodes and duplicates are dropped");
  const layout = wbAi.flowchartLayout(chart.nodes, chart.links);
  assert.ok(layout.get("1")!.y < layout.get("2")!.y && layout.get("2")!.y < layout.get("3")!.y && layout.get("3")!.y < layout.get("4")!.y, "top to bottom, loops ignored");
  const items = wbAi.structureItems(chart, { x: 0, y: 0 });
  assert.equal(items.connectors.length, 4);
  assert.ok(items.connectors.every((c) => c.item.endArrow && c.item.route === "elbow"));
  assert.equal(wbAi.generatedSchema.safeParse(chart).success, true);
});

test("generated content moves right past what it would cover", () => {
  const box = { x: 0, y: 0, w: 300, h: 200 };
  assert.deepEqual(wbAi.freeSpot(box, []), { dx: 0, dy: 0 }, "free: stays at the view centre");
  assert.deepEqual(wbAi.freeSpot(box, [{ x: 1000, y: 0, w: 100, h: 100 }]), { dx: 0, dy: 0 });
  const notes = [
    { x: 50, y: 50, w: 160, h: 120 },
    { x: 400, y: 0, w: 160, h: 120 },
  ];
  const { dx } = wbAi.freeSpot(box, notes);
  assert.equal(dx, 400 + 160 + 60, "past both notes, with a gap");
  assert.ok(notes.every((n) => box.x + dx >= n.x + n.w));
});

test("colours find options by name, notes split into title and text", () => {
  assert.equal(wbAi.guessOption("#fff6b6", ["Rot", "gelb"]), "gelb");
  assert.equal(wbAi.guessOption("#e9ecef", ["Gray"]), "Gray");
  assert.equal(wbAi.guessOption("#a5d8ff", ["Rot"]), "");
  assert.deepEqual(wbAi.noteTitle("\n  Angebot schreiben \nbis Freitag\n\nmit Preisen"), { title: "Angebot schreiben", body: "bis Freitag\n\nmit Preisen" });
});

// ---- With the provider ----

test("AI on whiteboards is off by default, a feature of its own and on with AI", async () => {
  await assert.rejects(clusterNotes(ben, { pageId: retro, ids: ["s1", "s2"] }), /ausgeschaltet/);
  setAi({ enabled: true, provider: { kind: "ollama", baseUrl: mock.base, model: "chat", embeddingModel: "" } });
  assert.equal(aiStatus(ben, wid).features.whiteboard.ok, true, "on together with AI");
  setAi({ features: { whiteboard: false } });
  assert.equal(aiStatus(ben, wid).features.whiteboard.ok, false);
  await assert.rejects(generateStructure(ben, { pageId: retro, prompt: "Ideen", kind: "mindmap" }), /ausgeschaltet/);
  setAi({ features: { whiteboard: true } });
  command(ben, { action: "ai.settings", features: { whiteboard: false } });
  await assert.rejects(summarizeBoard(ben, { pageId: retro }), /ausgeschaltet/);
  command(ben, { action: "ai.settings", features: { whiteboard: true } });
});

test("cluster: only visible notes with text reach the model, only for editors", async () => {
  mock.answer = () => JSON.stringify({ groups: [{ theme: "Geschwindigkeit", notes: ["n1", "n2"] }, { theme: "Team", notes: ["n3", "n4", "n77"] }] });
  const before = mock.chats.length;
  const result = await clusterNotes(ben, { pageId: retro, ids: ["s1", "s2", "s3", "s4", "s5", "s6", "f1"], locale: "de" });
  const sent = mock.chats[before];
  assert.equal(sent.system, CLUSTER_SYSTEM);
  assert.match(sent.prompt, /n1: Deployments dauern zu lange/);
  assert.ok(!sent.prompt.includes("Geheimer Zettel"), "covered notes stay hidden");
  assert.deepEqual(result.groups, [
    { label: "Geschwindigkeit", ids: ["s1", "s2"] },
    { label: "Team", ids: ["s3", "s4"] },
    { label: "Sonstiges", ids: ["s6"] },
  ]);
  assert.equal(result.sent, 4);
  await assert.rejects(clusterNotes(vic, { pageId: retro, ids: ["s1", "s2"] }), /Keine Berechtigung/);
  // A board closed to the AI.
  const closed = board("Gehälter", [sticky(1, "a"), sticky(2, "b")]);
  command(admin, { action: "ai.block", targetId: closed, kind: "page", blocked: true });
  await assert.rejects(clusterNotes(ben, { pageId: closed, ids: ["s1", "s2"] }), /für die KI gesperrt/);
  // Garbage twice: a clear error, nothing changes.
  mock.answer = () => "Ich weiß es nicht.";
  await assert.rejects(clusterNotes(ben, { pageId: retro, ids: ["s1", "s2"] }), /keine verwertbare Antwort/);
});

test("summary: a page next to the board with themes, decisions, questions and tasks", async () => {
  mock.answer = () =>
    JSON.stringify({
      summary: "Das Team will schneller liefern.",
      themes: [{ title: "Tempo", points: ["Deployments <langsam>"] }],
      decisions: ["Pipeline wird parallelisiert"],
      questions: ["Wer bezahlt neue Runner?"],
      actions: [
        { text: "Runner bestellen", owner: "Ben", due: "2026-11-03" },
        { text: "Pairing-Plan", owner: "Unbekannt", due: "bald" },
      ],
    });
  const before = mock.chats.length;
  const result = await summarizeBoard(ben, { pageId: retro, tasks: true, locale: "de" });
  const prompt = mock.chats[before].prompt;
  assert.match(prompt, /## Was lief gut\?\n- \[note, by Ben\] Kaffee war gut/, "frames become sections");
  assert.ok(!prompt.includes("Geheimer Zettel"));
  const page = one<{ title: string; parent_id: string; space_id: string; kind: string; created_by: string }>("SELECT title,parent_id,space_id,kind,created_by FROM pages WHERE id=?", result.pageId)!;
  assert.deepEqual(page, { title: "Zusammenfassung: Retro", parent_id: folder, space_id: space, kind: "document", created_by: ben.id });
  const html = one<{ html: string }>("SELECT html FROM documents WHERE page_id=?", result.pageId)!.html;
  assert.match(html, new RegExp(`href="/#page=${retro}"`), "links back to the board");
  assert.match(html, /Entscheidungen/);
  assert.match(html, /Offene Fragen/);
  assert.match(html, /Deployments &lt;langsam&gt;/);
  assert.match(html, new RegExp(`data-mention="${ben.id}"`));
  assert.match(html, /Pairing-Plan \(Unbekannt\)/);
  assert.ok(one("SELECT 1 FROM doc_tasks WHERE page_id=? AND assignee=? AND due='2026-11-03'", result.pageId, ben.id), "action items became tasks");
  assert.deepEqual(result.counts, { themes: 1, decisions: 1, questions: 1, actions: 2 });
  assert.equal(result.included, result.total);
  // Without tasks: a plain list, in English.
  const plain = await summarizeBoard(ben, { pageId: retro, tasks: false, locale: "en", ids: ["s1", "s2"] });
  const english = one<{ html: string; title: string }>("SELECT d.html,p.title FROM documents d JOIN pages p ON p.id=d.page_id WHERE d.page_id=?", plain.pageId)!;
  assert.equal(english.title, "Summary: Retro");
  assert.doesNotMatch(english.html, /taskList/);
  assert.match(english.html, /Runner bestellen \(Ben, 2026-11-03\)/);
  assert.equal(plain.total, 2);
});

test("summary of a large board: what is left out is said", async () => {
  const items = Array.from({ length: wbAi.WB_AI_LIMITS.summaryItems + 50 }, (_, i) => sticky(i, `Idee ${i}`));
  const big = board("Großes Board", items, null);
  mock.answer = (request) => (request.system.includes("JSON") ? JSON.stringify({ summary: "Viele Ideen." }) : "- Ideen");
  const result = await summarizeBoard(admin, { pageId: big, locale: "de" });
  assert.equal(result.total, wbAi.WB_AI_LIMITS.summaryItems + 50);
  assert.equal(result.included, wbAi.WB_AI_LIMITS.summaryItems);
  const html = one<{ html: string }>("SELECT html FROM documents WHERE page_id=?", result.pageId)!.html;
  assert.match(html, /Nicht berücksichtigt: 50/);
  const page = one<{ parent_id: string | null }>("SELECT parent_id FROM pages WHERE id=?", result.pageId)!;
  assert.equal(page.parent_id, null, "next to a board at the top of the space");
});

test("linked pages the AI may not read stay out of the board text", () => {
  const secret = createPage(wid, space, admin.id, "Geheimprojekt");
  command(admin, { action: "ai.block", targetId: secret, kind: "page", blocked: true });
  const open = createPage(wid, space, admin.id, "Roadmap");
  const text = boardText(ben, [
    { id: "c1", type: "card", pageId: secret, x: 0, y: 0, w: 10, h: 10, z: 0 },
    { id: "c2", type: "card", pageId: open, x: 0, y: 20, w: 10, h: 10, z: 1 },
  ] as WhiteboardItem[]);
  assert.ok(!text.text.includes("Geheimprojekt"));
  assert.match(text.text, /\[linked page\] Roadmap/);
});

test("generate: the answer is validated and limited, invalid answers fail", async () => {
  mock.answer = () => JSON.stringify({ nodes: [{ id: "a", text: "Start", type: "start" }, { id: "b", text: "Ende", type: "end" }], edges: [{ from: "a", to: "b" }, { from: "a", to: "zz" }] });
  const chart = await generateStructure(ben, { pageId: retro, prompt: "Ein kurzer Ablauf", kind: "flowchart", locale: "de" });
  assert.equal(chart.kind, "flowchart");
  assert.equal(chart.links.length, 1);
  mock.answer = () => JSON.stringify({ root: { text: "Fest", children: [{ text: "Essen" }, { text: "Musik" }] } });
  const map = await generateStructure(ben, { pageId: retro, prompt: "Ideen für ein Fest", kind: "mindmap" });
  assert.deepEqual(map.nodes.map((n) => n.text), ["Fest", "Essen", "Musik"]);
  mock.answer = () => JSON.stringify({ root: { children: [] } });
  await assert.rejects(generateStructure(ben, { pageId: retro, prompt: "Ideen", kind: "mindmap" }), /keine verwertbare Antwort/);
  await assert.rejects(generateStructure(vic, { pageId: retro, prompt: "Ideen", kind: "mindmap" }), /Keine Berechtigung/);
});

// ---- Notes → records ----

const db = createPage(wid, space, admin.id, "Backlog", "database");
const fields = JSON.parse(one<{ fields: string }>("SELECT fields FROM databases WHERE page_id=?", db)!.fields);
fields.push({ id: "farbe", name: "Farbe", type: "select", options: ["Gelb", "Rot"] });
run("UPDATE databases SET fields=? WHERE page_id=?", JSON.stringify(fields), db);

test("notes become records: title, document, colour option and author; repeating is a no-op", () => {
  const rowA = randomUUID(),
    rowB = randomUUID();
  const input = {
    action: "whiteboard.toRecords",
    pageId: retro,
    databaseId: db,
    colorField: "farbe",
    colorOptions: { "#fff6b6": "Gelb" },
    personField: "assignee",
    records: [
      { rowId: rowA, itemId: "s1", text: "Deployments dauern zu lange\nseit Mai", color: "#fff6b6", author: ben.id },
      { rowId: rowB, itemId: "s2", text: "Tests sind langsam", color: "#a5d8ff", author: "jemand-anderes", cells: { priority: "Hoch" } },
    ],
  };
  const result = command(ben, input) as { records: { itemId: string; rowId: string; created: boolean }[] };
  assert.deepEqual(result.records.map((r) => r.created), [true, true]);
  const a = JSON.parse(one<{ cells: string }>("SELECT cells FROM rows WHERE id=?", rowA)!.cells);
  assert.deepEqual(a, { farbe: "Gelb", assignee: ben.id, title: "Deployments dauern zu lange" });
  assert.match(one<{ html: string }>("SELECT html FROM row_documents WHERE row_id=?", rowA)!.html, /seit Mai/);
  const b = JSON.parse(one<{ cells: string }>("SELECT cells FROM rows WHERE id=?", rowB)!.cells);
  assert.deepEqual(b, { priority: "Hoch", title: "Tests sind langsam" }, "unmapped colour and non-members stay empty");
  const count = () => Number(one<{ n: number }>("SELECT count(*) n FROM rows WHERE page_id=?", db)!.n);
  const before = count();
  const again = command(ben, input) as { records: { created: boolean }[] };
  assert.deepEqual(again.records.map((r) => r.created), [false, false]);
  assert.equal(count(), before, "idempotent");
});

test("notes → records checks rights, values and limits", () => {
  const one_ = (extra: Record<string, unknown> = {}) => ({
    action: "whiteboard.toRecords",
    pageId: retro,
    databaseId: db,
    records: [{ rowId: randomUUID(), itemId: "s3", text: "Tolles Teamevent" }],
    ...extra,
  });
  assert.throws(() => command(vic, one_()), /Keine Berechtigung/, "readers of the board");
  assert.throws(() => command(ben, one_({ records: [{ rowId: randomUUID(), itemId: "s3", text: "x", cells: { status: "Gibt es nicht" } }] })), /Unbekannte Auswahl/);
  assert.throws(() => command(ben, one_({ colorField: "status-gibt-es-nicht" })), /Eigenschaft fehlt/);
  assert.throws(() => command(ben, one_({ databaseId: retro })), /Keine Datenbank/);
  assert.throws(() => command(ben, one_({ records: Array.from({ length: 101 }, (_, i) => ({ rowId: randomUUID(), itemId: `x${i}`, text: "x" })) })));
  // A database the person may only read.
  const readOnly = createPage(wid, space, admin.id, "Archiv", "database");
  const vicBoard = board("Vics Board", [sticky(1, "x")]);
  run("INSERT INTO grants(resource_id,user_id,role) VALUES(?,?,?)", vicBoard, vic.id, "editor");
  assert.throws(() => command(vic, { ...one_({ pageId: vicBoard, databaseId: readOnly }) }), /Keine Berechtigung/);
  assert.ok(!all("SELECT 1 FROM rows WHERE page_id=?", readOnly).length);
});

test("split with AI: values are normalised per property, wrong ones reported", async () => {
  mock.answer = () =>
    JSON.stringify({
      records: [
        { note: "n1", cells: { Status: "in arbeit", Verantwortlich: "Ben", Aufgabe: "nicht überschreiben", Farbe: "Lila" } },
        { note: "n2", cells: { "Fällig am": "2026-12-01" } },
      ],
    });
  const before = mock.chats.length;
  const { records } = await splitNotes(ben, { pageId: retro, databaseId: db, ids: ["s1", "s2", "s5"], locale: "de" });
  assert.ok(!mock.chats[before].prompt.includes("Geheimer Zettel"));
  assert.match(mock.chats[before].prompt, /"name":"Status"/);
  assert.deepEqual(records.s1.cells, { status: "In Arbeit", assignee: ben.id });
  assert.match(records.s1.problem || "", /Unbekannte Auswahl/);
  assert.deepEqual(records.s2.cells, { date: "2026-12-01" });
  assert.deepEqual(records.s1.view.find((v) => v.name === "Verantwortlich"), { name: "Verantwortlich", value: "Ben" });
  const blocked = createPage(wid, space, admin.id, "Gesperrt", "database");
  command(admin, { action: "ai.block", targetId: blocked, kind: "page", blocked: true });
  await assert.rejects(splitNotes(ben, { pageId: retro, databaseId: blocked, ids: ["s1"] }), /für die KI gesperrt/);
});

test("the command is documented for the API", async () => {
  const { commandActionNames, commandActions } = await import("../lib/openapi");
  assert.ok((commandActionNames as readonly string[]).includes("whiteboard.toRecords"));
  assert.ok(commandActions.some((a) => a.action === "whiteboard.toRecords"));
});
