import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Identity } from "../lib/types";

process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-cross-"));
const { id, run } = await import("../lib/db");
const { command, database, bootstrap } = await import("../lib/api");
const { createWorkspace } = await import("../lib/seed");
const { crossRecords, recordViews } = await import("../lib/cross-records");

function user(name: string): Identity {
  const uid = id();
  run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, name, `${name}@test.invalid`);
  return { id: uid, name, email: `${name}@test.invalid`, groups: [], isAdmin: false, disabled: 0, created_at: "" };
}
const me = user("me"),
  other = user("other");
const wid = createWorkspace(me.id, "Projects"),
  boot = bootstrap(me, wid);
run("INSERT INTO members VALUES(?,?,?)", wid, other.id, "editor");
const act = (body: Record<string, unknown>): any => command(me, body);
const project = (title: string, prefix: string) => {
  const pageId = act({ action: "page.create", workspaceId: wid, spaceId: boot.spaces[0].id, kind: "database", title }).id as string;
  act({
    action: "database.update",
    pageId,
    version: database(pageId).version,
    fields: [
      { id: "title", name: "Title", type: "text" },
      { id: "status", name: "Status", type: "select", options: ["Open", "Done"] },
      { id: "who", name: "Assignee", type: "person" },
      { id: "due", name: "Due", type: "date" },
      { id: "key", name: "ID", type: "id", prefix },
    ],
    views: database(pageId).views,
  });
  return pageId;
};
const web = project("Website", "WEB"),
  app = project("App", "APP");
act({ action: "row.create", pageId: web, cells: { title: "Header", status: "Open", who: me.id, due: "2020-01-01" } });
act({ action: "row.create", pageId: web, cells: { title: "Footer", status: "Done", who: me.id } });
act({ action: "row.create", pageId: app, cells: { title: "Login", status: "Open", who: me.id } });
act({ action: "row.create", pageId: app, cells: { title: "Other's", status: "Open", who: other.id } });

test("my open records across all databases", () => {
  const mine = crossRecords(me, wid, {});
  assert.deepEqual(mine.records.map((r) => [r.key, r.title]), [["WEB-1", "Header"], ["APP-1", "Login"]]);
  assert.deepEqual(crossRecords(me, wid, { due: "overdue" }).records.map((r) => r.title), ["Header"]);
  assert.equal(crossRecords(me, wid, { open: false }).records.length, 3);
  assert.equal(crossRecords(me, wid, { mine: false, databases: [app] }).records.length, 2);
  assert.deepEqual(crossRecords(me, wid, { query: "app-1" }).records.map((r) => r.title), ["Login"]);
});

test("saved views are personal", () => {
  act({ action: "recordView.save", workspaceId: wid, name: "Overdue", filter: { due: "overdue" } });
  assert.deepEqual(recordViews(me, wid).map((v) => [v.name, v.filter.due]), [["Overdue", "overdue"]]);
  assert.equal(recordViews(other, wid).length, 0);
});
