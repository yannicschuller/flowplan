// "Bei dieser Datei immer zulassen" (#425, lib/html-scripts-trust.ts): a
// person remembers an HTML file's scripts in their account (file id and the
// server's hash of its content); the preview's HEAD request on the signed-in
// route tells the viewer, nowhere else. Only for that person, only files
// they may read, asked again when the content changes, ignored while the
// instance switches scripts off, at most 500 files.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Identity } from "../lib/types";

const dir = mkdtempSync(join(tmpdir(), "flowplan-html-trust-"));
process.env.FLOWPLAN_DATA_DIR = dir;
const { run, id, one } = await import("../lib/db");
const { command, bootstrap } = await import("../lib/api");
const { createWorkspace } = await import("../lib/seed");
const { readableFile } = await import("../lib/file-access");
const { htmlPreviewResponse, HTML_PREVIEW_REMEMBERED_HEADER } = await import("../lib/html-preview");
const { htmlScriptsRemembered, htmlScriptsList, htmlScriptsEntries, HTML_SCRIPTS_MAX } = await import("../lib/html-scripts-trust");
const { commandActionNames } = await import("../lib/openapi");
const { HttpError } = await import("../lib/auth");

async function user(name: string): Promise<Identity> {
  const uid = id();
  await run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, name, `${name}-${uid}@example.test`);
  return { id: uid, name, email: `${name}@example.test`, disabled: 0, created_at: "", groups: [], isAdmin: false };
}
const anna = await user("Anna"),
  ben = await user("Ben"),
  stranger = await user("Fremd");
const wid = await createWorkspace(anna.id, "HTML");
await run("INSERT INTO members VALUES(?,?,?)", wid, ben.id, "viewer");
const team = (await bootstrap(anna, wid)).spaces[0].id;
const doc = ((await command(anna, { action: "page.create", workspaceId: wid, spaceId: team, title: "Seiten", kind: "document" })) as { id: string }).id;
const uploads = join(dir, "uploads");
mkdirSync(uploads, { recursive: true });
async function file(name: string, content: string, mime = "application/octet-stream") {
  const fid = id();
  writeFileSync(join(uploads, fid), content);
  await run("INSERT INTO files(id,page_id,name,mime,size,created_by) VALUES(?,?,?,?,?,?)", fid, doc, name, mime, Buffer.byteLength(content), anna.id);
  return fid;
}
const PAGE = `<!doctype html><script>document.title = "lief"</script><p>Hallo</p>`;
const allow = async (as: Identity, fileId: string, on = true) => await command(as, { action: "profile.htmlScripts", fileId, allow: on });
// The HEAD request the viewer sends on the signed-in route
// (app/api/files/[id]/html/handler.ts).
const head = async (as: Identity, fid: string) =>
  (await htmlPreviewResponse(new Request("http://localhost/api/files/x/html", { method: "HEAD" }), await readableFile(as, fid), async () => await htmlScriptsRemembered(as, fid))).headers.get(HTML_PREVIEW_REMEMBERED_HEADER);
const refused = async (promise: Promise<unknown>, status: number) =>
  await assert.rejects(promise, (e: unknown) => (e instanceof HttpError && e.status === status) || (status === 400 && (e as Error).name === "ZodError"));
const stored = async (as: Identity) => htmlScriptsEntries((await one<{ html_scripts: string | null }>("SELECT html_scripts FROM users WHERE id=?", as.id))?.html_scripts);

test("the commands are documented for the API and the SDKs", () => {
  assert.ok(commandActionNames.includes("profile.htmlScripts"));
  assert.ok(commandActionNames.includes("profile.htmlScriptsClear"));
});

test("remembered per person and file, on every opening; unticking forgets it", async () => {
  const fid = await file("bericht.html", PAGE);
  assert.equal(await head(anna, fid), "no");
  assert.deepEqual(await allow(anna, fid), { fileId: fid, allow: true });
  assert.equal(await head(anna, fid), "yes");
  // The hash is the server's own, of the content.
  const [entry] = await stored(anna);
  assert.equal(entry.id, fid);
  assert.match(entry.hash, /^[0-9a-f]{64}$/);
  // Allowing again keeps one entry.
  await allow(anna, fid);
  assert.equal((await stored(anna)).length, 1);
  // Only for Anna: Ben, who may read the file, is still asked.
  assert.equal(await head(ben, fid), "no");
  assert.equal(await htmlScriptsRemembered(ben, fid), false);
  // GET (the page itself) does not carry it.
  const page = await htmlPreviewResponse(new Request("http://localhost/api/files/x/html"), await readableFile(anna, fid), async () => true);
  assert.equal(page.headers.get(HTML_PREVIEW_REMEMBERED_HEADER), null);
  // Unticked: forgotten.
  assert.deepEqual(await allow(anna, fid, false), { fileId: fid, allow: false });
  assert.equal(await head(anna, fid), "no");
  assert.equal((await one<{ html_scripts: string | null }>("SELECT html_scripts FROM users WHERE id=?", anna.id))?.html_scripts, null);
});

test("only files the person may read, only HTML, only valid ids and choices", async () => {
  const fid = await file("intern.html", PAGE);
  await refused(allow(stranger, fid), 403);
  assert.deepEqual(await stored(stranger), []);
  await refused(allow(anna, id()), 404);
  await refused(allow(anna, await file("bild.png", "x", "image/png")), 415);
  await refused(allow(anna, await file("falsch.html", "%PDF", "application/pdf")), 415);
  for (const bad of ["../etc", "", 7, null, "not-a-uuid"]) await refused(command(anna, { action: "profile.htmlScripts", fileId: bad, allow: true }), 400);
  for (const bad of ["yes", 1, null, undefined]) await refused(command(anna, { action: "profile.htmlScripts", fileId: fid, allow: bad }), 400);
  // A client cannot hand in a hash of its own: it is ignored.
  await command(anna, { action: "profile.htmlScripts", fileId: fid, allow: true, hash: "0".repeat(64) });
  assert.notEqual((await stored(anna)).find((e) => e.id === fid)?.hash, "0".repeat(64));
  // Forgetting works even for a file one can no longer read.
  await allow(stranger, fid, false);
  await allow(anna, fid, false);
});

test("a changed file asks again", async () => {
  const fid = await file("wechsel.html", PAGE);
  await allow(anna, fid);
  assert.equal(await head(anna, fid), "yes");
  writeFileSync(join(uploads, fid), PAGE.replace("Hallo", "Neu"));
  assert.equal(await head(anna, fid), "no", "new content: asked again");
  // Allowed again, for the new content.
  await allow(anna, fid);
  assert.equal(await head(anna, fid), "yes");
  await allow(anna, fid, false);
});

test("an instance with scripts off ignores it and refuses new ones", async () => {
  const fid = await file("aus.html", PAGE);
  await allow(anna, fid);
  const saved = process.env.FLOWPLAN_HTML_PREVIEW_SCRIPTS;
  process.env.FLOWPLAN_HTML_PREVIEW_SCRIPTS = "0";
  try {
    assert.equal(await htmlScriptsRemembered(anna, fid), false);
    // No header at all: the viewer offers neither the button nor the box.
    assert.equal(await head(anna, fid), null);
    await refused(allow(anna, await file("neu.html", PAGE)), 409);
  } finally {
    if (saved === undefined) delete process.env.FLOWPLAN_HTML_PREVIEW_SCRIPTS;
    else process.env.FLOWPLAN_HTML_PREVIEW_SCRIPTS = saved;
  }
  assert.equal(await head(anna, fid), "yes", "on again: remembered as before");
  await allow(anna, fid, false);
});

test("shared links and published pages never use it", () => {
  // Their route passes nothing to ask: no header, the viewer offers no box.
  const share = readFileSync(new URL("../app/api/share/[token]/files/[fileId]/html/handler.ts", import.meta.url), "utf8");
  assert.doesNotMatch(share, /htmlScriptsRemembered|html-scripts-trust/);
  assert.match(share, /htmlPreviewResponse\(req, await withShareRequest\(req, async \(\) => await publicFile\(token, fileId\)\)\);/);
  const own = readFileSync(new URL("../app/api/files/[id]/html/handler.ts", import.meta.url), "utf8");
  assert.match(own, /htmlScriptsRemembered\(user, fileId\)/);
});

test("the settings list and clear; at most 500 files, the oldest dropped", async () => {
  const a = await file("a.html", PAGE),
    b = await file("b.html", PAGE);
  await allow(anna, a, true);
  await allow(anna, b, true);
  const list = await htmlScriptsList(anna);
  assert.deepEqual(
    list.map((f) => [f.fileId, f.name, f.pageId, f.page, f.available]),
    [
      [b, "b.html", doc, "Seiten", true],
      [a, "a.html", doc, "Seiten", true],
    ],
  );
  // A file gone: listed without name.
  await run("DELETE FROM files WHERE id=?", a);
  assert.deepEqual(
    (await htmlScriptsList(anna)).map((f) => [f.name, f.available]),
    [
      ["b.html", true],
      ["", false],
    ],
  );
  assert.deepEqual(await command(anna, { action: "profile.htmlScriptsClear" }), { ok: true });
  assert.deepEqual(await htmlScriptsList(anna), []);

  // The bound: an entry beyond 500 drops the oldest.
  const many = Array.from({ length: HTML_SCRIPTS_MAX }, (_, i) => ({ id: id(), hash: "a".repeat(64), at: i }));
  await run("UPDATE users SET html_scripts=? WHERE id=?", JSON.stringify(many), anna.id);
  await allow(anna, b);
  const kept = await stored(anna);
  assert.equal(kept.length, HTML_SCRIPTS_MAX);
  assert.equal(kept.at(-1)?.id, b);
  assert.ok(!kept.some((e) => e.id === many[0].id), "the oldest dropped");
  // Values written outside Flowplan read leniently.
  assert.deepEqual(htmlScriptsEntries("nonsense"), []);
  assert.deepEqual(htmlScriptsEntries(JSON.stringify([{ id: "x", hash: "y", at: 1 }, { id: b, hash: "b".repeat(64), at: 2 }])), [{ id: b, hash: "b".repeat(64), at: 2 }]);
});
