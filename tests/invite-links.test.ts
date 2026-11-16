// Invitation links for several people and direct adding of registered
// accounts (#320, lib/invite-links.ts, member.invite in lib/api.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Identity } from "../lib/types";
process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-invite-links-"));
process.env.APP_URL = "https://flowplan.example.test";
delete process.env.FLOWPLAN_INVITE_LINKS;
const { all, one, run, id } = await import("../lib/db");
const { createWorkspace } = await import("../lib/seed");
const { command } = await import("../lib/api");
const auth = await import("../lib/local-auth");
const links = await import("../lib/invite-links");
const { saveInstanceSettings, instanceSettings } = await import("../lib/instance-settings");
const { securityWritesSettled } = await import("../lib/security-events");
const { englishMessage } = await import("../lib/i18n-errors");

// Everything written to the console while the tests run: no token in it.
const logged: string[] = [];
for (const level of ["log", "info", "warn", "error", "debug"] as const) {
  const original = console[level].bind(console);
  console[level] = (...args: unknown[]) => {
    logged.push(args.map(String).join(" "));
    original(...args);
  };
}

const { user: admin } = await auth.register({ name: "Ada", email: "ada@example.test", password: "ein-langes-passwort" }, "de");
async function account(name: string, verified = true) {
  const uid = id();
  await run("INSERT INTO users(id,subject,name,email,email_verified) VALUES(?,?,?,?,?)", uid, `local:${uid}`, name, `${name.toLowerCase()}@example.test`, verified ? 1 : 0);
  return { id: uid, name, email: `${name.toLowerCase()}@example.test`, groups: [], isAdmin: false, disabled: 0, created_at: "" } as Identity;
}
const owner = { ...admin, groups: [], isAdmin: false } as unknown as Identity;
const wid = await createWorkspace(owner.id, "Team Nord");
const editor = await account("Edda");
await run("INSERT INTO members VALUES(?,?,?)", wid, editor.id, "editor");
const as = (user: Identity) => (input: Record<string, unknown>) => command(user, { workspaceId: wid, ...input });
const create = (input: Record<string, unknown> = {}, user = owner) => as(user)({ action: "inviteLink.create", role: "editor", expires: "7d", ...input }) as Promise<{ id: string; url: string; expiresAt: number }>;
const tokenOf = (url: string) => new URL(url).searchParams.get("join")!;
const membership = (uid: string, w = wid) => one<{ role: string }>("SELECT role FROM members WHERE workspace_id=? AND user_id=?", w, uid);
const isGuest = async (uid: string, w = wid) => !!(await one("SELECT 1 FROM workspace_guests WHERE workspace_id=? AND user_id=?", w, uid));

test("only owners create links, with editor or viewer – never owner – and a fixed expiry", async () => {
  await assert.rejects(create({}, editor), /Berechtigung/);
  for (const role of ["owner", "admin"]) await assert.rejects(create({ role }));
  await assert.rejects(create({ expires: "1y" }));
  await assert.rejects(create({ maxUses: 0 }));
  const before = Date.now();
  const link = await create({ expires: "24h", maxUses: 3 });
  assert.match(link.url, /^https:\/\/flowplan\.example\.test\/\?join=[A-Za-z0-9_-]{43}$/);
  assert.ok(Math.abs(link.expiresAt - (before + 24 * 3_600_000)) < 5_000);
  // Stored as a hash; the sealed copy does not contain it either.
  const token = tokenOf(link.url);
  const row = (await one<{ token_hash: string; token_sealed: string }>("SELECT token_hash,token_sealed FROM invite_links WHERE id=?", link.id))!;
  assert.match(row.token_hash, /^[0-9a-f]{64}$/);
  assert.ok(!row.token_hash.includes(token) && !row.token_sealed.includes(token));
  // Owners see it with its link, uses and expiry.
  const listed = (await links.listInviteLinks(wid)).find((l) => l.id === link.id)!;
  assert.equal(listed.url, link.url);
  assert.equal(listed.uses, 0);
  assert.equal(listed.maxUses, 3);
  assert.equal(listed.role, "editor");
});

test("joining: the link's role, guests as guests, twice is a no-op", async () => {
  const viewerLink = await create({ role: "viewer" });
  const guestLink = await create({ role: "editor", guest: true });
  const bo = await account("Bo"),
    cy = await account("Cy");
  assert.deepEqual(await links.acceptInviteLink(bo, tokenOf(viewerLink.url)), { status: "joined", workspaceId: wid });
  assert.equal((await membership(bo.id))?.role, "viewer");
  assert.equal(await isGuest(bo.id), false);
  assert.deepEqual(await links.acceptInviteLink(cy, tokenOf(guestLink.url)), { status: "joined", workspaceId: wid });
  assert.equal((await membership(cy.id))?.role, "editor");
  assert.equal(await isGuest(cy.id), true);
  // Again: nothing changes, no use is counted – also a member through
  // another link keeps their role (the link grants nothing more).
  assert.deepEqual(await links.acceptInviteLink(bo, tokenOf(viewerLink.url)), { status: "member", workspaceId: wid });
  assert.deepEqual(await links.acceptInviteLink(bo, tokenOf(guestLink.url)), { status: "member", workspaceId: wid });
  assert.equal((await membership(bo.id))?.role, "viewer");
  assert.equal(await isGuest(bo.id), false);
  assert.equal((await links.listInviteLinks(wid)).find((l) => l.id === viewerLink.id)!.uses, 1);
  assert.equal((await links.listInviteLinks(wid)).find((l) => l.id === guestLink.id)!.uses, 1);
  // A member already (the owner) stays owner.
  assert.equal((await links.acceptInviteLink(owner, tokenOf(viewerLink.url))).status, "member");
  assert.equal((await membership(owner.id))?.role, "owner");
});

test("max uses, expiry and revoking each refuse with their own reason", async () => {
  const limited = await create({ maxUses: 2 });
  const [p1, p2, p3] = [await account("Pia"), await account("Pit"), await account("Pol")];
  assert.equal((await links.acceptInviteLink(p1, tokenOf(limited.url))).status, "joined");
  assert.equal((await links.acceptInviteLink(p2, tokenOf(limited.url))).status, "joined");
  assert.deepEqual(await links.acceptInviteLink(p3, tokenOf(limited.url)), { status: "refused", reason: "used_up" });
  assert.equal(await membership(p3.id), undefined);
  assert.equal((await links.listInviteLinks(wid)).find((l) => l.id === limited.id)!.usedUp, true);
  // Expired: 24 hours later.
  const short = await create({ expires: "24h" });
  assert.deepEqual(await links.acceptInviteLink(p3, tokenOf(short.url), "", Date.now() + 25 * 3_600_000), { status: "refused", reason: "expired" });
  // Revoked: refused, and gone from the list; who joined before stays.
  const revoked = await create();
  assert.equal((await links.acceptInviteLink(p3, tokenOf(revoked.url))).status, "joined");
  await as(owner)({ action: "inviteLink.revoke", linkId: revoked.id });
  const p4 = await account("Pam");
  assert.deepEqual(await links.acceptInviteLink(p4, tokenOf(revoked.url)), { status: "refused", reason: "revoked" });
  assert.ok(!(await links.listInviteLinks(wid)).some((l) => l.id === revoked.id));
  assert.equal((await membership(p3.id))?.role, "editor");
  // Only owners revoke, and only links of their workspace.
  const other = await create();
  await assert.rejects(as(editor)({ action: "inviteLink.revoke", linkId: other.id }), /Berechtigung/);
  await assert.rejects(as(owner)({ action: "inviteLink.revoke", linkId: id() }), /nicht gefunden/);
  // Unknown and malformed tokens.
  assert.deepEqual(await links.acceptInviteLink(p4, "x".repeat(43)), { status: "refused", reason: "invalid" });
  assert.deepEqual(await links.acceptInviteLink(p4, "kurz"), { status: "refused", reason: "invalid" });
  // The messages are clear in both languages.
  for (const text of Object.values(links.inviteLinkMessages)) assert.notEqual(englishMessage(text), text);
});

test("closed sign-ups: a valid link opens sign-up for any address and joins", async () => {
  assert.equal((await instanceSettings()).allowSignup, false);
  const link = await create({ role: "viewer", maxUses: 5 });
  const token = tokenOf(link.url);
  assert.equal(await auth.signupOpen(), false);
  assert.equal(await auth.signupOpen(undefined, undefined, token), true);
  const options = await auth.loginOptions(undefined, undefined, token);
  assert.equal(options.signupOpen, true);
  assert.equal(options.joinWorkspace, "Team Nord");
  assert.equal(options.joinError, "");
  const { user } = await auth.register({ name: "Neo", email: "neo@example.test", password: "ein-langes-passwort", join: token }, "de");
  assert.equal((await membership(user.id))?.role, "viewer");
  assert.equal((await links.listInviteLinks(wid)).find((l) => l.id === link.id)!.uses, 1);
  // Without a link, or with a used-up, revoked or unknown one: closed.
  await assert.rejects(auth.register({ name: "Max", email: "max@example.test", password: "ein-langes-passwort" }, "de"), /nur Admins/);
  await assert.rejects(auth.register({ name: "Max", email: "max@example.test", password: "ein-langes-passwort", join: "y".repeat(43) }, "de"), /nur Admins/);
  await as(owner)({ action: "inviteLink.revoke", linkId: link.id });
  await assert.rejects(auth.register({ name: "Max", email: "max@example.test", password: "ein-langes-passwort", join: token }, "de"), /nur Admins/);
  const refused = await auth.loginOptions(undefined, undefined, token);
  assert.equal(refused.signupOpen, false);
  assert.equal(refused.joinWorkspace, "");
  assert.equal(refused.joinError, "revoked");
});

test("switched off by the administration (or FLOWPLAN_INVITE_LINKS=off): nothing is created or opened", async () => {
  const link = await create();
  const token = tokenOf(link.url);
  const zoe = await account("Zoe");
  await saveInstanceSettings({ inviteLinks: false });
  try {
    await assert.rejects(create(), /ausgeschaltet/);
    assert.deepEqual(await links.acceptInviteLink(zoe, token), { status: "refused", reason: "disabled" });
    assert.equal(await auth.signupOpen(undefined, undefined, token), false);
    assert.equal((await auth.loginOptions(undefined, undefined, token)).joinError, "disabled");
  } finally {
    await saveInstanceSettings({ inviteLinks: true });
  }
  process.env.FLOWPLAN_INVITE_LINKS = "off";
  try {
    assert.equal(links.inviteLinksForcedOff(), true);
    await assert.rejects(create(), /ausgeschaltet/);
    assert.deepEqual(await links.acceptInviteLink(zoe, token), { status: "refused", reason: "disabled" });
  } finally {
    delete process.env.FLOWPLAN_INVITE_LINKS;
  }
  assert.equal((await links.acceptInviteLink(zoe, token)).status, "joined");
  // Demo accounts never join.
  const demo = await account("Demo");
  assert.deepEqual(await links.acceptInviteLink({ ...demo, demo_until: Date.now() + 60_000 }, token), { status: "refused", reason: "invalid" });
});

test("joining is rate-limited per person and per address", async () => {
  const link = await create();
  const eager = await account("Eager");
  for (let i = 0; i < 20; i++) assert.equal((await links.acceptInviteLink(eager, "z".repeat(43))).status, "refused");
  assert.deepEqual(await links.acceptInviteLink(eager, tokenOf(link.url)), { status: "refused", reason: "limited" });
  assert.equal(await membership(eager.id), undefined);
  // The sign-in page's look-ups per address as well.
  for (let i = 0; i < 60; i++) await links.inviteLinkPreview("q".repeat(43), "203.0.113.9");
  assert.deepEqual(await links.inviteLinkPreview(tokenOf(link.url), "203.0.113.9"), { ok: false, reason: "limited" });
  assert.equal((await links.inviteLinkPreview(tokenOf(link.url), "203.0.113.10"))?.ok, true);
});

test("security events: created, used, refused, revoked – never the token", async () => {
  const link = await create({ maxUses: 1 });
  const token = tokenOf(link.url);
  await links.acceptInviteLink(await account("Una"), token);
  await links.acceptInviteLink(await account("Udo"), token);
  await as(owner)({ action: "inviteLink.revoke", linkId: link.id });
  await securityWritesSettled();
  const events = await all<{ kind: string; detail: string }>("SELECT kind,detail FROM security_events WHERE detail LIKE ? ORDER BY id", `%${link.id}%`);
  assert.deepEqual(events.map((e) => e.kind), ["invite_link.created", "invite_link.used", "invite_link.refused", "invite_link.revoked"]);
  // No token in any event, audit entry, table other than the link's own or the console.
  const tokens = (await all<{ token_hash: string }>("SELECT token_hash FROM invite_links")).length;
  assert.ok(tokens > 0);
  for (const row of await all<{ detail: string; subject: string }>("SELECT detail,subject FROM security_events"))
    assert.ok(!row.detail.includes(token) && !row.subject.includes(token));
  for (const row of await all<{ detail: string | null }>("SELECT detail FROM audit")) assert.ok(!(row.detail || "").includes(token));
  assert.ok(!logged.some((line) => line.includes(token)));
});

test("direct add: a confirmed account becomes a member at once, with a notification", async () => {
  const vera = await account("Vera");
  const before = await command(owner, { action: "member.invite", workspaceId: wid, email: "Vera@example.test", role: "viewer" });
  assert.equal((await membership(vera.id))?.role, "viewer");
  assert.equal(await one("SELECT 1 FROM invites WHERE workspace_id=? AND email='vera@example.test'", wid), undefined);
  const note = (await one<{ body: string; link: string; kind: string; page_id: string | null }>("SELECT body,link,kind,page_id FROM notifications WHERE user_id=?", vera.id))!;
  assert.equal(note.body, "Ada hat dich zu „Team Nord“ hinzugefügt");
  assert.equal(englishMessage(note.body), "Ada added you to “Team Nord”");
  assert.equal(note.link, `workspace:${wid}`);
  assert.equal(note.kind, "share");
  assert.equal(note.page_id, null);
  // Her bootstrap lists the workspace right away (the open app's refresh).
  const { bootstrap } = await import("../lib/api");
  assert.ok((await bootstrap(vera, undefined)).workspaces.some((w) => w.id === wid));
  // An unconfirmed account and an unknown address keep the invitation –
  // and the inviter's answer is the same in all three cases.
  const walt = await account("Walt", false);
  const unconfirmed = await command(owner, { action: "member.invite", workspaceId: wid, email: walt.email, role: "viewer" });
  const unknown = await command(owner, { action: "member.invite", workspaceId: wid, email: "nobody@example.test", role: "viewer" });
  assert.deepEqual(before, unconfirmed);
  assert.deepEqual(before, unknown);
  assert.equal(await membership(walt.id), undefined);
  assert.ok(await one("SELECT 1 FROM invites WHERE workspace_id=? AND email=?", wid, walt.email));
  assert.ok(await one("SELECT 1 FROM invites WHERE workspace_id=? AND email='nobody@example.test'", wid));
  assert.equal(await one("SELECT 1 FROM notifications WHERE user_id=?", walt.id), undefined);
  // Inviting a member again changes nothing and notifies nobody.
  await command(owner, { action: "member.invite", workspaceId: wid, email: vera.email, role: "editor" });
  assert.equal((await membership(vera.id))?.role, "viewer");
  assert.equal(Number((await one<{ n: number }>("SELECT COUNT(*) n FROM notifications WHERE user_id=?", vera.id))!.n), 1);
  // As a guest: a guest.
  const gus = await account("Gus");
  await command(owner, { action: "member.invite", workspaceId: wid, email: gus.email, role: "viewer", guest: true });
  assert.equal(await isGuest(gus.id), true);
  // Disabled accounts are not added.
  const dan = await account("Dan");
  await run("UPDATE users SET disabled=1 WHERE id=?", dan.id);
  await command(owner, { action: "member.invite", workspaceId: wid, email: dan.email, role: "viewer" });
  assert.equal(await membership(dan.id), undefined);
});

test("leaving after a direct add works like any leave", async () => {
  const lou = await account("Lou");
  await command(owner, { action: "member.invite", workspaceId: wid, email: lou.email, role: "editor" });
  assert.ok(await membership(lou.id));
  await command(lou, { action: "workspace.leave", workspaceId: wid, confirmName: "Team Nord" });
  assert.equal(await membership(lou.id), undefined);
});
