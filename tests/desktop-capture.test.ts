import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { Field, Identity } from "../lib/types";

process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-desktop-capture-"));
process.env.FLOWPLAN_OCR = "0";
delete process.env.WHISPER_URL;
const { id, one, all, run } = await import("../lib/db");
const { command, bootstrap, database } = await import("../lib/api");
const { createWorkspace } = await import("../lib/seed");
const { withContentLocale } = await import("../lib/content-locale");
const { identityFromRequest, HttpError } = await import("../lib/auth");
const I = await import("../lib/idempotency");
const D = await import("../lib/desktop-capture");
const S = await import("../lib/ai/capture-suggest");

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
async function account(name: string) {
  const uid = id(),
    cookie = randomUUID();
  await run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, name, `${name}@example.test`);
  await run("INSERT INTO sessions(token,user_id,groups_json,expires) VALUES(?,?,?,?)", sha(cookie), uid, "[]", Date.now() + 3600_000);
  const user = { id: uid, name, email: `${name}@example.test`, groups: [], isAdmin: false, disabled: 0, created_at: "" } as unknown as Identity;
  return { user, auth: { cookie: `flowplan_session=${cookie}` } as Record<string, string> };
}
const en = <T>(fn: () => T) => withContentLocale("en", fn);
const TODAY = new Date().toISOString().slice(0, 10);
const shift = (n: number) => {
  const d = new Date(`${TODAY}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

const owner = await account("desk-owner"),
  anna = await account("anna"),
  viewer = await account("desk-viewer");
const O = owner.user;
const wid = await createWorkspace(O.id, "Desk");
const sid = (await bootstrap(O, wid)).spaces[0].id;
await run("INSERT INTO members VALUES(?,?,?)", wid, anna.user.id, "editor");
await run("INSERT INTO members VALUES(?,?,?)", wid, viewer.user.id, "viewer");
await run("UPDATE users SET name=? WHERE id=?", "Anna Schmidt", anna.user.id);

async function makeDatabase(title: string, fields: Field[]) {
  const pageId = ((await command(O, { action: "page.create", workspaceId: wid, spaceId: sid, kind: "database", title })) as { id: string }).id;
  const current = await database(pageId);
  await command(O, { action: "database.update", pageId, version: current.version, fields, views: current.views });
  return pageId;
}
const inbox = await makeDatabase("Inbox", [
  { id: "title", name: "Name", type: "text" },
  { id: "due", name: "Due", type: "date" },
  { id: "tags", name: "Tags", type: "multiselect", options: ["Kunde", "Intern"] },
  { id: "who", name: "Assignee", type: "person" },
  { id: "prio", name: "Priority", type: "select", options: ["High", "Medium", "Low"] },
  { id: "link", name: "Link", type: "url" },
  { id: "files", name: "Files", type: "files" },
]);
await command(O, { action: "capture.target", workspaceId: wid, pageId: inbox });
const plain = await makeDatabase("Reading", [{ id: "title", name: "Name", type: "text" }]);
const notes = ((await command(O, { action: "page.create", workspaceId: wid, spaceId: sid, title: "Notes", kind: "document" })) as { id: string }).id;
const journal = ((await command(O, { action: "page.create", workspaceId: wid, spaceId: sid, title: "Diary", kind: "journal" })) as { id: string }).id;
const secretSpace = id();
await run("INSERT INTO spaces(id,workspace_id,name) VALUES(?,?,?)", secretSpace, wid, "Vault");
await run("UPDATE spaces SET encrypted=1 WHERE id=?", secretSpace);
const secret = id();
await run("INSERT INTO pages(id,workspace_id,space_id,title,kind,created_by) VALUES(?,?,?,?,?,?)", secret, wid, secretSpace, "Secret", "document", O.id);
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const webm = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(200, 1)]);
const row = async (rowId: string) => (await one<{ cells: string; content: string | null; created_by: string }>("SELECT cells,content,created_by FROM rows WHERE id=?", rowId))!;
const cells = async (rowId: string) => JSON.parse((await row(rowId)).cells) as Record<string, unknown>;
const html = async (pageId: string) => (await one<{ html: string }>("SELECT html FROM documents WHERE page_id=?", pageId))!.html;
const save = (user: Identity, body: Record<string, unknown>, files: { name: string; type: string; bytes: Buffer }[] = []) =>
  en(() => D.desktopCaptureSave(user, { today: TODAY, timeZone: "Europe/Berlin", ...body }, files));

test("targets: the inbox, databases with what the shorthand fills, documents, journals – no encrypted spaces", async () => {
  const t = await en(async () => await D.desktopCaptureTargets(O));
  assert.equal(t.inbox?.id, inbox);
  const byId = new Map(t.targets.map((x) => [x.id, x as Record<string, unknown>]));
  assert.deepEqual(byId.get(inbox)!.fills, { date: "Due", tags: true, person: "Assignee" });
  assert.deepEqual(byId.get(plain)!.fills, { date: null, tags: false, person: null });
  assert.equal(byId.get(notes)!.kind, "document");
  assert.equal(byId.get(journal)!.kind, "journal");
  assert.ok(!byId.has(secret), "end-to-end encrypted pages are never targets");
  assert.ok(t.encryptedExcluded >= 1, "and the window can say why");
  assert.equal(t.voice, false);
  assert.equal(t.suggest?.server ?? false, false, "no AI provider configured on the server");
  assert.deepEqual((await en(async () => await D.desktopCaptureTargets(viewer.user))).targets, [], "viewers add nothing");
});

test("preview: chips for the target's properties; a removed chip stays text", async () => {
  const p = await en(async () => await D.capturePreview(O, { text: "Angebot schreiben morgen 15 Uhr #kunde @anna !high", today: TODAY }));
  assert.equal(p.title, "Angebot schreiben");
  assert.deepEqual(
    p.chips.map((c) => [c.kind, c.field?.name, c.applies]),
    [
      ["date", "Due", true],
      ["tag", "Tags", true],
      ["person", "Assignee", true],
      ["priority", "Priority", true],
    ],
  );
  const dateChip = p.chips[0].id;
  const kept = await en(async () => await D.capturePreview(O, { text: "Angebot schreiben morgen 15 Uhr #kunde", today: TODAY, literal: [dateChip] }));
  assert.equal(kept.title, "Angebot schreiben morgen 15 Uhr");
  // Another database without those properties: nothing applies.
  assert.ok((await en(async () => await D.capturePreview(O, { targetId: plain, text: "x morgen #kunde", today: TODAY }))).chips.every((c) => !c.applies));
  await assert.rejects(async () => await en(async () => await D.capturePreview(O, { targetId: secret, text: "x", today: TODAY })), (e: { status: number }) => e.status === 409);
});

test("save into the inbox: the shorthand as properties, the time in the computer's zone", async () => {
  const saved = await save(O, { text: "Angebot schreiben morgen 15 Uhr #kunde @anna !high\nmit Details" });
  assert.equal(saved.kind, "record");
  assert.equal(saved.pageId, inbox);
  const c = await cells(saved.rowId!);
  assert.equal(c.title, "Angebot schreiben");
  const local = new Date(String(c.due)).toLocaleString("sv-SE", { timeZone: "Europe/Berlin" });
  assert.equal(local.slice(0, 16), `${shift(1)} 15:00`, "15:00 in Berlin, stored as an instant");
  assert.match(String(c.due), /Z$/);
  assert.deepEqual(c.tags, ["Kunde"]);
  assert.equal(c.who, anna.user.id);
  assert.equal(c.prio, "High");
  assert.match((await row(saved.rowId!)).content || "", /mit Details/);
  // Without parsing, the text stays as typed.
  const literal = await save(O, { text: "Kunde #kunde morgen", parse: false });
  assert.equal((await cells(literal.rowId!)).title, "Kunde #kunde morgen");
  // Multipart fields come as strings.
  const asStrings = await save(O, { text: "Meeting morgen", literal: JSON.stringify(["date:morgen"]), parse: "1" });
  assert.equal((await cells(asStrings.rowId!)).title, "Meeting morgen");
});

test("as a task: the parsed day and person, otherwise today and the person capturing", async () => {
  const mine = await save(O, { text: "Anrufen", task: true });
  assert.match((await row(mine.rowId!)).content || "", new RegExp(`data-due="${TODAY}"[^>]*>[\\s\\S]*data-mention="${O.id}"`));
  const page = await save(O, { targetId: notes, text: "Zurückrufen übermorgen @anna", task: true });
  assert.equal(page.kind, "append");
  assert.match(await html(notes), new RegExp(`data-due="${shift(2)}"[\\s\\S]*Zurückrufen[\\s\\S]*data-mention="${anna.user.id}"`));
  assert.ok((await all("SELECT 1 FROM doc_tasks WHERE page_id=?", notes)).length >= 1, "counts under My tasks at once");
});

test("a link with its preview, files, text files and a voice note", async () => {
  const link = await save(O, { text: "", url: "https://example.org/a", linkTitle: "Ein Artikel", linkDescription: "Worum es geht", linkProvider: "Example" });
  assert.equal((await cells(link.rowId!)).title, "Ein Artikel");
  assert.equal((await cells(link.rowId!)).link, "https://example.org/a");
  assert.match((await row(link.rowId!)).content || "", /data-link-card="https:\/\/example.org\/a"/);
  const files = await save(O, { text: "Mit Anhängen" }, [
    { name: "bild.png", type: "image/png", bytes: png },
    { name: "notiz.md", type: "text/markdown", bytes: Buffer.from("# Überschrift\n\n- Punkt") },
    { name: "sprachnotiz.webm", type: "audio/webm;codecs=opus", bytes: webm },
  ]);
  assert.equal(files.files.length, 2, "image and recording stored, the Markdown as text");
  assert.equal(files.transcribed, null, "no transcription service: the recording stays");
  const content = (await row(files.rowId!)).content || "";
  assert.match(content, /<img src="\/api\/files\//);
  assert.match(content, /<audio/);
  assert.match(content, /Überschrift/);
  assert.equal(((await cells(files.rowId!)).files as string[]).length, 2);
  await assert.rejects(save(O, { text: "x" }, [{ name: "evil.webm", type: "audio/webm", bytes: Buffer.from("<script>") }]), (e: { status: number }) => e.status === 400);
  await assert.rejects(save(O, { text: "" }), (e: { status: number }) => e.status === 400);
});

test("today's journal: the day is created, the entry appended; undo removes it while unchanged", async () => {
  const saved = await save(O, { targetId: journal, text: "Gedanke für heute" });
  assert.equal(saved.kind, "append");
  const day = (await one<{ id: string }>("SELECT id FROM pages WHERE parent_id=? AND journal_date=?", journal, TODAY))!.id;
  assert.equal(saved.pageId, day);
  assert.match(await html(day), /Gedanke für heute/);
  const undone = await en(async () => await D.captureUndo(O, { kind: "append", pageId: day, ...saved.undo! }));
  assert.deepEqual(undone, { undone: true });
  assert.doesNotMatch(await html(day), /Gedanke für heute/);
  assert.deepEqual(await en(async () => await D.captureUndo(O, { kind: "append", pageId: day, ...saved.undo! })), { undone: false, reason: "changed" }, "only once");
  // Changed since: kept.
  const again = await save(O, { targetId: notes, text: "Bleibt" });
  await save(O, { targetId: notes, text: "Danach geschrieben" });
  assert.equal((await en(async () => await D.captureUndo(O, { kind: "append", pageId: notes, ...again.undo! }))).undone, false);
  assert.match(await html(notes), /Bleibt/);
});

test("undo of a record: to the trash, only one's own", async () => {
  const saved = await save(O, { text: "Doch nicht" });
  await assert.rejects(async () => await en(async () => await D.captureUndo(anna.user, { kind: "record", pageId: inbox, rowId: saved.rowId })), (e: { status: number }) => e.status === 403);
  assert.deepEqual(await en(async () => await D.captureUndo(O, { kind: "record", pageId: inbox, rowId: saved.rowId })), { undone: true });
  assert.equal(await one("SELECT 1 FROM rows WHERE id=?", saved.rowId!), undefined);
  assert.ok(await one("SELECT 1 FROM row_trash WHERE id=?", saved.rowId!), "in the trash, restorable");
  assert.deepEqual(await en(async () => await D.captureUndo(O, { kind: "record", pageId: inbox, rowId: saved.rowId })), { undone: false, reason: "gone" });
});

test("a record template of the database (quick actions) and accepted AI values", async () => {
  const template = id();
  await run("INSERT INTO row_templates(id,page_id,name,cells,html,is_default,created_by) VALUES(?,?,?,?,?,?,?)", template, inbox, "Besprechung", JSON.stringify({ tags: ["Intern"] }), "<h2>Agenda</h2>", 0, O.id);
  const saved = await save(O, { text: "Weekly", templateId: template, cells: JSON.stringify({ prio: "Low", nope: 1 }) });
  assert.deepEqual((await cells(saved.rowId!)).tags, ["Intern"]);
  assert.equal((await cells(saved.rowId!)).prio, "Low");
  assert.match((await row(saved.rowId!)).content || "", /Agenda/);
});

test("the AI suggestion is checked against the targets: known databases, real options, members", async () => {
  const list = [{ id: inbox, name: "Inbox", workspaceId: wid, properties: await D.captureProperties(O, (await one("SELECT * FROM pages WHERE id=?", inbox))!) }];
  const members = () => [{ id: anna.user.id, name: "Anna Schmidt", email: "anna@example.test" }];
  const checked = await S.checkSuggestion(list, members, {
    targetId: inbox,
    title: "  Angebot   schreiben ",
    fields: { Tags: ["kunde", "Erfunden"], Priority: "Urgent", Due: "2026-02-30", Assignee: "Anna", Link: "javascript:alert(1)" },
  });
  assert.equal(checked.suggestion.targetId, inbox);
  assert.equal(checked.suggestion.title, "Angebot schreiben");
  assert.deepEqual(
    checked.suggestion.fields.map((f) => [f.name, f.value]),
    [
      ["Tags", ["Kunde"]],
      ["Assignee", anna.user.id],
    ],
  );
  assert.equal((await S.checkSuggestion(list, members, { targetId: secret, title: "x" })).suggestion.targetId, null, "an unknown target is dropped");
  // The device model's list form.
  assert.deepEqual((await S.checkSuggestion(list, members, { targetId: inbox, title: "x", fields: [{ name: "Priority", value: "medium" }] })).suggestion.fields.map((f) => f.value), ["Medium"]);
  assert.equal((await S.captureSuggestMode(O))?.server ?? false, false, "the server's AI is off without a provider");
});

test("the offline queue's retries create nothing twice (Idempotency-Key)", async () => {
  const route = I.withIdempotency(async (req: Request) => {
    try {
      const user = await identityFromRequest(req);
      if (!user) throw new HttpError(401, "Bitte melde dich an.");
      return Response.json(await save(user, await req.json()));
    } catch (e) {
      return Response.json({ error: (e as Error).message }, { status: e instanceof HttpError ? e.status : 500 });
    }
  });
  const key = randomUUID();
  const before = (await all("SELECT 1 FROM rows WHERE page_id=?", inbox)).length;
  const body = JSON.stringify({ text: "Aus der Warteschlange #kunde" });
  const send = () =>
    route(new Request("http://localhost/api/capture/save", { method: "POST", headers: { "content-type": "application/json", "Idempotency-Key": key, ...owner.auth }, body }));
  const first = await send();
  const second = await send();
  assert.equal(first.status, 200);
  assert.equal(second.headers.get("Idempotent-Replayed"), "true");
  assert.deepEqual(await second.json(), await first.json());
  assert.equal((await all("SELECT 1 FROM rows WHERE page_id=?", inbox)).length, before + 1);
});
