// The asynchronous database layer (lib/db-driver, docs/architecture/database.md)
// and the slice ported to it (sign-up, sign-in, sessions, API tokens, tags).
// Runs on SQLite by default and on PostgreSQL with DATABASE_URL=postgres://…
// (tests/helpers/postgres-backend.ts gives each run its own schema).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes, createHash } from "node:crypto";
process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-db-driver-"));
process.env.APP_URL = "https://flowplan.example.test";
const legacy = await import("../lib/db");
const { db, uniqueViolation } = await import("../lib/db-driver");
const { afterTransaction } = await import("../lib/db-driver/context");
const { numberPlaceholders, sqliteOnly } = await import("../lib/db-driver/dialect");
const auth = await import("../lib/local-auth");
const { identityFromToken, adminGroup } = await import("../lib/auth");
const { createApiToken, identityFromApiToken, listApiTokens } = await import("../lib/api-tokens");
const { createWorkspace } = await import("../lib/seed");
const { saveInstanceSettings, instanceSettings } = await import("../lib/instance-settings");
const { listTags, saveTag, workspaceTags } = await import("../lib/page-properties-server");
const backend = db.backend;

const user = async (name: string) => {
  const uid = legacy.id();
  await db.run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, `t:${uid}`, name, `${name.toLowerCase()}@example.test`);
  return uid;
};

test(`backend: ${backend} (DATABASE_URL ${process.env.DATABASE_URL ? "set" : "absent"})`, () => {
  assert.equal(backend, process.env.DATABASE_URL?.startsWith("postgres") ? "postgres" : "sqlite");
});

test("placeholders are numbered outside strings, identifiers and comments", () => {
  assert.equal(numberPlaceholders("SELECT ? , '?' , \"a?\" -- ?\n, ? /* ? */ , ?"), "SELECT $1 , '?' , \"a?\" -- ?\n, $2 /* ? */ , $3");
  assert.equal(numberPlaceholders("SELECT 'it''s ?', ?"), "SELECT 'it''s ?', $1");
  assert.match(sqliteOnly("INSERT OR IGNORE INTO t VALUES(?)") || "", /insertIgnore/);
  assert.equal(sqliteOnly("INSERT INTO meta VALUES('sqlite_master COLLATE NOCASE')"), null, "strings do not count");
});

// First: the instance has no account yet (the others below create some).
test("slice: sign-up, sign-in and the session behind a cookie", async () => {
  const { user: ana, groups } = await auth.register({ name: "Ana", email: "Ana@Example.test", password: "ein-langes-passwort" }, "en");
  assert.deepEqual(groups, [adminGroup()], "the first account administers the instance");
  await saveInstanceSettings({ ...(await instanceSettings()), allowSignup: true });
  await assert.rejects(auth.register({ name: "Ana 2", email: "ANA@example.test", password: "ein-langes-passwort" }, "en"), /already is an account|schon ein Konto/);
  const login = await auth.passwordLogin({ email: "aNa@example.TEST", password: "ein-langes-passwort" }, "198.51.100.1", "en");
  assert.equal(login.userId, ana.id, "the address ignores case on both backends");
  await assert.rejects(auth.passwordLogin({ email: "ana@example.test", password: "falsch-falsch-falsch" }, "198.51.100.1", "en"), /wrong|stimmt nicht/);
  const token = randomBytes(16).toString("hex");
  await db.run(
    "INSERT INTO sessions(token,user_id,groups_json,expires,created_at) VALUES(?,?,?,?,?)",
    createHash("sha256").update(token).digest("hex"),
    ana.id,
    JSON.stringify(login.groups),
    Date.now() + 3600_000,
    Date.now(),
  );
  const me = await identityFromToken(token);
  assert.equal(me?.id, ana.id);
  assert.equal(me?.isAdmin, true);
  assert.equal(await identityFromToken("unknown"), null);
});

test("one, all, run and the dialect's case-insensitive comparison", async () => {
  const uid = await user("Dora");
  const row = await db.one<{ name: string; disabled: number }>("SELECT name,disabled FROM users WHERE id=?", uid);
  assert.deepEqual({ ...row }, { name: "Dora", disabled: 0 });
  assert.equal(typeof (await db.one<{ n: number }>("SELECT COUNT(*) n FROM users"))!.n, "number", "COUNT(*) is a number on both");
  assert.equal((await db.one<{ e: number }>("SELECT EXISTS(SELECT 1 FROM users WHERE id=?) e", uid))!.e, 1, "booleans come back as 1/0");
  assert.equal((await db.all(`SELECT id FROM users WHERE ${db.dialect.ieq("name")}`, "DORA")).length, 1);
  assert.equal((await db.run("UPDATE users SET name=? WHERE id=?", "Dora B.", uid)).changes, 1);
  assert.equal((await db.run("UPDATE users SET name=? WHERE id=?", "x", "none")).changes, 0);
  assert.ok(!("rowid" in (await db.one<object>("SELECT * FROM users WHERE id=?", uid))!), "no emulated rowid in SELECT *");
  assert.ok((await db.columns("users")).includes("email_verified"));
});

test("transactions: commit, rollback, savepoints, helpers inside use the same transaction", async () => {
  const a = legacy.id();
  const insert = (id: string) => db.run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", id, `t:${id}`, "T", "t@example.test");
  // A helper that knows nothing of the transaction sees its rows.
  const exists = async (id: string) => !!(await db.one("SELECT 1 FROM users WHERE id=?", id));
  await db.tx(async () => {
    await insert(a);
    assert.equal(db.inTransaction(), true);
    assert.equal(await exists(a), true);
  });
  assert.equal(await exists(a), true);
  const b = legacy.id();
  await assert.rejects(
    db.tx(async () => {
      await insert(b);
      throw new Error("nope");
    }),
    /nope/,
  );
  assert.equal(await exists(b), false, "rolled back");
  const c = legacy.id(),
    d = legacy.id();
  await db.tx(async () => {
    await insert(c);
    await assert.rejects(
      db.tx(async () => {
        await insert(d);
        await insert(d); // primary key
      }),
      (e: unknown) => uniqueViolation(e),
    );
    // On Postgres the failed statement only spoiled the savepoint.
    assert.equal(await exists(c), true);
    assert.equal(await exists(d), false);
  });
  assert.equal(await exists(c), true);
  assert.equal(db.inTransaction(), false);
});

test("afterTransaction runs once the transaction has ended, outside it", async () => {
  const seen: string[] = [];
  await assert.rejects(
    db.tx(async () => {
      afterTransaction(() => seen.push(`after rollback, inside: ${db.inTransaction()}`));
      queueMicrotask(() => afterTransaction(() => seen.push("microtask")));
      await Promise.resolve();
      seen.push("body");
      throw new Error("x");
    }),
  );
  assert.deepEqual(seen, ["body", "after rollback, inside: false", "microtask"]);
});

test("a lock serialises transactions with the same key", async () => {
  const order: string[] = [];
  const work = (name: string) =>
    db.tx(
      async () => {
        order.push(`${name}:start`);
        await db.one("SELECT 1");
        await new Promise((r) => setTimeout(r, 30));
        order.push(`${name}:end`);
      },
      { lock: "test-lock" },
    );
  await Promise.all([work("a"), work("b")]);
  assert.deepEqual(order.slice(0, 2).map((s) => s.split(":")[1]), ["start", "end"], "no interleaving");
});

test("calls from elsewhere wait while a transaction is open; the helpers of lib/db.ts take part in it", async () => {
  const uid = await user("Sync");
  let release!: () => void;
  const open = db.tx(async () => {
    await db.run("UPDATE users SET name=? WHERE id=?", "Inside", uid);
    await new Promise<void>((r) => (release = r));
  });
  await new Promise((r) => setTimeout(r, 20));
  // SQLite: the one connection is held, the read waits for the commit;
  // Postgres: READ COMMITTED, the read sees what was committed before.
  let read: string | undefined;
  const outside = legacy.one<{ name: string }>("SELECT name FROM users WHERE id=?", uid).then((r) => (read = r?.name));
  await new Promise((r) => setTimeout(r, 20));
  if (backend === "sqlite") {
    assert.equal(read, undefined, "waits for the transaction");
    // The synchronous SQLite statements (the driver's own) are refused from outside.
    assert.throws(() => legacy.sqliteRun("UPDATE users SET name=? WHERE id=?", "Outside", uid), /asynchronous transaction/);
  } else assert.equal(read, "Sync");
  release();
  await open;
  await outside;
  if (backend === "sqlite") assert.equal(read, "Inside");
  assert.equal((await db.one<{ name: string }>("SELECT name FROM users WHERE id=?", uid))!.name, "Inside");
  // Inside, the helpers of lib/db.ts use the transaction (a nested
  // transaction() is a savepoint) and a rollback takes their writes along.
  await assert.rejects(
    db.tx(async () => {
      await legacy.run("UPDATE users SET name=? WHERE id=?", "Rolled back", uid);
      await legacy.transaction(async () => legacy.run("UPDATE users SET email=? WHERE id=?", "x@example.test", uid));
      assert.equal((await legacy.one<{ name: string }>("SELECT name FROM users WHERE id=?", uid))!.name, "Rolled back");
      throw new Error("undo");
    }),
    /undo/,
  );
  assert.equal((await db.one<{ name: string }>("SELECT name FROM users WHERE id=?", uid))!.name, "Inside");
});

test("slice: API tokens", async () => {
  const uid = await user("Toni");
  const owner = await identityFromToken("none") ?? { id: uid, name: "Toni", email: "toni@example.test", disabled: 0, created_at: "", groups: [], isAdmin: false };
  const { token } = await createApiToken(owner, { name: "Skript", scope: "write" });
  const viaToken = await identityFromApiToken(`Bearer ${token}`);
  assert.equal(viaToken?.id, uid);
  assert.equal(viaToken?.apiScope, "write");
  assert.equal((await listApiTokens(owner)).length, 1);
  assert.equal(await identityFromApiToken("Bearer fp_unknownunknownunknownunknown"), null);
});

test("slice: tag list and tag.save", async () => {
  const uid = await user("Olga");
  const owner = { id: uid, name: "Olga", email: "olga@example.test", disabled: 0, created_at: "", groups: [], isAdmin: false };
  const wid = await createWorkspace(uid, "Team");
  const kunde = (await saveTag(owner, { workspaceId: wid, name: "Kunde" })).id;
  await saveTag(owner, { workspaceId: wid, name: "angebot", color: "red" });
  await assert.rejects(saveTag(owner, { workspaceId: wid, name: "KUNDE" }), (e: { status?: number }) => e.status === 409);
  assert.deepEqual(
    (await listTags(wid)).map((t) => [t.name, t.color]),
    [
      ["Kunde", (await listTags(wid))[0].color],
      ["angebot", "red"],
    ],
  );
  await saveTag(owner, { workspaceId: wid, tagId: kunde, name: "Kunden", color: "purple" });
  assert.deepEqual((await listTags(wid, null)).map((t) => t.name), ["Kunden", "angebot"]);
  // The synchronous list reads the same rows (SQLite directly, Postgres through the bridge).
  assert.deepEqual((await workspaceTags(wid)).map((t) => t.name), ["Kunden", "angebot"]);
  const audit = await db.all<{ action: string }>("SELECT action FROM audit WHERE actor_id=? ORDER BY created_at", uid);
  assert.deepEqual(audit.map((a) => a.action).filter((a) => a.startsWith("tag.")).sort(), ["tag.create", "tag.create", "tag.save"]);
});

test("the Postgres schema file matches the SQLite schema of this version", { skip: backend !== "sqlite" }, async () => {
  const { readFileSync } = await import("node:fs");
  const { translateSqliteSchema } = await import("../lib/db-driver/pg-schema");
  const committed = JSON.parse(readFileSync(new URL("../lib/db-driver/postgres-schema.json", import.meta.url), "utf8"));
  // The seed rows are those of an empty database; this one has test data.
  const { seed: _live, ...live } = translateSqliteSchema(legacy.db());
  const { seed: _file, ...file } = committed;
  assert.deepEqual(live, file, "run: node --import tsx scripts/db-pg-schema.mjs");
});

test("a SQLite database at main's schema 93 (files in the trash, no seq) upgrades to the current one",{ skip: backend !== "sqlite" }, async () => {
  const { DatabaseSync } = await import("node:sqlite");
  const file = join(mkdtempSync(join(tmpdir(), "flowplan-schema93-")), "old.sqlite");
  legacy.db().exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`); // sqlite-only
  // Back to main's 93: without the insertion order of #127 (seq columns, their triggers).
  const old = new DatabaseSync(file);
  for (const table of [...legacy.SEQ_TABLES, "pages"]) {
    old.exec(`DROP TRIGGER IF EXISTS ${table}_seq`);
    if (table === "pages") old.exec("DROP TRIGGER IF EXISTS pages_created_at");
    old.exec(`ALTER TABLE ${table} DROP COLUMN seq`);
  }
  old.exec("CREATE TRIGGER pages_created_at AFTER INSERT ON pages WHEN NEW.created_at IS NULL BEGIN UPDATE pages SET created_at=CURRENT_TIMESTAMP WHERE rowid=NEW.rowid; END");
  old.exec("INSERT INTO spaces(id,name) VALUES('s93','Alt')");
  old.exec("PRAGMA user_version=93");
  legacy.migrateFile(old);
  const version = (old.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
  assert.equal(version, legacy.SCHEMA_VERSION);
  assert.equal(legacy.SCHEMA_VERSION, 100);
  for (const table of [...legacy.SEQ_TABLES, "pages"])
    assert.ok((old.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).some((c) => c.name === "seq"), table);
  // Existing rows get their order, new ones one from the trigger.
  assert.ok((old.prepare("SELECT seq FROM spaces WHERE id='s93'").get() as { seq: number }).seq > 0);
  old.exec("INSERT INTO spaces(id,name) VALUES('s94','Neu')");
  const [a, b] = ["s93", "s94"].map((sid) => (old.prepare("SELECT seq FROM spaces WHERE id=?").get(sid) as { seq: number }).seq);
  assert.ok(b > a);
  // #164's columns are kept.
  assert.ok((old.prepare("PRAGMA table_info(files)").all() as { name: string }[]).some((c) => c.name === "deleted_at"));
  old.close();
});

test("schema 95: issue connections allow Forgejo/Gitea, mappings survive the copy", { skip: backend !== "sqlite" }, async () => {
  const { DatabaseSync } = await import("node:sqlite");
  const file = join(mkdtempSync(join(tmpdir(), "flowplan-schema94-")), "old.sqlite");
  legacy.db().exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`); // sqlite-only
  const old = new DatabaseSync(file);
  old.exec("PRAGMA foreign_keys=ON");
  // Back to 94: the CHECK without 'forgejo'.
  old.exec(`DROP TABLE issue_sync_maps; DROP TABLE issue_connections;
    CREATE TABLE issue_connections(id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,provider TEXT NOT NULL CHECK(provider IN ('github','gitlab')),base_url TEXT NOT NULL DEFAULT '',repo TEXT NOT NULL DEFAULT '',token TEXT NOT NULL,hook_token TEXT NOT NULL UNIQUE,hook_secret TEXT NOT NULL,people TEXT NOT NULL DEFAULT '[]',state TEXT NOT NULL DEFAULT '{}',created_by TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,created_at INTEGER NOT NULL);
    CREATE INDEX issue_connections_workspace ON issue_connections(workspace_id);
    CREATE TABLE issue_sync_maps(page_id TEXT PRIMARY KEY REFERENCES pages(id) ON DELETE CASCADE,connection_id TEXT NOT NULL REFERENCES issue_connections(id) ON DELETE CASCADE,repo TEXT NOT NULL,config TEXT NOT NULL,state TEXT NOT NULL DEFAULT '{}',created_by TEXT,created_at INTEGER NOT NULL);
    CREATE INDEX issue_sync_maps_connection ON issue_sync_maps(connection_id);`);
  const uid = legacy.id(),
    wid = legacy.id(),
    pid = legacy.id();
  old.prepare("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)").run(uid, uid, "Old", "old@test.invalid");
  old.prepare("INSERT INTO workspaces(id,name) VALUES(?,?)").run(wid, "Old");
  old.prepare("INSERT INTO pages(id,workspace_id,title,kind) VALUES(?,?,?,?)").run(pid, wid, "Issues", "database");
  old.prepare("INSERT INTO issue_connections(id,workspace_id,provider,repo,token,hook_token,hook_secret,created_by,created_at) VALUES('c1',?,'github','a/b','t','h1','s',?,1)").run(wid, uid);
  old.prepare("INSERT INTO issue_sync_maps(page_id,connection_id,repo,config,created_at) VALUES(?,'c1','a/b','{}',7)").run(pid);
  const insert = (cid: string, provider: string) =>
    old
      .prepare("INSERT INTO issue_connections(id,workspace_id,provider,base_url,token,hook_token,hook_secret,created_by,created_at) VALUES(?,?,?,'https://codeberg.org','t',?,'s',?,1)")
      .run(cid, wid, provider, `hook-${cid}`, uid);
  assert.throws(() => insert("c2", "forgejo"), /CHECK/);
  old.exec("PRAGMA user_version=94");
  legacy.migrateFile(old);
  assert.equal((old.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, legacy.SCHEMA_VERSION);
  assert.deepEqual({ ...(old.prepare("SELECT page_id,connection_id,created_at FROM issue_sync_maps").get() as object) }, { page_id: pid, connection_id: "c1", created_at: 7 });
  insert("c2", "forgejo");
  assert.throws(() => insert("c3", "bitbucket"), /CHECK/);
  assert.ok(old.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name='issue_connections_workspace'").get());
  // The mapping still follows its connection.
  old.exec("DELETE FROM issue_connections WHERE id='c1'");
  assert.equal((old.prepare("SELECT COUNT(*) n FROM issue_sync_maps").get() as { n: number }).n, 0);
  old.close();
});

test("schema 95 on PostgreSQL: the data step widens the CHECK of an existing table", { skip: backend !== "postgres" }, async () => {
  const { runDataSteps, ISSUE_PROVIDERS_STEP } = await import("../lib/data-steps");
  const uid = await user("Forge");
  const wid = await createWorkspace(uid, "Forge");
  const insert = (cid: string, provider: string) =>
    db.run(
      "INSERT INTO issue_connections(id,workspace_id,provider,base_url,token,hook_token,hook_secret,created_by,created_at) VALUES(?,?,?,'https://codeberg.org','t',?,'s',?,1)",
      cid,
      wid,
      provider,
      `hook-${cid}`,
      uid,
    );
  // As a schema of 94 has it (the translated schema never replaces a CHECK).
  await db.run("ALTER TABLE issue_connections DROP CONSTRAINT IF EXISTS issue_connections_provider_check");
  await db.run("ALTER TABLE issue_connections ADD CONSTRAINT issue_connections_provider_check CHECK(provider IN ('github','gitlab'))");
  await assert.rejects(db.tx(async () => await insert("fj1", "forgejo")), /check constraint/);
  await db.run("DELETE FROM data_migrations WHERE name=?", ISSUE_PROVIDERS_STEP);
  await runDataSteps([ISSUE_PROVIDERS_STEP]);
  assert.ok(await db.one("SELECT 1 FROM data_migrations WHERE name=?", ISSUE_PROVIDERS_STEP));
  await insert("fj1", "forgejo");
  await assert.rejects(db.tx(async () => await insert("bb1", "bitbucket")), /check constraint/);
  await db.run("DELETE FROM issue_connections WHERE id='fj1'");
});

test("schema 96: the status log gets who completed, the view choices “Nur meine”; old entries stay NULL", { skip: backend !== "sqlite" }, async () => {
  const { DatabaseSync } = await import("node:sqlite");
  const file = join(mkdtempSync(join(tmpdir(), "flowplan-schema95-")), "old.sqlite");
  legacy.db().exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`); // sqlite-only
  const old = new DatabaseSync(file);
  // Back to 95: neither column.
  old.exec("ALTER TABLE row_status_log DROP COLUMN user_id; ALTER TABLE page_view_prefs DROP COLUMN completed_mine;");
  const uid = legacy.id(),
    wid = legacy.id(),
    pid = legacy.id();
  old.prepare("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)").run(uid, uid, "Old", "old@test.invalid");
  old.prepare("INSERT INTO workspaces(id,name) VALUES(?,?)").run(wid, "Old");
  old.prepare("INSERT INTO pages(id,workspace_id,title,kind) VALUES(?,?,?,?)").run(pid, wid, "Aufgaben", "database");
  old.prepare("INSERT INTO row_status_log(id,page_id,row_id,done,at) VALUES('l95',?,'r1',1,7)").run(pid);
  old.prepare("INSERT INTO page_view_prefs(user_id,page_id,properties_collapsed,updated_at) VALUES(?,?,1,7)").run(uid, pid);
  old.exec("PRAGMA user_version=95");
  legacy.migrateFile(old);
  assert.equal((old.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, legacy.SCHEMA_VERSION);
  assert.deepEqual({ ...(old.prepare("SELECT row_id,done,at,user_id FROM row_status_log WHERE id='l95'").get() as object) }, { row_id: "r1", done: 1, at: 7, user_id: null });
  assert.deepEqual({ ...(old.prepare("SELECT properties_collapsed,completed_mine FROM page_view_prefs").get() as object) }, { properties_collapsed: 1, completed_mine: null });
  // Run again: nothing changes.
  legacy.migrateFile(old);
  assert.equal((old.prepare("PRAGMA table_info(row_status_log)").all() as { name: string }[]).filter((c) => c.name === "user_id").length, 1);
  old.close();
});

test("schema 96 on PostgreSQL: an existing database gets the new columns, old entries stay NULL", { skip: backend !== "postgres" }, async () => {
  const { ensureCurrentPostgresSchema } = await import("../lib/db-driver/pg-current");
  const uid = await user("Status");
  const wid = await createWorkspace(uid, "Status");
  const pid = legacy.id();
  await db.run("INSERT INTO pages(id,workspace_id,title,kind) VALUES(?,?,?,?)", pid, wid, "Aufgaben", "database");
  // As a database of 95 has it.
  await db.run("ALTER TABLE row_status_log DROP COLUMN user_id");
  await db.run("ALTER TABLE page_view_prefs DROP COLUMN completed_mine");
  await db.run("INSERT INTO row_status_log(id,page_id,row_id,done,at) VALUES('l95',?,'r1',1,7)", pid);
  await db.run("UPDATE flowplan_meta SET value='95' WHERE key='sqlite_schema'");
  const result = await ensureCurrentPostgresSchema(db);
  assert.deepEqual({ from: result?.from, to: result?.to, applied: result?.applied }, { from: 95, to: legacy.SCHEMA_VERSION, applied: true });
  assert.deepEqual(await db.one("SELECT row_id,user_id FROM row_status_log WHERE id='l95'"), { row_id: "r1", user_id: null });
  await db.run("INSERT INTO row_status_log(id,page_id,row_id,done,at,user_id) VALUES('l96',?,'r1',0,8,?)", pid, uid);
  assert.equal((await db.one<{ user_id: string }>("SELECT user_id FROM row_status_log WHERE id='l96'"))!.user_id, uid);
  await db.run("INSERT INTO page_view_prefs(user_id,page_id,completed_mine,updated_at) VALUES(?,?,0,8)", uid, pid);
  assert.equal(Number((await db.one<{ completed_mine: number }>("SELECT completed_mine FROM page_view_prefs WHERE user_id=?", uid))!.completed_mine), 0);
  await db.run("DELETE FROM row_status_log WHERE page_id=?", pid);
});

test("schema 99: the record properties' choices per device; existing view choices stay", { skip: backend !== "sqlite" }, async () => {
  const { DatabaseSync } = await import("node:sqlite");
  const file = join(mkdtempSync(join(tmpdir(), "flowplan-schema98-")), "old.sqlite");
  legacy.db().exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`); // sqlite-only
  const old = new DatabaseSync(file);
  old.exec("ALTER TABLE page_view_prefs DROP COLUMN record_properties_phone; ALTER TABLE page_view_prefs DROP COLUMN record_properties_desktop;");
  const uid = legacy.id(),
    wid = legacy.id(),
    pid = legacy.id();
  old.prepare("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)").run(uid, uid, "Old", "old98@test.invalid");
  old.prepare("INSERT INTO workspaces(id,name) VALUES(?,?)").run(wid, "Old");
  old.prepare("INSERT INTO pages(id,workspace_id,title,kind) VALUES(?,?,?,?)").run(pid, wid, "Aufgaben", "database");
  old.prepare("INSERT INTO page_view_prefs(user_id,page_id,properties_collapsed,updated_at) VALUES(?,?,1,7)").run(uid, pid);
  old.exec("PRAGMA user_version=98");
  legacy.migrateFile(old);
  assert.equal((old.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, legacy.SCHEMA_VERSION);
  assert.deepEqual(
    { ...(old.prepare("SELECT properties_collapsed,record_properties_phone,record_properties_desktop FROM page_view_prefs WHERE user_id=?").get(uid) as object) },
    { properties_collapsed: 1, record_properties_phone: null, record_properties_desktop: null },
  );
  legacy.migrateFile(old);
  assert.equal((old.prepare("PRAGMA table_info(page_view_prefs)").all() as { name: string }[]).filter((c) => c.name.startsWith("record_properties_")).length, 2);
  old.close();
});

test("schema 99 on PostgreSQL: an existing database gets the new columns", { skip: backend !== "postgres" }, async () => {
  const { ensureCurrentPostgresSchema } = await import("../lib/db-driver/pg-current");
  const uid = await user("Fold");
  const wid = await createWorkspace(uid, "Fold");
  const pid = legacy.id();
  await db.run("INSERT INTO pages(id,workspace_id,title,kind) VALUES(?,?,?,?)", pid, wid, "Aufgaben", "database");
  await db.run("ALTER TABLE page_view_prefs DROP COLUMN record_properties_phone");
  await db.run("ALTER TABLE page_view_prefs DROP COLUMN record_properties_desktop");
  await db.run("INSERT INTO page_view_prefs(user_id,page_id,properties_collapsed,updated_at) VALUES(?,?,1,7)", uid, pid);
  await db.run("UPDATE flowplan_meta SET value='98' WHERE key='sqlite_schema'");
  const result = await ensureCurrentPostgresSchema(db);
  assert.deepEqual({ from: result?.from, to: result?.to, applied: result?.applied }, { from: 98, to: legacy.SCHEMA_VERSION, applied: true });
  assert.deepEqual(
    await db.one("SELECT record_properties_phone,record_properties_desktop FROM page_view_prefs WHERE user_id=?", uid),
    { record_properties_phone: null, record_properties_desktop: null },
  );
  await db.run("UPDATE page_view_prefs SET record_properties_phone=1 WHERE user_id=?", uid);
  assert.equal(Number((await db.one<{ record_properties_phone: number }>("SELECT record_properties_phone FROM page_view_prefs WHERE user_id=?", uid))!.record_properties_phone), 1);
});
