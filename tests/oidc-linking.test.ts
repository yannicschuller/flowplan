// Linking local accounts and SSO identities, and merging duplicates (#101).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { randomBytes } from "node:crypto";
import type { Identity } from "../lib/types";
process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-oidc-linking-"));
process.env.APP_URL = "https://flowplan.example.test";
delete process.env.SMTP_HOST;
delete process.env.OIDC_LINKED_SSO_ONLY;
delete process.env.OIDC_NEW_ACCOUNTS;
const { one, all, run, id, migrateIdentities } = await import("../lib/db");
const { runDataSteps, IDENTITIES_STEP } = await import("../lib/data-steps");
const { sqliteOnly } = await import("./helpers/backend");
const auth = await import("../lib/local-auth");
const { hash, adminGroup } = await import("../lib/auth");
const ids = await import("../lib/identities");
const link = await import("../lib/oidc-link");
const step = await import("../lib/step-up");
const merge = await import("../lib/account-merge");
const tf = await import("../lib/two-factor");
const totp = await import("../lib/totp");
const { confirmsWithPassword } = await import("../lib/account-deletion");
const { saveInstanceSettings } = await import("../lib/instance-settings");
const { createWorkspace } = await import("../lib/seed");
const { command } = await import("../lib/api");
const { createApiToken } = await import("../lib/api-tokens");

await saveInstanceSettings({ allowSignup: true });
const ISSUER = "https://idp.example.test/realms/flowplan";
const tick = () => new Promise((resolve) => setTimeout(resolve, 5));
let n = 0;
async function localAccount(name = `person${++n}`) {
  const { user } = await auth.register({ name, email: `${name}@example.test`, password: `${name}-passwort-123` }, "de");
  return user;
}
const sso = (subject: string, email: string, emailVerified = true): import("../lib/oidc-link").OidcProfile => ({
  issuer: ISSUER,
  subject,
  email,
  emailVerified,
  name: `SSO ${subject}`,
  groups: [],
});
async function session(userId: string, createdAt = Date.now()) {
  const token = randomBytes(24).toString("base64url");
  await run("INSERT INTO sessions(token,user_id,groups_json,expires,created_at) VALUES(?,?,?,?,?)", hash(token), userId, "[]", Date.now() + 3600_000, createdAt);
  return token;
}
const admin = async (userId: string): Promise<Identity> => {
  const u = (await one<{ name: string; email: string }>("SELECT name,email FROM users WHERE id=?", userId))!;
  return { id: userId, name: u.name, email: u.email, groups: [adminGroup()], isAdmin: true, disabled: 0, created_at: "" };
};
const events = async (kind: string) => await all<{ actor_id: string; detail: string }>("SELECT actor_id,detail FROM security_events WHERE kind=?", kind);

test("migration: existing SSO subjects become identities, once", async () => {
  const users: [string, string, string, number | null][] = [
    ["https://idp.example.test|plain", "A", "a@example.test", 123],
    ["https://tenant.auth0.example|auth0|abc", "B", "b@example.test", null],
    ["local:c", "C", "c@example.test", null],
    ["ldap:cn=d,dc=example", "D", "d@example.test", null],
    ["scim:ext-e", "E", "e@example.test", null],
    ["deleted:f", "", "", null],
    ["local-development", "G", "g@example.test", null],
  ];
  const uids = users.map(() => id());
  for (const [i, [subject, name, email, last]] of users.entries())
    await run("INSERT INTO users(id,subject,name,email,last_login_at) VALUES(?,?,?,?,?)", uids[i], subject, name, email, last);
  // The data step (lib/data-steps.ts) as on a database that just got
  // user_identities (schema 88), on both databases.
  await run("DELETE FROM data_migrations WHERE name=?", IDENTITIES_STEP);
  await runDataSteps([IDENTITIES_STEP]);
  const mine = async () =>
    (
      await all<Record<string, unknown>>(
        `SELECT user_id,issuer,subject,email,last_used_at FROM user_identities WHERE user_id IN (${uids.map(() => "?").join(",")})`,
        ...uids,
      )
    )
      .map((r) => ({ ...r, user_id: (uids as string[]).indexOf(String(r.user_id)), last_used_at: r.last_used_at === null ? null : Number(r.last_used_at) }))
      .sort((x, y) => x.user_id - y.user_id);
  assert.deepEqual(await mine(), [
    { user_id: 0, issuer: "https://idp.example.test", subject: "plain", email: "a@example.test", last_used_at: 123 },
    // The first "|" separates issuer and subject: Auth0 subjects keep theirs.
    { user_id: 1, issuer: "https://tenant.auth0.example", subject: "auth0|abc", email: "b@example.test", last_used_at: null },
  ]);
  // Once: a disconnected identity does not come back.
  await run("DELETE FROM user_identities WHERE user_id=?", uids[0]);
  await runDataSteps();
  assert.equal((await mine()).length, 1);
});

test("schema 88 on an older SQLite file: the new columns, and no identities copied where the table existed", { skip: sqliteOnly }, () => {
  const d = new DatabaseSync(":memory:");
  d.exec(`CREATE TABLE users(id TEXT PRIMARY KEY,subject TEXT UNIQUE NOT NULL,name TEXT NOT NULL,email TEXT NOT NULL,last_login_at INTEGER);
    CREATE TABLE oidc_flows(id TEXT PRIMARY KEY,state TEXT,verifier TEXT,nonce TEXT,expires INTEGER);`);
  migrateIdentities(d);
  const flows = (d.prepare("PRAGMA table_info(oidc_flows)").all() as { name: string }[]).map((c) => c.name);
  assert.ok(flows.includes("link_user_id") && flows.includes("link_session"));
  // A new table: the data step copies the identities (above).
  assert.equal(d.prepare("SELECT 1 FROM sqlite_master WHERE name='data_migrations'").get(), undefined);
  // Every later start: the table was there, the step counts as done.
  migrateIdentities(d);
  assert.ok(d.prepare("SELECT 1 FROM data_migrations WHERE name=?").get(IDENTITIES_STEP));
  d.close();
});

test("an SSO account from before schema 88 is still found by its subject", async () => {
  const uid = id();
  await run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, `${ISSUER}|legacy`, "Legacy", "legacy@example.test");
  assert.equal(await ids.identityOwner(ISSUER, "legacy"), uid);
  // …and recorded, so the identity is listed and can be managed.
  assert.equal((await ids.listIdentities(uid)).length, 1);
  const found = await link.resolveOidcSignIn(sso("legacy", "legacy@example.test"), "de");
  assert.deepEqual(found, { kind: "account", userId: uid, created: false });
});

test("first SSO sign-in: a verified matching address offers linking, nothing is linked without proof", async () => {
  const ana = await localAccount("ana");
  // Not verified by the provider: a separate account, as before.
  const unverified = await link.resolveOidcSignIn(sso("ana-unverified", "ana@example.test", false), "de");
  assert.equal(unverified.kind, "account");
  assert.notEqual((unverified as { userId: string }).userId, ana.id);
  // Verified: the existing account is offered, but nothing is attached yet.
  const offered = await link.resolveOidcSignIn(sso("ana-sub", "ANA@example.test"), "de");
  assert.deepEqual(offered, { kind: "link", candidateId: ana.id });
  assert.equal(await ids.identityOwner(ISSUER, "ana-sub"), null);
  assert.equal((await ids.listIdentities(ana.id)).length, 0);
  // Two accounts with the address (here: a second LDAP-style match) – no offer.
  assert.equal(await ids.linkCandidate("nobody@example.test"), null);
});

test("interstitial: wrong password counts as a failure, the right one links and signs in", async () => {
  const ben = await localAccount("ben");
  const token = await link.startPendingLink(ben.id, sso("ben-sub", "ben@example.test"), { remember: true, returnTo: "/p/1" });
  const row = await link.requirePending(token, "de");
  assert.equal((await link.pendingLinkInfo(token))?.password, true);
  assert.equal((await link.pendingLinkInfo(token))?.separate, true);
  const before = Number((await one<{ n: number }>("SELECT COUNT(*) n FROM login_failures WHERE key='email:ben@example.test'"))?.n);
  await assert.rejects(link.provePendingPassword(row, { password: "falsch-falsch-falsch" }, "203.0.113.9", "de"), /Passwort stimmt nicht/);
  assert.equal(Number((await one<{ n: number }>("SELECT COUNT(*) n FROM login_failures WHERE key='email:ben@example.test'"))?.n), before + 1);
  assert.equal(await ids.identityOwner(ISSUER, "ben-sub"), null);
  const proof = await link.provePendingPassword(row, { password: "ben-passwort-123" }, "203.0.113.9", "de");
  assert.deepEqual(proof, { userId: ben.id });
  const done = await link.completePendingLink(row, (proof as { userId: string }).userId, "de");
  assert.equal(done.userId, ben.id);
  assert.equal(done.remember, true);
  assert.equal(done.returnTo, "/p/1");
  assert.equal(await ids.identityOwner(ISSUER, "ben-sub"), ben.id);
  // Used up.
  await assert.rejects(async () => await link.requirePending(token, "en"), /expired/);
  await tick();
  assert.ok((await events("account.sso_linked")).some((e) => e.actor_id === ben.id));
  // The next SSO sign-in finds the account directly; its own name stays.
  assert.deepEqual(await link.resolveOidcSignIn(sso("ben-sub", "ben@example.test"), "de"), { kind: "account", userId: ben.id, created: false });
  assert.equal((await one<{ name: string }>("SELECT name FROM users WHERE id=?", ben.id))?.name, "ben");
});

test("interstitial with the authenticator app: password, then a code", async () => {
  const cem = await localAccount("cem");
  const setup = await tf.startTotpSetup({ id: cem.id }, "de");
  await tf.confirmTotpSetup(cem.id, { code: totp.totpCode(setup.secret, Date.now() - 60_000) }, "de", Date.now() - 60_000);
  const token = await link.startPendingLink(cem.id, sso("cem-sub", "cem@example.test"), { remember: false, returnTo: "/" });
  // A code before the password is refused.
  await assert.rejects(async () => await link.provePendingCode(await link.requirePending(token, "de"), { code: "123456" }, "", "de"), /zuerst das Passwort/);
  const proof = await link.provePendingPassword(await link.requirePending(token, "de"), { password: "cem-passwort-123" }, "", "de");
  assert.deepEqual(proof, { twoFactor: true });
  assert.equal((await link.pendingLinkInfo(token))?.secondFactor, true);
  // Still nothing linked after the password alone.
  assert.equal(await ids.identityOwner(ISSUER, "cem-sub"), null);
  await assert.rejects(async () => await link.provePendingCode(await link.requirePending(token, "de"), { code: "000000" }, "", "de"), /Code stimmt nicht/);
  const row = await link.requirePending(token, "de");
  const coded = await link.provePendingCode(row, { code: totp.totpCode(setup.secret, Date.now()) }, "", "de");
  assert.deepEqual(coded, { userId: cem.id });
  await link.completePendingLink(row, cem.id, "de");
  assert.equal(await ids.identityOwner(ISSUER, "cem-sub"), cem.id);
});

test("interstitial: a proof for another account is refused; a separate account only when allowed", async () => {
  const dana = await localAccount("dana");
  const eve = await localAccount("eve");
  const token = await link.startPendingLink(dana.id, sso("dana-sub", "dana@example.test"), { remember: false, returnTo: "/" });
  await assert.rejects(async () => await link.completePendingLink(await link.requirePending(token, "de"), eve.id, "de"), /anderen Konto/);
  assert.equal(await ids.identityOwner(ISSUER, "dana-sub"), null);
  process.env.OIDC_NEW_ACCOUNTS = "false";
  assert.equal((await link.pendingLinkInfo(token))?.separate, false);
  await assert.rejects(async () => await link.separateFromPending(await link.requirePending(token, "de"), "de"), /kein Flowplan-Konto/);
  delete process.env.OIDC_NEW_ACCOUNTS;
  const separate = await link.separateFromPending(await link.requirePending(token, "de"), "de");
  assert.notEqual(separate.userId, dana.id);
  assert.equal(await ids.identityOwner(ISSUER, "dana-sub"), separate.userId);
});

test("Connect SSO: the flow belongs to the account and session that started it", async () => {
  const finn = await localAccount("finn");
  const other = await localAccount("gil");
  const mine = await session(finn.id);
  const theirs = await session(other.id);
  const flow = { link_user_id: finn.id, link_session: hash(mine) };
  assert.equal(await link.linkFlowOwner(flow, mine), finn.id);
  // Another session (also of another account) cannot complete it.
  assert.equal(await link.linkFlowOwner(flow, theirs), null);
  assert.equal(await link.linkFlowOwner(flow, undefined), null);
  assert.equal(await link.linkFlowOwner({ link_user_id: other.id, link_session: hash(mine) }, mine), null);
  // The session ended meanwhile.
  await run("DELETE FROM sessions WHERE token=?", hash(mine));
  assert.equal(await link.linkFlowOwner(flow, mine), null);
  assert.equal(await link.linkFromSettings(finn.id, sso("finn-sub", "finn@corp.example"), "de"), true);
  assert.equal(await link.linkFromSettings(finn.id, sso("finn-sub", "finn@corp.example"), "de"), false);
  assert.equal((await ids.listIdentities(finn.id))[0].email, "finn@corp.example");
});

test("Connect SSO is refused when the identity belongs to another account", async () => {
  const hana = await localAccount("hana");
  const owner = await link.createSsoAccount(sso("taken-sub", "taken@example.test"), "de");
  await assert.rejects(async () => await link.linkFromSettings(hana.id, sso("taken-sub", "taken@example.test"), "en"), /ask an administrator to merge/);
  assert.equal(await ids.identityOwner(ISSUER, "taken-sub"), owner);
  assert.equal((await ids.listIdentities(hana.id)).length, 0);
  await tick();
  assert.ok((await events("account.sso_link_refused")).some((e) => e.actor_id === hana.id));
});

test("disconnecting and removing the password keep one way to sign in", async () => {
  const ida = await localAccount("ida");
  // Without SSO the password cannot go.
  await assert.rejects(async () => await ids.removePassword(ida.id, "de"), /Verbinde zuerst ein SSO-Konto/);
  await link.linkFromSettings(ida.id, sso("ida-sub", "ida@example.test"), "de");
  const [identity] = await ids.listIdentities(ida.id);
  await ids.removePassword(ida.id, "de");
  assert.equal((await ids.signInMethods(ida.id)).password, false);
  await assert.rejects(auth.passwordLogin({ email: "ida@example.test", password: "ida-passwort-123" }, "", "de"), /Passwort stimmt nicht/);
  assert.equal(await confirmsWithPassword(ida.id), false);
  // The only identity now: it stays.
  await assert.rejects(async () => await ids.removeIdentity(ida.id, identity.id, "en"), /only way to sign in/);
  // A second identity: the first can go.
  await link.linkFromSettings(ida.id, sso("ida-second", "ida@example.test"), "de");
  await ids.removeIdentity(ida.id, identity.id, "de");
  assert.equal(await ids.identityOwner(ISSUER, "ida-sub"), null);
  // A password again (set without the old one), then the last identity can go too.
  await auth.setNewPassword(ida.id, "ein-neues-passwort", "de");
  const [second] = await ids.listIdentities(ida.id);
  await ids.removeIdentity(ida.id, second.id, "de");
  assert.equal((await ids.listIdentities(ida.id)).length, 0);
  await tick();
  assert.ok((await events("account.sso_unlinked")).length >= 2);
  assert.ok((await events("account.password_removed")).some((e) => e.actor_id === ida.id));
});

test("a disconnected SSO-created identity starts fresh at its next sign-in", async () => {
  const created = await link.createSsoAccount(sso("jo-sub", "jo@example.test"), "de");
  await link.linkFromSettings(created, sso("jo-second", "jo@example.test"), "de");
  const first = (await ids.listIdentities(created)).find((i) => i.subject === "jo-sub")!;
  await ids.removeIdentity(created, first.id, "de");
  // users.subject no longer names it, so the legacy fallback cannot find it.
  assert.equal(await ids.identityOwner(ISSUER, "jo-sub"), null);
  assert.notEqual((await one<{ subject: string }>("SELECT subject FROM users WHERE id=?", created))?.subject, `${ISSUER}|jo-sub`);
});

test("confirming a step: password, app code, or a fresh sign-in without either", async () => {
  const kai = await localAccount("kai");
  const ctx = { address: "198.51.100.4", locale: "de" as const, sessionStart: Date.now() };
  await assert.rejects(step.confirmStep(kai.id, { confirm: {} }, ctx), /Passwort, einem Passkey oder einem Code/);
  await assert.rejects(step.confirmStep(kai.id, { confirm: { password: "falsch" } }, ctx), /Passwort stimmt nicht/);
  assert.equal(Number((await one<{ n: number }>("SELECT COUNT(*) n FROM login_failures WHERE key=?", `totp:${kai.id}`))?.n), 1);
  await step.confirmStep(kai.id, { confirm: { password: "kai-passwort-123" } }, ctx);
  // An SSO-only account without passkey or app: a recent sign-in counts.
  const sso1 = await link.createSsoAccount(sso("kai-sso", "kai-sso@example.test"), "de");
  await step.confirmStep(sso1, { confirm: {} }, { ...ctx, sessionStart: Date.now() - 60_000 });
  await assert.rejects(step.confirmStep(sso1, { confirm: {} }, { ...ctx, sessionStart: Date.now() - 3600_000 }), /erneut an/);
  // Limits: too many wrong passwords lock the step for 15 minutes.
  for (let i = 0; i < 7; i++) await step.confirmStep(kai.id, { confirm: { password: "falsch" } }, ctx).catch(() => {});
  await assert.rejects(step.confirmStep(kai.id, { confirm: { password: "kai-passwort-123" } }, ctx), /Zu viele Versuche/);
});

test("OIDC_LINKED_SSO_ONLY: linked accounts sign in through SSO only", async () => {
  const lia = await localAccount("lia");
  const solo = await localAccount("solo");
  await link.linkFromSettings(lia.id, sso("lia-sub", "lia@example.test"), "de");
  await ids.refuseSsoOnly(lia.id, "de");
  process.env.OIDC_LINKED_SSO_ONLY = "true";
  try {
    await assert.rejects(async () => await ids.refuseSsoOnly(lia.id, "en"), /signs in through SSO only/);
    // Accounts without SSO are not affected.
    await ids.refuseSsoOnly(solo.id, "de");
    // The password no longer confirms steps either; a code does.
    assert.equal((await step.stepUpMethods(lia.id, null)).password, false);
    assert.equal(await confirmsWithPassword(lia.id), false);
    assert.equal((await ids.signInOverview(lia.id)).ssoOnly, true);
  } finally {
    delete process.env.OIDC_LINKED_SSO_ONLY;
  }
});

test("SCIM: a provisioned account is claimed together with its identity", async () => {
  const uid = id();
  await run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, "scim:ext-77", "Prov", "prov@example.test");
  await run("INSERT INTO scim_users(id,user_id,user_name,external_id,created_at,updated_at) VALUES(?,?,?,?,?,?)", id(), uid, "prov", "sub-77", Date.now(), Date.now());
  const found = await link.resolveOidcSignIn(sso("sub-77", "prov@example.test"), "de");
  assert.deepEqual(found, { kind: "account", userId: uid, created: false });
  assert.equal((await ids.listIdentities(uid))[0].subject, "sub-77");
});

// ---- Merging ----

test("every table that refers to accounts is handled by the merge", async () => {
  const known = new Set(Object.keys(merge.USER_REFERENCES));
  const missing = (await merge
    .userReferenceColumns())
    .map((c) => `${c.table}.${c.column}`)
    .filter((key) => !known.has(key));
  assert.deepEqual(missing, [], `Add these to USER_REFERENCES in lib/account-merge.ts: ${missing.join(", ")}`);
  // …and nothing listed there is gone from the schema.
  const live = new Set((await merge.userReferenceColumns()).map((c) => `${c.table}.${c.column}`));
  assert.deepEqual([...known].filter((key) => !live.has(key)), []);
});

test("merge: preview (dry run), then everything moves and the source is gone", async () => {
  const boss = await localAccount("boss");
  const source = await localAccount("src");
  const target = await link.createSsoAccount(sso("tgt-sub", "tgt@example.test"), "de");
  await link.linkFromSettings(source.id, sso("src-sub", "src@example.test"), "de");
  const shared = await createWorkspace(boss.id, "Geteilt");
  const own = await createWorkspace(source.id, "Eigener Bereich");
  await run("INSERT INTO members VALUES(?,?,?)", shared, source.id, "editor");
  await run("INSERT INTO members VALUES(?,?,?)", shared, target, "viewer");
  await run("INSERT INTO workspace_guests(workspace_id,user_id) VALUES(?,?)", shared, target);
  const space = (await one<{ id: string }>("SELECT id FROM spaces WHERE workspace_id=? LIMIT 1", own))!.id;
  const page = id();
  await run("INSERT INTO pages(id,workspace_id,space_id,title,kind,owner_id,created_by,position) VALUES(?,?,?,?,?,?,?,0)", page, own, space, "Notizen", "database", source.id, source.id);
  await run("INSERT INTO databases(page_id,fields,views) VALUES(?,?,?)", page, JSON.stringify([{ id: "who", name: "Wer", type: "person" }, { id: "team", name: "Team", type: "person" }]), "[]");
  const row = id();
  await run("INSERT INTO rows(id,page_id,cells,created_by,updated_by) VALUES(?,?,?,?,?)", row, page, JSON.stringify({ who: source.id, team: [source.id, target] }), source.id, source.id);
  await run("INSERT INTO comments(id,page_id,author_id,body) VALUES(?,?,?,?)", id(), page, source.id, JSON.stringify({ type: "doc", content: [{ type: "mention", attrs: { userId: source.id } }] }));
  await run("INSERT INTO favorites(user_id,page_id) VALUES(?,?)", source.id, page);
  await run("INSERT INTO favorites(user_id,page_id) VALUES(?,?)", target, page);
  await run("INSERT INTO notifications(id,user_id,body) VALUES(?,?,?)", id(), source.id, "Hallo");
  await createApiToken({ ...(await admin(source.id)), groups: [], isAdmin: false }, { name: "Skript", scope: "read" });
  const token = await session(source.id);
  await run("INSERT INTO passkeys(id,user_id,public_key,counter,transports,name,created_at) VALUES(?,?,?,?,?,?,?)", "cred-src", source.id, Buffer.from([1]), 0, "[]", "Key", Date.now());
  await run("INSERT INTO webhooks(id,workspace_id,url,events,secret,created_by,created_at) VALUES(?,?,?,?,?,?,?)", id(), own, "https://hooks.example.test/x", "[]", "s", source.id, Date.now());
  await run("INSERT INTO sidebar_state(user_id,workspace_id,keys,updated_at) VALUES(?,?,?,?)", source.id, own, "[]", Date.now());
  const docPage = id();
  await run("INSERT INTO pages(id,workspace_id,space_id,title,kind,owner_id,created_by,position) VALUES(?,?,?,?,?,?,?,1)", docPage, own, space, "Text", "document", source.id, source.id);
  await run("INSERT INTO documents(page_id,html) VALUES(?,?)", docPage, `<p>Hallo <span data-mention="${source.id}" class="mention">@src</span></p>`);

  const me = await admin(boss.id);
  await assert.rejects(async () => await merge.mergePreview(me, source.id, source.id), /zwei verschiedene/);
  await assert.rejects(async () => await merge.mergePreview(me, boss.id, target), /Zielkonto/);
  const preview = await merge.mergePreview(me, source.id, target);
  assert.equal(preview.summary.identities, 1);
  assert.equal(preview.summary.apiTokens, 1);
  assert.equal(preview.summary.records, 1);
  assert.equal(preview.summary.documents, 1);
  assert.ok(preview.notes.includes("tokens"));
  const listed = new Set(preview.tables.map((t) => `${t.table}.${t.column}`));
  for (const key of ["members.user_id", "pages.owner_id", "comments.author_id", "favorites.user_id", "sessions.user_id", "passkeys.user_id", "user_identities.user_id", "webhooks.created_by", "local_accounts.user_id"])
    assert.ok(listed.has(key), key);
  // A dry run changes nothing.
  assert.ok(await one("SELECT 1 FROM users WHERE id=?", source.id));

  const result = (await command(me, { action: "admin.mergeUsers", sourceId: source.id, targetId: target })) as { source: { id: string } };
  assert.equal(result.source.id, source.id);
  assert.equal(await one("SELECT 1 FROM users WHERE id=?", source.id), undefined);
  // No column anywhere still names the source.
  for (const { table, column } of await merge.userReferenceColumns())
    assert.equal(Number((await one<{ n: number }>(`SELECT COUNT(*) n FROM "${table}" WHERE "${column}"=?`, source.id))?.n || 0), 0, `${table}.${column}`);
  // Higher role, and no longer a guest where the source was a member.
  assert.equal((await one<{ role: string }>("SELECT role FROM members WHERE workspace_id=? AND user_id=?", shared, target))?.role, "editor");
  assert.equal(await one("SELECT 1 FROM workspace_guests WHERE workspace_id=? AND user_id=?", shared, target), undefined);
  assert.equal((await one<{ role: string }>("SELECT role FROM members WHERE workspace_id=? AND user_id=?", own, target))?.role, "owner");
  assert.equal((await one<{ owner_id: string }>("SELECT owner_id FROM pages WHERE id=?", page))?.owner_id, target);
  // Person properties: replaced, and the target named once.
  assert.deepEqual(JSON.parse((await one<{ cells: string }>("SELECT cells FROM rows WHERE id=?", row))!.cells), { who: target, team: [target] });
  assert.ok((await one<{ body: string }>("SELECT body FROM comments WHERE page_id=?", page))!.body.includes(target));
  assert.ok((await one<{ html: string }>("SELECT html FROM documents WHERE page_id=?", docPage))!.html.includes(`data-mention="${target}"`));
  assert.equal(Number((await one<{ n: number }>("SELECT COUNT(*) n FROM favorites WHERE user_id=? AND page_id=?", target, page))?.n), 1);
  // Identities and passkeys move; the source's password too (the target had none).
  assert.equal(await ids.identityOwner(ISSUER, "src-sub"), target);
  assert.equal(await ids.identityOwner(ISSUER, "tgt-sub"), target);
  assert.equal((await one<{ user_id: string }>("SELECT user_id FROM passkeys WHERE id='cred-src'"))?.user_id, target);
  assert.ok((await auth.passwordLogin({ email: "src@example.test", password: "src-passwort-123" }, "", "de")).userId === target);
  // Sessions and API tokens of the source: ended and revoked.
  assert.equal(await one("SELECT 1 FROM sessions WHERE token=?", hash(token)), undefined);
  assert.equal(Number((await one<{ n: number }>("SELECT COUNT(*) n FROM api_tokens WHERE user_id=?", target))?.n), 0);
  assert.ok(await one("SELECT 1 FROM audit WHERE action='admin.mergeUsers' AND resource_id=?", target));
  await tick();
  assert.ok((await events("admin.merge")).some((e) => e.actor_id === boss.id));
});

test("merge: the authenticator app moves re-sealed when the target has none", async () => {
  const boss = await localAccount("boss2");
  const source = await localAccount("tfa-src");
  const target = await localAccount("tfa-tgt");
  const setup = await tf.startTotpSetup({ id: source.id }, "de");
  await tf.confirmTotpSetup(source.id, { code: totp.totpCode(setup.secret, Date.now() - 120_000) }, "de", Date.now() - 120_000);
  await command(await admin(boss.id), { action: "admin.mergeUsers", sourceId: source.id, targetId: target.id });
  assert.equal((await tf.twoFactorStatus(target.id)).enabled, true);
  // The moved secret opens for the target: a current code is accepted.
  assert.equal(await tf.useSecondFactor(target.id, totp.totpCode(setup.secret, Date.now())), true);
  assert.equal(await one("SELECT 1 FROM local_accounts WHERE user_id=?", source.id), undefined);
});

test("an SSO sign-in writes the address together with the provider's confirmation", async () => {
  // users-email/changed-without-resetting-email-verified
  const first = await link.resolveOidcSignIn(sso("eve-addr", "eve-addr@example.test"), "de");
  const userId = (first as { userId: string }).userId;
  await run("UPDATE users SET email_verified=1 WHERE id=?", userId);
  const row = async () => ({ ...(await one<{ email: string; email_verified: number }>("SELECT email,email_verified FROM users WHERE id=?", userId))! });
  await link.knownAccount(sso("eve-addr", "victim-addr@example.test", false), "de");
  assert.deepEqual(await row(), { email: "victim-addr@example.test", email_verified: 0 });
  await link.knownAccount(sso("eve-addr", "victim-addr@example.test", true), "de");
  assert.deepEqual(await row(), { email: "victim-addr@example.test", email_verified: 1 });
});
