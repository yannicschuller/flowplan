import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Identity } from "../lib/types";
process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-share-protection-"));
process.env.APP_URL = "https://flowplan.example.test";
const { id, run, one } = await import("../lib/db");
const { command, bootstrap } = await import("../lib/api");
const { createWorkspace } = await import("../lib/seed");
const { sharedContent, mutateSharedContent } = await import("../lib/shared-content");
const { publicPage, publicFile } = await import("../lib/publication");
const { listShareLinks } = await import("../lib/share-links");
const { shareAccess } = await import("../lib/share-presence");
const { guestUpload } = await import("../lib/shared-uploads");
const { copyPublication } = await import("../lib/publication-copy");
const access = await import("../lib/share-access");

function user(name: string): Identity {
  const uid = id();
  run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, name, `${name}@example.com`);
  return { id: uid, name, email: `${name}@example.com`, groups: [], isAdmin: false, disabled: 0, created_at: "" };
}
const owner = user("owner"),
  wid = createWorkspace(owner.id, "Sharing"),
  boot = bootstrap(owner, wid);
const page = (extra = {}) =>
  (command(owner, { action: "page.create", workspaceId: wid, spaceId: boot.spaces[0].id, title: "Shared", ...extra }) as { id: string }).id;
const link = (pageId: string, extra: Record<string, unknown> = {}) =>
  (command(owner, { action: "share.create", pageId, role: "editor", name: "Kunde", ...extra }) as { token: string }).token;
const status = (fn: () => unknown, code: number) => assert.throws(fn, (e: { status?: number }) => e.status === code);
// A page with a file that its document links.
function withFile(pid: string) {
  const fid = id();
  run("INSERT INTO files(id,page_id,name,mime,size,created_by) VALUES(?,?,?,?,?,?)", fid, pid, "plan.txt", "text/plain", 1, owner.id);
  run("UPDATE documents SET html=? WHERE page_id=?", `<p><a href="/api/files/${fid}">Plan</a></p>`, pid);
  return fid;
}
// What the unlock route does: the right password gives the cookie value.
const unlock = async (token: string, password: string, address = "10.0.0.1") => (await access.unlockShare(token, password, address)).value;

test("a link with a password needs it for pages, records, files, live updates and uploads", async () => {
  const pid = page(),
    fid = withFile(pid),
    token = link(pid, { password: "geheim-123" });
  const stored = one<{ password_hash: string }>("SELECT password_hash FROM share_links WHERE token=?", token)!;
  assert.match(stored.password_hash, /^scrypt\$/, "hashed with the app's password hashing");
  assert.ok(!JSON.stringify(listShareLinks(owner, pid)).includes("scrypt"), "the hash never leaves the server");
  assert.equal(listShareLinks(owner, pid)[0].password, true);
  // Without the cookie: nothing.
  status(() => sharedContent(token, pid), 401);
  status(() => publicPage(token), 401);
  status(() => publicFile(token, fid), 401);
  status(() => shareAccess(token, pid), 401);
  status(() => mutateSharedContent(token, { action: "comment", pageId: pid, name: "Gast", body: "Hallo" }), 401);
  await assert.rejects(guestUpload(token, pid, new File(["x"], "x.txt", { type: "text/plain" })), (e: { status?: number }) => e.status === 401);
  assert.equal(access.shareState(token, undefined), "password");
  // Wrong password: refused.
  await assert.rejects(unlock(token, "falsch-falsch"), /Passwort stimmt nicht/);
  // Right password: a signed value for the cookie, only for this link's paths.
  const { value, maxAge } = await access.unlockShare(token, "geheim-123", "10.0.0.1");
  assert.ok(maxAge > 0 && maxAge <= 12 * 3600);
  const cookies = access.unlockCookies(token, value, maxAge);
  assert.deepEqual(
    cookies.map((c) => /Path=([^;]+)/.exec(c)![1]),
    [`/share/${token}`, `/api/share/${token}`],
  );
  assert.ok(cookies.every((c) => /HttpOnly/.test(c) && /SameSite=Lax/.test(c) && /Secure/.test(c)));
  assert.equal(access.shareState(token, value), "open");
  access.withShareCookie(value, () => {
    assert.equal(sharedContent(token, pid).title, "Shared");
    assert.equal(publicFile(token, fid).id, fid);
    assert.equal(shareAccess(token, pid).id, pid);
  });
  // The cookie parsed from a request header works the same way.
  const req = new Request("https://flowplan.example.test/api/share/x", { headers: { cookie: `other=1; ${access.SHARE_COOKIE}=${encodeURIComponent(value)}` } });
  assert.equal(access.withShareRequest(req, () => publicPage(token).page.id), pid);
  // A made-up or altered value does not open it.
  status(() => access.withShareCookie(`${Date.now() + 60_000}.abc`, () => publicPage(token)), 401);
  status(() => access.withShareCookie(value.replace(/^\d+/, String(Date.now() + 10 * 86400_000)), () => publicPage(token)), 401);
});

test("the unlock is scoped to its link and ends with a new password", async () => {
  const a = page(),
    b = page(),
    tokenA = link(a, { password: "passwort-a" }),
    tokenB = link(b, { password: "passwort-a" }),
    otherOnA = link(a, { password: "passwort-a", name: "Zweiter" });
  const value = await unlock(tokenA, "passwort-a");
  // Same password, other link: the cookie of A opens neither B nor A's second link.
  status(() => access.withShareCookie(value, () => publicPage(tokenB)), 401);
  status(() => access.withShareCookie(value, () => publicPage(otherOnA)), 401);
  assert.equal(access.withShareCookie(value, () => publicPage(tokenA)).page.id, a);
  // A new password ends every unlock of the old one.
  command(owner, { action: "share.protect", pageId: a, token: tokenA, password: "passwort-neu" });
  status(() => access.withShareCookie(value, () => publicPage(tokenA)), 401);
  assert.equal(access.withShareCookie(await unlock(tokenA, "passwort-neu"), () => publicPage(tokenA)).page.id, a);
  // Too short, and only owners of the page set it.
  status(() => command(owner, { action: "share.protect", pageId: a, token: tokenA, password: "kurz" }), 400);
  const viewer = user("viewer");
  run("INSERT INTO members VALUES(?,?,?)", wid, viewer.id, "viewer");
  status(() => command(viewer, { action: "share.protect", pageId: a, token: tokenA, password: null }), 403);
});

test("wrong passwords are limited per link and address", async () => {
  const pid = page(),
    token = link(pid, { password: "richtig-123" });
  for (let i = 0; i < 10; i++) await assert.rejects(unlock(token, `falsch-${i}`, "10.9.9.9"), /stimmt nicht/);
  // Now even the right password waits – from this address.
  await assert.rejects(unlock(token, "richtig-123", "10.9.9.9"), /Zu viele Versuche/);
  assert.ok(await unlock(token, "richtig-123", "10.9.9.10"));
  // Unknown links get no hint beyond "not found".
  await assert.rejects(access.unlockShare(id(), "egal-egal", "10.9.9.11"), (e: { status?: number }) => e.status === 404);
});

test("after its end date a link shows nothing, files included", async () => {
  const pid = page(),
    fid = withFile(pid);
  status(() => link(pid, { expiresAt: Date.now() - 1000 }), 400);
  const token = link(pid, { expiresAt: Date.now() + 3_600_000 });
  assert.equal(publicPage(token).page.id, pid);
  assert.equal(publicFile(token, fid).id, fid);
  const listed = listShareLinks(owner, pid).find((l) => l.token === token)!;
  assert.ok(listed.expires_at! > Date.now());
  // The end passes.
  run("UPDATE share_links SET expires_at=? WHERE token=?", Date.now() - 1, token);
  assert.equal(access.shareState(token, undefined), "expired");
  status(() => publicPage(token), 410);
  status(() => publicFile(token, fid), 410);
  status(() => sharedContent(token, pid), 410);
  status(() => shareAccess(token, pid), 410);
  await assert.rejects(access.unlockShare(token, "egal-egal", "10.0.0.2"), (e: { status?: number }) => e.status === 410);
  // Owners extend it or remove the end.
  command(owner, { action: "share.protect", pageId: pid, token, expiresAt: Date.now() + 86_400_000 });
  assert.equal(publicPage(token).page.id, pid);
  command(owner, { action: "share.protect", pageId: pid, token, expiresAt: null });
  assert.equal(listShareLinks(owner, pid).find((l) => l.token === token)!.expires_at, null);
  // The unlock cookie never outlives the link.
  const protectedToken = link(pid, { password: "geheim-456", expiresAt: Date.now() + 120_000 });
  const { maxAge } = await access.unlockShare(protectedToken, "geheim-456", "10.0.0.3");
  assert.ok(maxAge <= 120);
});

test("removing the password opens the link again", async () => {
  const pid = page(),
    token = link(pid, { password: "geheim-789" });
  status(() => sharedContent(token, pid), 401);
  command(owner, { action: "share.protect", pageId: pid, token, password: null });
  assert.equal(one<{ password_hash: string | null }>("SELECT password_hash FROM share_links WHERE token=?", token)!.password_hash, null);
  assert.equal(sharedContent(token, pid).title, "Shared");
  assert.equal(listShareLinks(owner, pid)[0].password, false);
  // Unchanged fields stay as they are.
  command(owner, { action: "share.protect", pageId: pid, token, expiresAt: Date.now() + 60_000 });
  assert.equal(listShareLinks(owner, pid)[0].password, false);
});

test("publications take a password and an end date too, kept when published again", async () => {
  const pid = page(),
    fid = withFile(pid);
  command(owner, { action: "page.publish", pageId: pid, enabled: true });
  const token = one<{ public_token: string }>("SELECT public_token FROM pages WHERE id=?", pid)!.public_token;
  assert.equal(publicPage(token).page.id, pid);
  command(owner, { action: "publication.protect", pageId: pid, password: "oeffentlich-1" });
  status(() => publicPage(token), 401);
  status(() => publicFile(token, fid), 401);
  // Changing the publication's options keeps the password.
  command(owner, { action: "page.publish", pageId: pid, enabled: true, includeChildren: true, allowCopy: true });
  status(() => publicPage(token), 401);
  const value = await unlock(token, "oeffentlich-1");
  assert.equal(access.withShareCookie(value, () => publicFile(token, fid)).id, fid);
  // Behind a password, a publication is not copied away.
  const visitor = user("visitor"),
    own = createWorkspace(visitor.id, "Eigener"),
    ownBoot = bootstrap(visitor, own);
  status(() => copyPublication(visitor, { token, workspaceId: own, spaceId: ownBoot.spaces[0].id }), 403);
  command(owner, { action: "publication.protect", pageId: pid, expiresAt: Date.now() + 60_000 });
  run("UPDATE publications SET expires_at=? WHERE page_id=?", Date.now() - 1, pid);
  status(() => access.withShareCookie(value, () => publicPage(token)), 410);
  // Unpublished and published again: a fresh start.
  command(owner, { action: "page.publish", pageId: pid, enabled: false });
  command(owner, { action: "page.publish", pageId: pid, enabled: true });
  const again = one<{ public_token: string }>("SELECT public_token FROM pages WHERE id=?", pid)!.public_token;
  assert.equal(publicPage(again).page.id, pid);
  status(() => command(owner, { action: "publication.protect", pageId: page(), password: "egal-egal" }), 400);
});
