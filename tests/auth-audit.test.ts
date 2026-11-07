// Security audit (Nov 2026), sign-in: an API token must not start an app
// hand-off (it would mint a full session that outlives the token), and a
// session from a hand-off is only as "recent" as the browser session that
// confirmed it (step-up).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomBytes } from "node:crypto";
process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-auth-audit-"));
const { run, id } = await import("../lib/db");
const { hash } = await import("../lib/auth");
const { createDesktopCode, redeemDesktopCode } = await import("../lib/desktop-sign-in");
const { sessionStartedAt, stepUpMethods } = await import("../lib/step-up");

const uid = id();
await run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", uid, `https://idp|${uid}`, "Sam", "sam@example.test");

test("the desktop hand-off refuses API-token identities (source guard)", () => {
  const route = readFileSync(join(import.meta.dirname, "../app/api/auth/[action]/route.ts"), "utf8");
  const post = route.slice(route.indexOf('if (action === "desktop") {'));
  assert.match(post.slice(0, 900), /user\.apiScope/, "POST desktop must refuse API tokens");
  const get = route.slice(route.indexOf("App sign-in: the browser opened the hand-off"));
  assert.match(get.slice(0, 400), /user\.apiScope/, "GET desktop must treat API tokens as not signed in");
});

test("a hand-off carries the browser session's sign-in time into the app session", async () => {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const signedIn = Date.now() - 3 * 3600_000;
  const code = await createDesktopCode(uid, [], challenge, signedIn);
  const handoff = (await redeemDesktopCode(code, verifier))!;
  assert.equal(handoff.authenticatedAt, signedIn);
  // The new session (created now) counts as signed in when the browser did.
  const token = randomBytes(32).toString("base64url");
  await run(
    "INSERT INTO sessions(token,user_id,groups_json,expires,created_at,authenticated_at) VALUES(?,?,?,?,?,?)",
    hash(token), uid, "[]", Date.now() + 3600_000, Date.now(), handoff.authenticatedAt,
  );
  assert.equal(await sessionStartedAt(token), signedIn);
  assert.equal((await stepUpMethods(uid, await sessionStartedAt(token))).recentOk, false);
  // A genuinely fresh sign-in still passes.
  const fresh = randomBytes(32).toString("base64url");
  await run("INSERT INTO sessions(token,user_id,groups_json,expires,created_at,authenticated_at) VALUES(?,?,?,?,?,?)", hash(fresh), uid, "[]", Date.now() + 3600_000, Date.now(), Date.now());
  assert.equal((await stepUpMethods(uid, await sessionStartedAt(fresh))).recentOk, true);
});

// Security audit hardening: sessions end where a sign-in method changes.
const authRoute = () => readFileSync(join(import.meta.dirname, "../app/api/auth/[action]/route.ts"), "utf8");
const block = (source: string, marker: string, length: number) => {
  const at = source.indexOf(marker);
  assert.ok(at >= 0, marker);
  return source.slice(at, at + length);
};

test("turning on the authenticator app or removing a passkey ends the other sessions", () => {
  const route = authRoute();
  assert.match(block(route, 'if (action === "totp-confirm")', 400), /confirmTotpSetup[\s\S]*endOtherSessions\(user\.id\)/);
  assert.match(block(route, 'else if (action === "passkey-delete")', 400), /deletePasskey\(user\.id, id\)\) await endOtherSessions\(user\.id\)/);
});

test("deletePasskey tells whether a passkey was removed", async () => {
  const { deletePasskey } = await import("../lib/local-auth");
  await run("INSERT INTO passkeys(id,user_id,public_key,counter,transports,name,created_at) VALUES(?,?,?,?,?,?,?)", "pk-1", uid, Buffer.from([1]), 0, "[]", "Key", Date.now());
  assert.equal(await deletePasskey(uid, "pk-1"), true);
  assert.equal(await deletePasskey(uid, "pk-1"), false, "gone already");
  assert.equal(await deletePasskey(id(), "pk-1"), false);
});

test("the e-mail confirmation link signs in only where other sign-ins would (SSO-only accounts)", () => {
  const verify = block(authRoute(), 'if (action === "verify") {', 900);
  assert.match(verify, /const here = [^;]*!\(await ssoOnlyAccount\(userId\)\)/);
});

test("starting a demo while signed in ends the previous session", () => {
  const trial = block(authRoute(), 'if (action === "trial") {', 900);
  const ends = trial.indexOf('run("DELETE FROM sessions WHERE token=?", hash(previous))');
  assert.ok(ends > 0, "the previous session row is deleted");
  assert.ok(ends < trial.indexOf("issueSession("), "before the demo session is issued");
});
