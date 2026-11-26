// Files uploaded straight into a space (#569): one page per file, a normal
// document with the file's block (lib/file-pages.ts, lib/file-blocks.ts),
// from the web app's upload (purpose "page") and the phone's share sheet
// (POST /api/mobile/capture/save, place "pages").
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { Identity } from "../lib/types";

const dir = mkdtempSync(join(tmpdir(), "flowplan-file-pages-"));
process.env.FLOWPLAN_DATA_DIR = dir;
process.env.FLOWPLAN_OCR = "0";
const { id, one, all, run } = await import("../lib/db");
const { command, bootstrap } = await import("../lib/api");
const { createWorkspace } = await import("../lib/seed");
const { registerMobileDevice } = await import("../lib/mobile-devices");
const { withContentLocale } = await import("../lib/content-locale");
const { widgetUser } = await import("../lib/mobile-widgets");
const { fileBlock, filePageTitle } = await import("../lib/file-blocks");
const F = await import("../lib/file-pages");
const C = await import("../lib/mobile-capture");
const { uploadPath } = await import("../lib/storage");
const route = await import("../app/api/mobile/capture/[action]/handler");

async function account(name: string) {
  const uid = id(),
    token = id();
  await run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, name, `${name}@example.test`);
  await run("INSERT INTO sessions(token,user_id,groups_json,expires) VALUES(?,?,?,?)", token, uid, "[]", Date.now() + 3600000);
  const user = { id: uid, name, email: `${name}@example.test`, groups: [], isAdmin: false, disabled: 0, created_at: "" } as unknown as Identity;
  const { deviceToken } = await registerMobileDevice(user, token, { installationId: randomUUID(), platform: "ios" });
  return { user, deviceToken, device: (await widgetUser(`Bearer ${deviceToken}`))! };
}
const en = <T>(fn: () => Promise<T>) => withContentLocale("en", fn);
const owner = await account("files-owner"),
  viewer = await account("files-viewer"),
  stranger = await account("files-stranger");
const wid = await createWorkspace(owner.user.id, "Files");
const sid = (await bootstrap(owner.user, wid)).spaces[0].id;
await run("INSERT INTO members VALUES(?,?,?)", wid, viewer.user.id, "viewer");
await createWorkspace(stranger.user.id, "Elsewhere");
const otherSpace = ((await command(owner.user, { action: "space.create", workspaceId: wid, name: "Other" })) as { id: string }).id;
const secret = id();
await run("INSERT INTO spaces(id,workspace_id,name,owner_id,encrypted) VALUES(?,?,?,?,1)", secret, wid, "Secret", owner.user.id);
const parent = ((await command(owner.user, { action: "page.create", workspaceId: wid, spaceId: sid, title: "Projects", kind: "document" })) as { id: string }).id;
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const pdf = Buffer.from("%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n");
const pageCount = async () => Number((await one<{ n: number }>("SELECT COUNT(*) n FROM pages WHERE workspace_id=?", wid))!.n);
const html = async (pageId: string) => (await one<{ html: string }>("SELECT html FROM documents WHERE page_id=?", pageId))!.html;

test("the block of a file is the editor's: picture, PDF, cards, players, else a link", () => {
  const url = "/api/files/0123abcd-0000-4000-8000-000000000000";
  assert.deepEqual(fileBlock({ url, name: "Photo.png", type: "image/png" }), { type: "image", attrs: { src: url, alt: "Photo.png" } });
  const kind = (name: string, type = "application/octet-stream") => fileBlock({ url, name, type }).attrs?.kind;
  assert.equal(kind("Invoice.pdf", "application/pdf"), "pdf");
  assert.equal(kind("Part.stl"), "model");
  assert.equal(kind("Page.html"), "html");
  assert.equal(kind("Budget.xlsx"), "sheet");
  assert.equal(kind("Deck.pptx"), "office");
  assert.equal(kind("Letter.docx"), "office");
  assert.equal(kind("Clip.mp4", "video/mp4"), "video");
  assert.equal(kind("Talk.mp3", "audio/mpeg"), "audio");
  // Cards only for stored files; anything else is a link with its name.
  assert.equal(fileBlock({ url: "https://example.org/x.xlsx", name: "x.xlsx", type: "" }).type, "paragraph");
  assert.deepEqual(fileBlock({ url, name: "notes.zip", type: "application/zip" }).content?.[0].marks, [{ type: "link", attrs: { href: url } }]);
  assert.equal(filePageTitle("Quarterly report.pdf"), "Quarterly report");
  assert.equal(filePageTitle("archive.tar.gz"), "archive.tar");
  assert.equal(filePageTitle(".env"), ".env");
  assert.equal(filePageTitle("README"), "README");
});

test("where pages may go: a space one may create pages in, not encrypted, a parent of that space", async () => {
  const place = await F.filePagePlace(owner.user, { spaceId: sid });
  assert.deepEqual(place, { workspaceId: wid, spaceId: sid, parentId: null });
  assert.equal((await F.filePagePlace(owner.user, { spaceId: sid, parentId: parent })).parentId, parent);
  const status = (status: number) => (e: { status: number }) => e.status === status;
  await assert.rejects(en(() => F.filePagePlace(viewer.user, { spaceId: sid })), status(403));
  await assert.rejects(en(() => F.filePagePlace(stranger.user, { spaceId: sid })), status(403));
  await assert.rejects(en(() => F.filePagePlace(owner.user, { spaceId: secret })), status(409));
  await assert.rejects(en(() => F.filePagePlace(owner.user, { spaceId: otherSpace, parentId: parent })), status(400));
  await assert.rejects(en(() => F.filePagePlace(owner.user, { spaceId: randomUUID() })), status(404));
  await assert.rejects(F.filePagePlace(owner.user, { spaceId: "nope" }));
});

test("a file becomes a document of its own, titled with its name, with the file's block and a line below", async () => {
  const place = await F.filePagePlace(owner.user, { spaceId: sid, parentId: parent });
  const fileId = id();
  const made = await F.createFilePage(owner.user, place, { id: fileId, name: "Site plan.pdf", mime: "application/pdf", content: pdf });
  const page = (await one<{ title: string; kind: string; parent_id: string; space_id: string }>("SELECT title,kind,parent_id,space_id FROM pages WHERE id=?", made.pageId))!;
  assert.deepEqual(page, { title: "Site plan", kind: "document", parent_id: parent, space_id: sid });
  assert.equal(made.file, `/api/files/${fileId}`);
  assert.match(made.url, new RegExp(`page=${made.pageId}`));
  assert.equal((await one<{ page_id: string }>("SELECT page_id FROM files WHERE id=?", fileId))!.page_id, made.pageId);
  assert.ok(existsSync(uploadPath(fileId)));
  const body = await html(made.pageId);
  assert.match(body, new RegExp(`data-pdf="/api/files/${fileId}"`));
  assert.match(body, /<p><\/p>$/);
  // The stored state holds the same content (what the editor opens).
  assert.ok((await one<{ state: Uint8Array | null }>("SELECT state FROM documents WHERE page_id=?", made.pageId))!.state?.length);
  // At the top level of a space, from a temporary file moved into place.
  const top = await F.filePagePlace(owner.user, { spaceId: sid });
  mkdirSync(join(dir, "uploads"), { recursive: true });
  const temp = join(dir, "uploads", `incoming-${randomUUID()}`);
  writeFileSync(temp, png);
  const streamed = await F.createFilePage(owner.user, top, { id: id(), name: "Whiteboard photo.png", mime: "image/png", path: temp, size: png.length });
  assert.equal((await one<{ parent_id: string | null; title: string }>("SELECT parent_id,title FROM pages WHERE id=?", streamed.pageId))!.parent_id, null);
  assert.ok(!existsSync(temp));
  assert.match(await html(streamed.pageId), /<img[^>]+src="\/api\/files\//);
});

test("a refused file leaves no page: quota and a failing write roll back together", async () => {
  const place = await F.filePagePlace(owner.user, { spaceId: sid });
  const before = await pageCount();
  await run("UPDATE workspaces SET quota_mb=? WHERE id=?", 0.000001, wid);
  await assert.rejects(F.createFilePage(owner.user, place, { id: id(), name: "Too big.pdf", mime: "application/pdf", content: pdf }), (e: { status: number }) => e.status === 413);
  await run("UPDATE workspaces SET quota_mb=NULL WHERE id=?", wid);
  // The upload's name is taken: the page made before it goes again.
  const taken = id();
  mkdirSync(join(dir, "uploads"), { recursive: true });
  writeFileSync(uploadPath(taken), "x");
  await assert.rejects(F.createFilePage(owner.user, place, { id: taken, name: "Clash.pdf", mime: "application/pdf", content: pdf }));
  assert.equal(await pageCount(), before);
  assert.equal(await one("SELECT 1 x FROM files WHERE id=?", taken), undefined);
});

test("capture targets list the spaces one may make pages in; old fields stay", async () => {
  const targets = await C.captureTargets(owner.device);
  assert.ok(Array.isArray(targets.targets));
  const names = targets.spaces.map((s) => s.name);
  assert.ok(targets.spaces.some((s) => s.id === sid && s.workspace === "Files"));
  assert.ok(names.includes("Other"));
  assert.ok(!targets.spaces.some((s) => s.id === secret), "no encrypted space");
  assert.deepEqual((await C.captureTargets(viewer.device)).spaces, []);
  assert.ok(!(await C.captureTargets(stranger.device)).spaces.some((s) => s.id === sid));
});

test("capture/save with place pages: every file a page of its own, any file type, all or none", async () => {
  const form = new FormData();
  form.set("place", "pages");
  form.set("spaceId", sid);
  form.set("parentId", parent);
  form.set("title", "ignored");
  form.append("file", new File([new Uint8Array(png)], "Receipt.png", { type: "image/png" }));
  form.append("file", new File(["a,b\n1,2\n"], "Numbers.csv", { type: "text/csv" }));
  const response = await route.POST(
    new Request("http://localhost/api/mobile/capture/save?lang=en", { method: "POST", headers: { authorization: `Bearer ${owner.deviceToken}`, "content-length": "4000" }, body: form }),
    { params: Promise.resolve({ action: "save" }) },
  );
  assert.equal(response.status, 200);
  const saved = (await response.json()) as { pageId: string; url: string; title: string; files: string[]; pages: { pageId: string; title: string; url: string; file: string }[] };
  assert.deepEqual(saved.pages.map((p) => p.title), ["Receipt", "Numbers"]);
  assert.equal(saved.pageId, saved.pages[0].pageId);
  assert.equal(saved.title, "Receipt");
  const rows = await all<{ parent_id: string; kind: string }>("SELECT parent_id,kind FROM pages WHERE id IN (?,?)", ...saved.pages.map((p) => p.pageId));
  assert.deepEqual(rows.map((r) => [r.parent_id, r.kind]), [[parent, "document"], [parent, "document"]]);
  assert.match(await html(saved.pages[0].pageId), /<img/);
  assert.match(await html(saved.pages[1].pageId), /data-sheet-file/);
  // A space is needed, files too; viewers may not.
  const save = (user: Identity, body: Record<string, unknown>, files = [{ name: "a.png", type: "image/png", bytes: png }]) => en(() => C.saveCapture(user, body, files));
  await assert.rejects(save(owner.device, { place: "pages" }), (e: { status: number }) => e.status === 400);
  await assert.rejects(save(owner.device, { place: "pages", spaceId: sid }, []), (e: { status: number }) => e.status === 400);
  await assert.rejects(save(viewer.device, { place: "pages", spaceId: sid }), (e: { status: number }) => e.status === 403);
  await assert.rejects(save(owner.device, { place: "pages", spaceId: secret }), (e: { status: number }) => e.status === 409);
  // Over the quota: no page at all.
  const before = await pageCount();
  await run("UPDATE workspaces SET quota_mb=? WHERE id=?", 0.000001, wid);
  await assert.rejects(save(owner.device, { place: "pages", spaceId: sid }), (e: { status: number }) => e.status === 413);
  await run("UPDATE workspaces SET quota_mb=NULL WHERE id=?", wid);
  assert.equal(await pageCount(), before);
  // The shares of old apps are unchanged: a sub page with all files.
  const old = await save(owner.device, { targetId: parent, text: "From an old app" });
  assert.equal((await one<{ parent_id: string }>("SELECT parent_id FROM pages WHERE id=?", old.pageId))!.parent_id, parent);
});
