import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sqliteOnly } from "./helpers/backend";
process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-indexes-383-"));
const { db, SCHEMA_VERSION } = await import("../lib/db");

// Schema 106 (#383): indexes for the permission checks and the page tree.
const plan = (sql: string) =>
  (db().prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as { detail: string }[]).map((r) => r.detail).join("\n");

test("schema 106 has the indexes", { skip: sqliteOnly }, () => {
  assert.ok(SCHEMA_VERSION >= 106);
  const names = new Set((db().prepare("SELECT name FROM sqlite_master WHERE type='index'").all() as { name: string }[]).map((r) => r.name));
  for (const name of ["group_members_user", "members_user", "pages_parent", "rows_restricted"]) assert.ok(names.has(name), name);
});

test("the hot queries use them", { skip: sqliteOnly }, () => {
  // The groups of a person in every grant check (lib/permissions.ts).
  assert.match(
    plan(
      "SELECT role FROM grants WHERE resource_id=? AND resource_kind=? AND workspace_id=? AND (user_id=? OR group_id IN (SELECT group_id FROM group_members WHERE user_id=?))",
    ),
    /group_members USING (COVERING )?INDEX group_members_user/,
  );
  // The workspaces of a person.
  assert.match(plan("SELECT workspace_id,role FROM members WHERE user_id=?"), /USING (COVERING )?INDEX members_user/);
  // The pages below a page.
  assert.match(plan("SELECT id FROM pages WHERE parent_id=?"), /USING (COVERING )?INDEX pages_parent/);
  // Records with their own access (lib/row-access.ts).
  assert.match(
    plan("SELECT id,access,created_by FROM rows WHERE page_id=? AND access<>'inherit' AND access='private'"),
    /USING INDEX rows_restricted/,
  );
  assert.match(
    plan(
      `SELECT g.row_id,g.user_id,g.group_id,g.role FROM row_grants g JOIN rows r ON r.id=g.row_id
       WHERE r.page_id=? AND r.access<>'inherit' AND (g.user_id=? OR g.group_id IN (SELECT group_id FROM group_members WHERE user_id=?))`,
    ),
    /rows_restricted|row_grants/,
  );
});
