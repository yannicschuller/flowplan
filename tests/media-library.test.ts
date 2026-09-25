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

function account(name: string) {
  const uid = id();
  run(
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
const owner = account("media-owner"),
  member = account("media-member"),
  stranger = account("media-stranger");
const wid = createWorkspace(owner.id, "Medien");
run("INSERT INTO members VALUES(?,?,?)", wid, member.id, "viewer");
const act = (input: Record<string, unknown>) =>
  command(owner, input) as { id: string };
const team = bootstrap(owner, wid).spaces[0].id;
const privateSpace = act({
  action: "space.create",
  workspaceId: wid,
  name: "Privat",
  private: true,
}).id;
const page = (title: string, spaceId = team) =>
  act({ action: "page.create", workspaceId: wid, spaceId, title }).id;
const file = (pageId: string, name: string, mime: string, size = 2048) =>
  run(
    "INSERT INTO files(id,page_id,name,mime,size,created_by) VALUES(?,?,?,?,?,?)",
    id(),
    pageId,
    name,
    mime,
    size,
    owner.id,
  );

test("the media overview lists readable files with type and name filters", () => {
  const shared = page("Galerie"),
    hidden = page("Gehälter", privateSpace),
    trashed = page("Alt");
  file(shared, "Urlaub.jpg", "image/jpeg");
  file(shared, "Vortrag.mp4", "video/mp4");
  file(shared, "Protokoll.pdf", "application/pdf");
  file(shared, "Daten.csv", "text/csv");
  file(hidden, "Gehalt.pdf", "application/pdf");
  file(trashed, "Weg.png", "image/png");
  command(owner, { action: "page.delete", pageId: trashed });
  const names = (as: Identity, options = {}) =>
    mediaLibrary(as, wid, options)
      .items.map((i) => i.name)
      .sort();
  assert.deepEqual(names(member), [
    "Daten.csv",
    "Protokoll.pdf",
    "Urlaub.jpg",
    "Vortrag.mp4",
  ]);
  assert.ok(names(owner).includes("Gehalt.pdf"));
  assert.deepEqual(names(member, { kind: "pdf" }), ["Protokoll.pdf"]);
  assert.deepEqual(names(member, { kind: "image" }), ["Urlaub.jpg"]);
  assert.deepEqual(names(member, { kind: "other" }), ["Daten.csv"]);
  assert.deepEqual(names(member, { query: "URLAUB" }), ["Urlaub.jpg"]);
  const result = mediaLibrary(member, wid);
  assert.equal(result.total, 4);
  assert.equal(result.bytes, 4 * 2048);
  const photo = result.items.find((i) => i.name === "Urlaub.jpg")!;
  assert.equal(photo.kind, "image");
  assert.equal(photo.pageTitle, "Galerie");
  assert.match(photo.url, /^\/api\/files\/[0-9a-f-]{36}$/);
  assert.throws(
    () => mediaLibrary(stranger, wid),
    /Mitglied|Zugriff|Berechtigung/i,
  );
});

test("the media overview pages through large libraries", () => {
  const many = page("Viele");
  for (let i = 0; i < MEDIA_PAGE + 5; i++)
    file(many, `bild-${i}.png`, "image/png", 1);
  const first = mediaLibrary(owner, wid, { query: "bild-" });
  assert.equal(first.items.length, MEDIA_PAGE);
  assert.equal(first.total, MEDIA_PAGE + 5);
  const second = mediaLibrary(owner, wid, {
    query: "bild-",
    offset: MEDIA_PAGE,
  });
  assert.equal(second.items.length, 5);
  assert.equal(
    new Set([...first.items, ...second.items].map((i) => i.id)).size,
    MEDIA_PAGE + 5,
  );
});
