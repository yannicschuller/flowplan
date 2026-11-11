import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Identity } from "../lib/types";
process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-account-deletion-"));
const { id, run, one, all, transaction } = await import("../lib/db");
const { command, bootstrap } = await import("../lib/api");
const { createWorkspace } = await import("../lib/seed");
const { deleteAccount } = await import("../lib/account-deletion");
const { userReferenceColumns } = await import("../lib/account-merge");

async function person(name: string, admin = false): Promise<Identity> {
  const uid = id();
  await run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, name, `${name}@example.test`);
  return { id: uid, name, email: `${name}@example.test`, groups: [], isAdmin: admin, disabled: 0, created_at: "" } as Identity;
}
const admin = await person("admin", true);
const wid = await createWorkspace(admin.id, "W");
const space = (await bootstrap(admin, wid)).spaces[0].id;
const table = String(((await command(admin, { action: "page.create", workspaceId: wid, spaceId: space, kind: "database", title: "T" })) as { id: string }).id);
const row = String(((await command(admin, { action: "row.create", pageId: table, cells: {} })) as { id: string }).id);

// Personal data of `user` in tables a real deletion empties by cascade or
// that have no foreign key at all.
async function personalData(user: Identity) {
  const at = Date.now();
  await run("INSERT INTO members VALUES(?,?,?)", wid, user.id, "editor");
  await run("INSERT INTO row_grants(row_id,user_id,group_id,role) VALUES(?,?,'','editor')", row, user.id);
  await run("INSERT INTO time_entries(id,page_id,row_id,field_id,user_id,start,end) VALUES(?,?,?,?,?,?,?)", id(), table, row, "f", user.id, at - 60_000, at);
  await run("INSERT INTO time_entries(id,page_id,row_id,field_id,user_id,start) VALUES(?,?,?,?,?,?)", id(), table, row, "f", user.id, at - 1000);
  await run("INSERT INTO whiteboard_presence(page_id,user_id,name,x,y,seen) VALUES(?,?,?,?,?,?)", table, user.id, user.name, 0, 0, at);
  const connection = id();
  await run("INSERT INTO calendar_connections(id,user_id,provider,refresh_token,created_at) VALUES(?,?,?,?,?)", connection, user.id, "google", "dummy-refresh-token", at);
  await run("INSERT INTO calendar_sync_mappings(id,connection_id,user_id,page_id,view_id,calendar_id,created_at) VALUES(?,?,?,?,?,?,?)", id(), connection, user.id, table, "v", "cal", at);
  await run("INSERT INTO calendar_oauth_flows(id,user_id,provider,state,verifier,nonce,expires) VALUES(?,?,?,?,?,?,?)", id(), user.id, "google", "s", "v", "n", at + 60_000);
  await run("INSERT INTO workspace_guests(workspace_id,user_id) VALUES(?,?)", wid, user.id);
  await run("INSERT INTO e2ee_identities(user_id,public_key,wrapped_private,recovery_wrapped,created_at,updated_at) VALUES(?,?,?,?,?,?)", user.id, "pk", "wp", "rw", at, at);
  await run("INSERT INTO e2ee_space_keys(space_id,user_id,key_version,sealed,sealed_by,created_at) VALUES(?,?,?,?,?,?)", space, user.id, 1, "sealed", admin.id, at);
  await run("INSERT INTO app_devices(user_id,device_id,secret_hash,created_at,last_used_at) VALUES(?,?,?,?,?)", user.id, "d", Buffer.from("x"), at, at);
  await run("INSERT INTO weekly_digests(user_id,enabled,updated_at) VALUES(?,1,?)", user.id, at);
  await run("INSERT INTO sidebar_state(user_id,workspace_id,keys,updated_at) VALUES(?,?,'[]',?)", user.id, wid, at);
  await run("INSERT INTO form_drafts(page_id,user_id,cells,updated_at) VALUES(?,?,'{}',?)", table, user.id, at);
  await run("INSERT INTO capture_targets(user_id,workspace_id,page_id) VALUES(?,?,?)", user.id, wid, table);
}
// Rows that stay with a deleted account: what the person contributed to
// shared content (tracked time, authorship), not personal data.
const KEPT = new Set(["time_entries", "page_edits", "document_authors"]);
async function leftovers(userId: string) {
  const found: string[] = [];
  for (const { table: name, column } of await userReferenceColumns())
    if (column === "user_id" && !KEPT.has(name) && (await one(`SELECT 1 FROM ${name} WHERE user_id=?`, userId))) found.push(name);
  return found;
}

test("an account kept as a shell for what it wrote loses all personal data", async () => {
  const ben = await person("ben");
  await personalData(ben);
  // Ben wrote a page in the shared workspace: the account stays as a shell.
  await run("INSERT INTO pages(id,workspace_id,space_id,title,kind,created_by) VALUES(?,?,?,?,?,?)", id(), wid, space, "Von Ben", "document", ben.id);
  await run("UPDATE users SET disabled=1 WHERE id=?", ben.id);
  await transaction(async () => await deleteAccount(admin, ben.id));
  assert.equal((await one<{ subject: string }>("SELECT subject FROM users WHERE id=?", ben.id))?.subject, `deleted:${ben.id}`);
  assert.deepEqual(await leftovers(ben.id), []);
  // No calendar sync for the account any more, and no running timer.
  assert.deepEqual(await all("SELECT id FROM calendar_sync_mappings WHERE user_id=?", ben.id), []);
  const times = await all<{ end: number | null }>("SELECT end FROM time_entries WHERE user_id=?", ben.id);
  assert.equal(times.length, 2, "tracked time stays with the record");
  assert.ok(times.every((t) => t.end !== null));
});

test("a share link someone created does not keep their account as a shell", async () => {
  const cleo = await person("cleo");
  await personalData(cleo);
  await run("INSERT INTO share_links(token,root_id,name,role,created_by) VALUES(?,?,?,?,?)", "dummy-share-token", table, "Link", "viewer", cleo.id);
  await run("UPDATE users SET disabled=1 WHERE id=?", cleo.id);
  await transaction(async () => await deleteAccount(admin, cleo.id));
  assert.equal(await one("SELECT 1 FROM users WHERE id=?", cleo.id), undefined, "deleted, not a shell");
  assert.deepEqual(await leftovers(cleo.id), []);
  // The link keeps working for the people who have it.
  assert.equal((await one<{ created_by: string | null }>("SELECT created_by FROM share_links WHERE token=?", "dummy-share-token"))?.created_by, null);
});
