// The start page's stats widget (#499): "recordsDone" counts only records
// the reader may see, in databases whose done property they may read – as
// the journal's "Erledigt" list (lib/journal-completed.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Identity } from "../lib/types";

process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-home-stats-"));
const { id, one, run } = await import("../lib/db");
const { command, database, bootstrap } = await import("../lib/api");
const { createWorkspace } = await import("../lib/seed");
const { homeData } = await import("../lib/home-widgets");

async function user(name: string): Promise<Identity> {
  const uid = id();
  await run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, name, `${name}@test.invalid`);
  return { id: uid, name, email: `${name}@test.invalid`, groups: [], isAdmin: false, disabled: 0, created_at: "" };
}
const owner = await user("hs-owner");
const viewer = await user("hs-viewer");
const wid = await createWorkspace(owner.id, "Stats");
const space = (await bootstrap(owner, wid)).spaces[0].id;
await run("INSERT INTO members(workspace_id,user_id,role) VALUES(?,?,?)", wid, viewer.id, "viewer");
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const act = async (body: Record<string, unknown>): Promise<any> => await command(owner, body);
async function tasks(title: string, statusAccess?: unknown) {
  const pageId = (await act({ action: "page.create", workspaceId: wid, spaceId: space, kind: "database", title, databaseKind: "empty" })).id as string;
  const d = await database(pageId);
  await act({
    action: "database.update",
    pageId,
    version: d.version,
    views: d.views,
    fields: [
      { id: "title", name: "T", type: "text" },
      { id: "status", name: "Status", type: "select", options: ["Offen", "Erledigt"], ...(statusAccess ? { access: statusAccess } : {}) },
    ],
  });
  return pageId;
}
const today = new Date().toISOString().slice(0, 10);
const recordsDone = async (who: Identity) =>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ((await homeData(who, { workspaceId: wid, today, zone: "UTC", widgets: [{ id: "s", kind: "stats", config: {} }] })).widgets[0] as any).data.recordsDone as number;
const done = async (pageId: string, rowId: string) =>
  await act({ action: "row.update", pageId, rowId, version: (await one<{ version: number }>("SELECT version FROM rows WHERE id=?", rowId))!.version, cells: { status: "Erledigt" } });

test("#499: recordsDone leaves out private records and hidden done properties", async () => {
  const open = await tasks("Tasks");
  const visible = (await act({ action: "row.create", pageId: open, cells: { title: "visible", status: "Offen" } })).id;
  const hidden = (await act({ action: "row.create", pageId: open, cells: { title: "private", status: "Offen" } })).id;
  await act({ action: "row.access", pageId: open, rowId: hidden, access: "private", grants: [] });
  assert.equal(await recordsDone(viewer), 0);
  await done(open, visible);
  assert.equal(await recordsDone(viewer), 1);
  await done(open, hidden);
  assert.equal(await recordsDone(viewer), 1, "a private record of someone else does not count");

  const restricted = await tasks("Hidden status", { read: "owners" });
  const row = (await act({ action: "row.create", pageId: restricted, cells: { title: "vis", status: "Offen" } })).id;
  await done(restricted, row);
  assert.equal(await recordsDone(viewer), 1, "a done property the reader may not read does not count");
  // The owner sees all three.
  assert.equal(await recordsDone(owner), 3);
});
