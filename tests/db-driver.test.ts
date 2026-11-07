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
  saveInstanceSettings({ ...instanceSettings(), allowSignup: true });
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

test("synchronous writes from elsewhere are refused while an async transaction is open", async () => {
  const uid = await user("Sync");
  let release!: () => void;
  const open = db.tx(async () => {
    await db.run("UPDATE users SET name=? WHERE id=?", "Inside", uid);
    await new Promise<void>((r) => (release = r));
  });
  await new Promise((r) => setTimeout(r, 20));
  // Reads are fine (SQLite: the open transaction's data; Postgres: committed data).
  assert.ok(legacy.one("SELECT 1 FROM users WHERE id=?", uid));
  if (backend === "sqlite") assert.throws(() => legacy.run("UPDATE users SET name=? WHERE id=?", "Outside", uid), /asynchronous transaction/);
  release();
  await open;
  assert.equal((await db.one<{ name: string }>("SELECT name FROM users WHERE id=?", uid))!.name, "Inside");
  // Inside the transaction, synchronous helpers share it on SQLite and may
  // only read on Postgres (their bridge has a connection of its own).
  await db.tx(async () => {
    if (backend === "sqlite") legacy.run("UPDATE users SET name=? WHERE id=?", "Sync inside", uid);
    else assert.throws(() => legacy.run("UPDATE users SET name=? WHERE id=?", "Sync inside", uid), /inside an asynchronous Postgres transaction/);
  });
});

test("slice: API tokens", async () => {
  const uid = await user("Toni");
  const owner = (await identityFromToken("none")) ?? { id: uid, name: "Toni", email: "toni@example.test", disabled: 0, created_at: "", groups: [], isAdmin: false };
  const { token } = createApiToken(owner, { name: "Skript", scope: "write" });
  const viaToken = await identityFromApiToken(`Bearer ${token}`);
  assert.equal(viaToken?.id, uid);
  assert.equal(viaToken?.apiScope, "write");
  assert.equal((await listApiTokens(owner)).length, 1);
  assert.equal(await identityFromApiToken("Bearer fp_unknownunknownunknownunknown"), null);
});

test("slice: tag list and tag.save", async () => {
  const uid = await user("Olga");
  const owner = { id: uid, name: "Olga", email: "olga@example.test", disabled: 0, created_at: "", groups: [], isAdmin: false };
  const wid = createWorkspace(uid, "Team");
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
  assert.deepEqual(workspaceTags(wid).map((t) => t.name), ["Kunden", "angebot"]);
  const audit = await db.all<{ action: string }>("SELECT action FROM audit WHERE actor_id=? ORDER BY created_at", uid);
  assert.deepEqual(audit.map((a) => a.action).filter((a) => a.startsWith("tag.")).sort(), ["tag.create", "tag.create", "tag.save"]);
});

test("the Postgres schema file matches the SQLite schema of this version", { skip: backend !== "sqlite" }, async () => {
  const { readFileSync } = await import("node:fs");
  const { translateSqliteSchema } = await import("../lib/db-driver/pg-schema");
  const committed = JSON.parse(readFileSync(new URL("../lib/db-driver/postgres-schema.json", import.meta.url), "utf8"));
  assert.deepEqual(translateSqliteSchema(legacy.db()), committed, "run: node --import tsx scripts/db-pg-schema.mjs");
});
