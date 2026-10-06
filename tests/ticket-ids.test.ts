import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Field, Identity } from "../lib/types";

process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-ids-"));
const { id, run, one } = await import("../lib/db");
const { command, database, bootstrap, rows } = await import("../lib/api");
const { createWorkspace } = await import("../lib/seed");
const { resolveTicket } = await import("../lib/ticket-refs");
const { computedCells } = await import("../lib/database");
const { suggestedPrefix } = await import("../lib/ticket-ids");

function user(name: string): Identity {
  const uid = id();
  run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, name, `${name}@test.invalid`);
  return { id: uid, name, email: `${name}@test.invalid`, groups: [], isAdmin: false, disabled: 0, created_at: "" };
}
const owner = user("owner"),
  stranger = user("stranger");
const wid = createWorkspace(owner.id, "Tickets"),
  boot = bootstrap(owner, wid);
const act = (body: Record<string, unknown>): any => command(owner, body);
const db = (title: string) => act({ action: "page.create", workspaceId: wid, spaceId: boot.spaces[0].id, kind: "database", title }).id as string;
const withId = (pageId: string, prefix?: string) => {
  const fields: Field[] = [...database(pageId).fields.filter((f) => f.type !== "id"), { id: "key", name: "ID", type: "id", prefix }];
  return act({ action: "database.update", pageId, version: database(pageId).version, fields, views: database(pageId).views });
};

test("records get running numbers, shown with the prefix", () => {
  const web = db("Website");
  const a = act({ action: "row.create", pageId: web, cells: { title: "A" } }).id;
  const b = act({ action: "row.create", pageId: web, cells: { title: "B" } }).id;
  withId(web, "WEB");
  const fields = database(web).fields;
  const shown = (rid: string) => {
    const row = one<any>("SELECT * FROM rows WHERE id=?", rid);
    return computedCells({ ...row, cells: JSON.parse(row.cells) }, fields).key;
  };
  assert.equal(shown(a), "WEB-1");
  assert.equal(shown(b), "WEB-2");
  // Deleted and restored: the same number again.
  act({ action: "row.delete", pageId: web, rowId: b });
  const c = act({ action: "row.create", pageId: web, cells: { title: "C" } }).id;
  assert.equal(shown(c), "WEB-3");
  const trash = one<{ id: string }>("SELECT id FROM row_trash WHERE id=?", b);
  act({ action: "row.trash.restore", pageId: web, trashId: trash!.id });
  assert.equal(shown(b), "WEB-2");
  // The number cannot be edited.
  assert.throws(() => act({ action: "row.update", pageId: web, rowId: a, version: 1, cells: { key: "X" } }));
  // References resolve for readers only.
  const found = resolveTicket(owner, wid, "web-2")!;
  assert.equal(found.rowId, b);
  assert.equal(found.title, "B");
  assert.equal(resolveTicket(stranger, wid, "WEB-2"), null);
  assert.equal(resolveTicket(owner, wid, "WEB-99"), null);
});

test("prefixes are required and unique in the workspace", () => {
  const other = db("Other");
  assert.throws(() => withId(other), /Präfix/);
  assert.throws(() => withId(other, "WEB"), /WEB nutzt schon/);
  withId(other, "OPS");
  assert.equal(suggestedPrefix("Website Relaunch"), "WR");
  assert.equal(suggestedPrefix("Marketing"), "MARK");
});
