// Reported (Nov 2026): three actions that skipped the space rights the
// matching write action checks – page.fromShare wrote into a private space,
// page.moveCheck and template.dependencies told an outsider a space's name,
// workspace and tag names.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Identity } from "../lib/types";
process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-space-rights-"));
const { run, id, one } = await import("../lib/db");
const { createWorkspace } = await import("../lib/seed");
const { command } = await import("../lib/api");
const { exportArchive } = await import("../lib/archive");
const { readExportZip } = await import("./helpers/read-export-zip");

async function account(name: string) {
  const uid = id();
  await run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, name, `${name}@example.test`);
  return { id: uid, name, email: `${name}@example.test`, groups: [], isAdmin: false, disabled: 0, created_at: "" } as Identity;
}
const owner = await account("Olga"),
  member = await account("Max");
const wid = await createWorkspace(owner.id, "Firma");
await run("INSERT INTO members VALUES(?,?,?)", wid, member.id, "editor");
type Result = { id: string } & Record<string, unknown>;
const act = async (input: Record<string, unknown>, as = owner) => (await command(as, input)) as Result;
const team = (await act({ action: "space.create", workspaceId: wid, name: "Team" })).id;
const secret = (await act({ action: "space.create", workspaceId: wid, name: "Geheim", private: true })).id;
await act({ action: "tag.save", workspaceId: wid, name: "Übernahme", spaceId: secret });
// Another workspace Max is not part of.
const otherWid = await createWorkspace(owner.id, "Privat");
const otherSpace = (await act({ action: "space.create", workspaceId: otherWid, name: "Fremd" })).id;
const status = async (fn: () => unknown) => {
  try {
    await fn();
    return 200;
  } catch (e) {
    return (e as { status?: number }).status ?? 500;
  }
};

test("page.fromShare only writes into spaces the person may write in", async () => {
  const pages = async () => (await one<{ n: number }>("SELECT COUNT(*) n FROM pages WHERE space_id=?", secret))!.n;
  const before = await pages();
  assert.equal(await status(async () => await act({ action: "page.fromShare", workspaceId: wid, spaceId: secret, title: "Eingeschleust", text: "Bitte hier klicken" }, member)), 403);
  assert.equal(await status(async () => await act({ action: "page.fromShare", workspaceId: wid, spaceId: secret, url: "https://evil.example/", as: "bookmark" }, member)), 403);
  assert.equal(await pages(), before);
  // Where they may write, and for the space's owner, it works as before.
  assert.equal(await status(async () => await act({ action: "page.fromShare", workspaceId: wid, spaceId: team, title: "Geteilt", text: "ok" }, member)), 200);
  assert.equal(await status(async () => await act({ action: "page.fromShare", workspaceId: wid, spaceId: secret, title: "Notiz", text: "ok" })), 200);
});

test("page.moveCheck says nothing about a space the person may not write in", async () => {
  const own = (await act({ action: "page.create", workspaceId: wid, spaceId: team, title: "Meine Seite", kind: "document" }, member)).id;
  for (const spaceId of [secret, otherSpace]) {
    let leaked: unknown;
    const code = await status(async () => (leaked = await act({ action: "page.moveCheck", pageId: own, spaceId }, member)));
    assert.equal(code, 403, JSON.stringify(leaked));
  }
  assert.equal(await status(async () => await act({ action: "page.moveCheck", pageId: own, spaceId: team }, member)), 200);
});

test("template.dependencies does not list a private space's tags to outsiders", async () => {
  const source = (await act({ action: "page.create", workspaceId: wid, spaceId: team, title: "Vorlage", kind: "document" }, member)).id;
  const template = (await act({ action: "template.save", pageId: source, name: "Meine Vorlage" }, member)).id;
  let leaked: unknown;
  assert.equal(await status(async () => (leaked = await act({ action: "template.dependencies", workspaceId: wid, templateId: template, spaceId: secret }, member))), 403, JSON.stringify(leaked));
  assert.equal(await status(async () => await act({ action: "template.dependencies", workspaceId: wid, templateId: template, spaceId: team }, member)), 200);
});

test("bookmarks.import creates nothing in a space the person may not write in", async () => {
  const pages = async () => (await one<{ n: number }>("SELECT COUNT(*) n FROM pages WHERE space_id=?", secret))!.n;
  const before = await pages();
  const html = '<DL><DT><A HREF="https://evil.example/">Hier</A></DL>';
  assert.equal(await status(async () => await act({ action: "bookmarks.import", workspaceId: wid, spaceId: secret, html }, member)), 403);
  assert.equal(await pages(), before);
  assert.equal(await status(async () => await act({ action: "bookmarks.import", workspaceId: wid, spaceId: team, html }, member)), 200);
});

test("tag.save does not reveal a private space's tag names through a name clash", async () => {
  assert.equal(await status(async () => await act({ action: "tag.save", workspaceId: wid, name: "Übernahme", spaceId: secret }, member)), 403);
  assert.equal(await status(async () => await act({ action: "tag.save", workspaceId: wid, name: "Etwas anderes", spaceId: secret }, member)), 403);
});

test("the workspace archive leaves out a private space's templates, tags and definitions", async () => {
  const source = (await act({ action: "page.create", workspaceId: wid, spaceId: secret, title: "Vorlagenquelle", kind: "document" })).id;
  await act({ action: "template.save", pageId: source, name: "Geheime Vorlage", visibility: "workspace" });
  await act({ action: "property.save", workspaceId: wid, name: "Budget intern", type: "text", options: [], spaceId: secret });
  const text = async (as: Identity) => [...(await readExportZip(await exportArchive(as, wid))).values()].map((b) => b.toString("utf8")).join("\n");
  const outsider = await text(member);
  for (const secretText of ["Geheime Vorlage", "Übernahme", "Budget intern"]) assert.ok(!outsider.includes(secretText), secretText);
  // The space's owner still gets everything.
  const own = await text(owner);
  for (const secretText of ["Geheime Vorlage", "Übernahme", "Budget intern"]) assert.ok(own.includes(secretText), secretText);
});
