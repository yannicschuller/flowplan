import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Identity, User } from "../lib/types";
process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-page-share-"));
const { run, one, all, id } = await import("../lib/db");
const { createWorkspace } = await import("../lib/seed");
const { command, bootstrap } = await import("../lib/api");
const { requirePage } = await import("../lib/permissions");
const { acceptInvites, acceptInviteToken } = await import("../lib/auth");
const { pageShares } = await import("../lib/page-share");

// Accounts with a proven address by default (as after SSO or a confirmation link).
function person(name: string, verified = true): Identity {
  const uid = id();
  run("INSERT INTO users(id,subject,name,email,email_verified) VALUES(?,?,?,?,?)", uid, uid, name, `${name.toLowerCase()}@example.test`, verified ? 1 : 0);
  return { id: uid, name, email: `${name.toLowerCase()}@example.test`, groups: [], isAdmin: false, disabled: 0, created_at: "" } as Identity;
}
const ada = person("Ada"),
  ben = person("Ben"),
  cleo = person("Cleo");
const wid = createWorkspace(ada.id, "Familie");
// Cleo is an editor of the workspace with a space of her own.
run("INSERT INTO members VALUES(?,?,?)", wid, cleo.id, "editor");
const as = (user: Identity) => (b: Record<string, unknown>) => command(user, { workspaceId: wid, ...b }) as Record<string, unknown>;
const team = bootstrap(ada, wid).spaces[0].id;
const insurance = String(as(ada)({ action: "page.create", spaceId: team, title: "Versicherungen", kind: "database" }).id);
const policy = String(as(ada)({ action: "page.create", spaceId: team, title: "Police", kind: "document", parentId: insurance }).id);
const secret = String(as(ada)({ action: "page.create", spaceId: team, title: "Geheim", kind: "document" }).id);
const canRead = (user: Identity, pageId: string) => {
  try {
    requirePage(user, pageId);
    return true;
  } catch {
    return false;
  }
};

test("an existing account gets exactly one page, as a guest of the workspace", () => {
  const result = as(ada)({ action: "page.share", pageId: insurance, email: "BEN@example.test", role: "viewer" });
  assert.equal(result.status, "added");
  assert.equal(result.name, "Ben");
  assert.ok(one("SELECT 1 FROM workspace_guests WHERE workspace_id=? AND user_id=?", wid, ben.id));
  assert.ok(canRead(ben, insurance));
  assert.ok(canRead(ben, policy), "sub-pages come along");
  assert.ok(!canRead(ben, secret), "nothing else of the workspace");
  const boot = bootstrap(ben, wid);
  assert.deepEqual(boot.pages.map((p) => p.id).sort(), [insurance, policy].sort());
  assert.equal(boot.workspace.guest, 1);
  // Ben hears about it.
  assert.match(one<{ body: string }>("SELECT body FROM notifications WHERE user_id=? AND kind='share'", ben.id)!.body, /Ada hat „Versicherungen“ mit dir geteilt/);
  // Viewing only: no editing.
  assert.throws(() => requirePage(ben, insurance, true), /Keine Berechtigung/);
  // Editing raises the guest's cap.
  as(ada)({ action: "page.shareUpdate", pageId: insurance, userId: ben.id, role: "editor" });
  assert.ok(requirePage(ben, insurance, true));
  assert.equal(pageShares(ada, insurance).people[0].role, "editor");
});

test("only owners of the workspace or of the space share", () => {
  assert.throws(() => as(cleo)({ action: "page.share", pageId: secret, email: "ben@example.test", role: "viewer" }), /Nur Eigentümer/);
  const own = String(as(cleo)({ action: "space.create", name: "Cleo", private: true }).id);
  const notes = String(as(cleo)({ action: "page.create", spaceId: own, title: "Notizen", kind: "document" }).id);
  assert.equal(as(cleo)({ action: "page.share", pageId: notes, email: "ben@example.test", role: "editor" }).status, "added");
  assert.ok(requirePage(ben, notes, true));
  assert.equal(pageShares(ben, notes).manage, false);
  assert.throws(() => as(ben)({ action: "page.share", pageId: insurance, email: "x@example.test", role: "viewer" }), /Nur Eigentümer/);
  assert.throws(() => as(ada)({ action: "page.share", pageId: insurance, email: "ada@example.test", role: "viewer" }), /bereits Zugriff/);
});

test("without an account: an invitation, the page is there after signing in", () => {
  const result = as(ada)({ action: "page.share", pageId: policy, email: "dora@example.test", role: "editor" });
  assert.equal(result.status, "invited");
  assert.deepEqual(pageShares(ada, policy).pending, [{ email: "dora@example.test", role: "editor" }]);
  const dora = person("Dora");
  acceptInvites({ ...(dora as unknown as User) }, true);
  assert.ok(requirePage(dora, policy, true));
  assert.ok(!canRead(dora, insurance), "the parent stays closed");
  assert.ok(one("SELECT 1 FROM workspace_guests WHERE workspace_id=? AND user_id=?", wid, dora.id));
  assert.equal(all("SELECT 1 FROM invite_grants").length, 0);
});

test("a cancelled invitation and a removed guest leave nothing behind", () => {
  as(ada)({ action: "page.share", pageId: secret, email: "eve@example.test", role: "viewer" });
  as(ada)({ action: "page.shareUpdate", pageId: secret, email: "eve@example.test", role: "remove" });
  assert.equal(one("SELECT 1 FROM invites WHERE email='eve@example.test'"), undefined);
  // Dora had only the policy: removing it removes her from the workspace.
  const dora = one<{ id: string }>("SELECT id FROM users WHERE email='dora@example.test'")!;
  as(ada)({ action: "page.shareUpdate", pageId: policy, userId: dora.id, role: "remove" });
  assert.equal(one("SELECT 1 FROM members WHERE workspace_id=? AND user_id=?", wid, dora.id), undefined);
  // Ben still has Cleo's page, so he stays.
  as(ada)({ action: "page.shareUpdate", pageId: insurance, userId: ben.id, role: "remove" });
  assert.ok(one("SELECT 1 FROM members WHERE workspace_id=? AND user_id=?", wid, ben.id));
  assert.ok(!canRead(ben, insurance));
});

test("an existing account takes over a later invitation when the app loads", () => {
  const fritz = person("Fritz");
  // A confirmed local account (e-mail and password).
  run("INSERT INTO local_accounts(user_id,email,password_hash,is_admin,email_verified,verify_required,created_at) VALUES(?,?,?,?,?,?,?)", fritz.id, fritz.email, "x", 0, 1, 0, Date.now());
  const own = createWorkspace(fritz.id, "Fritz");
  as(ada)({ action: "member.invite", email: fritz.email, role: "editor" });
  // Before, the invitation only counted when confirming the address.
  const boot = bootstrap(fritz, own);
  assert.ok(boot.workspaces.some((w) => w.id === wid));
  assert.match(one<{ body: string }>("SELECT body FROM notifications WHERE user_id=? AND kind='share'", fritz.id)!.body, /Ada hat dich zum Arbeitsbereich „Familie“ hinzugefügt/);
  assert.equal(one("SELECT 1 FROM invites WHERE email=?", fritz.email), undefined);
  // Unconfirmed addresses wait.
  const gina = person("Gina", false);
  run("INSERT INTO local_accounts(user_id,email,password_hash,is_admin,email_verified,verify_required,created_at) VALUES(?,?,?,?,?,?,?)", gina.id, gina.email, "x", 0, 0, 1, Date.now());
  as(ada)({ action: "member.invite", email: gina.email, role: "viewer" });
  bootstrap(gina, createWorkspace(gina.id, "Gina"));
  assert.ok(one("SELECT 1 FROM invites WHERE email=?", gina.email));
});

test("an existing account gets an e-mail right away, unless they turned it off", () => {
  process.env.SMTP_HOST = "smtp.example.test";
  process.env.SMTP_FROM = "flowplan@example.test";
  try {
    const hanna = person("Hanna");
    const doc = String(as(ada)({ action: "page.create", spaceId: team, title: "Garten", kind: "document" }).id);
    const result = as(ada)({ action: "page.share", pageId: doc, email: hanna.email, role: "viewer" });
    assert.equal(result.mailed, true);
    const mail = one<{ subject: string; text: string }>("SELECT subject,text FROM mail_queue WHERE recipient=?", hanna.email)!;
    assert.match(mail.subject, /Ada hat „Garten“ mit dir geteilt/);
    assert.match(mail.text, new RegExp(`#page=${doc}`));
    // The summary leaves this notification out.
    assert.ok(one<{ emailed_at: string | null }>("SELECT emailed_at FROM notifications WHERE user_id=? AND kind='share'", hanna.id)!.emailed_at);
    // Turned off: inbox only.
    const ida = person("Ida");
    run("INSERT INTO notification_prefs(user_id,kind,inbox,push,email) VALUES(?,'share',1,1,0)", ida.id);
    assert.equal(as(ada)({ action: "page.share", pageId: doc, email: ida.email, role: "viewer" }).mailed, false);
    assert.equal(one("SELECT 1 FROM mail_queue WHERE recipient=?", ida.email), undefined);
  } finally {
    delete process.env.SMTP_HOST;
    delete process.env.SMTP_FROM;
  }
});

test("open invitations can be withdrawn with their pages, or sent again", () => {
  as(ada)({ action: "page.share", pageId: secret, email: "jan@example.test", role: "viewer" });
  const invite = one<{ id: string; created_at: number }>("SELECT id,created_at FROM invites WHERE email='jan@example.test'")!;
  assert.ok(invite.created_at > 0);
  as(ada)({ action: "invite.resend", inviteId: invite.id });
  assert.throws(() => as(cleo)({ action: "invite.cancel", inviteId: invite.id }), /Keine Berechtigung/);
  as(ada)({ action: "invite.cancel", inviteId: invite.id });
  assert.equal(one("SELECT 1 FROM invites WHERE email='jan@example.test'"), undefined);
  assert.equal(one("SELECT 1 FROM invite_grants WHERE email='jan@example.test'"), undefined);
});

test("an unproven address gets an invitation link, not the page", () => {
  // Anyone can sign up with any address where mail is not set up: such an
  // account does not take over pages shared with that address.
  const kim = person("Kim", false);
  const doc = String(as(ada)({ action: "page.create", spaceId: team, title: "Steuer", kind: "document" }).id);
  assert.equal(as(ada)({ action: "page.share", pageId: doc, email: kim.email, role: "viewer" }).status, "invited");
  bootstrap(kim, createWorkspace(kim.id, "Kim"));
  assert.ok(!canRead(kim, doc));
  // The link from the invitation proves it.
  const token = one<{ token: string }>("SELECT token FROM invites WHERE email=?", kim.email)!.token;
  assert.match(token, /^[A-Za-z0-9_-]{32}$/);
  assert.equal(acceptInviteToken(kim as unknown as User, "falsch"), null);
  assert.equal(acceptInviteToken(kim as unknown as User, token), wid);
  assert.ok(canRead(kim, doc));
  assert.equal(one("SELECT 1 FROM invites WHERE token=?", token), undefined);
});

test("guests keep shared pages where they are and see no one's addresses", () => {
  const doc = String(as(ada)({ action: "page.create", spaceId: team, title: "Urlaub", kind: "document" }).id);
  as(ada)({ action: "page.share", pageId: doc, email: ben.email, role: "editor" });
  const own = createWorkspace(ben.id, "Ben");
  const ownSpace = bootstrap(ben, own).spaces[0].id;
  assert.throws(() => command(ben, { action: "page.move", workspaceId: wid, pageId: doc, spaceId: ownSpace }), /Gäste/);
  assert.equal(one<{ workspace_id: string }>("SELECT workspace_id FROM pages WHERE id=?", doc)!.workspace_id, wid);
  assert.deepEqual(pageShares(ben, doc).people, []);
  // Members see who has access, but only owners see the addresses.
  assert.ok(pageShares(cleo, doc).people.every((p) => !("email" in p) || !p.email));
});

test("read-only API tokens do not write", () => {
  const reader = { ...ada, apiScope: "read" } as Identity;
  assert.throws(() => command(reader, { workspaceId: wid, action: "page.create", spaceId: team, title: "Nein", kind: "document" }), /nur lesen/);
  assert.throws(() => command(reader, { workspaceId: wid, action: "page.update", pageId: secret, title: "Nein" }), /nur lesen/);
});

test("removing a member leaves no rights or traces behind", () => {
  const lou = person("Lou");
  run("INSERT INTO members VALUES(?,?,?)", wid, lou.id, "editor");
  run("INSERT INTO grants(resource_id,user_id,role) VALUES(?,?,?)", secret, lou.id, "editor");
  run("INSERT INTO favorites(user_id,page_id) VALUES(?,?)", lou.id, secret);
  as(ada)({ action: "member.role", userId: lou.id, role: "remove" });
  assert.equal(one("SELECT 1 FROM members WHERE user_id=?", lou.id), undefined);
  assert.equal(one("SELECT 1 FROM grants WHERE user_id=?", lou.id), undefined, "a later invitation does not bring old rights back");
  assert.equal(one("SELECT 1 FROM favorites WHERE user_id=?", lou.id), undefined);
});
