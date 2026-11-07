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

async function user(name: string): Promise<Identity> {
  const uid = id();
  await run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, uid, name, `${name}@example.com`);
  return { id: uid, name, email: `${name}@example.com`, groups: [], isAdmin: false, disabled: 0, created_at: "" };
}
const owner = await user("owner"),
  wid = await createWorkspace(owner.id, "Sharing"),
  boot = await bootstrap(owner, wid);
const page = async (extra = {}) =>
  ((await command(owner, { action: "page.create", workspaceId: wid, spaceId: boot.spaces[0].id, title: "Shared", ...extra })) as { id: string }).id;
const link = async (pageId: string, extra: Record<string, unknown> = {}) =>
  ((await command(owner, { action: "share.create", pageId, role: "editor", name: "Kunde", ...extra })) as { token: string }).token;
const status = async (fn: () => unknown, code: number) => assert.rejects(async () => fn(), (e: { status?: number }) => e.status === code);
// A page with a file that its document links.
async function withFile(pid: string) {
  const fid = id();
  await run("INSERT INTO files(id,page_id,name,mime,size,created_by) VALUES(?,?,?,?,?,?)", fid, pid, "plan.txt", "text/plain", 1, owner.id);
  await run("UPDATE documents SET html=? WHERE page_id=?", `<p><a href="/api/files/${fid}">Plan</a></p>`, pid);
  return fid;
}
// What the unlock route does: the right password gives the cookie value.
const unlock = async (token: string, password: string, address = "10.0.0.1") => (await access.unlockShare(token, password, address)).value;

test("a link with a password needs it for pages, records, files, live updates and uploads", async () => {
  const pid = await page(),
    fid = await withFile(pid),
    token = await link(pid, { password: "geheim-123" });
  const stored = (await one<{ password_hash: string }>("SELECT password_hash FROM share_links WHERE token=?", token))!;
  assert.match(stored.password_hash, /^scrypt\$/, "hashed with the app's password hashing");
  assert.ok(!JSON.stringify(await listShareLinks(owner, pid)).includes("scrypt"), "the hash never leaves the server");
  assert.equal((await listShareLinks(owner, pid))[0].password, true);
  // Without the cookie: nothing.
  await status(async () => await sharedContent(token, pid), 401);
  await status(async () => await publicPage(token), 401);
  await status(async () => await publicFile(token, fid), 401);
  await status(async () => await shareAccess(token, pid), 401);
  await status(async () => await mutateSharedContent(token, { action: "comment", pageId: pid, name: "Gast", body: "Hallo" }), 401);
  await assert.rejects(guestUpload(token, pid, new File(["x"], "x.txt", { type: "text/plain" })), (e: { status?: number }) => e.status === 401);
  assert.equal(await access.shareState(token, undefined), "password");
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
  assert.equal(await access.shareState(token, value), "open");
  await access.withShareCookie(value, async () => {
    assert.equal((await sharedContent(token, pid)).title, "Shared");
    assert.equal((await publicFile(token, fid)).id, fid);
    assert.equal((await shareAccess(token, pid)).id, pid);
  });
  // The cookie parsed from a request header works the same way.
  const req = new Request("https://flowplan.example.test/api/share/x", { headers: { cookie: `other=1; ${access.SHARE_COOKIE}=${encodeURIComponent(value)}` } });
  assert.equal(await access.withShareRequest(req, async () => (await publicPage(token)).page.id), pid);
  // A made-up or altered value does not open it.
  await status(async () => await access.withShareCookie(`${Date.now() + 60_000}.abc`, async () => await publicPage(token)), 401);
  await status(async () => await access.withShareCookie(value.replace(/^\d+/, String(Date.now() + 10 * 86400_000)), async () => await publicPage(token)), 401);
});

test("the unlock is scoped to its link and ends with a new password", async () => {
  const a = await page(),
    b = await page(),
    tokenA = await link(a, { password: "passwort-a" }),
    tokenB = await link(b, { password: "passwort-a" }),
    otherOnA = await link(a, { password: "passwort-a", name: "Zweiter" });
  const value = await unlock(tokenA, "passwort-a");
  // Same password, other link: the cookie of A opens neither B nor A's second link.
  await status(async () => await access.withShareCookie(value, async () => await publicPage(tokenB)), 401);
  await status(async () => await access.withShareCookie(value, async () => await publicPage(otherOnA)), 401);
  assert.equal((await access.withShareCookie(value, async () => await publicPage(tokenA))).page.id, a);
  // A new password ends every unlock of the old one.
  await command(owner, { action: "share.protect", pageId: a, token: tokenA, password: "passwort-neu" });
  await status(async () => await access.withShareCookie(value, async () => await publicPage(tokenA)), 401);
  assert.equal((await access.withShareCookie(await unlock(tokenA, "passwort-neu"), async () => await publicPage(tokenA))).page.id, a);
  // Too short, and only owners of the page set it.
  await status(async () => await command(owner, { action: "share.protect", pageId: a, token: tokenA, password: "kurz" }), 400);
  const viewer = await user("viewer");
  await run("INSERT INTO members VALUES(?,?,?)", wid, viewer.id, "viewer");
  await status(async () => await command(viewer, { action: "share.protect", pageId: a, token: tokenA, password: null }), 403);
});

test("wrong passwords are limited per link and address", async () => {
  const pid = await page(),
    token = await link(pid, { password: "richtig-123" });
  for (let i = 0; i < 10; i++) await assert.rejects(unlock(token, `falsch-${i}`, "10.9.9.9"), /stimmt nicht/);
  // Now even the right password waits – from this address.
  await assert.rejects(unlock(token, "richtig-123", "10.9.9.9"), /Zu viele Versuche/);
  assert.ok(await unlock(token, "richtig-123", "10.9.9.10"));
  // Unknown links get no hint beyond "not found".
  await assert.rejects(access.unlockShare(id(), "egal-egal", "10.9.9.11"), (e: { status?: number }) => e.status === 404);
});

test("after its end date a link shows nothing, files included", async () => {
  const pid = await page(),
    fid = await withFile(pid);
  await status(async () => await link(pid, { expiresAt: Date.now() - 1000 }), 400);
  const token = await link(pid, { expiresAt: Date.now() + 3_600_000 });
  assert.equal((await publicPage(token)).page.id, pid);
  assert.equal((await publicFile(token, fid)).id, fid);
  const listed = (await listShareLinks(owner, pid)).find((l) => l.token === token)!;
  assert.ok(listed.expires_at! > Date.now());
  // The end passes.
  await run("UPDATE share_links SET expires_at=? WHERE token=?", Date.now() - 1, token);
  assert.equal(await access.shareState(token, undefined), "expired");
  await status(async () => await publicPage(token), 410);
  await status(async () => await publicFile(token, fid), 410);
  await status(async () => await sharedContent(token, pid), 410);
  await status(async () => await shareAccess(token, pid), 410);
  await assert.rejects(access.unlockShare(token, "egal-egal", "10.0.0.2"), (e: { status?: number }) => e.status === 410);
  // Owners extend it or remove the end.
  await command(owner, { action: "share.protect", pageId: pid, token, expiresAt: Date.now() + 86_400_000 });
  assert.equal((await publicPage(token)).page.id, pid);
  await command(owner, { action: "share.protect", pageId: pid, token, expiresAt: null });
  assert.equal((await listShareLinks(owner, pid)).find((l) => l.token === token)!.expires_at, null);
  // The unlock cookie never outlives the link.
  const protectedToken = await link(pid, { password: "geheim-456", expiresAt: Date.now() + 120_000 });
  const { maxAge } = await access.unlockShare(protectedToken, "geheim-456", "10.0.0.3");
  assert.ok(maxAge <= 120);
});

test("removing the password opens the link again", async () => {
  const pid = await page(),
    token = await link(pid, { password: "geheim-789" });
  await status(async () => await sharedContent(token, pid), 401);
  await command(owner, { action: "share.protect", pageId: pid, token, password: null });
  assert.equal((await one<{ password_hash: string | null }>("SELECT password_hash FROM share_links WHERE token=?", token))!.password_hash, null);
  assert.equal((await sharedContent(token, pid)).title, "Shared");
  assert.equal((await listShareLinks(owner, pid))[0].password, false);
  // Unchanged fields stay as they are.
  await command(owner, { action: "share.protect", pageId: pid, token, expiresAt: Date.now() + 60_000 });
  assert.equal((await listShareLinks(owner, pid))[0].password, false);
});

test("publications take a password and an end date too, kept when published again", async () => {
  const pid = await page(),
    fid = await withFile(pid);
  await command(owner, { action: "page.publish", pageId: pid, enabled: true });
  const token = (await one<{ public_token: string }>("SELECT public_token FROM pages WHERE id=?", pid))!.public_token;
  assert.equal((await publicPage(token)).page.id, pid);
  await command(owner, { action: "publication.protect", pageId: pid, password: "oeffentlich-1" });
  await status(async () => await publicPage(token), 401);
  await status(async () => await publicFile(token, fid), 401);
  // Changing the publication's options keeps the password.
  await command(owner, { action: "page.publish", pageId: pid, enabled: true, includeChildren: true, allowCopy: true });
  await status(async () => await publicPage(token), 401);
  const value = await unlock(token, "oeffentlich-1");
  assert.equal((await access.withShareCookie(value, async () => await publicFile(token, fid))).id, fid);
  // Behind a password, a publication is not copied away.
  const visitor = await user("visitor"),
    own = await createWorkspace(visitor.id, "Eigener"),
    ownBoot = await bootstrap(visitor, own);
  await status(async () => await copyPublication(visitor, { token, workspaceId: own, spaceId: ownBoot.spaces[0].id }), 403);
  await command(owner, { action: "publication.protect", pageId: pid, expiresAt: Date.now() + 60_000 });
  await run("UPDATE publications SET expires_at=? WHERE page_id=?", Date.now() - 1, pid);
  await status(async () => await access.withShareCookie(value, async () => await publicPage(token)), 410);
  // Unpublished and published again: a fresh start.
  await command(owner, { action: "page.publish", pageId: pid, enabled: false });
  await command(owner, { action: "page.publish", pageId: pid, enabled: true });
  const again = (await one<{ public_token: string }>("SELECT public_token FROM pages WHERE id=?", pid))!.public_token;
  assert.equal((await publicPage(again)).page.id, pid);
  await status(async () => await command(owner, { action: "publication.protect", pageId: await page(), password: "egal-egal" }), 400);
});
