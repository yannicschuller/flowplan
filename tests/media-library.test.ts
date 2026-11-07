import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Identity } from "../lib/types";
process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-media-"));
const { run, id } = await import("../lib/db");
const { createWorkspace } = await import("../lib/seed");
const { command, bootstrap } = await import("../lib/api");
const { mediaLibrary, MEDIA_PAGE } = await import("../lib/media-library");

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
const owner = await account("media-owner"),
  member = await account("media-member"),
  stranger = await account("media-stranger");
const wid = await createWorkspace(owner.id, "Medien");
await run("INSERT INTO members VALUES(?,?,?)", wid, member.id, "viewer");
const act = async (input: Record<string, unknown>) =>
  (await command(owner, input)) as { id: string };
const team = (await bootstrap(owner, wid)).spaces[0].id;
const privateSpace = (await act({
  action: "space.create",
  workspaceId: wid,
  name: "Privat",
  private: true,
})).id;
const page = async (title: string, spaceId = team) =>
  (await act({ action: "page.create", workspaceId: wid, spaceId, title })).id;
const file = async (pageId: string, name: string, mime: string, size = 2048) =>
  await run(
    "INSERT INTO files(id,page_id,name,mime,size,created_by) VALUES(?,?,?,?,?,?)",
    id(),
    pageId,
    name,
    mime,
    size,
    owner.id,
  );

test("the media overview lists readable files with type and name filters", async () => {
  const shared = await page("Galerie"),
    hidden = await page("Gehälter", privateSpace),
    trashed = await page("Alt");
  await file(shared, "Urlaub.jpg", "image/jpeg");
  await file(shared, "Vortrag.mp4", "video/mp4");
  await file(shared, "Protokoll.pdf", "application/pdf");
  await file(shared, "Daten.csv", "text/csv");
  await file(hidden, "Gehalt.pdf", "application/pdf");
  await file(trashed, "Weg.png", "image/png");
  await command(owner, { action: "page.delete", pageId: trashed });
  const names = async (as: Identity, options = {}) =>
    (await mediaLibrary(as, wid, options))
      .items.map((i) => i.name)
      .sort();
  assert.deepEqual(await names(member), [
    "Daten.csv",
    "Protokoll.pdf",
    "Urlaub.jpg",
    "Vortrag.mp4",
  ]);
  assert.ok((await names(owner)).includes("Gehalt.pdf"));
  assert.deepEqual(await names(member, { kind: "pdf" }), ["Protokoll.pdf"]);
  assert.deepEqual(await names(member, { kind: "image" }), ["Urlaub.jpg"]);
  assert.deepEqual(await names(member, { kind: "other" }), ["Daten.csv"]);
  assert.deepEqual(await names(member, { query: "URLAUB" }), ["Urlaub.jpg"]);
  const result = await mediaLibrary(member, wid);
  assert.equal(result.total, 4);
  assert.equal(result.bytes, 4 * 2048);
  const photo = result.items.find((i) => i.name === "Urlaub.jpg")!;
  assert.equal(photo.kind, "image");
  assert.equal(photo.pageTitle, "Galerie");
  assert.match(photo.url, /^\/api\/files\/[0-9a-f-]{36}$/);
  await assert.rejects(
    async () => await mediaLibrary(stranger, wid),
    /Mitglied|Zugriff|Berechtigung/i,
  );
});

test("the media overview pages through large libraries", async () => {
  const many = await page("Viele");
  for (let i = 0; i < MEDIA_PAGE + 5; i++)
    await file(many, `bild-${i}.png`, "image/png", 1);
  const first = await mediaLibrary(owner, wid, { query: "bild-" });
  assert.equal(first.items.length, MEDIA_PAGE);
  assert.equal(first.total, MEDIA_PAGE + 5);
  const second = await mediaLibrary(owner, wid, {
    query: "bild-",
    offset: MEDIA_PAGE,
  });
  assert.equal(second.items.length, 5);
  assert.equal(
    new Set([...first.items, ...second.items].map((i) => i.id)).size,
    MEDIA_PAGE + 5,
  );
});
