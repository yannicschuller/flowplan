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

function account(name: string) {
  const uid = id();
  run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, name, `${name}@example.test`);
  return { id: uid, name, email: `${name}@example.test`, groups: [], isAdmin: false, disabled: 0, created_at: "" } as Identity;
}
const owner = account("Olga"),
  member = account("Max");
const wid = createWorkspace(owner.id, "Firma");
run("INSERT INTO members VALUES(?,?,?)", wid, member.id, "editor");
type Result = { id: string } & Record<string, unknown>;
const act = (input: Record<string, unknown>, as = owner) => command(as, input) as Result;
const team = act({ action: "space.create", workspaceId: wid, name: "Team" }).id;
const secret = act({ action: "space.create", workspaceId: wid, name: "Geheim", private: true }).id;
act({ action: "tag.save", workspaceId: wid, name: "Übernahme", spaceId: secret });
// Another workspace Max is not part of.
const otherWid = createWorkspace(owner.id, "Privat");
const otherSpace = act({ action: "space.create", workspaceId: otherWid, name: "Fremd" }).id;
const status = (fn: () => unknown) => {
  try {
    fn();
    return 200;
  } catch (e) {
    return (e as { status?: number }).status ?? 500;
  }
};

test("page.fromShare only writes into spaces the person may write in", () => {
  const pages = () => one<{ n: number }>("SELECT COUNT(*) n FROM pages WHERE space_id=?", secret)!.n;
  const before = pages();
  assert.equal(status(() => act({ action: "page.fromShare", workspaceId: wid, spaceId: secret, title: "Eingeschleust", text: "Bitte hier klicken" }, member)), 403);
  assert.equal(status(() => act({ action: "page.fromShare", workspaceId: wid, spaceId: secret, url: "https://evil.example/", as: "bookmark" }, member)), 403);
  assert.equal(pages(), before);
  // Where they may write, and for the space's owner, it works as before.
  assert.equal(status(() => act({ action: "page.fromShare", workspaceId: wid, spaceId: team, title: "Geteilt", text: "ok" }, member)), 200);
  assert.equal(status(() => act({ action: "page.fromShare", workspaceId: wid, spaceId: secret, title: "Notiz", text: "ok" })), 200);
});

test("page.moveCheck says nothing about a space the person may not write in", () => {
  const own = act({ action: "page.create", workspaceId: wid, spaceId: team, title: "Meine Seite", kind: "document" }, member).id;
  for (const spaceId of [secret, otherSpace]) {
    let leaked: unknown;
    const code = status(() => (leaked = act({ action: "page.moveCheck", pageId: own, spaceId }, member)));
    assert.equal(code, 403, JSON.stringify(leaked));
  }
  assert.equal(status(() => act({ action: "page.moveCheck", pageId: own, spaceId: team }, member)), 200);
});

test("template.dependencies does not list a private space's tags to outsiders", () => {
  const source = act({ action: "page.create", workspaceId: wid, spaceId: team, title: "Vorlage", kind: "document" }, member).id;
  const template = act({ action: "template.save", pageId: source, name: "Meine Vorlage" }, member).id;
  let leaked: unknown;
  assert.equal(status(() => (leaked = act({ action: "template.dependencies", workspaceId: wid, templateId: template, spaceId: secret }, member))), 403, JSON.stringify(leaked));
  assert.equal(status(() => act({ action: "template.dependencies", workspaceId: wid, templateId: template, spaceId: team }, member)), 200);
});

test("bookmarks.import creates nothing in a space the person may not write in", () => {
  const pages = () => one<{ n: number }>("SELECT COUNT(*) n FROM pages WHERE space_id=?", secret)!.n;
  const before = pages();
  const html = '<DL><DT><A HREF="https://evil.example/">Hier</A></DL>';
  assert.equal(status(() => act({ action: "bookmarks.import", workspaceId: wid, spaceId: secret, html }, member)), 403);
  assert.equal(pages(), before);
  assert.equal(status(() => act({ action: "bookmarks.import", workspaceId: wid, spaceId: team, html }, member)), 200);
});

test("tag.save does not reveal a private space's tag names through a name clash", () => {
  assert.equal(status(() => act({ action: "tag.save", workspaceId: wid, name: "Übernahme", spaceId: secret }, member)), 403);
  assert.equal(status(() => act({ action: "tag.save", workspaceId: wid, name: "Etwas anderes", spaceId: secret }, member)), 403);
});

test("the workspace archive leaves out a private space's templates, tags and definitions", async () => {
  const source = act({ action: "page.create", workspaceId: wid, spaceId: secret, title: "Vorlagenquelle", kind: "document" }).id;
  act({ action: "template.save", pageId: source, name: "Geheime Vorlage", visibility: "workspace" });
  act({ action: "property.save", workspaceId: wid, name: "Budget intern", type: "text", options: [], spaceId: secret });
  const text = async (as: Identity) => [...(await readExportZip(await exportArchive(as, wid))).values()].map((b) => b.toString("utf8")).join("\n");
  const outsider = await text(member);
  for (const secretText of ["Geheime Vorlage", "Übernahme", "Budget intern"]) assert.ok(!outsider.includes(secretText), secretText);
  // The space's owner still gets everything.
  const own = await text(owner);
  for (const secretText of ["Geheime Vorlage", "Übernahme", "Budget intern"]) assert.ok(own.includes(secretText), secretText);
});
