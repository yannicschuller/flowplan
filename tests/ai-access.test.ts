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

function person(name: string): Identity {
  const uid = id();
  run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, name, `${name.toLowerCase()}@example.test`);
  const token = randomBytes(16).toString("hex");
  run("INSERT INTO sessions(token,user_id,groups_json,expires) VALUES(?,?,?,?)", createHash("sha256").update(token).digest("hex"), uid, "[]", Date.now() + 3600_000);
  return identityFromToken(token)!;
}
const owner = person("Olga"),
  eve = person("Eve");
const wid = createWorkspace(owner.id, "Team");
run("INSERT INTO members VALUES(?,?,?)", wid, eve.id, "editor");
const space = one<{ id: string }>("SELECT id FROM spaces WHERE workspace_id=?", wid)!.id;
const space2 = id();
run("INSERT INTO spaces(id,workspace_id,name,visibility,owner_id) VALUES(?,?,?,?,?)", space2, wid, "Zweiter", "team", owner.id);
// A → B → C, a database D below A, a page E elsewhere, F in the second space.
const A = createPage(wid, space, owner.id, "A");
const B = createPage(wid, space, owner.id, "B", "document", A);
const C = createPage(wid, space, owner.id, "C", "document", B);
const D = createPage(wid, space, owner.id, "D", "database", A);
const E = createPage(wid, space, owner.id, "E");
const F = createPage(wid, space2, owner.id, "F");
const visible = command(eve, { action: "row.create", pageId: D, cells: { title: "offen" } }) as { id: string };
const secret = command(owner, { action: "row.create", pageId: D, cells: { title: "privat" } }) as { id: string };
run("UPDATE rows SET access='private' WHERE id=?", secret.id);
const all = [A, B, C, D, E, F];
const readable = (user: Identity) => all.filter((p) => aiMayRead(user, p));
const rule = (user: Identity, targetId: string, mode: "include" | "exclude" | null) => command(user, { action: "ai.rule", targetId, mode });

test("by default the AI reads what the person may read – no more", () => {
  assert.deepEqual(readable(eve), all);
  assert.equal(aiMayRead(eve, D, visible.id), true);
  assert.equal(aiMayRead(eve, D, secret.id), false, "another person's private record");
  assert.equal(aiMayRead(owner, D, secret.id), true);
  assert.equal(aiMayRead(eve, D, id()), false, "unknown record");
  assert.equal(aiMayRead(eve, id()), false, "unknown page");
  const stranger = person("Stranger");
  assert.deepEqual(readable(stranger), [], "not a member");
});

test("rules are inherited; the closest wins", () => {
  rule(eve, A, "exclude");
  assert.deepEqual(readable(eve), [E, F]);
  assert.equal(aiMayRead(eve, D, visible.id), false, "records inherit from their database");
  rule(eve, B, "include");
  assert.deepEqual(readable(eve), [B, C, E, F], "the include on B is closer than the exclude on A");
  rule(eve, space, "include");
  assert.deepEqual(readable(eve), [B, C, E, F], "a space rule is further away than the page rule");
  rule(eve, A, null);
  rule(eve, B, null);
  rule(eve, space, null);
  // Workspace exclude, page include.
  rule(eve, wid, "exclude");
  rule(eve, C, "include");
  assert.deepEqual(readable(eve), [C]);
  rule(eve, wid, null);
  rule(eve, C, null);
  assert.deepEqual(readable(eve), all);
});

test("scope 'selected': only what is included", () => {
  command(eve, { action: "ai.settings", scope: "selected" });
  assert.deepEqual(readable(eve), []);
  rule(eve, space2, "include");
  rule(eve, B, "include");
  assert.deepEqual(readable(eve), [B, C, F]);
  rule(eve, C, "exclude");
  assert.deepEqual(readable(eve), [B, F]);
  for (const target of [space2, B, C]) rule(eve, target, null);
  command(eve, { action: "ai.settings", scope: "all" });
});

test("'Für KI gesperrt' by a manager beats every personal include", () => {
  assert.throws(() => command(eve, { action: "ai.block", targetId: A, kind: "page", blocked: true }), /Eigentümer/, "editors who do not own the space cannot");
  command(owner, { action: "ai.block", targetId: A, kind: "page", blocked: true });
  rule(eve, B, "include");
  rule(eve, D, "include");
  assert.deepEqual(readable(eve), [E, F]);
  assert.deepEqual(readable(owner), [E, F], "for everyone, the manager too");
  assert.equal(aiMayRead(eve, D, visible.id), false);
  assert.throws(() => requireAiRead(eve, C), /für die KI gesperrt/);
  assert.equal(aiPageAccess(eve, C).reason, "blocked");
  command(owner, { action: "ai.block", targetId: A, kind: "page", blocked: false });
  command(owner, { action: "ai.block", targetId: space2, kind: "space", blocked: true });
  assert.deepEqual(readable(eve), all.filter((p) => p !== F));
  command(owner, { action: "ai.block", targetId: space2, kind: "space", blocked: false });
  rule(eve, B, null);
  rule(eve, D, null);
});

test("journals with a PIN, trashed pages and trashed spaces are always excluded", () => {
  const journal = createPage(wid, space, owner.id, "Tagebuch", "journal");
  const day = createPage(wid, space, owner.id, "Montag", "document", journal);
  const below = createPage(wid, space, owner.id, "Notiz", "document", day);
  assert.equal(aiMayRead(owner, below), true);
  run("INSERT INTO journal_settings(page_id,lock_hash) VALUES(?,?)", journal, "pin-hash");
  rule(owner, below, "include");
  assert.equal(aiMayRead(owner, journal), false);
  assert.equal(aiMayRead(owner, day), false);
  assert.equal(aiMayRead(owner, below), false, "an include does not open a PIN journal");
  // Even while the journal is unlocked.
  run("INSERT INTO journal_unlocks(user_id,page_id,until) VALUES(?,?,?)", owner.id, journal, Date.now() + 600_000);
  assert.equal(aiMayRead(owner, day), false);
  rule(owner, below, null);
  const trashed = createPage(wid, space, owner.id, "Alt", "document", E);
  run("UPDATE pages SET deleted_at=CURRENT_TIMESTAMP WHERE id=?", E);
  assert.equal(aiMayRead(owner, E), false);
  assert.equal(aiMayRead(owner, trashed), false, "below a trashed page");
  run("UPDATE pages SET deleted_at=NULL WHERE id=?", E);
  run("UPDATE spaces SET deleted_at=CURRENT_TIMESTAMP WHERE id=?", space2);
  assert.equal(aiMayRead(owner, F), false);
  run("UPDATE spaces SET deleted_at=NULL WHERE id=?", space2);
});

test("the batch filter agrees with single checks and keeps the order", () => {
  rule(eve, B, "exclude");
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
  const filtered = aiFilter(eve, items);
  assert.deepEqual(filtered, items.filter((i) => aiMayRead(eve, i.pageId, i.rowId)));
  assert.deepEqual(filtered, [{ pageId: F }, { pageId: A }, { pageId: D, rowId: visible.id }, { pageId: D }]);
  assert.deepEqual([...aiReadablePages(eve, [C, A, B])], [A]);
  rule(eve, B, null);
});

test("aiStatus lists the pages closed to the AI", () => {
  const admin = { ...owner, isAdmin: true };
  command(admin, { action: "admin.ai", settings: { enabled: true, provider: { kind: "ollama", baseUrl: "http://127.0.0.1:1", model: "x", embeddingModel: "" } } });
  rule(eve, A, "exclude");
  const status = aiStatus(eve, wid, all.map((id) => ({ id })));
  assert.equal(status.enabled, true);
  assert.deepEqual(status.excludedPages.sort(), [A, B, C, D].sort());
  rule(eve, A, null);
});
