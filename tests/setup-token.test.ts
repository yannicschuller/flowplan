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

test("FLOWPLAN_SETUP_TOKEN: the first account needs the setup link", async () => {
  assert.equal(auth.firstAccount(), true);
  // Without or with a wrong token the instance offers no sign-up.
  assert.equal(auth.signupOpen(), false);
  assert.equal(auth.signupOpen("falsch"), false);
  assert.equal(auth.loginOptions().firstAccount, false);
  // An invitation (from a demo workspace) does not replace the setup link.
  const demo = id(),
    wid = id();
  run("INSERT INTO users(id,subject,name,email,demo_until) VALUES(?,?,?,?,?)", demo, `demo:${demo}`, "Demo", "demo@example.test", Date.now() + 60_000);
  run("INSERT INTO workspaces(id,name,created_by) VALUES(?,?,?)", wid, "Demo", demo);
  run("INSERT INTO invites(id,workspace_id,email,role,created_by,guest,token) VALUES(?,?,?,?,?,0,?)", id(), wid, ana.email, "editor", demo, "einladung-vor-dem-setup");
  assert.equal(auth.signupOpen(undefined, "einladung-vor-dem-setup"), false);
  assert.equal(auth.loginOptions(undefined, "einladung-vor-dem-setup").invitedEmail, "");
  await assert.rejects(auth.register({ ...ana, invite: "einladung-vor-dem-setup" }, "en"), /setup link/);
  run("DELETE FROM invites");
  await assert.rejects(auth.register(ana, "en"), /setup link/);
  await assert.rejects(auth.register({ ...ana, setup: "falsch" }, "de"), /Einrichtungslink/);
  assert.equal(auth.firstAccount(), true, "nothing was created");
  // The token from the environment, without the surrounding spaces.
  assert.equal(auth.signupOpen("einrichten-2026"), true);
  assert.equal(auth.loginOptions("einrichten-2026").firstAccount, true);
  const { user, groups } = await auth.register({ ...ana, setup: "einrichten-2026" }, "de");
  assert.deepEqual(groups, [adminGroup()]);
  assert.deepEqual(auth.localGroups(user.id), [adminGroup()]);
  // Afterwards the token opens nothing: sign-ups follow the instance settings.
  assert.equal(auth.signupOpen("einrichten-2026"), false);
  await assert.rejects(auth.register({ name: "Ben", email: "ben@example.test", password: "ein-langes-passwort", setup: "einrichten-2026" }, "en"), /Only administrators/);
});

test("the admin group is matched literally in the admin list", () => {
  const before = process.env.OIDC_ADMIN_GROUP;
  process.env.OIDC_ADMIN_GROUP = "max_mueller";
  try {
    const exact = id(),
      lookalike = id();
    run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", exact, `oidc:${exact}`, "Max", `${exact}@example.test`);
    run("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)", lookalike, `oidc:${lookalike}`, "Maxi", `${lookalike}@example.test`);
    const session = (userId: string, groups: string[]) =>
      run("INSERT INTO sessions(token,user_id,groups_json,expires,created_at) VALUES(?,?,?,?,?)", id(), userId, JSON.stringify(groups), Date.now() + 3_600_000, Date.now());
    session(exact, ["max_mueller"]);
    // "_" used to be a LIKE wildcard: "maxXmueller" counted as the admin group.
    session(lookalike, ["maxXmueller"]);
    const admins = adminUserIds();
    assert.ok(admins.includes(exact));
    assert.ok(!admins.includes(lookalike));
  } finally {
    if (before === undefined) delete process.env.OIDC_ADMIN_GROUP;
    else process.env.OIDC_ADMIN_GROUP = before;
  }
});
