import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
process.env.FLOWPLAN_DATA_DIR = mkdtempSync(join(tmpdir(), "flowplan-setup-token-"));
process.env.APP_URL = "https://flowplan.example.test";
process.env.FLOWPLAN_SETUP_TOKEN = "  einrichten-2026  ";
const { run, id } = await import("../lib/db");
const auth = await import("../lib/local-auth");
const { adminGroup, adminUserIds } = await import("../lib/auth");

const ana = { name: "Ana", email: "ana@example.test", password: "ein-langes-passwort" };

test("FLOWPLAN_SETUP_TOKEN: the start log names the setup link, never the token (#194)", async () => {
  assert.equal(await auth.firstAccount(), true);
  const hint = await auth.setupHint();
  assert.match(hint, /https:\/\/flowplan\.example\.test\/register\?setup=<your FLOWPLAN_SETUP_TOKEN>/);
  assert.ok(!hint.includes("einrichten-2026"), "the token stays out of the log");
  // With the token there is nothing to warn about.
  assert.equal(await auth.setupWarning(), "");
  // Without password sign-in the first administrator comes through SSO or LDAP.
  process.env.FLOWPLAN_LOCAL_LOGIN = "false";
  try {
    assert.equal(await auth.setupHint(), "");
  } finally {
    delete process.env.FLOWPLAN_LOCAL_LOGIN;
  }
});

test("FLOWPLAN_SETUP_TOKEN: the first account needs the setup link", async () => {
  assert.equal(await auth.firstAccount(), true);
  // Without or with a wrong token the instance offers no sign-up.
  assert.equal(await auth.signupOpen(), false);
  assert.equal(await auth.signupOpen("falsch"), false);
  assert.equal((await auth.loginOptions()).firstAccount, false);
  // An invitation (from a demo workspace) does not replace the setup link.
  const demo = id(),
    wid = id();
  await run("INSERT INTO users(id,subject,name,email,demo_until) VALUES(?,?,?,?,?)", demo, `demo:${demo}`, "Demo", "demo@example.test", Date.now() + 60_000);
  await run("INSERT INTO workspaces(id,name,created_by) VALUES(?,?,?)", wid, "Demo", demo);
  await run("INSERT INTO invites(id,workspace_id,email,role,created_by,guest,token) VALUES(?,?,?,?,?,0,?)", id(), wid, ana.email, "editor", demo, "einladung-vor-dem-setup");
  assert.equal(await auth.signupOpen(undefined, "einladung-vor-dem-setup"), false);
  assert.equal((await auth.loginOptions(undefined, "einladung-vor-dem-setup")).invitedEmail, "");
  await assert.rejects(auth.register({ ...ana, invite: "einladung-vor-dem-setup" }, "en"), /setup link/);
  await run("DELETE FROM invites");
  await assert.rejects(auth.register(ana, "en"), /setup link/);
  await assert.rejects(auth.register({ ...ana, setup: "falsch" }, "de"), /Einrichtungslink/);
  assert.equal(await auth.firstAccount(), true, "nothing was created");
  // The token from the environment, without the surrounding spaces.
  assert.equal(await auth.signupOpen("einrichten-2026"), true);
  assert.equal((await auth.loginOptions("einrichten-2026")).firstAccount, true);
  const { user, groups } = await auth.register({ ...ana, setup: "einrichten-2026" }, "de");
  assert.deepEqual(groups, [adminGroup()]);
  assert.deepEqual(await auth.localGroups(user.id), [adminGroup()]);
  assert.equal(await auth.setupHint(), "", "set up: no more hint");
  // Afterwards the token opens nothing: sign-ups follow the instance settings.
  assert.equal(await auth.signupOpen("einrichten-2026"), false);
  await assert.rejects(auth.register({ name: "Ben", email: "ben@example.test", password: "ein-langes-passwort", setup: "einrichten-2026" }, "en"), /Only administrators/);
});

test("the admin group is matched literally in the admin list", async () => {
  const before = process.env.OIDC_ADMIN_GROUP;
  process.env.OIDC_ADMIN_GROUP = "max_mueller";
  try {
    const exact = id(),
      lookalike = id();
    await run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", exact, `oidc:${exact}`, "Max", `${exact}@example.test`);
    await run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", lookalike, `oidc:${lookalike}`, "Maxi", `${lookalike}@example.test`);
    const session = async (userId: string, groups: string[]) =>
      await run("INSERT INTO sessions(token,user_id,groups_json,expires,created_at) VALUES(?,?,?,?,?)", id(), userId, JSON.stringify(groups), Date.now() + 3_600_000, Date.now());
    await session(exact, ["max_mueller"]);
    // "_" used to be a LIKE wildcard: "maxXmueller" counted as the admin group.
    await session(lookalike, ["maxXmueller"]);
    const admins = await adminUserIds();
    assert.ok(admins.includes(exact));
    assert.ok(!admins.includes(lookalike));
  } finally {
    if (before === undefined) delete process.env.OIDC_ADMIN_GROUP;
    else process.env.OIDC_ADMIN_GROUP = before;
  }
});

test("a setup token with a + also works when the link turned it into a space", async () => {
  const { setupAllowed } = await import("../lib/local-auth");
  const before = process.env.FLOWPLAN_SETUP_TOKEN;
  process.env.FLOWPLAN_SETUP_TOKEN = "ab+cd/ef+gh";
  try {
    assert.equal(setupAllowed("ab+cd/ef+gh"), true);
    assert.equal(setupAllowed("ab cd/ef gh"), true);
    assert.equal(setupAllowed("ab cd/ef"), false);
    assert.equal(setupAllowed("abxcd/efxgh"), false);
  } finally {
    process.env.FLOWPLAN_SETUP_TOKEN = before;
  }
});
