import { test } from "node:test";
import { sqliteOnly } from "./helpers/backend";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Identity, Page } from "../lib/types";
process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-read-memo-"));
const { one, run, id, transaction, writeGeneration } = await import("../lib/db");
const { createWorkspace } = await import("../lib/seed");
const { command, bootstrap } = await import("../lib/api");
const { pageRole, requirePage } = await import("../lib/permissions");
const { withReadMemo, memoized } = await import("../lib/read-memo");

// Permission lookups are remembered within a request or command until the
// next write (lib/read-memo.ts) – never across requests, never past a
// change of rights.

const account = (name: string) => {
  const uid = id();
  run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, name, `${name}@example.test`);
  return { id: uid, name, email: `${name}@example.test`, groups: [], isAdmin: false, disabled: 0, created_at: "" } as Identity;
};
const owner = account("memo-owner"),
  member = account("memo-member");
const wid = createWorkspace(owner.id, "Memo");
run("INSERT INTO members VALUES(?,?,?)", wid, member.id, "editor");
const space = bootstrap(owner, wid).spaces[0];
const pageId = (command(owner, { action: "page.create", workspaceId: wid, spaceId: space.id, title: "Plan", kind: "document" }) as { id: string }).id;
const childId = (command(owner, { action: "page.create", workspaceId: wid, spaceId: space.id, parentId: pageId, title: "Teil", kind: "document" }) as { id: string }).id;
const page = (pid: string) => one<Page>("SELECT * FROM pages WHERE id=?", pid)!;

test("nothing is remembered outside a request or command", () => {
  let calls = 0;
  memoized("probe", () => ++calls);
  memoized("probe", () => ++calls);
  assert.equal(calls, 2);
});

test("within a scope a lookup runs once until something is written", () => {
  withReadMemo(() => {
    let calls = 0;
    assert.equal(memoized("probe", () => ++calls), 1);
    assert.equal(memoized("probe", () => ++calls), 1);
    const before = writeGeneration();
    run("UPDATE pages SET title=title WHERE id=?", pageId);
    assert.ok(writeGeneration() > before);
    assert.equal(memoized("probe", () => ++calls), 2);
  });
});

test("a write in the same scope changes the rights the next check sees", () => {
  withReadMemo(() => {
    assert.equal(pageRole(member, page(childId)), "editor");
    run("INSERT INTO grants(resource_id,user_id,group_id,role) VALUES(?,?,?,?)", pageId, member.id, "", "viewer");
    // Inherited from the parent page.
    assert.equal(pageRole(member, page(childId)), "viewer");
    run("DELETE FROM members WHERE workspace_id=? AND user_id=?", wid, member.id);
    assert.equal(pageRole(member, page(childId)), null);
    assert.throws(() => requirePage(member, childId), /Keine Berechtigung/);
    run("INSERT INTO members VALUES(?,?,?)", wid, member.id, "editor");
    run("DELETE FROM grants WHERE resource_id=? AND user_id=?", pageId, member.id);
    assert.equal(pageRole(member, page(childId)), "editor");
  });
});

test("a rolled back change of rights is forgotten too", () => {
  withReadMemo(() => {
    assert.equal(pageRole(member, page(pageId)), "editor");
    assert.throws(() =>
      transaction(() => {
        run("DELETE FROM members WHERE workspace_id=? AND user_id=?", wid, member.id);
        assert.equal(pageRole(member, page(pageId)), null);
        throw new Error("abort");
      }),
    );
    assert.equal(pageRole(member, page(pageId)), "editor");
  });
});

test("scopes do not share what they remember", { skip: sqliteOnly }, async () => {
  // Another connection (a script on the same file) takes the membership away
  // while a scope has looked it up: the next request sees the change.
  const other = new DatabaseSync(join(process.env.FLOWPLAN_DATA_DIR!, "flowplan.sqlite"));
  try {
    await withReadMemo(async () => {
      assert.equal(pageRole(member, page(pageId)), "editor");
      other.prepare("UPDATE members SET role='viewer' WHERE workspace_id=? AND user_id=?").run(wid, member.id);
      await withReadMemo(async () => {
        // The inner call joins the scope of the outer one.
        assert.equal(pageRole(member, page(pageId)), "editor");
      });
    });
    await Promise.all([
      withReadMemo(async () => {
        assert.equal(pageRole(member, page(pageId)), "viewer");
      }),
      withReadMemo(async () => {
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(pageRole(member, page(pageId)), "viewer");
      }),
    ]);
  } finally {
    other.prepare("UPDATE members SET role='editor' WHERE workspace_id=? AND user_id=?").run(wid, member.id);
    other.close();
  }
});

test("a command that shares a page checks the new rights within itself", () => {
  const viewer = account("memo-viewer");
  run("INSERT INTO members VALUES(?,?,?)", wid, viewer.id, "viewer");
  const privateSpace = (command(owner, { action: "space.create", workspaceId: wid, name: "Privat", private: true }) as { id: string }).id;
  const secret = (command(owner, { action: "page.create", workspaceId: wid, spaceId: privateSpace, title: "Geheim", kind: "document" }) as { id: string }).id;
  assert.throws(() => requirePage(viewer, secret));
  run("INSERT INTO grants(resource_id,user_id,group_id,role) VALUES(?,?,?,?)", secret, viewer.id, "", "viewer");
  assert.equal(requirePage(viewer, secret).id, secret);
  // The copy handed out does not change what later checks read.
  withReadMemo(() => {
    const copy = requirePage(owner, secret) as Page & { title: string };
    copy.title = "verändert";
    copy.parent_id = null;
    assert.equal(requirePage(owner, secret).title, "Geheim");
  });
});
