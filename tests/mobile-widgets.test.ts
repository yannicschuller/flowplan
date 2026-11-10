import { nowText } from "../lib/db-driver/dialect";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { Field, Identity, View } from "../lib/types";
import { mapAsync } from "../lib/each-async";

process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-widgets-"));
delete process.env.WHISPER_URL;
const { id, one, all, run } = await import("../lib/db");
const { command, bootstrap, database } = await import("../lib/api");
const { createWorkspace, createPage } = await import("../lib/seed");
const { htmlState } = await import("../lib/document-server");
const { registerMobileDevice, mobileSummary } = await import("../lib/mobile-devices");
const { withContentLocale } = await import("../lib/content-locale");
const W = await import("../lib/mobile-widgets");
const { widgetAction } = await import("../lib/mobile-widget-actions");
const { trackJob, jobProgress } = await import("../lib/background-jobs");
const route = await import("../app/api/mobile/widgets/[action]/route");

const NOW = Date.now();
// Monday 00:00 of this week: just after midnight on a Monday an hour ago is last week.
const WEEK_START = new Date(NOW).setHours(0, 0, 0, 0) - ((new Date(NOW).getDay() + 6) % 7) * 86_400_000;
const TODAY = new Date(NOW).toISOString().slice(0, 10);
const day = (offset: number) => new Date(Date.parse(`${TODAY}T12:00:00Z`) + offset * 86_400_000).toISOString().slice(0, 10);

async function account(name: string, groups: string[] = []) {
  const uid = id(),
    token = id();
  await run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, name, `${name}@example.test`);
  await run("INSERT INTO sessions(token,user_id,groups_json,expires) VALUES(?,?,?,?)", token, uid, JSON.stringify(groups), Date.now() + 3600000);
  const user = { id: uid, name, email: `${name}@example.test`, groups, isAdmin: false, disabled: 0, created_at: "" } as Identity;
  return { user, token };
}
// The identity a phone gets from its device token.
async function phone(acc: { user: Identity; token: string }) {
  const { deviceToken } = await registerMobileDevice(acc.user, acc.token, { installationId: randomUUID(), platform: "ios" });
  return { deviceToken, device: (await W.widgetUser(`Bearer ${deviceToken}`))! };
}
type Result = { id: string | null; kind: string; ok: boolean; status?: number; error?: string; data?: Record<string, any> };
async function widgets(user: Identity, list: { kind: string; config?: Record<string, unknown>; id?: string }[], now = NOW) {
  return (await withContentLocale("en", async () => await W.widgetsData(user, { today: TODAY, zone: "UTC", widgets: list }, now))).widgets as Result[];
}
const one_ = async (user: Identity, kind: string, config: Record<string, unknown> = {}, now = NOW) => {
  const [result] = await widgets(user, [{ kind, config }], now);
  assert.equal(result.ok, true, `${kind}: ${result.error}`);
  return result.data!;
};
const act = (user: Identity, body: Record<string, unknown>) => withContentLocale("en", () => widgetAction(user, body));
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));

async function makeDatabase(user: Identity, wid: string, sid: string, title: string, fields: Field[], views?: View[]) {
  const pageId = ((await command(user, { action: "page.create", workspaceId: wid, spaceId: sid, kind: "database", title })) as { id: string }).id;
  const current = await database(pageId);
  await command(user, { action: "database.update", pageId, version: current.version, fields, views: views ?? current.views });
  return pageId;
}
const addRow = async (user: Identity, pageId: string, cells: Record<string, unknown>) =>
  ((await command(user, { action: "row.create", pageId, cells })) as { id: string }).id;
const taskItem = (text: string, due: string) => `<li data-type="taskItem" data-checked="false" data-due="${due}"><p>${text}</p></li>`;
async function writeDocument(user: Identity, wid: string, pageId: string, html: string) {
  const generation = String((await one<{ generation: string }>("SELECT generation FROM documents WHERE page_id=?", pageId))!.generation);
  await command(user, { action: "document.sync", workspaceId: wid, pageId, generation, update: Buffer.from(htmlState(html)).toString("base64") });
}

// ---- One shared workspace: owner, an editor, a viewer, a guest, a stranger ----

const owner = await account("widget-owner"),
  editor = await account("widget-editor"),
  viewer = await account("widget-viewer"),
  guest = await account("widget-guest"),
  stranger = await account("widget-stranger");
const wid = await createWorkspace(owner.user.id, "Widgets");
const sid = (await bootstrap(owner.user, wid)).spaces[0].id;
await run("INSERT INTO members VALUES(?,?,?)", wid, editor.user.id, "editor");
await run("INSERT INTO members VALUES(?,?,?)", wid, viewer.user.id, "viewer");
await run("INSERT INTO members VALUES(?,?,?)", wid, guest.user.id, "editor");
await command(owner.user, { action: "member.guest", workspaceId: wid, userId: guest.user.id, guest: true });
await createWorkspace(stranger.user.id, "Elsewhere");
const O = (await phone(owner)).device,
  E = (await phone(editor)).device,
  V = (await phone(viewer)).device,
  G = (await phone(guest)).device,
  S = (await phone(stranger)).device;

const tasksDb = await makeDatabase(owner.user, wid, sid, "Inbox", [
  { id: "title", name: "Title", type: "text" },
  { id: "due", name: "Due", type: "date" },
  { id: "done", name: "Erledigt", type: "checkbox" },
  { id: "files", name: "Files", type: "files" },
  { id: "secret", name: "Salary", type: "text", access: { read: "owners" } },
]);
const plan = ((await command(owner.user, { action: "page.create", workspaceId: wid, spaceId: sid, title: "Plan", kind: "document" })) as { id: string }).id;

test("only a device token opens the widget API; a revoked device gets 401", async () => {
  const acc = await account("widget-revoked");
  await run("INSERT INTO members VALUES(?,?,?)", wid, acc.user.id, "editor");
  const { deviceToken } = await phone(acc);
  const ctx = (action: string) => ({ params: Promise.resolve({ action }) });
  const get = (authorization?: string) =>
    route.GET(new Request("http://localhost/api/mobile/widgets/options?kind=capture", { headers: authorization ? { authorization } : {} }), ctx("options"));
  const ok = await get(`Bearer ${deviceToken}`);
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get("Cache-Control"), "no-store");
  const options = (await ok.json()) as { targets: { id: string; kind: string }[]; share?: boolean };
  assert.equal(options.share, true);
  assert.ok(options.targets.some((t) => t.id === tasksDb && t.kind === "database"));
  assert.ok(options.targets.some((t) => t.id === plan && t.kind === "document"));
  assert.equal((await get()).status, 401);
  // A personal API token or the session token itself is no device token.
  assert.equal((await get("Bearer fp_abcdefghijklmnopqrstuvwxyz0123")).status, 401);
  assert.equal((await get(`Bearer ${acc.token}`)).status, 401);
  const data = await route.POST(
    new Request("http://localhost/api/mobile/widgets/data", {
      method: "POST",
      headers: { authorization: `Bearer ${deviceToken}`, "accept-language": "de" },
      body: JSON.stringify({ today: TODAY, zone: "UTC", widgets: [{ kind: "calendar", config: {} }] }),
    }),
    ctx("data"),
  );
  assert.equal(data.status, 200);
  assert.equal(((await data.json()) as { widgets: Result[] }).widgets[0].data!.title, "Heute");
  // Signing out (or revoking the session) ends the device token.
  await run("DELETE FROM sessions WHERE token=?", acc.token);
  assert.equal((await get(`Bearer ${deviceToken}`)).status, 401);
  const action = await route.POST(
    new Request("http://localhost/api/mobile/widgets/action", {
      method: "POST",
      headers: { authorization: `Bearer ${deviceToken}` },
      body: JSON.stringify({ action: "mention.readAll" }),
    }),
    ctx("action"),
  );
  assert.equal(action.status, 401);
  // Unknown endpoints and kinds.
  const other = await route.GET(new Request("http://localhost/api/mobile/widgets/options?kind=nope", { headers: { authorization: `Bearer ${(await phone(owner)).deviceToken}` } }), ctx("options"));
  assert.equal(other.status, 400);
});

test("titles follow the profile language first, then the app", async () => {
  const acc = await account("widget-language");
  const { deviceToken } = await phone(acc);
  const ask = async (headers: Record<string, string>, query = "") => {
    const response = await route.POST(
      new Request(`http://localhost/api/mobile/widgets/data${query}`, {
        method: "POST",
        headers: { authorization: `Bearer ${deviceToken}`, ...headers },
        body: JSON.stringify({ widgets: [{ kind: "time" }, { kind: "pinned", config: { mode: "page", pageId: randomUUID() } }] }),
      }),
      { params: Promise.resolve({ action: "data" }) },
    );
    return ((await response.json()) as { widgets: Result[] }).widgets;
  };
  assert.equal((await ask({ "accept-language": "en" }))[0].data!.title, "Time this week");
  assert.equal((await ask({ "accept-language": "en" }, "?lang=de"))[0].data!.title, "Zeit diese Woche");
  const english = await ask({ "accept-language": "en" });
  assert.equal(english[1].status, 404);
  assert.equal(english[1].error, "Page not found.");
  await run("UPDATE users SET language='de' WHERE id=?", acc.user.id);
  assert.equal((await ask({ "accept-language": "en" }, "?lang=en"))[0].data!.title, "Zeit diese Woche");
});

test("quick capture: notes, tasks, photos and voice memos land where the person may write", async () => {
  const note = await act(O, { action: "capture.note", targetId: tasksDb, title: "Call Anna", text: "About the offer", due: day(1) });
  const row = (await one<{ cells: string }>("SELECT cells FROM rows WHERE id=?", note.rowId as string))!;
  assert.deepEqual(JSON.parse(row.cells).due, day(1));
  assert.equal(JSON.parse(row.cells).title, "Call Anna");
  assert.ok(await one("SELECT 1 FROM audit WHERE actor_id=? AND action='capture.record'", O.id));

  await act(E, { action: "capture.task", targetId: plan, title: "Book the room", due: TODAY });
  const task = (await one<{ due: string; checked: number }>("SELECT due,checked FROM doc_tasks WHERE page_id=? AND text='Book the room'", plan))!;
  assert.equal(task.due, TODAY);
  assert.equal(task.checked, 0);

  const sub = await act(E, { action: "capture.note", targetId: plan, title: "Idea", text: "Line one\n\nLine <two>" });
  const child = (await one<{ parent_id: string; title: string }>("SELECT parent_id,title FROM pages WHERE id=?", sub.pageId as string))!;
  assert.equal(child.parent_id, plan);
  assert.equal(child.title, "Idea");
  assert.match((await one<{ html: string }>("SELECT html FROM documents WHERE page_id=?", sub.pageId as string))!.html, /Line &lt;two&gt;/);

  // A photo into the database: the file belongs to it and fills the files property.
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
    "base64",
  );
  const photo = await withContentLocale("en", () =>
    widgetAction(O, { action: "capture.upload", targetId: tasksDb, type: "photo", transcribe: true }, { name: "IMG_1.png", type: "image/png", bytes: png }),
  );
  const file = (await one<{ page_id: string; mime: string }>("SELECT page_id,mime FROM files WHERE id=?", String(photo.file).split("/").pop()!))!;
  assert.equal(file.page_id, tasksDb);
  assert.equal(file.mime, "image/png");
  assert.deepEqual(JSON.parse((await one<{ cells: string }>("SELECT cells FROM rows WHERE id=?", photo.rowId as string))!.cells).files, [photo.file]);
  // A voice memo without a transcription service is kept as a recording.
  const voice = await withContentLocale("en", () =>
    widgetAction(E, { action: "capture.upload", targetId: plan, type: "voice" }, { name: "memo.m4a", type: "audio/mp4", bytes: Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypM4A recording")]) }),
  );
  assert.equal(voice.transcribed, null);
  assert.match((await one<{ html: string }>("SELECT html FROM documents WHERE page_id=?", voice.pageId as string))!.html, /<audio[^>]+src="\/api\/files\//);
  await assert.rejects(
    withContentLocale("en", () => widgetAction(E, { action: "capture.upload", targetId: plan, type: "photo" }, { name: "x.txt", type: "text/plain", bytes: Buffer.from("x") })),
    /photo/,
  );

  // Viewers, guests and strangers cannot capture; the options say so.
  await assert.rejects(act(V, { action: "capture.note", targetId: tasksDb, title: "No" }), (e: { status: number }) => e.status === 403);
  await assert.rejects(act(S, { action: "capture.note", targetId: tasksDb, title: "No" }), (e: { status: number }) => e.status === 404);
  await assert.rejects(act(G, { action: "capture.task", targetId: plan, title: "No" }), (e: { status: number }) => e.status === 404);
  assert.deepEqual(((await W.widgetOptions(V, "capture")) as { targets: unknown[] }).targets, []);
  assert.deepEqual(((await W.widgetOptions(G, "capture")) as { targets: unknown[] }).targets, []);
  const data = await one_(O, "capture", { targetId: tasksDb });
  assert.equal(data.target.id, tasksDb);
  assert.equal(data.voice, false);
  assert.equal((await one_(V, "capture", { targetId: tasksDb })).target, null);
});

test("share from another app: text, a link, photos and PDFs in one capture", async () => {
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
  const pdf = Buffer.from("%PDF-1.4\n%shared\n");
  const share = (user: Identity, body: Record<string, unknown>, files: { name: string; type: string; bytes: Buffer }[] = []) =>
    withContentLocale("en", () => widgetAction(user, { action: "capture.share", ...body }, files[0] ?? null, files));

  // Into the inbox database: one record, the link in the text, both files in
  // the files property and shown in the record.
  const record = await share(O, { targetId: tasksDb, text: "Worth reading https://example.com/a" }, [
    { name: "IMG_2.png", type: "image/png", bytes: png },
    { name: "Offer.pdf", type: "application/pdf", bytes: pdf },
  ]);
  const cells = JSON.parse((await one<{ cells: string }>("SELECT cells FROM rows WHERE id=?", record.rowId as string))!.cells);
  assert.equal(cells.title, "Worth reading");
  assert.deepEqual(cells.files, record.files);
  assert.equal((record.files as string[]).length, 2);
  const mimes = await all<{ mime: string; page_id: string }>("SELECT mime,page_id FROM files WHERE id IN (?,?)", ...(record.files as string[]).map((f) => f.split("/").pop()!));
  assert.deepEqual(mimes.map((f) => f.mime).sort(), ["application/pdf", "image/png"]);
  assert.ok(mimes.every((f) => f.page_id === tasksDb));
  const rowHtml = (await one<{ html: string }>("SELECT html FROM row_documents WHERE row_id=?", record.rowId as string))?.html ?? "";
  assert.match(rowHtml, /https:\/\/example\.com\/a/);
  assert.match(rowHtml, /data-pdf="\/api\/files\//);

  // Into a document: a sub page with the text, the link and the media; the
  // files belong to the new page.
  const page = await share(E, { targetId: plan, title: "Receipt", url: "https://example.com/r" }, [{ name: "scan.pdf", type: "application/pdf", bytes: pdf }]);
  const child = (await one<{ parent_id: string; title: string }>("SELECT parent_id,title FROM pages WHERE id=?", page.pageId as string))!;
  assert.equal(child.parent_id, plan);
  assert.equal(child.title, "Receipt");
  const html = (await one<{ html: string }>("SELECT html FROM documents WHERE page_id=?", page.pageId as string))!.html;
  assert.match(html, /href="https:\/\/example\.com\/r"/);
  assert.match(html, /data-pdf="\/api\/files\/[a-f0-9-]+"/);
  assert.equal((await one<{ page_id: string }>("SELECT page_id FROM files WHERE id=?", (page.files as string[])[0].split("/").pop()!))!.page_id, page.pageId);

  // Only a link: the host is the title. Nothing at all, other file types, too
  // many files and viewers are refused.
  const bare = await share(O, { targetId: plan, url: "https://news.example.org/story" });
  assert.equal((await one<{ title: string }>("SELECT title FROM pages WHERE id=?", bare.pageId as string))!.title, "news.example.org");
  await assert.rejects(share(O, { targetId: plan }), /Nothing was shared/);
  await assert.rejects(share(O, { targetId: plan }, [{ name: "x.html", type: "text/html", bytes: Buffer.from("<script>") }]), /Only photos and PDFs/);
  await assert.rejects(share(O, { targetId: plan }, [{ name: "fake.pdf", type: "application/pdf", bytes: Buffer.from("not a pdf") }]), /Only photos and PDFs/);
  await assert.rejects(
    share(O, { targetId: plan }, Array.from({ length: 11 }, (_, i) => ({ name: `${i}.png`, type: "image/png", bytes: png }))),
    (e: { status: number }) => e.status === 413,
  );
  await assert.rejects(share(V, { targetId: tasksDb, text: "No" }), (e: { status: number }) => e.status === 403);

  // Through the endpoint: multipart with several "file" parts.
  const { deviceToken } = await phone(owner);
  const form = new FormData();
  form.append("action", "capture.share");
  form.append("targetId", tasksDb);
  form.append("title", "Two photos");
  form.append("file", new File([new Uint8Array(png)], "a.png", { type: "image/png" }));
  form.append("file", new File([new Uint8Array(png)], "b.png", { type: "image/png" }));
  const response = await route.POST(
    new Request("http://localhost/api/mobile/widgets/action", { method: "POST", headers: { authorization: `Bearer ${deviceToken}` }, body: form }),
    { params: Promise.resolve({ action: "action" }) },
  );
  assert.equal(response.status, 200);
  const answer = (await response.json()) as { ok: boolean; action: string; files: string[]; rowId: string; url: string };
  assert.equal(answer.action, "capture.share");
  assert.equal(answer.files.length, 2);
  assert.match(answer.url, new RegExp(answer.rowId));
});

test("interactive tasks: my tasks, a view and a page, completed with the web app's rules", async () => {
  const doc = ((await command(owner.user, { action: "page.create", workspaceId: wid, spaceId: sid, title: "Sprint", kind: "document" })) as { id: string }).id;
  await writeDocument(owner.user, wid, doc, `<ul data-type="taskList">${taskItem("Late", day(-2))}${taskItem("Now", TODAY)}${taskItem("Later", day(5))}</ul>`);
  const texts = (data: Record<string, any>) => data.items.map((t: { text: string }) => t.text);
  assert.deepEqual(texts(await one_(O, "tasks", { filter: "today" })).filter((t: string) => ["Late", "Now", "Later"].includes(t)), ["Now"]);
  assert.deepEqual(texts(await one_(O, "tasks", { filter: "overdue" })).filter((t: string) => ["Late", "Now", "Later"].includes(t)), ["Late"]);
  const page = await one_(O, "tasks", { source: "page", pageId: doc, max: 2 });
  assert.deepEqual(texts(page), ["Late", "Now"]);
  assert.equal(page.total, 3);

  // Ticking off a document task changes the document like in the browser.
  const late = page.items[0];
  await act(O, { action: "task.complete", source: "doc", pageId: doc, index: late.index, text: late.text, done: true });
  assert.equal((await one<{ checked: number }>("SELECT checked FROM doc_tasks WHERE page_id=? AND text='Late'", doc))!.checked, 1);
  assert.match((await one<{ html: string }>("SELECT html FROM documents WHERE page_id=?", doc))!.html, /data-checked="true"/);
  assert.ok(await one("SELECT 1 FROM audit WHERE actor_id=? AND action='task.update' AND resource_id=?", O.id, doc));
  // A stale text is refused instead of ticking off the wrong task.
  await assert.rejects(act(O, { action: "task.complete", source: "doc", pageId: doc, index: 1, text: "Changed", done: true }), (e: { status: number }) => e.status === 409);
  // Viewers may look, not tick.
  await assert.rejects(act(V, { action: "task.complete", source: "doc", pageId: doc, index: 1, text: "Now", done: true }), (e: { status: number }) => e.status === 403);

  // Database view: open records (the "Erledigt" checkbox), private ones hidden.
  const db = await makeDatabase(owner.user, wid, sid, "Work items", [
    { id: "title", name: "Title", type: "text" },
    { id: "due", name: "Due", type: "date" },
    { id: "done", name: "Erledigt", type: "checkbox" },
  ]);
  const a = await addRow(owner.user, db, { title: "Alpha", due: TODAY });
  await addRow(owner.user, db, { title: "Beta", due: TODAY, done: true });
  const c = await addRow(owner.user, db, { title: "Private gamma", due: TODAY });
  await run("UPDATE rows SET access='private' WHERE id=?", c);
  assert.deepEqual(texts(await one_(O, "tasks", { source: "view", pageId: db })).sort(), ["Alpha", "Private gamma"]);
  const mine = await one_(E, "tasks", { source: "view", pageId: db, filter: "today" });
  assert.deepEqual(texts(mine), ["Alpha"]);
  assert.equal(mine.items[0].canEdit, true);
  assert.doesNotMatch(JSON.stringify(await widgets(E, [{ kind: "tasks", config: { source: "view", pageId: db } }])), /gamma/);
  const version = (await one<{ version: number }>("SELECT version FROM rows WHERE id=?", a))!.version;
  await act(E, { action: "task.complete", source: "row", pageId: db, rowId: a, done: true });
  const after = (await one<{ cells: string; version: number; updated_by: string }>("SELECT cells,version,updated_by FROM rows WHERE id=?", a))!;
  assert.equal(JSON.parse(after.cells).done, true);
  assert.equal(after.version, version + 1);
  assert.equal(after.updated_by, E.id);
  assert.ok(await one("SELECT 1 FROM audit WHERE actor_id=? AND action='row.update' AND resource_id=?", E.id, db));
  assert.deepEqual(texts(await one_(E, "tasks", { source: "view", pageId: db })), []);
  await act(E, { action: "task.complete", source: "row", pageId: db, rowId: a, done: false });
  assert.equal(JSON.parse((await one<{ cells: string }>("SELECT cells FROM rows WHERE id=?", a))!.cells).done, false);
  await assert.rejects(act(E, { action: "task.complete", source: "row", pageId: db, rowId: c, done: true }), (e: { status: number }) => e.status === 404);
  await assert.rejects(act(V, { action: "task.complete", source: "row", pageId: db, rowId: a, done: true }), (e: { status: number }) => e.status === 403);
  // Strangers get an error for that widget, not the data.
  const [denied] = await widgets(S, [{ kind: "tasks", config: { source: "view", pageId: db } }]);
  assert.equal(denied.ok, false);
  assert.equal(denied.status, 404);
});

test("checking off from the phone: long tasks, mentions with a due date, records – through the route", async () => {
  const acc = await account("widget-checker");
  await run("INSERT INTO members VALUES(?,?,?)", wid, acc.user.id, "editor");
  const { deviceToken } = await phone(acc);
  const post = async (action: "data" | "action", body: Record<string, unknown>) => {
    const response = await route.POST(
      new Request(`http://localhost/api/mobile/widgets/${action}?lang=en`, {
        method: "POST",
        headers: { authorization: `Bearer ${deviceToken}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
      { params: Promise.resolve({ action }) },
    );
    return { status: response.status, body: (await response.json()) as Record<string, any> };
  };
  const tasks = async (config: Record<string, unknown>) => {
    const answer = await post("data", { today: TODAY, zone: "UTC", widgets: [{ id: "t", kind: "tasks", config }] });
    assert.equal(answer.status, 200);
    const [result] = answer.body.widgets as Result[];
    assert.equal(result.ok, true, result.error ?? "");
    return result.data!.items as Record<string, any>[];
  };
  // What the app sends back: exactly the fields of the item.
  const complete = (item: Record<string, any>) =>
    post("action", { action: "task.complete", source: item.source, pageId: item.pageId, ...(item.rowId ? { rowId: item.rowId } : {}), ...(item.index !== undefined ? { index: item.index } : {}), ...(item.key ? { key: item.key } : {}), done: true });

  const long = `Prepare the quarterly report with all numbers from sales, marketing and support, then ${"send it to everyone who asked for it ".repeat(4)}`.trim();
  assert.ok(long.length > 120);
  const longer = "x".repeat(520);
  const mention = `<span data-mention="${acc.user.id}" class="mention">@widget-checker</span>`;
  const doc = ((await command(owner.user, { action: "page.create", workspaceId: wid, spaceId: sid, title: "Phone tasks", kind: "document" })) as { id: string }).id;
  await writeDocument(
    owner.user,
    wid,
    doc,
    `<ul data-type="taskList">${taskItem(`${mention} ${long}`, TODAY)}${taskItem(`Call ${mention} about the offer`, day(1))}${taskItem(`${mention} ${longer}`, day(2))}</ul>`,
  );
  const mine = await tasks({ source: "mine", filter: "open", max: 10 });
  const ours = mine.filter((t) => t.pageId === doc);
  assert.equal(ours.length, 3);
  const [first, second, third] = ours;
  // Shown shortened; identified by position and key.
  assert.ok(first.text.length <= 120 && first.text.endsWith("…"));
  assert.equal(typeof first.key, "string");
  assert.equal(first.canEdit, true);
  assert.equal(second.text, "Call @widget-checker about the offer");
  assert.equal(second.due, day(1));

  assert.equal((await complete(first)).status, 200);
  assert.equal((await complete(second)).status, 200);
  assert.equal((await complete(third)).status, 200);
  const after = await tasks({ source: "mine", filter: "open", max: 10 });
  assert.equal(after.filter((t) => t.pageId === doc).length, 0);
  assert.equal((await one<{ n: number }>("SELECT COUNT(*) n FROM doc_tasks WHERE page_id=? AND checked=1", doc))!.n, 3);
  assert.equal((await tasks({ source: "page", pageId: doc })).length, 0);

  // A stale position is still refused (the document changed meanwhile).
  await writeDocument(owner.user, wid, doc, `<ul data-type="taskList">${taskItem(`${mention} Something new`, TODAY)}${taskItem(`${mention} Second`, TODAY)}</ul>`);
  const fresh = (await tasks({ source: "page", pageId: doc })).find((t) => t.text.endsWith("Second"))!;
  const stale = await complete({ ...fresh, index: 0 });
  assert.equal(stale.status, 409);
  assert.equal(typeof stale.body.error, "string");
  // App builds before the key send the shown text, shortened with "…".
  const old = ((await command(owner.user, { action: "page.create", workspaceId: wid, spaceId: sid, title: "Old app", kind: "document" })) as { id: string }).id;
  await writeDocument(owner.user, wid, old, `<ul data-type="taskList">${taskItem(`${mention} ${long}`, TODAY)}</ul>`);
  const legacy = (await tasks({ source: "page", pageId: old }))[0];
  assert.ok(legacy.text.endsWith("…"));
  assert.equal((await post("action", { action: "task.complete", source: "doc", pageId: old, index: legacy.index, text: legacy.text, done: true })).status, 200);
  assert.equal((await tasks({ source: "page", pageId: old })).length, 0);

  // A task in a record's document, and a record of a database view.
  const db = await makeDatabase(owner.user, wid, sid, "Phone records", [
    { id: "title", name: "Title", type: "text" },
    { id: "due", name: "Due", type: "date" },
    { id: "done", name: "Erledigt", type: "checkbox" },
  ]);
  const record = await addRow(owner.user, db, { title: "Order paper", due: TODAY });
  const { rowDocumentData } = await import("../lib/row-documents");
  const Y = await import("yjs");
  const initial = await rowDocumentData(owner.user, db, record);
  const rowDoc = new Y.Doc();
  Y.applyUpdate(rowDoc, Buffer.from(initial.state, "base64"));
  Y.applyUpdate(rowDoc, htmlState(`<ul data-type="taskList">${taskItem(`${mention} Check the invoice`, TODAY)}</ul>`));
  await command(owner.user, { action: "row.document.sync", pageId: db, rowId: record, generation: initial.generation, update: Buffer.from(Y.encodeStateAsUpdate(rowDoc)).toString("base64") });
  const inRecord = (await tasks({ source: "mine", filter: "today" })).find((t) => t.rowId === record)!;
  assert.equal(inRecord.text, "@widget-checker Check the invoice");
  assert.equal((await complete(inRecord)).status, 200);
  assert.equal((await tasks({ source: "mine", filter: "today" })).filter((t) => t.rowId === record).length, 0);

  const row = (await tasks({ source: "view", pageId: db, filter: "today" })).find((t) => t.rowId === record)!;
  assert.equal(row.source, "row");
  assert.equal(row.canEdit, true);
  assert.equal((await complete(row)).status, 200);
  assert.equal((await tasks({ source: "view", pageId: db, filter: "today" })).filter((t) => t.rowId === record).length, 0);

  // A task given to the person in a page they may only read: shown, not tickable.
  const readOnly = ((await command(owner.user, { action: "page.create", workspaceId: wid, spaceId: sid, title: "Read only", kind: "document" })) as { id: string }).id;
  await writeDocument(owner.user, wid, readOnly, `<ul data-type="taskList">${taskItem(`${mention} Just look`, TODAY)}</ul>`);
  await run("UPDATE pages SET locked=1 WHERE id=?", readOnly);
  const locked = (await tasks({ source: "mine", filter: "today" })).find((t) => t.pageId === readOnly)!;
  assert.equal(locked.canEdit, false);
  assert.equal((await complete(locked)).status, 409);
});

test("my tasks include open records I am assigned to, with the web's rights", async () => {
  const me = await account("widget-assignee");
  await run("INSERT INTO members VALUES(?,?,?)", wid, me.user.id, "editor");
  const M = (await phone(me)).device;
  const other = editor.user.id;
  const db = await makeDatabase(owner.user, wid, sid, "Tickets", [
    { id: "title", name: "Title", type: "text" },
    { id: "status", name: "Status", type: "select", options: ["Open", "Done"] },
    { id: "who", name: "Verantwortlich", type: "person" },
    { id: "start", name: "Start", type: "date" },
    { id: "due", name: "Due", type: "date" },
  ]);
  const fix = await addRow(owner.user, db, { title: "Fix login", status: "Open", who: me.user.id, due: TODAY, start: day(-9) });
  await addRow(owner.user, db, { title: "Write docs", who: [other, me.user.id] });
  await addRow(owner.user, db, { title: "Late invoice", status: "Open", who: [me.user.id], due: day(-3) });
  await addRow(owner.user, db, { title: "Shipped", status: "Done", who: me.user.id, due: TODAY });
  await addRow(owner.user, db, { title: "Not mine", status: "Open", who: other, due: TODAY });
  const secret = await addRow(owner.user, db, { title: "Private salary talk", status: "Open", who: me.user.id, due: TODAY });
  await run("UPDATE rows SET access='private' WHERE id=?", secret);
  const shared = await addRow(owner.user, db, { title: "Look only", status: "Open", who: me.user.id });
  await run("UPDATE rows SET access='readonly' WHERE id=?", shared);

  const records = async (config: Record<string, unknown> = {}) =>
    ((await one_(M, "tasks", { source: "mine", filter: "open", max: 10, ...config })).items as Record<string, any>[]).filter((t) => t.pageId === db);
  const open = await records();
  // Overdue first, then today, then the ones without a date in the
  // database's order (lib/task-order.ts).
  assert.deepEqual(open.map((t) => t.text), ["Late invoice", "Fix login", "Write docs", "Look only"]);
  const first = open.find((t) => t.rowId === fix)!;
  // The due date is the property named like one, not simply the first date.
  assert.deepEqual([first.source, first.due, first.page, first.done, first.canEdit], ["row", TODAY, "Tickets", false, true]);
  assert.match(first.url, new RegExp(fix));
  assert.equal(open.find((t) => t.rowId === shared)!.canEdit, false);
  assert.doesNotMatch(JSON.stringify(await widgets(M, [{ kind: "tasks", config: { source: "mine" } }])), /salary|Not mine|Shipped/);
  assert.deepEqual((await records({ filter: "today" })).map((t) => t.text), ["Fix login"]);
  assert.deepEqual((await records({ filter: "overdue" })).map((t) => t.text), ["Late invoice"]);
  // The same records as "Records from databases" on the web page.
  const { crossRecords } = await import("../lib/cross-records");
  assert.deepEqual(
    (await crossRecords(me.user, wid, {})).records.map((r) => r.rowId).sort(),
    open.map((t) => t.rowId).sort(),
  );

  // Ticking one off sets the database's "done" state and drops it.
  await act(M, { action: "task.complete", source: "row", pageId: db, rowId: fix, done: true });
  assert.equal(JSON.parse((await one<{ cells: string }>("SELECT cells FROM rows WHERE id=?", fix))!.cells).status, "Done");
  assert.equal((await records()).some((t) => t.rowId === fix), false);
  await assert.rejects(act(M, { action: "task.complete", source: "row", pageId: db, rowId: shared, done: true }), (e: { status: number }) => e.status === 403);
  await assert.rejects(act(M, { action: "task.complete", source: "row", pageId: db, rowId: secret, done: true }), (e: { status: number }) => e.status === 404);

  // A viewer assigned to a record sees it, but cannot tick it.
  await command(owner.user, { action: "row.update", pageId: db, rowId: fix, version: (await one<{ version: number }>("SELECT version FROM rows WHERE id=?", fix))!.version, cells: { status: "Open", who: viewer.user.id } });
  const looking = ((await one_(V, "tasks", { source: "mine" })).items as Record<string, any>[]).find((t) => t.rowId === fix)!;
  assert.equal(looking.canEdit, false);
  await assert.rejects(act(V, { action: "task.complete", source: "row", pageId: db, rowId: fix, done: true }), (e: { status: number }) => e.status === 403);

  // A read rule on the person property: nothing counts as "mine" any more.
  // On the "done" property: shown, but not ticked off from the phone.
  const fields = (await database(db)).fields as Field[];
  const withRule = (id: string) => fields.map((f) => (f.id === id ? { ...f, access: { read: "owners" } } : f)) as Field[];
  const update = async (list: Field[]) => command(owner.user, { action: "database.update", pageId: db, version: (await database(db)).version, fields: list, views: (await database(db)).views });
  await update(withRule("status"));
  const hiddenDone = await records();
  assert.ok(hiddenDone.length >= 3);
  assert.ok(hiddenDone.every((t) => t.canEdit === false));
  await update(withRule("who"));
  assert.deepEqual(await records(), []);
  await update(fields);
});

test("pinned views and counters show only what the person may read", async () => {
  const rows = [
    { title: "Won deal", stage: "won", amount: 10, secret: "S-100" },
    { title: "Lost deal", stage: "lost", amount: 20, secret: "S-200" },
    { title: "Hidden deal", stage: "won", amount: 30, secret: "S-300" },
  ];
  const db = await makeDatabase(owner.user, wid, sid, "Sales", [
    { id: "title", name: "Title", type: "text" },
    { id: "stage", name: "Stage", type: "select", options: ["won", "lost"] },
    { id: "amount", name: "Amount", type: "number" },
    { id: "secret", name: "Salary", type: "text", access: { read: "owners" } },
  ]);
  const ids = await mapAsync(rows, async (cells) => await addRow(owner.user, db, cells));
  await run("UPDATE rows SET access='private' WHERE id=?", ids[2]);
  await run("UPDATE rows SET created_at=? WHERE id=?", `${day(-5)} 08:00:00`, ids[0]);

  const pinned = async (user: Identity) => await one_(user, "pinned", { mode: "page", pageId: db, properties: ["stage", "secret", "amount"] });
  const own = await pinned(O);
  assert.deepEqual(own.properties, ["Stage", "Salary", "Amount"]);
  assert.equal(own.items.length, 3);
  const theirs = await pinned(E);
  assert.deepEqual(theirs.properties, ["Stage", "Amount"]);
  assert.deepEqual(theirs.items.map((i: { title: string }) => i.title), ["Won deal", "Lost deal"]);
  assert.doesNotMatch(JSON.stringify(theirs), /S-\d00|Hidden deal|Salary/);

  const count = await one_(E, "counter", { pageId: db });
  assert.equal(count.value, 2);
  assert.equal((await one_(O, "counter", { pageId: db, history: false })).value, 3);
  const sum = await one_(O, "counter", { pageId: db, aggregate: "sum", fieldId: "amount", groupFieldId: "stage", groupValue: "won" });
  assert.equal(sum.value, 40);
  assert.equal(sum.records, 2);
  assert.equal(sum.history.length, 14);
  assert.deepEqual(sum.history[13], { day: TODAY, value: 40 });
  // Before the first snapshot: estimated from the records and their creation day.
  assert.deepEqual(sum.history[0], { day: day(-13), value: null, estimated: true });
  assert.deepEqual(sum.history.find((p: { day: string }) => p.day === day(-5)), { day: day(-5), value: 10, estimated: true });
  // One snapshot per configuration and day, updated on every refresh.
  const amountCells = JSON.parse((await one<{ cells: string }>("SELECT cells FROM rows WHERE id=?", ids[0]))!.cells);
  await run("UPDATE rows SET cells=? WHERE id=?", JSON.stringify({ ...amountCells, amount: 50 }), ids[0]);
  assert.equal((await one_(O, "counter", { pageId: db, aggregate: "sum", fieldId: "amount", groupFieldId: "stage", groupValue: "won" })).history[13].value, 80);
  assert.equal((await one<{ n: number }>("SELECT COUNT(*) n FROM widget_counter_days WHERE user_id=?", O.id))!.n, 1);
  // Average over a property the editor cannot read: refused.
  const [hidden] = await widgets(E, [{ kind: "counter", config: { pageId: db, aggregate: "sum", fieldId: "secret" } }]);
  assert.equal(hidden.status, 400);
});

test("recently opened pages (Android app shortcuts): newest first, only what the person may read", async () => {
  const acc = await account("widget-recent");
  await run("INSERT INTO members VALUES(?,?,?)", wid, acc.user.id, "editor");
  const R = (await phone(acc)).device;
  const page = async (title: string) => ((await command(owner.user, { action: "page.create", workspaceId: wid, spaceId: sid, title, kind: "document" })) as { id: string }).id;
  const [first, second, gone] = [await page("First"), await page("Second"), await page("Gone")];
  const privateWorkspace = await createWorkspace(stranger.user.id, "Private");
  const elsewhere = await createPage(privateWorkspace, (await bootstrap(stranger.user, privateWorkspace)).spaces[0].id, stranger.user.id, "Not yours", "document");
  const visit = async (pageId: string, at: number) => await run("INSERT INTO page_visits(user_id,page_id,seen_at) VALUES(?,?,?)", R.id, pageId, at);
  await visit(first, 1);
  await visit(second, 3);
  await visit(gone, 4);
  await visit(elsewhere, 5);
  await run("UPDATE pages SET deleted_at=? WHERE id=?", nowText(), gone);
  const recent = await one_(R, "pinned", { mode: "recent", max: 5 });
  assert.equal(recent.title, "Recently opened");
  assert.deepEqual(recent.items.map((i: { title: string }) => i.title), ["Second", "First"]);
  assert.equal(recent.items[0].url, `/#page=${second}`);
  assert.deepEqual((await one_(R, "pinned", { mode: "recent", max: 1 })).items.map((i: { id: string }) => i.id), [second]);
});

test("journals behind a PIN show 'locked'; encrypted spaces only a status", async () => {
  const journal = ((await command(owner.user, { action: "page.create", workspaceId: wid, spaceId: sid, title: "Diary", kind: "journal" })) as { id: string }).id;
  const yesterday = ((await command(owner.user, { action: "journal.roll", pageId: journal, date: day(-1) })) as { dayId: string }).dayId;
  const write = async (pageId: string, html: string) => await run("UPDATE documents SET html=?,state=? WHERE page_id=?", html, htmlState(html), pageId);
  await write(yesterday, "<p>Dear diary, yesterday</p>");
  const today = ((await command(owner.user, { action: "journal.roll", pageId: journal, date: TODAY })) as { dayId: string }).dayId;
  const before = await one_(O, "journal", { journalId: journal });
  assert.equal(before.journal.written, false);
  assert.equal(before.journal.streak, 1);
  await write(today, "<p>Dear diary, the secret of today</p>");
  const open = await one_(O, "journal", { journalId: journal });
  assert.equal(open.journal.written, true);
  assert.equal(open.journal.streak, 2);
  assert.deepEqual(open.journal.trackers.map((t: { id: string }) => t.id), ["mood"]);
  assert.doesNotMatch(JSON.stringify(open), /secret of today/);

  // Mood via a widget: the day's entry, like the journal bar.
  return act(O, { action: "journal.track", journalId: journal, today: TODAY, trackerId: "mood", value: 4 }).then(async () => {
    assert.equal((await one_(O, "journal", { journalId: journal })).journal.trackers[0].value, 4);
    await command(owner.user, { action: "favorite", pageId: today, value: true });
    await run("INSERT INTO notifications(id,user_id,body,page_id,kind) VALUES(?,?,?,?,'mention')", id(), O.id, "Ben hat dich in „Dear diary secret“ erwähnt", today);
    await command(owner.user, { action: "journal.lock", pageId: journal, pin: "482915" });
    await run("DELETE FROM journal_unlocks WHERE page_id=?", journal);
    const locked = await widgets(O, [
      { kind: "journal", config: { journalId: journal } },
      { kind: "pinned", config: { mode: "page", pageId: journal } },
      { kind: "pinned", config: { mode: "favorites" } },
      { kind: "mentions", config: {} },
      { kind: "tasks", config: { source: "page", pageId: today } },
    ]);
    assert.deepEqual(locked[0].data!.journal, { id: journal, name: "Diary", locked: true, url: `/#page=${journal}` });
    assert.equal(locked[1].data!.locked, true);
    assert.deepEqual(locked[1].data!.items, []);
    const favorite = locked[2].data!.items.find((i: { id: string }) => i.id === today);
    assert.equal(favorite.locked, true);
    assert.equal(favorite.title, "");
    assert.equal(locked[3].data!.items[0].locked, true);
    assert.equal(locked[3].data!.items[0].text, "Mention in a protected page");
    assert.equal(locked[4].data!.locked, true);
    assert.doesNotMatch(JSON.stringify(locked), /Dear diary|secret|Donnerstag|Thursday/i);
    return assert.rejects(act(O, { action: "capture.note", targetId: today, title: "x" }), (e: { status: number }) => e.status === 423);
  }).then(async () => {
    // End-to-end encrypted space: names and content never leave the server.
    const encryptedSpace = id();
    await run("INSERT INTO spaces(id,workspace_id,name,owner_id,visibility) VALUES(?,?,?,?,?)", encryptedSpace, wid, "Vault", owner.user.id, "private");
    const secretPage = await createPage(wid, encryptedSpace, owner.user.id, "Merger plans", "document");
    // A record assigned to the person there stays out of "My tasks".
    const secretDb = await createPage(wid, encryptedSpace, owner.user.id, "Merger tasks", "database");
    await run("UPDATE databases SET fields=? WHERE page_id=?", JSON.stringify([{ id: "title", name: "Title", type: "text" }, { id: "who", name: "Who", type: "person" }]), secretDb);
    await run("INSERT INTO rows(id,page_id,cells) VALUES(?,?,?)", id(), secretDb, JSON.stringify({ title: "Merger task", who: O.id }));
    await run("UPDATE spaces SET encrypted=1,encrypt_titles=1 WHERE id=?", encryptedSpace);
    await run("INSERT INTO favorites(user_id,page_id) VALUES(?,?)", O.id, secretPage);
    const result = await widgets(O, [
      { kind: "pinned", config: { mode: "favorites" } },
      { kind: "pinned", config: { mode: "page", pageId: secretPage } },
      { kind: "tasks", config: { source: "mine" } },
    ]);
    assert.equal(result[2].ok, true);
    assert.equal(result[2].data!.items.some((i: { pageId: string }) => i.pageId === secretDb), false);
    assert.equal(result[0].data!.items.find((i: { id: string }) => i.id === secretPage).encrypted, true);
    assert.deepEqual(result[1].data, { title: "", encrypted: true, url: `/#page=${secretPage}`, items: [] });
    assert.doesNotMatch(JSON.stringify(result), /Merger/);
    const options = (await W.widgetOptions(O, "pinned")) as { pages: { id: string; name: string; encrypted?: boolean }[] };
    assert.deepEqual(options.pages.find((p) => p.id === secretPage)?.name, "");
    assert.doesNotMatch(JSON.stringify(await W.widgetOptions(O, "capture")), /Merger|Vault/);
    await assert.rejects(act(O, { action: "capture.note", targetId: secretPage, title: "x" }), (e: { status: number }) => e.status === 409);
  });
});

test("habits: today's record is created once and ticked off", async () => {
  const habits = await makeDatabase(owner.user, wid, sid, "Habits", [
    { id: "title", name: "Day", type: "text" },
    { id: "date", name: "Date", type: "date" },
    { id: "sport", name: "Sport", type: "checkbox" },
    { id: "read", name: "Read", type: "checkbox" },
  ]);
  assert.ok(((await W.widgetOptions(O, "journal")) as { habits: { id: string }[] }).habits.some((h) => h.id === habits));
  const before = (await one_(O, "journal", { habitsId: habits })).habits;
  assert.equal(before.total, 2);
  assert.equal(before.done, 0);
  await act(O, { action: "habit.check", pageId: habits, fieldId: "sport", done: true, today: TODAY });
  await act(O, { action: "habit.check", pageId: habits, fieldId: "read", done: true, today: TODAY });
  const after = (await one_(O, "journal", { habitsId: habits })).habits;
  assert.equal(after.done, 2);
  assert.equal((await one<{ n: number }>("SELECT COUNT(*) n FROM rows WHERE page_id=?", habits))!.n, 1);
  await assert.rejects(act(V, { action: "habit.check", pageId: habits, fieldId: "read", done: false, today: TODAY }), (e: { status: number }) => e.status === 403);
  await assert.rejects(act(O, { action: "habit.check", pageId: habits, fieldId: "title", done: true, today: TODAY }), (e: { status: number }) => e.status === 400);
});

test("calendar and meeting now: events of the chosen views, the meeting note on demand", async () => {
  const at = (ms: number) => new Date(ms).toISOString().slice(0, 16);
  const cal = await makeDatabase(
    owner.user,
    wid,
    sid,
    "Meetings",
    [
      { id: "title", name: "Title", type: "text" },
      { id: "when", name: "When", type: "date" },
      { id: "until", name: "Until", type: "date" },
    ],
    [
      { id: "table", name: "Table", type: "table", filters: [], sorts: [] },
      { id: "cal", name: "Calendar", type: "calendar", filters: [], sorts: [], dateField: "when", endDateField: "until" },
    ],
  );
  await addRow(owner.user, cal, { title: "Standup", when: at(NOW - 10 * 60_000), until: at(NOW + 50 * 60_000) });
  await addRow(owner.user, cal, { title: "Review", when: at(NOW + 2 * 3_600_000), until: at(NOW + 3 * 3_600_000) });
  await addRow(owner.user, cal, { title: "Offsite", when: TODAY });
  await addRow(owner.user, cal, { title: "Next month", when: day(40) });
  const options = (await W.widgetOptions(E, "calendar")) as { calendars: { pageId: string; viewId: string }[] };
  assert.ok(options.calendars.some((c) => c.pageId === cal && c.viewId === "cal"));
  const sources = [{ pageId: cal, viewId: "cal" }];
  const titles = (await one_(E, "calendar", { sources, range: "3days", tasks: false })).items.map((i: { title: string }) => i.title);
  assert.ok(["Standup", "Review", "Offsite"].every((t) => titles.includes(t)), titles.join());
  assert.ok(!titles.includes("Next month"));
  assert.ok((await one_(E, "calendar", { range: "week" })).items.some((i: { title: string }) => i.title === "Offsite"));
  assert.deepEqual((await one_(S, "calendar", { sources })).items, []);

  const worklog = ((await command(owner.user, { action: "page.create", workspaceId: wid, spaceId: sid, title: "Work log", kind: "journal" })) as { id: string }).id;
  const meeting = await one_(O, "meeting", { sources, journalId: worklog });
  assert.equal(meeting.now.title, "Standup");
  assert.equal(meeting.next.title, "Review");
  assert.equal(meeting.now.note, null);
  assert.equal(meeting.now.canCreateNote, true);
  const note = await act(O, {
    action: "meeting.note",
    pageId: cal,
    rowId: meeting.now.rowId,
    date: meeting.now.date,
    start: meeting.now.start,
    end: meeting.now.end,
    timed: true,
    zone: "UTC",
    journalId: worklog,
  });
  assert.equal(note.existing, false);
  const notePage = (await one<{ title: string; parent_id: string }>("SELECT title,parent_id FROM pages WHERE id=?", note.noteId as string))!;
  assert.match(notePage.title, /^Standup/);
  assert.equal(notePage.parent_id, worklog);
  assert.equal((await one_(O, "meeting", { sources })).now.note.id, note.noteId);
  const again = await act(O, { action: "meeting.note", pageId: cal, rowId: meeting.now.rowId, date: meeting.now.date, start: meeting.now.start, timed: true, journalId: worklog });
  assert.equal(again.existing, true);
  // A viewer cannot create one.
  await assert.rejects(act(V, { action: "meeting.note", pageId: cal, rowId: meeting.now.rowId, date: meeting.now.date, start: meeting.now.start }), (e: { status: number }) => e.status === 404);
});

test("time this week, the timer and a focus session that records its time", async () => {
  const work = await makeDatabase(owner.user, wid, sid, "Work", [
    { id: "title", name: "Title", type: "text" },
    { id: "spent", name: "Time", type: "time" },
  ]);
  const offer = await addRow(owner.user, work, { title: "Write offer" });
  await run(`INSERT INTO time_entries(id,page_id,row_id,field_id,user_id,start,"end") VALUES(?,?,?,?,?,?,?)`, id(), work, offer, "spent", O.id, NOW - 3_600_000, NOW);
  const time = await one_(O, "time");
  const hours = Math.min(3_600_000, NOW - WEEK_START) / 3_600_000;
  assert.ok(Math.abs(time.week - hours) <= 0.01, String(time.week));
  assert.equal(time.days.length, 7);
  assert.equal(time.timer, null);
  assert.equal(time.recent[0].title, "Write offer");

  await act(O, { action: "timer.start", pageId: work, rowId: offer, fieldId: "spent" });
  assert.equal((await one_(O, "time")).timer.title, "Write offer");
  await act(O, { action: "timer.stop" });
  assert.equal((await one_(O, "time")).timer, null);
  await assert.rejects(act(V, { action: "timer.start", pageId: work, rowId: offer, fieldId: "spent" }), (e: { status: number }) => e.status === 403);

  const started = await act(O, { action: "focus.start", minutes: 25, breakMinutes: 5, pageId: work, rowId: offer, fieldId: "spent" });
  const focus = started.focus as { phase: string; startedAt: number; focusEndsAt: number; task: { title: string } };
  assert.equal(focus.phase, "focus");
  assert.equal(focus.task.title, "Write offer");
  assert.equal(focus.focusEndsAt - focus.startedAt, 25 * 60_000);
  assert.ok(await one(`SELECT 1 FROM time_entries WHERE user_id=? AND "end" IS NULL`, O.id));
  // After the focus time the timer stops at its end, not when asked.
  const brk = await one_(O, "focus", {}, focus.startedAt + 27 * 60_000);
  assert.equal(brk.phase, "break");
  const entry = (await one<{ start: number; end: number }>(`SELECT start,"end" FROM time_entries WHERE user_id=? ORDER BY start DESC LIMIT 1`, O.id))!;
  assert.equal(entry.end, focus.focusEndsAt);
  assert.equal((await one_(O, "focus", {}, focus.startedAt + 31 * 60_000)).phase, "idle");
  // Stopping early stops the timer at once.
  await act(O, { action: "focus.start", minutes: 50, breakMinutes: 10, pageId: work, rowId: offer, fieldId: "spent" });
  const stopped = await act(O, { action: "focus.stop" });
  assert.equal((stopped.focus as { phase: string }).phase, "idle");
  assert.equal(await one(`SELECT 1 FROM time_entries WHERE user_id=? AND "end" IS NULL`, O.id), undefined);
  // Without a task: a plain focus session.
  assert.equal(((await act(E, { action: "focus.start", minutes: 15, breakMinutes: 0 })).focus as { phase: string }).phase, "focus");
  await assert.rejects(act(E, { action: "focus.start", minutes: 15, pageId: work }), (e: { status: number }) => e.status === 400);
});

test("mentions and assignments only, marked read from the widget", async () => {
  const note = async (kind: string, body: string, pageId: string | null = plan) => {
    const nid = id();
    await run("INSERT INTO notifications(id,user_id,body,page_id,kind) VALUES(?,?,?,?,?)", nid, E.id, body, pageId, kind);
    return nid;
  };
  const mention = await note("mention", "Ben hat dich in „Plan“ erwähnt");
  await note("mention", "Ben hat dir eine Aufgabe in „Plan“ gegeben: Prepare slides");
  const comment = await note("comment", "Ben hat „Plan“ kommentiert");
  const all_ = await one_(E, "mentions");
  assert.deepEqual(all_.items.map((i: { type: string }) => i.type), ["assignment", "mention"]);
  assert.deepEqual(all_.unread, { mentions: 1, assignments: 1 });
  assert.equal(all_.items[1].text, "Ben mentioned you in “Plan”");
  assert.deepEqual((await one_(E, "mentions", { show: "assignments" })).items.map((i: { type: string }) => i.type), ["assignment"]);
  await act(E, { action: "mention.read", notificationId: mention });
  assert.deepEqual((await one_(E, "mentions", { show: "mentions" })).items, []);
  assert.equal((await one_(E, "mentions", { show: "mentions", unreadOnly: false })).items[0].read, true);
  await assert.rejects(act(E, { action: "mention.read", notificationId: comment }), (e: { status: number }) => e.status === 404);
  await assert.rejects(act(V, { action: "mention.read", notificationId: mention }), (e: { status: number }) => e.status === 404);
  assert.equal((await act(E, { action: "mention.readAll" })).changed, 1);
  assert.equal((await one<{ read_at: string | null }>("SELECT read_at FROM notifications WHERE id=?", comment))!.read_at, null);
});

test("form responses: new ones since the last look, the latest few", async () => {
  const form = await makeDatabase(owner.user, wid, sid, "Feedback", [
    { id: "title", name: "Name", type: "text" },
    { id: "text", name: "Text", type: "text" },
  ]);
  await run("INSERT INTO forms(page_id,token,enabled) VALUES(?,?,1)", form, id());
  const old = await addRow(owner.user, form, { title: "Old answer" });
  await run("UPDATE rows SET created_at=? WHERE id=?", `${day(-3)} 09:00:00`, old);
  await addRow(owner.user, form, { title: "Fresh answer" });
  assert.ok((await W.formList(E)).some((f) => f.id === form));
  const data = await one_(E, "forms", { pageId: form });
  assert.equal(data.total, 2);
  assert.equal(data.new, 1);
  assert.deepEqual(data.items.map((i: { title: string; new: boolean }) => [i.title, i.new]), [["Fresh answer", true], ["Old answer", false]]);
  assert.equal((await one_(E, "forms", { pageId: form, since: NOW - 10 * 86_400_000 })).new, 2);
  assert.equal((await widgets(S, [{ kind: "forms", config: { pageId: form } }]))[0].status, 404);
});

test("long-running jobs: progress for the Live Activity, only the person's own", async () => {
  const seen = await trackJob(owner.user, "import", "notion-export.zip", async () => {
    await jobProgress(0.5);
    const running = await one_(O, "jobs");
    assert.equal(running.running, 1);
    assert.equal(running.items[0].status, "running");
    assert.equal(running.items[0].progress, 50);
    assert.equal(running.items[0].label, "notion-export.zip");
    return running.items[0].id;
  });
  const done = (await one_(O, "jobs")).items.find((j: { id: string }) => j.id === seen);
  assert.equal(done.status, "done");
  assert.equal(done.progress, 100);
  await assert.rejects(trackJob(owner.user, "export", "Markdown", () => Promise.reject(new Error("disk full"))), /disk full/);
  assert.equal((await one_(O, "jobs")).items[0].status, "failed");
  assert.deepEqual((await one_(E, "jobs")).items, []);
  // Entries of an earlier server process count as interrupted.
  await run("UPDATE background_jobs SET status='running',boot='old',finished_at=NULL WHERE id=?", seen);
  assert.equal((await one_(O, "jobs")).items.find((j: { id: string }) => j.id === seen).status, "interrupted");
});

test("admin incident: administrators only, checked again on every request", async () => {
  const admin = await account("widget-admin", ["flowplan-admins"]);
  const { deviceToken } = await phone(admin);
  const device = async () => (await W.widgetUser(`Bearer ${deviceToken}`))!;
  const incident = (await widgets(await device(), [{ kind: "incident" }]))[0];
  assert.equal(incident.ok, true);
  assert.ok(["ok", "warning", "critical"].includes(incident.data!.level));
  assert.ok(Array.isArray(incident.data!.issues));
  assert.equal((await device()).isAdmin, false, "the device identity itself never administers");
  assert.equal((await widgets(E, [{ kind: "incident" }]))[0].status, 403);
  assert.equal(((await W.widgetOptions(E, "incident")) as { available: boolean }).available, false);
  // A local account that lost its admin right.
  await run("INSERT INTO local_accounts(user_id,email,password_hash,is_admin,created_at) VALUES(?,?,?,?,?)", admin.user.id, "widget-admin@example.test", "x", 0, Date.now());
  assert.equal((await widgets(await device(), [{ kind: "incident" }]))[0].status, 403);
  await run("UPDATE local_accounts SET is_admin=1 WHERE user_id=?", admin.user.id);
  assert.equal((await widgets(await device(), [{ kind: "incident" }]))[0].ok, true);
  // Groups of the session change (SSO sign-in without the admin group).
  await run("UPDATE sessions SET groups_json='[]' WHERE token=?", admin.token);
  assert.equal((await widgets(await device(), [{ kind: "incident" }]))[0].status, 403);
});

test("answers stay small: at most 10 items and 2 KB per widget, 16 widgets per request", async () => {
  const big = await makeDatabase(owner.user, wid, sid, "Big", [
    { id: "title", name: "Title", type: "text" },
    { id: "notes", name: "Notes", type: "text" },
  ]);
  for (let i = 0; i < 30; i++) await addRow(owner.user, big, { title: `${i} ${"long title ".repeat(30)}`, notes: "n".repeat(500) });
  const pinned = await one_(O, "pinned", { mode: "page", pageId: big, properties: ["notes"], max: 10 });
  assert.ok(pinned.items.length <= 10);
  assert.ok(bytes(pinned) <= W.MAX_WIDGET_BYTES, String(bytes(pinned)));
  assert.equal(pinned.total, 30);
  await assert.rejects(async () => await W.widgetsData(O, { widgets: Array.from({ length: 17 }, () => ({ kind: "time" })) }));
  const tooMany = (await W.widgetsData(O, { widgets: [{ kind: "tasks", config: { max: 50 } }] })).widgets[0];
  assert.equal(tooMany.ok, false);
  assert.equal((tooMany as { status: number }).status, 400);
  const capped = W.capped({ title: "x", items: Array.from({ length: 200 }, (_, i) => ({ title: `item ${i} ${"y".repeat(100)}` })) });
  assert.ok(bytes(capped) <= W.MAX_WIDGET_BYTES);
  assert.equal(capped.truncated, true);
  // Every kind answers within the limit for this busy account.
  const all_ = await widgets(O, W.widgetKinds.filter((k) => k !== "incident" && k !== "counter" && k !== "forms").map((kind) => ({ kind, config: {} })));
  for (const w of all_) {
    assert.equal(w.ok, true, `${w.kind}: ${w.error}`);
    assert.ok(bytes(w.data) <= W.MAX_WIDGET_BYTES, `${w.kind}: ${bytes(w.data)}`);
    for (const value of Object.values(w.data!)) if (Array.isArray(value) && w.kind !== "time") assert.ok(value.length <= 10, w.kind);
  }
});

test("guests see only what is shared with them; rate limits per person", async () => {
  assert.deepEqual((await one_(G, "pinned")).items, []);
  assert.deepEqual(((await W.widgetOptions(G, "pinned")) as { pages: unknown[] }).pages, []);
  await run("INSERT INTO grants(resource_id,user_id,group_id,role) VALUES(?,?,?,?)", plan, G.id, "", "viewer");
  await run("INSERT INTO favorites(user_id,page_id) VALUES(?,?)", G.id, plan);
  assert.deepEqual((await one_(G, "pinned")).items.map((i: { id: string }) => i.id), [plan]);
  const shared = ((await W.widgetOptions(G, "pinned")) as { pages: { id: string }[] }).pages.map((p) => p.id);
  assert.ok(shared.includes(plan) && !shared.includes(tasksDb));
  // Only the shared page and what lies below it.
  for (const pageId of shared) assert.ok(pageId === plan || (await one<{ parent_id: string }>("SELECT parent_id FROM pages WHERE id=?", pageId))!.parent_id === plan);
  assert.deepEqual(((await W.widgetOptions(G, "capture")) as { targets: unknown[] }).targets, []);

  const busy = await account("widget-busy");
  for (let i = 0; i < 30; i++) W.limitWidgets(busy.user, "action");
  assert.throws(() => W.limitWidgets(busy.user, "action"), (e: { status: number }) => e.status === 429);
  W.limitWidgets(busy.user, "data");
  // Through the route, too.
  const { deviceToken } = await phone(busy);
  const response = await route.POST(
    new Request("http://localhost/api/mobile/widgets/action", { method: "POST", headers: { authorization: `Bearer ${deviceToken}` }, body: JSON.stringify({ action: "mention.readAll" }) }),
    { params: Promise.resolve({ action: "action" }) },
  );
  assert.equal(response.status, 429);
  assert.equal((await all<{ id: string }>("SELECT id FROM notifications WHERE user_id=?", busy.user.id)).length, 0);
});

test("tasks in a sensible order: overdue, today, upcoming, undated – the same in the overview and the Tasks widget", async () => {
  const acc = await account("widget-order");
  await run("INSERT INTO members VALUES(?,?,?)", wid, acc.user.id, "editor");
  const { device } = await phone(acc);
  const mention = `<span data-mention="${acc.user.id}" class="mention">@widget-order</span>`;
  const open = (text: string) => `<li data-type="taskItem" data-checked="false"><p>${mention} ${text}</p></li>`;
  const dated = (text: string, due: string) => taskItem(`${mention} ${text}`, due);
  const create = async (title: string) => ((await command(owner.user, { action: "page.create", workspaceId: wid, spaceId: sid, title, kind: "document" })) as { id: string }).id;
  // Written in an order that is none of the expected ones; "Zeta" first.
  const zeta = await create("Zeta order"),
    alpha = await create("Alpha order");
  await writeDocument(owner.user, wid, zeta, `<ul data-type="taskList">${open("Z1")}${dated("Upcoming", day(3))}${open("Z2")}${dated("Today", TODAY)}</ul>`);
  await writeDocument(owner.user, wid, alpha, `<ul data-type="taskList">${open("A1")}${dated("Tomorrow", day(1))}${dated("Long overdue", day(-9))}${open("A2")}${dated("Overdue", day(-1))}</ul>`);
  const expected = ["Long overdue", "Overdue", "Today", "Tomorrow", "Upcoming", "A1", "A2", "Z1", "Z2"];
  const strip = (text: string) => text.replace(/^@widget-order /, "");
  const suite = await one_(device, "tasks", { source: "mine", filter: "open", max: 10 });
  // As many as fit into the widget's 2 KB, in that order.
  assert.ok(suite.items.length >= 5);
  assert.deepEqual(suite.items.map((t: { text: string }) => strip(t.text)), expected.slice(0, suite.items.length));
  assert.equal(suite.total, expected.length);
  assert.ok(suite.items.every((t: Record<string, unknown>) => !("order" in t)));
  const summary = await mobileSummary(acc.user, TODAY);
  assert.deepEqual(summary.tasks.items.map((t) => strip(t.text)), expected.slice(0, 8));
  assert.equal(summary.tasks.due, 3);
  assert.equal(summary.tasks.overdue, 2);
  // One page: by date, then the position in the document.
  const page = await one_(device, "tasks", { source: "page", pageId: alpha, max: 10 });
  assert.deepEqual(page.items.map((t: { text: string }) => strip(t.text)), ["Long overdue", "Overdue", "Tomorrow", "A1", "A2"]);

  // A database view: equal dates by priority (high first), then the view's order.
  const db = await makeDatabase(owner.user, wid, sid, "Prioritised", [
    { id: "title", name: "Title", type: "text" },
    { id: "due", name: "Due", type: "date" },
    { id: "prio", name: "Priority", type: "select", options: ["High", "Medium", "Low"] },
  ]);
  await addRow(owner.user, db, { title: "Undated high", prio: "High" });
  await addRow(owner.user, db, { title: "Today low", due: TODAY, prio: "Low" });
  await addRow(owner.user, db, { title: "Today none", due: TODAY });
  await addRow(owner.user, db, { title: "Today high", due: TODAY, prio: "High" });
  await addRow(owner.user, db, { title: "Late medium", due: day(-1), prio: "Medium" });
  const view = await one_(device, "tasks", { source: "view", pageId: db, max: 10 });
  assert.deepEqual(
    view.items.map((t: { text: string }) => t.text),
    ["Late medium", "Today high", "Today low", "Today none", "Undated high"],
  );
});
