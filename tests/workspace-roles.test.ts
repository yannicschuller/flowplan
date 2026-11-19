// The roles of all pages of a workspace at once (#383, lib/permissions.ts
// workspaceRoles()) must equal pageRole() page by page: over generated
// workspaces with groups, guests, private and deleted spaces, an encrypted
// space, page and space grants (direct, inherited, through groups), records
// with their own access and grants, pages below records (also below records
// in the trash, gone or moved to another database), the trash, locked and
// workflow pages, a parent cycle and parents in another workspace – for
// every page and every person, also after changes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Identity, Page } from "../lib/types";
process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-workspace-roles-"));
const { id, run, all, one } = await import("../lib/db");
const { pageRole, workspaceRoles } = await import("../lib/permissions");
const { withReadMemo } = await import("../lib/read-memo");

// A small deterministic random source (mulberry32), so a failure repeats.
function random(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function user(name: string): Promise<Identity> {
  const uid = id();
  await run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, name, `${name}-${uid}@example.com`);
  return { id: uid, name, email: `${name}@example.com`, groups: [], isAdmin: false, disabled: 0, created_at: "" } as Identity;
}

type World = { workspace: string; people: Identity[]; pages: string[]; databases: string[]; rows: string[]; spaces: string[]; groups: string[] };

async function world(seed: number): Promise<World> {
  const rnd = random(seed);
  const pick = <T,>(list: T[]) => list[Math.floor(rnd() * list.length)];
  const workspace = id();
  await run("INSERT INTO workspaces(id,name) VALUES(?,?)", workspace, `W${seed}`);
  const people: Identity[] = [];
  const roles = ["owner", "editor", "viewer"] as const;
  for (let i = 0; i < 9; i++) {
    const p = await user(`p${seed}-${i}`);
    people.push(p);
    // The last one is no member; two of the members are guests.
    if (i < 8) await run("INSERT INTO members(workspace_id,user_id,role) VALUES(?,?,?)", workspace, p.id, i === 0 ? "owner" : pick([...roles]));
    if (i === 5 || i === 6) await run("INSERT INTO workspace_guests(workspace_id,user_id) VALUES(?,?)", workspace, p.id);
  }
  const groups: string[] = [];
  for (let i = 0; i < 3; i++) {
    const g = id();
    groups.push(g);
    await run("INSERT INTO groups(id,workspace_id,name) VALUES(?,?,?)", g, workspace, `G${i}`);
    for (const p of people) if (rnd() < 0.35) await run("INSERT INTO group_members(group_id,user_id) VALUES(?,?)", g, p.id);
  }
  // Spaces: team ones, private ones (owned, some shared by a grant), one
  // in the trash, one encrypted.
  const spaces: string[] = [];
  for (let i = 0; i < 6; i++) {
    const s = id();
    spaces.push(s);
    const visibility = i < 2 ? "team" : "private";
    await run(
      "INSERT INTO spaces(id,workspace_id,name,visibility,owner_id,deleted_at,encrypted) VALUES(?,?,?,?,?,?,?)",
      s,
      workspace,
      `S${i}`,
      visibility,
      i === 0 ? null : pick(people).id,
      i === 4 ? "2026-01-01 00:00:00" : null,
      i === 5 ? 1 : 0,
    );
  }
  for (let i = 0; i < 6; i++) {
    const target = pick(spaces);
    const byGroup = rnd() < 0.4;
    await run(
      "INSERT INTO grants(resource_id,user_id,group_id,role,resource_kind,workspace_id) VALUES(?,?,?,?,?,?) ON CONFLICT DO NOTHING",
      target,
      byGroup ? "" : pick(people).id,
      byGroup ? pick(groups) : "",
      pick([...roles]),
      "space",
      workspace,
    );
  }
  // Pages: a forest across the spaces, some databases with records.
  const pages: string[] = [],
    databases: string[] = [],
    rows: string[] = [];
  const spaceOf = new Map<string, string>();
  for (let i = 0; i < 70; i++) {
    const pid = id();
    const parent = pages.length && rnd() < 0.7 ? pick(pages) : null;
    // Mostly the parent's space, now and then another one.
    const space = parent && rnd() < 0.9 ? spaceOf.get(parent)! : pick(spaces);
    // (Only documents in the encrypted space.)
    const kind = space === spaces[5] ? "document" : rnd() < 0.15 ? "database" : rnd() < 0.05 ? "workflow" : "document";
    // Below a record of the parent database.
    let parentRow: string | null = null;
    if (parent && databases.includes(parent) && rnd() < 0.6) {
      const own = await all<{ id: string }>("SELECT id FROM rows WHERE page_id=?", parent);
      if (own.length) parentRow = pick(own).id;
    }
    await run(
      "INSERT INTO pages(id,workspace_id,space_id,parent_id,parent_row_id,title,kind,deleted_at,locked,synced) VALUES(?,?,?,?,?,?,?,?,?,?)",
      pid,
      workspace,
      space,
      parent,
      parentRow,
      `P${i}`,
      kind,
      rnd() < 0.1 ? "2026-02-01 00:00:00" : null,
      rnd() < 0.1 ? 1 : 0,
      rnd() < 0.03 ? 1 : 0,
    );
    pages.push(pid);
    spaceOf.set(pid, space);
    if (kind === "database") {
      databases.push(pid);
      for (let r = 0; r < 4; r++) {
        const rid = id();
        rows.push(rid);
        await run(
          "INSERT INTO rows(id,page_id,cells,created_by,access) VALUES(?,?,?,?,?)",
          rid,
          pid,
          JSON.stringify({ title: `R${r}` }),
          pick(people).id,
          pick(["inherit", "inherit", "readonly", "private"]),
        );
        if (rnd() < 0.5) {
          const byGroup = rnd() < 0.4;
          await run(
            "INSERT INTO row_grants(row_id,user_id,group_id,role) VALUES(?,?,?,?) ON CONFLICT DO NOTHING",
            rid,
            byGroup ? "" : pick(people).id,
            byGroup ? pick(groups) : "",
            pick(["viewer", "editor"]),
          );
        }
      }
    }
  }
  // Page grants, direct and (through the tree) inherited.
  for (let i = 0; i < 25; i++) {
    const byGroup = rnd() < 0.4;
    await run(
      "INSERT INTO grants(resource_id,user_id,group_id,role,resource_kind,workspace_id) VALUES(?,?,?,?,?,?) ON CONFLICT DO NOTHING",
      pick(pages),
      byGroup ? "" : pick(people).id,
      byGroup ? pick(groups) : "",
      pick([...roles]),
      "page",
      workspace,
    );
  }
  return { workspace, people, pages, databases, rows, spaces, groups };
}

// Every page of the workspace, every person: the bulk answer and the
// page-by-page one. Both outside a request (no read memo), so pageRole()
// decides on its own.
async function same(w: World, label: string) {
  const pages = await all<Page>("SELECT * FROM pages WHERE workspace_id=?", w.workspace);
  let compared = 0;
  for (const person of w.people) {
    const bulk = await workspaceRoles(person, w.workspace);
    assert.equal(bulk.roles.size, pages.length, label);
    for (const page of pages) {
      const expected = await pageRole(person, page);
      assert.equal(bulk.roles.has(page.id) ? bulk.roles.get(page.id) : "missing", expected, `${label}: ${person.name} on ${page.title} (${page.id})`);
      compared++;
    }
  }
  return compared;
}

test("workspaceRoles() equals pageRole() for every page and person of generated workspaces", async () => {
  let compared = 0,
    seen = { owner: 0, editor: 0, viewer: 0, none: 0 };
  for (const seed of [1, 2, 3, 4, 5, 6]) {
    const w = await world(seed);
    compared += await same(w, `seed ${seed}`);
    for (const person of w.people)
      for (const role of (await workspaceRoles(person, w.workspace)).roles.values()) seen[role || "none"]++;
  }
  // The fixtures reach every outcome.
  assert.ok(compared > 3000, String(compared));
  for (const [role, n] of Object.entries(seen)) assert.ok(n > 20, `${role}: ${n}`);
});

test("special cases: records in the trash, gone or moved, parent cycles, parents in another workspace", async () => {
  const w = await world(42);
  const rnd = random(7);
  const pick = <T,>(list: T[]) => list[Math.floor(rnd() * list.length)];
  // Pages below records of each database with records.
  const below = async (database: string, row: string) => {
    const pid = id();
    const space = (await one<{ space_id: string }>("SELECT space_id FROM pages WHERE id=?", database))!.space_id;
    await run("INSERT INTO pages(id,workspace_id,space_id,parent_id,parent_row_id,title) VALUES(?,?,?,?,?,?)", pid, w.workspace, space, database, row, "below");
    // And a page below that one.
    await run("INSERT INTO pages(id,workspace_id,space_id,parent_id,title) VALUES(?,?,?,?,?)", id(), w.workspace, space, pid, "deeper");
    return pid;
  };
  const dbs = w.databases.slice(0, 4);
  assert.ok(dbs.length >= 3);
  const rowsOf = async (db: string) => (await all<{ id: string; access: string; created_by: string }>("SELECT id,access,created_by FROM rows WHERE page_id=?", db));
  // A record in the trash (with its access and grants in the payload).
  const [trashedRow] = await rowsOf(dbs[0]);
  await below(dbs[0], trashedRow.id);
  await run(
    "INSERT INTO row_trash(id,page_id,workspace_id,title,payload) VALUES(?,?,?,?,?)",
    trashedRow.id,
    dbs[0],
    w.workspace,
    "R",
    JSON.stringify({ row: { access: "private", created_by: w.people[2].id }, grants: [{ user_id: w.people[3].id, group_id: "", role: "editor" }] }),
  );
  await run("DELETE FROM rows WHERE id=?", trashedRow.id);
  // A record gone altogether.
  const [goneRow] = await rowsOf(dbs[1]);
  await below(dbs[1], goneRow.id);
  await run("DELETE FROM rows WHERE id=?", goneRow.id);
  // A record moved to another database (its page still names the first).
  const [movedRow] = await rowsOf(dbs[2]);
  await below(dbs[2], movedRow.id);
  await run("UPDATE rows SET page_id=?,access='private' WHERE id=?", dbs[dbs.length - 1] === dbs[2] ? dbs[0] : dbs[3] || dbs[0], movedRow.id);
  // Private records with sub-pages, for everyone.
  for (const db of dbs) for (const r of await rowsOf(db)) await below(db, r.id);
  // A parent cycle.
  const a = id(),
    b = id();
  await run("INSERT INTO pages(id,workspace_id,space_id,title) VALUES(?,?,?,?)", a, w.workspace, w.spaces[0], "cycle a");
  await run("INSERT INTO pages(id,workspace_id,space_id,parent_id,title) VALUES(?,?,?,?,?)", b, w.workspace, w.spaces[0], a, "cycle b");
  await run("UPDATE pages SET parent_id=? WHERE id=?", b, a);
  await run("INSERT INTO pages(id,workspace_id,space_id,parent_id,title) VALUES(?,?,?,?,?)", id(), w.workspace, w.spaces[1], a, "below the cycle");
  // A page without a space, one in a space of another workspace, and one
  // whose parent is in another workspace (data that should not exist).
  const other = await world(43);
  await run("INSERT INTO pages(id,workspace_id,space_id,title) VALUES(?,?,?,?)", id(), w.workspace, null, "no space");
  await run("INSERT INTO pages(id,workspace_id,space_id,title) VALUES(?,?,?,?)", id(), w.workspace, other.spaces[0], "foreign space");
  await run("INSERT INTO pages(id,workspace_id,space_id,parent_id,title) VALUES(?,?,?,?,?)", id(), w.workspace, w.spaces[0], pick(other.pages), "foreign parent");
  await run("INSERT INTO pages(id,workspace_id,space_id,parent_id,parent_row_id,title) VALUES(?,?,?,?,?,?)", id(), w.workspace, w.spaces[0], other.databases[0], (await rowsOf(other.databases[0]))[0]?.id || null, "below a foreign record");
  // A grant on a page shared out of a private space and below a record.
  for (const p of (await all<{ id: string }>("SELECT id FROM pages WHERE workspace_id=? AND title='deeper'", w.workspace)).slice(0, 4))
    await run("INSERT INTO grants(resource_id,user_id,group_id,role,resource_kind,workspace_id) VALUES(?,?,?,?,?,?) ON CONFLICT DO NOTHING", p.id, w.people[7].id, "", "editor", "page", w.workspace);
  await same(w, "special");
});

test("after changes (moves, grants, memberships, groups, record access) both still agree", async () => {
  const w = await world(99);
  const rnd = random(99);
  const pick = <T,>(list: T[]) => list[Math.floor(rnd() * list.length)];
  for (let round = 0; round < 6; round++) {
    await run("UPDATE pages SET parent_id=? WHERE id=?", pick(w.pages), pick(w.pages));
    await run("UPDATE pages SET space_id=? WHERE id=?", pick(w.spaces), pick(w.pages));
    await run("DELETE FROM grants WHERE resource_id IN (SELECT resource_id FROM grants WHERE workspace_id=? ORDER BY resource_id LIMIT 2)", w.workspace);
    await run("INSERT INTO grants(resource_id,user_id,group_id,role,resource_kind,workspace_id) VALUES(?,?,?,?,?,?) ON CONFLICT DO NOTHING", pick(w.pages), pick(w.people).id, "", "viewer", "page", w.workspace);
    await run("UPDATE members SET role=? WHERE workspace_id=? AND user_id=?", pick(["viewer", "editor", "owner"]), w.workspace, pick(w.people.slice(1)).id);
    await run("INSERT INTO group_members(group_id,user_id) VALUES(?,?) ON CONFLICT DO NOTHING", pick(w.groups), pick(w.people).id);
    if (w.rows.length) await run("UPDATE rows SET access=? WHERE id=?", pick(["inherit", "readonly", "private"]), pick(w.rows));
    await run("UPDATE spaces SET visibility=? WHERE id=?", pick(["team", "private"]), pick(w.spaces));
    await same(w, `round ${round}`);
  }
});

test("within a request pageRole() answers from the bulk roles, but checks a changed page itself", async () => {
  const w = await world(7);
  const person = w.people[3];
  const page = (await one<Page>("SELECT * FROM pages WHERE workspace_id=? AND parent_id IS NOT NULL LIMIT 1", w.workspace))!;
  const elsewhere = { ...page, parent_id: null, space_id: w.spaces[0] };
  const expected = { stored: await pageRole(person, page), moved: await pageRole(person, elsewhere) };
  await withReadMemo(async () => {
    const roles = await workspaceRoles(person, w.workspace);
    assert.equal(roles.roles.get(page.id), expected.stored);
    assert.equal(await pageRole(person, page), expected.stored);
    assert.equal(await pageRole(person, elsewhere), expected.moved);
    // A write in between: the remembered roles are gone with it.
    await run("INSERT INTO grants(resource_id,user_id,group_id,role,resource_kind,workspace_id) VALUES(?,?,?,?,?,?) ON CONFLICT DO NOTHING", page.id, person.id, "", "owner", "page", w.workspace);
    const member = (await one<{ role: string }>("SELECT role FROM members WHERE workspace_id=? AND user_id=?", w.workspace, person.id))!.role;
    assert.equal(await pageRole(person, page), (await one("SELECT 1 FROM spaces WHERE id=? AND deleted_at IS NULL", page.space_id)) ? member : null);
  });
});
