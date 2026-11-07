import { nowText } from "../lib/db-driver/dialect";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-ai-access-"));
process.env.APP_URL = "https://flowplan.example.test";
const { run, one, id } = await import("../lib/db");
const { createWorkspace, createPage } = await import("../lib/seed");
const { identityFromToken } = await import("../lib/auth");
const { command } = await import("../lib/api");
const { aiMayRead, aiFilter, aiReadablePages, requireAiRead, aiPageAccess } = await import("../lib/ai/access");
const { aiStatus } = await import("../lib/ai/resolve");
import type { Identity } from "../lib/types";
import { filterAsync } from "../lib/each-async";

async function person(name: string): Promise<Identity> {
  const uid = id();
  await run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, name, `${name.toLowerCase()}@example.test`);
  const token = randomBytes(16).toString("hex");
  await run("INSERT INTO sessions(token,user_id,groups_json,expires) VALUES(?,?,?,?)", createHash("sha256").update(token).digest("hex"), uid, "[]", Date.now() + 3600_000);
  return (await identityFromToken(token))!;
}
const owner = await person("Olga"),
  eve = await person("Eve");
const wid = await createWorkspace(owner.id, "Team");
await run("INSERT INTO members VALUES(?,?,?)", wid, eve.id, "editor");
const space = (await one<{ id: string }>("SELECT id FROM spaces WHERE workspace_id=?", wid))!.id;
const space2 = id();
await run("INSERT INTO spaces(id,workspace_id,name,visibility,owner_id) VALUES(?,?,?,?,?)", space2, wid, "Zweiter", "team", owner.id);
// A → B → C, a database D below A, a page E elsewhere, F in the second space.
const A = await createPage(wid, space, owner.id, "A");
const B = await createPage(wid, space, owner.id, "B", "document", A);
const C = await createPage(wid, space, owner.id, "C", "document", B);
const D = await createPage(wid, space, owner.id, "D", "database", A);
const E = await createPage(wid, space, owner.id, "E");
const F = await createPage(wid, space2, owner.id, "F");
const visible = (await command(eve, { action: "row.create", pageId: D, cells: { title: "offen" } })) as { id: string };
const secret = (await command(owner, { action: "row.create", pageId: D, cells: { title: "privat" } })) as { id: string };
await run("UPDATE rows SET access='private' WHERE id=?", secret.id);
const all = [A, B, C, D, E, F];
const readable = async (user: Identity) => await filterAsync(all, async (p) => await aiMayRead(user, p));
const rule = async (user: Identity, targetId: string, mode: "include" | "exclude" | null) => await command(user, { action: "ai.rule", targetId, mode });

test("by default the AI reads what the person may read – no more", async () => {
  assert.deepEqual(await readable(eve), all);
  assert.equal(await aiMayRead(eve, D, visible.id), true);
  assert.equal(await aiMayRead(eve, D, secret.id), false, "another person's private record");
  assert.equal(await aiMayRead(owner, D, secret.id), true);
  assert.equal(await aiMayRead(eve, D, id()), false, "unknown record");
  assert.equal(await aiMayRead(eve, id()), false, "unknown page");
  const stranger = await person("Stranger");
  assert.deepEqual(await readable(stranger), [], "not a member");
});

test("rules are inherited; the closest wins", async () => {
  await rule(eve, A, "exclude");
  assert.deepEqual(await readable(eve), [E, F]);
  assert.equal(await aiMayRead(eve, D, visible.id), false, "records inherit from their database");
  await rule(eve, B, "include");
  assert.deepEqual(await readable(eve), [B, C, E, F], "the include on B is closer than the exclude on A");
  await rule(eve, space, "include");
  assert.deepEqual(await readable(eve), [B, C, E, F], "a space rule is further away than the page rule");
  await rule(eve, A, null);
  await rule(eve, B, null);
  await rule(eve, space, null);
  // Workspace exclude, page include.
  await rule(eve, wid, "exclude");
  await rule(eve, C, "include");
  assert.deepEqual(await readable(eve), [C]);
  await rule(eve, wid, null);
  await rule(eve, C, null);
  assert.deepEqual(await readable(eve), all);
});

test("scope 'selected': only what is included", async () => {
  await command(eve, { action: "ai.settings", scope: "selected" });
  assert.deepEqual(await readable(eve), []);
  await rule(eve, space2, "include");
  await rule(eve, B, "include");
  assert.deepEqual(await readable(eve), [B, C, F]);
  await rule(eve, C, "exclude");
  assert.deepEqual(await readable(eve), [B, F]);
  for (const target of [space2, B, C]) await rule(eve, target, null);
  await command(eve, { action: "ai.settings", scope: "all" });
});

test("'Für KI gesperrt' by a manager beats every personal include", async () => {
  await assert.rejects(async () => await command(eve, { action: "ai.block", targetId: A, kind: "page", blocked: true }), /Eigentümer/, "editors who do not own the space cannot");
  await command(owner, { action: "ai.block", targetId: A, kind: "page", blocked: true });
  await rule(eve, B, "include");
  await rule(eve, D, "include");
  assert.deepEqual(await readable(eve), [E, F]);
  assert.deepEqual(await readable(owner), [E, F], "for everyone, the manager too");
  assert.equal(await aiMayRead(eve, D, visible.id), false);
  await assert.rejects(async () => await requireAiRead(eve, C), /für die KI gesperrt/);
  assert.equal((await aiPageAccess(eve, C)).reason, "blocked");
  await command(owner, { action: "ai.block", targetId: A, kind: "page", blocked: false });
  await command(owner, { action: "ai.block", targetId: space2, kind: "space", blocked: true });
  assert.deepEqual(await readable(eve), all.filter((p) => p !== F));
  await command(owner, { action: "ai.block", targetId: space2, kind: "space", blocked: false });
  await rule(eve, B, null);
  await rule(eve, D, null);
});

test("journals with a PIN, trashed pages and trashed spaces are always excluded", async () => {
  const journal = await createPage(wid, space, owner.id, "Tagebuch", "journal");
  const day = await createPage(wid, space, owner.id, "Montag", "document", journal);
  const below = await createPage(wid, space, owner.id, "Notiz", "document", day);
  assert.equal(await aiMayRead(owner, below), true);
  await run("INSERT INTO journal_settings(page_id,lock_hash) VALUES(?,?)", journal, "pin-hash");
  await rule(owner, below, "include");
  assert.equal(await aiMayRead(owner, journal), false);
  assert.equal(await aiMayRead(owner, day), false);
  assert.equal(await aiMayRead(owner, below), false, "an include does not open a PIN journal");
  // Even while the journal is unlocked.
  await run("INSERT INTO journal_unlocks(user_id,page_id,until) VALUES(?,?,?)", owner.id, journal, Date.now() + 600_000);
  assert.equal(await aiMayRead(owner, day), false);
  await rule(owner, below, null);
  const trashed = await createPage(wid, space, owner.id, "Alt", "document", E);
  await run("UPDATE pages SET deleted_at=? WHERE id=?", nowText(), E);
  assert.equal(await aiMayRead(owner, E), false);
  assert.equal(await aiMayRead(owner, trashed), false, "below a trashed page");
  await run("UPDATE pages SET deleted_at=NULL WHERE id=?", E);
  await run("UPDATE spaces SET deleted_at=? WHERE id=?", nowText(), space2);
  assert.equal(await aiMayRead(owner, F), false);
  await run("UPDATE spaces SET deleted_at=NULL WHERE id=?", space2);
});

test("the batch filter agrees with single checks and keeps the order", async () => {
  await rule(eve, B, "exclude");
  const items = [
    { pageId: F },
    { pageId: C },
    { pageId: D, rowId: secret.id },
    { pageId: A },
    { pageId: D, rowId: visible.id },
    { pageId: id() },
    { pageId: B },
    { pageId: D },
  ];
  const filtered = await aiFilter(eve, items);
  assert.deepEqual(filtered, await filterAsync(items, async (i) => await aiMayRead(eve, i.pageId, i.rowId)));
  assert.deepEqual(filtered, [{ pageId: F }, { pageId: A }, { pageId: D, rowId: visible.id }, { pageId: D }]);
  assert.deepEqual([...await aiReadablePages(eve, [C, A, B])], [A]);
  await rule(eve, B, null);
});

test("aiStatus lists the pages closed to the AI", async () => {
  const admin = { ...owner, isAdmin: true };
  await command(admin, { action: "admin.ai", settings: { enabled: true, provider: { kind: "ollama", baseUrl: "http://127.0.0.1:1", model: "x", embeddingModel: "" } } });
  await rule(eve, A, "exclude");
  const status = await aiStatus(eve, wid, all.map((id) => ({ id })));
  assert.equal(status.enabled, true);
  assert.deepEqual(status.excludedPages.sort(), [A, B, C, D].sort());
  await rule(eve, A, null);
});
