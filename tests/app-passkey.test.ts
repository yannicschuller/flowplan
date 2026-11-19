import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-app-passkey-"));
process.env.APP_URL = "https://flowplan.example.test";
const { one, run, id } = await import("../lib/db");
const { hash } = await import("../lib/auth");
const auth = await import("../lib/local-auth");
const { securityWritesSettled } = await import("../lib/security-events");
const app = await import("../lib/app-passkey");

// "Passkey hinzufügen" in the app (lib/app-passkey.ts): a one-time token for
// the system's sign-in sheet, good for one passkey ceremony of its account.
async function localUser(name: string) {
  const userId = id();
  const email = `${name.toLowerCase()}-${userId.slice(0, 8)}@example.test`;
  await run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", userId, `local|${userId}`, name, email);
  await run("INSERT INTO local_accounts(user_id,email,password_hash,created_at) VALUES(?,?,?,?)", userId, email, await auth.hashPassword("ein-langes-passwort"), Date.now());
  return { id: userId, name, email };
}
const forged = { response: { id: "x", rawId: "x", type: "public-key", response: {} } };

test("the link: only for accounts with e-mail and password, kept hashed, five minutes", async () => {
  const ana = await localUser("Ana");
  const token = await auth.issueAppPasskeyToken(ana, "de");
  assert.ok(app.isAppPasskeyToken(token));
  assert.equal(await one("SELECT 1 FROM auth_tokens WHERE id=?", token), undefined, "never stored in the clear");
  const row = await one<{ kind: string; user_id: string; expires: number }>("SELECT kind,user_id,expires FROM auth_tokens WHERE id=?", hash(token));
  assert.equal(row?.kind, "passkey-app");
  assert.equal(row?.user_id, ana.id);
  assert.ok(Math.abs(row!.expires - Date.now() - 5 * 60_000) < 5_000);
  assert.equal(auth.APP_PASSKEY_LINK_MS, 5 * 60_000);
  // SSO accounts sign in with their provider.
  const sso = id();
  await run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", sso, "https://id.example|7", "Sso", "sso7@example.test");
  await assert.rejects(auth.issueAppPasskeyToken({ id: sso }, "en"), /SSO accounts/);
  // A new link replaces the previous one.
  const next = await auth.issueAppPasskeyToken(ana, "de");
  assert.equal(await auth.appPasskeyTokenAccount(token), null);
  assert.deepEqual(await auth.appPasskeyTokenAccount(next), { name: "Ana", email: ana.email });
  await securityWritesSettled();
  assert.ok(await one("SELECT 1 FROM security_events WHERE kind='account.passkey_app_link' AND actor_id=?", ana.id));
});

test("the link is used once: looking at it keeps it, the ceremony uses it up", async () => {
  const ben = await localUser("Ben");
  const token = await auth.issueAppPasskeyToken(ben, "de");
  assert.ok(await auth.appPasskeyTokenAccount(token));
  assert.ok(await auth.appPasskeyTokenAccount(token), "looking does not use it");
  const { options, token: ceremony } = await auth.appPasskeyRegistrationOptions(token, "de");
  assert.equal(options.rp.id, "flowplan.example.test");
  assert.equal(new TextDecoder().decode(Buffer.from(options.user.id, "base64url")), ben.id, "the ceremony is the token's account's");
  await assert.rejects(auth.appPasskeyRegistrationOptions(token, "de"), /abgelaufen oder wurde schon benutzt/);
  assert.equal(await auth.appPasskeyTokenAccount(token), null);
  // The ceremony reaches the check of the passkey – for its account – once.
  await assert.rejects(auth.finishAppPasskeyRegistration(ceremony, forged, "de"), /nicht geprüft/);
  await assert.rejects(auth.finishAppPasskeyRegistration(ceremony, forged, "de"), /abgelaufen/);
  await securityWritesSettled();
  assert.ok(await one("SELECT 1 FROM security_events WHERE kind='account.passkey_app_link_used' AND actor_id=?", ben.id));
});

test("two exchanges at the same moment: only one gets the ceremony", async () => {
  const cem = await localUser("Cem");
  const token = await auth.issueAppPasskeyToken(cem, "de");
  const results = await Promise.allSettled([auth.appPasskeyRegistrationOptions(token, "de"), auth.appPasskeyRegistrationOptions(token, "de")]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
});

test("an expired link does nothing", async () => {
  const dana = await localUser("Dana");
  const token = await auth.issueAppPasskeyToken(dana, "de");
  await run("UPDATE auth_tokens SET expires=? WHERE id=?", Date.now() - 1, hash(token));
  assert.equal(await auth.appPasskeyTokenAccount(token), null);
  await assert.rejects(auth.appPasskeyRegistrationOptions(token, "en"), /expired or was already used/);
  // A disabled account neither.
  const other = await auth.issueAppPasskeyToken(dana, "de");
  await run("UPDATE users SET disabled=1 WHERE id=?", dana.id);
  assert.equal(await auth.appPasskeyTokenAccount(other), null);
  await assert.rejects(auth.appPasskeyRegistrationOptions(other, "de"), /abgelaufen/);
  // Nonsense is refused before the database.
  for (const value of [undefined, "", "x", 42, "a".repeat(44)]) await assert.rejects(auth.appPasskeyRegistrationOptions(value, "de"), /abgelaufen/);
});

test("wrong account: the ceremony stays with the account of the link", async () => {
  const eva = await localUser("Eva"),
    finn = await localUser("Finn");
  const { token: ceremony } = await auth.appPasskeyRegistrationOptions(await auth.issueAppPasskeyToken(eva, "de"), "de");
  // A session of another account in the sheet's browser cannot take it.
  await assert.rejects(auth.finishPasskeyRegistration(finn, ceremony, forged, "de"), /abgelaufen/);
  assert.deepEqual(await auth.listPasskeys(finn.id), []);
  // Finn's own link gives Finn's ceremony, never Eva's.
  const { options } = await auth.appPasskeyRegistrationOptions(await auth.issueAppPasskeyToken(finn, "de"), "de");
  assert.equal(new TextDecoder().decode(Buffer.from(options.user.id, "base64url")), finn.id);
});

test("wrong purpose: the link is no reset or confirmation link, and the other way round", async () => {
  const gil = await localUser("Gil");
  const resetLink = await auth.adminResetLink(gil.id);
  const resetToken = new URL(resetLink).searchParams.get("token")!;
  await assert.rejects(auth.appPasskeyRegistrationOptions(resetToken, "de"), /abgelaufen/);
  assert.equal(await auth.appPasskeyTokenAccount(resetToken), null);
  const token = await auth.issueAppPasskeyToken(gil, "de");
  await assert.rejects(auth.resetPassword({ token, password: "ein-ganz-neues-passwort" }, "de"));
  assert.equal(await auth.verifyEmail(token), null);
  // Neither used the other up.
  assert.ok(await auth.appPasskeyTokenAccount(token));
  await auth.resetPassword({ token: resetToken, password: "ein-ganz-neues-passwort" }, "de");
  // A login or step-up challenge is no registration ceremony.
  const login = await auth.passkeyLoginOptions();
  await assert.rejects(auth.finishAppPasskeyRegistration(login.token, forged, "de"), /abgelaufen/);
  await run("INSERT INTO passkeys(id,user_id,public_key,counter,transports,name,created_at) VALUES(?,?,?,?,?,?,?)", `gil-${gil.id}`, gil.id, Buffer.from([1]), 0, "[]", "Passkey", Date.now());
  const confirm = await auth.passkeyConfirmOptions(gil.id, "de");
  await assert.rejects(auth.finishAppPasskeyRegistration(confirm.token, forged, "de"), /abgelaufen/);
  await assert.rejects(auth.finishAppPasskeyRegistration(undefined, forged, "de"), /abgelaufen/);
});

test("links are limited per account", async () => {
  const hana = await localUser("Hana"),
    ivo = await localUser("Ivo");
  for (let i = 0; i < auth.APP_PASSKEY_LINKS.max; i++) await auth.issueAppPasskeyToken(hana, "de");
  await assert.rejects(auth.issueAppPasskeyToken(hana, "en"), (e: { status?: number; message: string }) => e.status === 429 && /Too many attempts/.test(e.message));
  // Others are not affected; after the window it works again.
  await auth.issueAppPasskeyToken(ivo, "de");
  await auth.issueAppPasskeyToken(hana, "de", Date.now() + auth.APP_PASSKEY_LINKS.windowMs + 1);
});

test("the desktop app's window asks whether its link was used – its own only", async () => {
  const jo = await localUser("Jo"),
    kim = await localUser("Kim");
  const token = await auth.issueAppPasskeyToken(jo, "de");
  assert.equal(await auth.appPasskeyLinkStatus(jo.id, token), "waiting");
  // Another account learns nothing about it.
  assert.equal(await auth.appPasskeyLinkStatus(kim.id, token), "gone");
  assert.equal(await auth.appPasskeyLinkStatus(jo.id, "nonsense"), "gone");
  assert.equal(await auth.appPasskeyLinkStatus(jo.id, undefined), "gone");
  await auth.appPasskeyRegistrationOptions(token, "de");
  assert.equal(await auth.appPasskeyLinkStatus(jo.id, token), "used");
  // Used stays used – it gives no second ceremony – until the ceremony's time is up.
  await assert.rejects(auth.appPasskeyRegistrationOptions(token, "de"), /abgelaufen/);
  assert.equal(await auth.appPasskeyLinkStatus(jo.id, token, Date.now() + 6 * 60_000), "gone");
  // A new link does not undo the used one's state.
  const next = await auth.issueAppPasskeyToken(jo, "de");
  assert.equal(await auth.appPasskeyLinkStatus(jo.id, token), "used");
  assert.equal(await auth.appPasskeyLinkStatus(jo.id, next), "waiting");
  // Expired without use: gone.
  await run("UPDATE auth_tokens SET expires=? WHERE id=?", Date.now() - 1, hash(next));
  assert.equal(await auth.appPasskeyLinkStatus(jo.id, next), "gone");
});

test("the desktop window waits for the new passkey, the link's end, a cancel or the time", async () => {
  const known = new Set(["old"]);
  const answers = (list: { status: "waiting" | "used" | "gone"; passkeys: { id: string }[] }[]) => {
    let i = 0;
    return async () => list[Math.min(i++, list.length - 1)];
  };
  const fast = { sleep: async () => {}, intervalMs: 0 };
  assert.equal(
    await app.waitForDesktopPasskey(answers([{ status: "waiting", passkeys: [{ id: "old" }] }, { status: "used", passkeys: [{ id: "old" }] }, { status: "used", passkeys: [{ id: "old" }, { id: "new" }] }]), known, fast),
    "added",
  );
  assert.equal(await app.waitForDesktopPasskey(answers([{ status: "used", passkeys: [] }, { status: "gone", passkeys: [{ id: "old" }] }]), known, fast), "gone");
  // A passkey that arrived just before the link went still counts.
  assert.equal(await app.waitForDesktopPasskey(answers([{ status: "gone", passkeys: [{ id: "new" }] }]), known, fast), "added");
  let stop = false;
  const cancelling = app.waitForDesktopPasskey(
    async () => {
      stop = true;
      return { status: "waiting", passkeys: [] };
    },
    known,
    { ...fast, cancelled: () => stop },
  );
  assert.equal(await cancelling, "cancelled");
  let clock = 0;
  assert.equal(await app.waitForDesktopPasskey(answers([{ status: "waiting", passkeys: [] }]), known, { sleep: async () => void (clock += 1000), now: () => clock, limitMs: 5000 }), "timeout");
  // An unanswered request is just asked again.
  let calls = 0;
  assert.equal(
    await app.waitForDesktopPasskey(
      async () => {
        if (++calls < 3) throw new Error("offline");
        return { status: "used", passkeys: [{ id: "new" }] };
      },
      known,
      fast,
    ),
    "added",
  );
});

test("the callback: only the app's own scheme, host and state", () => {
  const ok = "flowplan://passkey?state=abcdefghijklmnop0123";
  assert.equal(app.isAppPasskeyReturn(ok), true);
  for (const bad of [
    "https://evil.example/passkey?state=abcdefghijklmnop0123",
    "flowplan://sign-in?state=abcdefghijklmnop0123",
    "flowplan://passkey",
    "flowplan://passkey?state=short",
    "flowplan://passkey?state=abcdefghijklmnop0123&next=https://evil.example",
    "flowplan://passkey?state=abcdefghijklmnop0123#x",
    "FLOWPLAN://passkey?state=abcdefghijklmnop0123",
    "flowplan://passkey.evil.example?state=abcdefghijklmnop0123",
    "javascript:alert(1)//flowplan://passkey?state=abcdefghijklmnop0123",
    "flowplan://passkey?state=abcdefghijklmnop0123\n",
    "flowplan://passkey?state=" + "a".repeat(129),
    undefined,
    42,
  ])
    assert.equal(app.isAppPasskeyReturn(bad), false, String(bad));
  assert.equal(app.appPasskeyCallback(ok, "added"), `${ok}&status=added`);
  assert.throws(() => app.appPasskeyCallback("https://evil.example/?state=abcdefghijklmnop0123", "added"));
  assert.equal(app.appPasskeyLink("https://flowplan.example.test/", "tok_en-1"), "https://flowplan.example.test/passkey-add?token=tok_en-1");
});

test("the passkey's name and the app's answer", async () => {
  assert.equal(app.passkeyName("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Safari/604.1"), "Passkey · iPhone");
  // iPadOS' Safari names itself a Mac.
  assert.equal(app.passkeyName("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Safari/605.1.15", 5), "Passkey · iPad");
  assert.equal(app.passkeyName("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Safari/605.1.15", 0), "Passkey · Mac");
  assert.equal(app.passkeyName("Mozilla/5.0 (Linux; Android 15; Pixel 9) Chrome/140.0 Mobile Safari/537.36"), "Passkey · Android");
  assert.equal(app.passkeyName(""), "Passkey");
  assert.equal(app.appAddsPasskey({ addPasskey: () => {} }), true);
  assert.equal(app.appAddsPasskey({}), false);
  assert.equal(app.appAddsPasskey(undefined), false);
  assert.equal(app.appPasskeyAnswer({ status: "added" }), "added");
  assert.equal(app.appPasskeyAnswer({ status: "opened" }), null);
  assert.equal(app.appPasskeyAnswer(null), null);

  const target = new EventTarget();
  let started = 0;
  const waiting = app.waitForAppPasskey(target as never, () => {
    started++;
    target.dispatchEvent(new CustomEvent("flowplan:passkey", { detail: { status: "nonsense" } }));
    target.dispatchEvent(new CustomEvent("flowplan:passkey", { detail: { status: "cancelled" } }));
  });
  assert.equal(await waiting, "cancelled");
  assert.equal(started, 1);
  // No answer: null after the wait, nothing left listening.
  let fire: () => void = () => {};
  const silent = app.waitForAppPasskey(target as never, () => {}, 10, { set: (run) => ((fire = run), 1), clear: () => {} });
  fire();
  assert.equal(await silent, null);
  // The bridge throws: the caller hears it.
  await assert.rejects(app.waitForAppPasskey(target as never, () => { throw new Error("bridge"); }, 10), /bridge/);
});

test("the route issues the link only to a browser session, and the page validates the callback", () => {
  const route = readFileSync(new URL("../app/api/auth/[action]/handler.ts", import.meta.url), "utf8");
  const block = route.slice(route.indexOf('"passkey-app-link", "passkey-app-status"].includes(action)'));
  assert.match(block.slice(0, 800), /!user \|\| user\.demo/);
  assert.match(block.slice(0, 800), /user\.apiScope/);
  assert.match(block.slice(0, 1600), /twoFactorSetup/);
  const page = readFileSync(new URL("../app/passkey-add/page.tsx", import.meta.url), "utf8");
  assert.match(page, /isAppPasskeyReturn\(params\.return\)/);
  // A callback given but invalid: the token is not even looked up.
  assert.match(page, /returnTo === false \? null : await appPasskeyTokenAccount\(token\)/);
  assert.match(block.slice(0, 2600), /"passkey-app-status"[\s\S]*appPasskeyLinkStatus\(user\.id, token\)/);
  assert.match(page, /referrer: "no-referrer"/);
});
