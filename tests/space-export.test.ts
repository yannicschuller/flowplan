import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Identity } from "../lib/types";
process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-space-export-"));
process.env.APP_URL = "https://flowplan.example.test";
const { run, id } = await import("../lib/db");
const { createWorkspace } = await import("../lib/seed");
const { command, bootstrap } = await import("../lib/api");
const { htmlState } = await import("../lib/document-server");
const { exportMarkdown } = await import("../lib/markdown-export");
const { readExportZip } = await import("./helpers/read-export-zip");

function person(name: string): Identity {
  const uid = id();
  run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, name, `${name}@example.test`);
  return { id: uid, name, email: `${name}@example.test`, groups: [], isAdmin: false, disabled: 0, created_at: "" } as Identity;
}
// A family: Ada owns the workspace, Ben is a member with his own private space.
const ada = person("Ada"),
  ben = person("Ben");
const wid = createWorkspace(ada.id, "Familie");
run("INSERT INTO members VALUES(?,?,?)", wid, ben.id, "editor");
const as = (user: Identity) => (b: Record<string, unknown>) => command(user, { workspaceId: wid, ...b }) as Record<string, unknown>;
const shared = bootstrap(ada, wid).spaces[0].id;
const benSpace = String(as(ben)({ action: "space.create", name: "Ben privat", private: true }).id);
const write = (pageId: string, html: string) => run("UPDATE documents SET html=?,state=? WHERE page_id=?", html, htmlState(html), pageId);

const house = String(as(ada)({ action: "page.create", spaceId: shared, title: "Haus", kind: "document" }).id);
const car = String(as(ada)({ action: "page.create", spaceId: shared, title: "Auto", kind: "document" }).id);
const heating = String(as(ada)({ action: "page.create", spaceId: shared, title: "Heizung", kind: "document", parentId: house }).id);
write(heating, `<p>Siehe <a href="/#page=${car}">Auto</a> und <a href="https://flowplan.example.test/#page=${house}">Haus</a>.</p>`);
as(ada)({ action: "comment.create", pageId: car, body: "TÜV im März" });
const diary = String(as(ben)({ action: "page.create", spaceId: benSpace, title: "Tagebuch", kind: "document" }).id);
write(diary, "<p>Nur für mich.</p>");

test("a space becomes one ZIP: a folder per top-level page, relative links, an index", async () => {
  const result = await exportMarkdown(ben, { spaceId: shared, format: "zip", includeSubpages: false, history: true });
  const files = await readExportZip(result.bytes as Buffer);
  const names = [...files.keys()];
  const houseDir = `Haus-${house.slice(0, 8)}`,
    carDir = `Auto-${car.slice(0, 8)}`;
  assert.ok(files.has(`${houseDir}/index.md`), names.join(", "));
  assert.ok(files.has(`${carDir}/index.md`));
  const sub = names.find((n) => n.startsWith(`${houseDir}/pages/`) && n.endsWith(`${heating}.md`))!;
  assert.ok(sub, "sub-page inside its top-level page's folder");
  const text = files.get(sub)!.toString("utf8");
  // Links between pages of the space stay inside the ZIP.
  assert.match(text, new RegExp(`\\]\\(<?\\.\\./\\.\\./${carDir}/index\\.md>?\\)`));
  assert.match(text, /\]\(<?\.\.\/index\.md>?\)/);
  // The index lists the top-level pages; comments come along on request.
  const index = files.get("index.md")!.toString("utf8");
  assert.match(index, /^# /);
  assert.match(index, new RegExp(`\\[Haus\\]\\(<?${houseDir}/index\\.md>?\\)`));
  assert.match(files.get(`${carDir}/index.comments.md`)!.toString("utf8"), /TÜV im März/);
  assert.match(files.get("README.txt")!.toString("utf8"), /eigenen Ordner|folder of its own/);
  // Nothing from Ben's private space.
  assert.ok(!names.some((n) => n.includes("Tagebuch")));
  assert.equal(result.name, `${bootstrap(ada, wid).spaces.find((s) => s.id === shared)!.name}.zip`.replace(/[\\/:*?"<>|]/g, "-"));
});

test("only who may read the space exports it, and only as a ZIP", async () => {
  // Ada owns the workspace but Ben's space is private: no export for her.
  await assert.rejects(exportMarkdown(ada, { spaceId: benSpace, format: "zip", includeSubpages: false }), /Keine Berechtigung für diesen Bereich/);
  const own = await readExportZip((await exportMarkdown(ben, { spaceId: benSpace, format: "zip", includeSubpages: false })).bytes as Buffer);
  assert.match(own.get(`Tagebuch-${diary.slice(0, 8)}/index.md`)!.toString("utf8"), /Nur für mich/);
  await assert.rejects(exportMarkdown(ben, { spaceId: shared, format: "markdown", includeSubpages: false }), /nur als ZIP/);
  await assert.rejects(exportMarkdown(ben, { spaceId: shared, pageId: house, format: "zip", includeSubpages: false }), /Entweder/);
  await assert.rejects(exportMarkdown(ben, { spaceId: id(), format: "zip", includeSubpages: false }), /Bereich nicht gefunden/);
  // A single page keeps its layout (index.md at the top).
  const page = await readExportZip((await exportMarkdown(ada, { pageId: house, format: "zip", includeSubpages: true })).bytes as Buffer);
  assert.ok(page.has("index.md") && [...page.keys()].some((n) => n.startsWith("pages/")));
});
