import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { Field, Identity } from "../lib/types";

process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-capture-"));
process.env.FLOWPLAN_OCR = "0";
const { id, one, all, run } = await import("../lib/db");
const { command, bootstrap, database } = await import("../lib/api");
const { createWorkspace } = await import("../lib/seed");
const { registerMobileDevice } = await import("../lib/mobile-devices");
const { withContentLocale } = await import("../lib/content-locale");
const W = await import("../lib/mobile-widgets");
const C = await import("../lib/mobile-capture");
const route = await import("../app/api/mobile/capture/[action]/route");

function account(name: string) {
  const uid = id(),
    token = id();
  run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, name, `${name}@example.test`);
  run("INSERT INTO sessions(token,user_id,groups_json,expires) VALUES(?,?,?,?)", token, uid, "[]", Date.now() + 3600000);
  const user = { id: uid, name, email: `${name}@example.test`, groups: [], isAdmin: false, disabled: 0, created_at: "" } as unknown as Identity;
  const { deviceToken } = registerMobileDevice(user, token, { installationId: randomUUID(), platform: "ios" });
  return { user, deviceToken, device: W.widgetUser(`Bearer ${deviceToken}`)! };
}
const save = (user: Identity, body: Record<string, unknown>, files: { name: string; type: string; bytes: Buffer }[] = []) =>
  withContentLocale("en", () => C.saveCapture(user, body, files));
const ctx = (action: string) => ({ params: Promise.resolve({ action }) });

const owner = account("capture-owner"),
  viewer = account("capture-viewer"),
  stranger = account("capture-stranger");
const wid = createWorkspace(owner.user.id, "Capture");
const sid = bootstrap(owner.user, wid).spaces[0].id;
run("INSERT INTO members VALUES(?,?,?)", wid, viewer.user.id, "viewer");
createWorkspace(stranger.user.id, "Elsewhere");
const O = owner.device;

function makeDatabase(title: string, fields: Field[]) {
  const pageId = (command(owner.user, { action: "page.create", workspaceId: wid, spaceId: sid, kind: "database", title }) as { id: string }).id;
  const current = database(pageId);
  command(owner.user, { action: "database.update", pageId, version: current.version, fields, views: current.views });
  return pageId;
}
const inbox = makeDatabase("Inbox", [
  { id: "title", name: "Title", type: "text" },
  { id: "link", name: "Link", type: "url" },
  { id: "files", name: "Files", type: "files" },
]);
const notes = (command(owner.user, { action: "page.create", workspaceId: wid, spaceId: sid, title: "Notes", kind: "document" }) as { id: string }).id;
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const pdf = Buffer.from("%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n");
const html = (pageId: string) => one<{ html: string }>("SELECT html FROM documents WHERE page_id=?", pageId)!.html;

test("targets: only with a device token; the inbox is the capture database once one is set", async () => {
  const get = (authorization?: string) =>
    route.GET(new Request("http://localhost/api/mobile/capture/targets?lang=en", { headers: authorization ? { authorization } : {} }), ctx("targets"));
  assert.equal((await get()).status, 401);
  const before = (await (await get(`Bearer ${owner.deviceToken}`)).json()) as { inbox: unknown; targets: { id: string; kind: string }[]; maxFiles: number };
  assert.equal(before.inbox, null);
  assert.ok(before.targets.some((t) => t.id === inbox && t.kind === "database"));
  assert.ok(before.targets.some((t) => t.id === notes && t.kind === "document"));
  assert.equal(before.maxFiles, C.MAX_CAPTURE_FILES);
  // Without an inbox, "inbox" asks to choose.
  await assert.rejects(save(O, { targetId: "inbox", text: "Lost" }), (e: { status: number }) => e.status === 409);
  command(owner.user, { action: "capture.target", workspaceId: wid, pageId: inbox });
  const after = C.captureTargets(O);
  assert.equal(after.inbox?.id, inbox);
  assert.equal(after.inbox?.name, "Inbox");
  // Viewers may not add anything.
  assert.deepEqual(C.captureTargets(viewer.device).targets, []);
  assert.equal(C.captureTargets(viewer.device).inbox, null);
  assert.equal((await route.GET(new Request("http://localhost/api/mobile/capture/nothing", { headers: { authorization: `Bearer ${owner.deviceToken}` } }), ctx("nothing"))).status, 404);
});

test("a shared link and text land in the inbox as a record with the link in its URL property", async () => {
  const saved = await save(O, { targetId: "inbox", text: "Worth reading\nhttps://example.org/article", title: "" });
  assert.equal(saved.pageId, inbox);
  const row = one<{ cells: string; content: string }>("SELECT cells,content FROM rows WHERE id=?", saved.rowId!)!;
  const cells = JSON.parse(row.cells);
  assert.equal(cells.title, "Worth reading");
  assert.equal(cells.link, "https://example.org/article");
  assert.match(saved.url, new RegExp(`page=${inbox}&row=${saved.rowId}`));
  await assert.rejects(save(O, { targetId: "inbox" }), (e: { status: number }) => e.status === 400);
});

test("images and PDFs into a database: the files belong to the database and fill its files property", async () => {
  const saved = await save(O, { targetId: inbox, title: "Receipt" }, [
    { name: "photo.png", type: "image/png", bytes: png },
    { name: "invoice.pdf", type: "application/pdf", bytes: pdf },
  ]);
  assert.equal(saved.files.length, 2);
  const files = all<{ page_id: string; mime: string }>("SELECT page_id,mime FROM files WHERE id IN (?,?)", ...saved.files.map((f) => f.split("/").pop()!));
  assert.deepEqual(files.map((f) => f.page_id), [inbox, inbox]);
  assert.deepEqual(files.map((f) => f.mime).sort(), ["application/pdf", "image/png"]);
  assert.deepEqual(JSON.parse(one<{ cells: string }>("SELECT cells FROM rows WHERE id=?", saved.rowId!)!.cells).files, saved.files);
});

test("shares into a document become a sub page; other file types are refused", async () => {
  const saved = await save(O, { targetId: notes, text: "From the phone", url: "https://example.org" }, [{ name: "a.png", type: "image/png", bytes: png }]);
  assert.notEqual(saved.pageId, notes);
  assert.equal(one<{ parent_id: string }>("SELECT parent_id FROM pages WHERE id=?", saved.pageId)!.parent_id, notes);
  const body = html(saved.pageId);
  assert.match(body, /From the phone/);
  assert.match(body, /href="https:\/\/example.org"/);
  assert.match(body, /<img[^>]+src="\/api\/files\//);
  assert.equal(one<{ page_id: string }>("SELECT page_id FROM files WHERE id=?", saved.files[0].split("/").pop()!)!.page_id, saved.pageId);
  await assert.rejects(save(O, { targetId: notes }, [{ name: "x.txt", type: "text/plain", bytes: Buffer.from("x") }]), /Only images and PDFs/);
  const many = Array.from({ length: C.MAX_CAPTURE_FILES + 1 }, () => ({ name: "a.png", type: "image/png", bytes: png }));
  await assert.rejects(save(O, { targetId: notes }, many), (e: { status: number }) => e.status === 413);
});

test("a scan is appended to the page with its recognised text as the PDF's search text", async () => {
  const saved = await save(O, { targetId: notes, place: "append", scan: "1", recognized: "Invoice 4711 Total 12.50" }, [
    { name: "Scan.pdf", type: "application/pdf", bytes: pdf },
  ]);
  assert.equal(saved.pageId, notes);
  assert.equal(saved.title, "Scan");
  const fileId = saved.files[0].split("/").pop()!;
  assert.match(html(notes), new RegExp(`data-pdf="/api/files/${fileId}"`));
  const text = one<{ text: string; status: string }>("SELECT text,status FROM file_texts WHERE file_id=?", fileId)!;
  assert.equal(text.status, "device-ocr");
  assert.equal(text.text, "Invoice 4711 Total 12.50");
  assert.ok(one("SELECT 1 FROM search_dirty WHERE page_id=? AND row_id=?", notes, `f:${fileId}`));

  // Into a record's document.
  const record = await save(O, { targetId: inbox, title: "Trip" });
  const scan = await save(O, { targetId: inbox, rowId: record.rowId, place: "append", recognized: "Boarding pass" }, [{ name: "s.pdf", type: "application/pdf", bytes: pdf }]);
  assert.equal(scan.rowId, record.rowId);
  assert.match(one<{ html: string }>("SELECT html FROM row_documents WHERE row_id=?", record.rowId!)!.html, /data-pdf=/);
});

test("viewers and strangers cannot save", async () => {
  await assert.rejects(save(viewer.device, { targetId: notes, text: "No" }), (e: { status: number }) => e.status === 403);
  await assert.rejects(save(stranger.device, { targetId: notes, text: "No" }), (e: { status: number }) => e.status === 404);
});

test("POST /api/mobile/capture/save takes multipart with its size stated", async () => {
  const form = new FormData();
  form.append("targetId", notes);
  form.append("title", "Upload");
  form.append("file", new File([png], "p.png", { type: "image/png" }));
  const encoded = new Response(form);
  const body = Buffer.from(await encoded.arrayBuffer());
  const request = (headers: Record<string, string>) =>
    route.POST(
      new Request("http://localhost/api/mobile/capture/save", {
        method: "POST",
        headers: { authorization: `Bearer ${owner.deviceToken}`, "content-type": encoded.headers.get("content-type")!, ...headers },
        body,
      }),
      ctx("save"),
    );
  assert.equal((await request({})).status, 411);
  const ok = await request({ "content-length": String(body.length) });
  assert.equal(ok.status, 200);
  const saved = (await ok.json()) as { pageId: string; files: string[] };
  assert.equal(saved.files.length, 1);
  assert.equal(one<{ title: string }>("SELECT title FROM pages WHERE id=?", saved.pageId)!.title, "Upload");
});

test("spotlight: readable pages and open tasks, nothing of encrypted spaces", async () => {
  const secretSpace = id();
  run("INSERT INTO spaces(id,workspace_id,name) VALUES(?,?,?)", secretSpace, wid, "Vault");
  run("UPDATE spaces SET encrypted=1 WHERE id=?", secretSpace);
  const hidden = id();
  run("INSERT INTO pages(id,workspace_id,space_id,title,kind,created_by) VALUES(?,?,?,?,?,?)", hidden, wid, secretSpace, "Secret plan", "document", owner.user.id);
  const items = withContentLocale("en", () => C.spotlightItems(O));
  const ids = items.pages.map((p) => p.id);
  assert.ok(ids.includes(notes));
  assert.ok(ids.includes(inbox));
  assert.ok(!ids.includes(hidden));
  const page = items.pages.find((p) => p.id === notes)!;
  assert.equal(page.url, `/#page=${notes}`);
  assert.match(page.place, /Capture/);
  assert.match(page.excerpt, /Scan|From|Invoice|^$/);
  assert.deepEqual(C.spotlightItems(stranger.device).pages.filter((p) => p.id === notes), []);
  const response = await route.GET(new Request("http://localhost/api/mobile/capture/spotlight", { headers: { authorization: `Bearer ${owner.deviceToken}` } }), ctx("spotlight"));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
});
