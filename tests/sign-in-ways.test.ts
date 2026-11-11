import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  LAST_SIGN_IN_KEY,
  availableSignInWays,
  chooseSignInWays,
  readLastSignIn,
  writeLastSignIn,
} from "../lib/sign-in-ways";

// The sign-in page shows the fastest way first: one large button for the
// way last used on this device, the others below it.
const all = { sso: true, passkey: true, password: true };

test("only the ways the instance offers are shown", () => {
  assert.deepEqual(availableSignInWays(all), ["sso", "passkey", "password"]);
  // No OIDC (OIDC_ISSUER unset).
  assert.deepEqual(availableSignInWays({ ...all, sso: false }), ["passkey", "password"]);
  // FLOWPLAN_LOCAL_LOGIN=false: no passkeys and no password form, only SSO.
  assert.deepEqual(availableSignInWays({ sso: true, passkey: false, password: false }), ["sso"]);
  // LDAP without local accounts: the password form, no passkeys.
  assert.deepEqual(availableSignInWays({ sso: false, passkey: false, password: true }), ["password"]);
  assert.deepEqual(availableSignInWays({ sso: false, passkey: false, password: false }), []);
});

test("a first visit starts with SSO, then passkeys, then the password", () => {
  assert.deepEqual(chooseSignInWays(["sso", "passkey", "password"], null), {
    main: "sso",
    lastUsed: false,
    secondary: ["passkey"],
    passwordLink: true,
  });
  assert.deepEqual(chooseSignInWays(["passkey", "password"], null), {
    main: "passkey",
    lastUsed: false,
    secondary: [],
    passwordLink: true,
  });
  // Password only: the form itself, no extra tap.
  assert.deepEqual(chooseSignInWays(["password"], null), { main: "password", lastUsed: false, secondary: [], passwordLink: false });
  assert.deepEqual(chooseSignInWays(["sso"], null), { main: "sso", lastUsed: false, secondary: [], passwordLink: false });
  assert.deepEqual(chooseSignInWays([], null), { main: null, lastUsed: false, secondary: [], passwordLink: false });
});

test("the way last used on this device comes first, marked as such", () => {
  assert.deepEqual(chooseSignInWays(["sso", "passkey", "password"], "password"), {
    main: "password",
    lastUsed: true,
    secondary: ["sso", "passkey"],
    passwordLink: false,
  });
  assert.deepEqual(chooseSignInWays(["sso", "passkey", "password"], "passkey"), {
    main: "passkey",
    lastUsed: true,
    secondary: ["sso"],
    passwordLink: true,
  });
  assert.deepEqual(chooseSignInWays(["passkey", "password"], "sso").main, "passkey");
  // A way the instance has turned off since is not offered, and not "last used".
  assert.deepEqual(chooseSignInWays(["passkey", "password"], "sso"), { main: "passkey", lastUsed: false, secondary: [], passwordLink: true });
  assert.deepEqual(chooseSignInWays(["sso"], "password"), { main: "sso", lastUsed: false, secondary: [], passwordLink: false });
  // Anything else in storage counts as nothing.
  assert.equal(chooseSignInWays(["sso", "password"], "magic").main, "sso");
});

test("the last way is stored per device; blocked storage is a first visit", () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    removeItem: (key: string) => void values.delete(key),
  };
  assert.equal(readLastSignIn(storage), null);
  writeLastSignIn("sso", storage);
  assert.equal(values.get(LAST_SIGN_IN_KEY), "sso");
  assert.equal(readLastSignIn(storage), "sso");
  values.set(LAST_SIGN_IN_KEY, "<script>");
  assert.equal(readLastSignIn(storage), null);
  writeLastSignIn(null, storage);
  assert.equal(values.has(LAST_SIGN_IN_KEY), false);
  const blocked = {
    getItem: () => {
      throw new Error("SecurityError");
    },
    setItem: () => {
      throw new Error("QuotaExceededError");
    },
    removeItem: () => {
      throw new Error("SecurityError");
    },
  };
  assert.equal(readLastSignIn(blocked), null);
  assert.doesNotThrow(() => writeLastSignIn("passkey", blocked));
  // No localStorage at all (server render, old engines).
  assert.equal(readLastSignIn(), null);
});

test("the sign-in page feeds the instance's flags into the choice", () => {
  const login = readFileSync(new URL("../components/login.tsx", import.meta.url), "utf8");
  // SSO with OIDC, passkeys with local accounts (in the app as the hand-off),
  // the form with local accounts or LDAP.
  assert.match(login, /availableSignInWays\(\{ sso: configured, passkey: localLogin && \(passkeyHandOff \|\| passkeyButton\), password: passwordForm \}\)/);
  assert.match(login, /const passwordForm = localLogin \|\| ldap;/);
  // The way that signed in is remembered once the sign-in succeeded.
  assert.match(login, /if \(usedWay\.current\) writeLastSignIn\(usedWay\.current\)/);
  // The hint belongs to its button.
  assert.match(login, /aria-describedby=\{describedBy\("sso"\)\}/);
  assert.match(login, /aria-describedby=\{describedBy\("passkey"\)\}/);
  // The closed form stays in the page for password managers, but inert.
  assert.match(login, /data-collapsed=\{formShown \? undefined : ""\} inert=\{!formShown\}/);
  assert.match(login, /autoComplete=\{mode === "signin" \? "username webauthn" : "email"\}/);
  assert.match(login, /autoComplete=\{mode === "register" \? "new-password" : "current-password"\}/);
});
