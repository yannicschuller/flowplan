// Link previews of published pages (#531): the page's title, the start of
// its text and its cover in Open Graph and Twitter tags – only through the
// publication's address, never behind a password or after its end date.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Identity } from "../lib/types";
process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-publication-preview-"));
process.env.APP_URL = "https://flowplan.example.test";
const { id, run, one } = await import("../lib/db");
const { command, bootstrap } = await import("../lib/api");
const { createWorkspace } = await import("../lib/seed");
const { publicPage } = await import("../lib/publication");
const { excerpt, publicationMetadata, publicationPreview } = await import("../lib/publication-meta");

async function user(name: string): Promise<Identity> {
  const uid = id();
  await run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, name, `${name}@example.com`);
  return { id: uid, name, email: `${name}@example.com`, groups: [], isAdmin: false, disabled: 0, created_at: "" };
}
const owner = await user("owner"),
  wid = await createWorkspace(owner.id, "Previews"),
  space = (await bootstrap(owner, wid)).spaces[0].id;
const create = async (title: string) =>
  ((await command(owner, { action: "page.create", workspaceId: wid, spaceId: space, title })) as { id: string }).id;
const publish = async (pageId: string) => {
  await command(owner, { action: "page.publish", pageId, enabled: true, includeChildren: false });
  return String((await one<{ public_token: string }>("SELECT public_token FROM pages WHERE id=?", pageId))?.public_token);
};
const withDocument = (pageId: string, html: string) =>
  run("INSERT INTO documents(page_id,html) VALUES(?,?) ON CONFLICT(page_id) DO UPDATE SET html=excluded.html", pageId, html);
async function withCover(pageId: string) {
  const fid = randomUUID();
  await run("INSERT INTO files(id,page_id,name,mime,size,created_by) VALUES(?,?,?,?,?,?)", fid, pageId, "cover.png", "image/png", 1, owner.id);
  await run("UPDATE pages SET cover=? WHERE id=?", `/api/files/${fid}`, pageId);
  return fid;
}

test("an excerpt is cut at a word and ends with an ellipsis", () => {
  assert.equal(excerpt("  Kurz   und gut "), "Kurz und gut");
  const long = "Wort ".repeat(80);
  const cut = excerpt(long);
  assert.ok(cut.length <= 200, String(cut.length));
  assert.ok(cut.endsWith("Wort…"), cut);
});

test("a published page previews with its text and cover", async () => {
  const page = await create("Sommerfest 2026");
  await withDocument(page, "<h1>Einladung</h1><p>Wir feiern am <strong>12. Juli</strong> im Garten &amp; am See.</p><script>alert(1)</script>");
  const cover = await withCover(page);
  const token = await publish(page);
  const preview = await publicationPreview(token, await publicPage(token));
  assert.equal(preview.description, "Einladung Wir feiern am 12. Juli im Garten & am See.");
  assert.equal(preview.image, `https://flowplan.example.test/api/share/${token}/files/${cover}`);
});

test("an empty page and a colour cover leave description and image out", async () => {
  const page = await create("Leer");
  await run("UPDATE pages SET cover=? WHERE id=?", "#ffcc00", page);
  const token = await publish(page);
  assert.deepEqual(await publicationPreview(token, await publicPage(token)), {});
});

test("behind a password the preview names nothing of the page", async () => {
  const page = await create("Geheimplan");
  await withDocument(page, "<p>Streng vertraulich</p>");
  const token = await publish(page);
  await command(owner, { action: "publication.protect", pageId: page, password: "geheim-123" });
  const meta = await publicationMetadata(token);
  assert.equal(meta.title, undefined);
  assert.equal(meta.description, undefined);
  assert.equal(meta.openGraph, undefined);
  assert.equal(meta.twitter, undefined);
});
