// Collapsing the bar with tags and properties (#83): the choice per person
// and page in the account, the default (more than four properties), the
// collapsed line (chips, "+N", "N Eigenschaften").
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Identity } from "../lib/types";
process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-collapse-"));
const { one, run, id } = await import("../lib/db");
const { createWorkspace } = await import("../lib/seed");
const { command, bootstrap, pageData } = await import("../lib/api");
const { commandActionNames, commandActions } = await import("../lib/openapi");
const { isBarCollapsed, summaryTags, propertyCountLabel, visibleProperties, COLLAPSE_AFTER } = await import("../lib/page-properties");
const { deleteInactiveAccount } = await import("../lib/account-deletion");

function account(name: string) {
  const uid = id();
  run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, name, `${name}@example.test`);
  return { id: uid, name, email: `${name}@example.test`, groups: [], isAdmin: false, disabled: 0, created_at: "" } as Identity;
}
const owner = account("Olga"),
  viewer = account("Vera"),
  stranger = account("Sven");
const wid = createWorkspace(owner.id, "Agentur");
run("INSERT INTO members VALUES(?,?,?)", wid, viewer.id, "viewer");
const team = bootstrap(owner, wid).spaces[0].id;
const act = (input: Record<string, unknown>, as = owner) => command(as, input) as Record<string, unknown>;
const page = (title: string) => (act({ action: "page.create", workspaceId: wid, spaceId: team, title, kind: "document" }) as { id: string }).id;
const choice = (pageId: string, as = owner) => (pageData(as, pageId) as { propertiesCollapsed?: boolean | null }).propertiesCollapsed;

const angebot = page("Angebot");
const protokoll = page("Protokoll");

test("schema 83: the table exists", () => {
  assert.ok(one("SELECT 1 FROM sqlite_master WHERE type='table' AND name='page_view_prefs'"));
});

test("stored per person and per page, in the account", () => {
  assert.equal(choice(angebot), null);
  assert.deepEqual(act({ action: "page.collapseProperties", pageId: angebot, collapsed: true }), { collapsed: true });
  assert.equal(choice(angebot), true);
  // Another page and another person are untouched.
  assert.equal(choice(protokoll), null);
  assert.equal(choice(angebot, viewer), null);
  // Readers choose for themselves too.
  act({ action: "page.collapseProperties", pageId: angebot, collapsed: false }, viewer);
  assert.equal(choice(angebot, viewer), false);
  assert.equal(choice(angebot), true);
  // Open again; null forgets the choice.
  act({ action: "page.collapseProperties", pageId: angebot, collapsed: false });
  assert.equal(choice(angebot), false);
  act({ action: "page.collapseProperties", pageId: angebot, collapsed: null });
  assert.equal(choice(angebot), null);
  assert.equal(one<{ n: number }>("SELECT COUNT(*) n FROM page_view_prefs WHERE user_id=?", owner.id)!.n, 0);
});

test("only for pages one may open; bad input is refused", () => {
  assert.throws(() => act({ action: "page.collapseProperties", pageId: angebot, collapsed: true }, stranger), /Seite|Berechtigung/);
  assert.equal(one("SELECT 1 FROM page_view_prefs WHERE user_id=?", stranger.id), undefined);
  assert.throws(() => act({ action: "page.collapseProperties", pageId: angebot, collapsed: "yes" }));
  assert.throws(() => act({ action: "page.collapseProperties", pageId: "nope", collapsed: true }));
});

test("gone with the page and with the account", () => {
  const notes = page("Notizen");
  act({ action: "page.collapseProperties", pageId: notes, collapsed: true });
  act({ action: "page.collapseProperties", pageId: notes, collapsed: true }, viewer);
  run("DELETE FROM pages WHERE id=?", notes);
  assert.equal(one("SELECT 1 FROM page_view_prefs WHERE page_id=?", notes), undefined);
  const temp = account("Tim");
  run("INSERT INTO members VALUES(?,?,?)", wid, temp.id, "editor");
  act({ action: "page.collapseProperties", pageId: protokoll, collapsed: true }, temp);
  deleteInactiveAccount(temp.id);
  assert.equal(one("SELECT 1 FROM page_view_prefs WHERE user_id=?", temp.id), undefined);
});

test("listed for the API", () => {
  assert.ok(commandActionNames.includes("page.collapseProperties"));
  assert.ok(commandActions.some((a) => a.action === "page.collapseProperties"));
});

test("default: open while small, collapsed with more than four properties; a choice wins", () => {
  assert.equal(COLLAPSE_AFTER, 4);
  assert.equal(isBarCollapsed(null, 0), false);
  assert.equal(isBarCollapsed(undefined, 4), false);
  assert.equal(isBarCollapsed(null, 5), true);
  assert.equal(isBarCollapsed(false, 9), false);
  assert.equal(isBarCollapsed(true, 1), true);
  // Counted: the automatic properties and those with a value, not empty ones.
  const def = (pid: string, type: string) => ({ id: pid, name: pid, type, options: [], position: 0 }) as never;
  const defs = [def("a", "text"), def("b", "number"), def("c", "checkbox"), def("d", "created_at"), def("e", "multiselect"), def("f", "text")];
  const visible = visibleProperties(defs, { a: "x", b: 0, c: false, e: [] });
  assert.deepEqual(
    visible.map((d: { id: string }) => d.id),
    ["a", "b", "d"],
  );
});

test("collapsed line: chips, overflow count, pluralisation", () => {
  const tags = ["Kunde", "Angebot", "2026", "Wichtig", "Intern"];
  assert.deepEqual(summaryTags(tags, 3), { shown: ["Kunde", "Angebot", "2026"], more: 2 });
  assert.deepEqual(summaryTags(tags.slice(0, 2), 3), { shown: ["Kunde", "Angebot"], more: 0 });
  assert.deepEqual(summaryTags([], 3), { shown: [], more: 0 });
  assert.deepEqual(summaryTags(tags, 2), { shown: ["Kunde", "Angebot"], more: 3 });
  const de = (d: string) => d,
    en = (_: string, e: string) => e;
  assert.equal(propertyCountLabel(0, de), "");
  assert.equal(propertyCountLabel(1, de), "1 Eigenschaft");
  assert.equal(propertyCountLabel(5, de), "5 Eigenschaften");
  assert.equal(propertyCountLabel(1, en), "1 property");
  assert.equal(propertyCountLabel(7, en), "7 properties");
});
