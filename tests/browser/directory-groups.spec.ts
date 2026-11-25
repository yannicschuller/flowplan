import { test, expect } from "@playwright/test";
import { randomUUID, randomBytes, createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";

// Directory groups by hand (#451): in a person's details an administrator
// adds them to a new directory group (created as a SCIM group) and removes
// them again; an SSO membership is shown read-only. Under Grenzen pro
// Gruppe, the "Mitglieder" dialog of a directory group lists, adds and
// removes members; the person's limits follow at once.
test("directory groups: add and remove in a person's details, and the members dialog", async ({ browser }, info) => {
  test.skip(!process.env.FLOWPLAN_DATA_DIR, "FLOWPLAN_DATA_DIR of the test server is required.");
  test.setTimeout(150_000);
  const errors: string[] = [];
  const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
  const db = new DatabaseSync(join(process.env.FLOWPLAN_DATA_DIR!, "flowplan.sqlite"));
  db.exec("PRAGMA busy_timeout=5000;");
  const session = (groups: string[], name: string, sso = 0) => {
    const uid = randomUUID(),
      token = randomBytes(32).toString("hex");
    db.prepare("INSERT INTO users(id,subject,name,email,onboarded_at) VALUES(?,?,?,?,?)").run(uid, `dir-groups:${uid}`, name, `${uid}@example.test`, Date.now());
    db.prepare("INSERT INTO sessions(token,user_id,groups_json,expires,created_at,sso) VALUES(?,?,?,?,?,?)").run(createHash("sha256").update(token).digest("hex"), uid, JSON.stringify(groups), Date.now() + 600000, Date.now(), sso);
    return { uid, token };
  };
  const mobile = info.project.name === "mobile" ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } : {};
  const stamp = Date.now();
  const group = `Testers ${stamp}`;
  const ssoGroup = `Staff ${stamp}`;
  const name = `Nora ${stamp}`;
  const other = `Olaf ${stamp}`;
  // Nora signed in through SSO with the group "Staff …".
  const nora = session([ssoGroup], name, 1);
  const olaf = session([], other);
  const adminSession = session(["flowplan-admins"], `Admin ${stamp}`);
  db.prepare("INSERT INTO group_limits(target,limits,updated_at) VALUES(?,?,?)").run(`dir:${group}`, JSON.stringify({ storageMb: 4321 }), Date.now());
  const context = await browser.newContext({ ...mobile, locale: "de-DE" });
  await context.addCookies([{ name: "flowplan_session", value: adminSession.token, url: origin, httpOnly: true, sameSite: "Lax" }]);
  const page = await context.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  const scimId = () => (db.prepare("SELECT id FROM scim_groups WHERE display_name=?").get(group) as { id: string } | undefined)?.id;
  try {
    await page.goto(`${origin}/#settings/instance/users`);
    await page.getByRole("searchbox", { name: "Benutzer suchen" }).fill(name);
    await page.locator(".user-row", { hasText: name }).getByRole("button", { name, exact: true }).click();
    const sheet = page.getByRole("dialog", { name, exact: true });
    const groups = sheet.getByRole("region", { name: "Verzeichnisgruppen" });
    await expect(groups).toBeVisible({ timeout: 20_000 });
    // The SSO membership: read-only with the hint.
    const sso = groups.getByRole("listitem").filter({ hasText: ssoGroup });
    await expect(sso).toContainText("SSO");
    await expect(sso).toContainText(`Kommt aus SSO – dort ändern.`);
    await expect(sso.getByRole("button")).toHaveCount(0);
    // A new name: created as a SCIM group, with the keyboard.
    const input = groups.getByLabel("Zu Gruppe hinzufügen");
    await input.fill(group);
    await expect(groups).toContainText("wird als SCIM-Gruppe angelegt");
    await input.press("Enter");
    const item = groups.getByRole("listitem").filter({ hasText: group });
    await expect(item).toContainText("von Hand");
    await expect(item).toContainText("SCIM");
    await expect.poll(scimId).toBeTruthy();
    await page.screenshot({ path: `test-results/admin-verification/${info.project.name}-directory-groups.png`, fullPage: true });
    expect(db.prepare("SELECT added_by FROM scim_group_members WHERE group_id=? AND user_id=?").get(scimId()!, nora.uid)).toEqual({ added_by: adminSession.uid });
    // The person's limits follow at once.
    await expect(sheet).toContainText(`Verzeichnis · ${group}`);
    // Removed again.
    await item.getByRole("button", { name: `${name} aus „${group}“ entfernen` }).click();
    await expect(groups.getByRole("listitem").filter({ hasText: group })).toHaveCount(0);
    expect(db.prepare("SELECT 1 FROM scim_group_members WHERE group_id=? AND user_id=?").get(scimId()!, nora.uid)).toBeUndefined();
    await page.keyboard.press("Escape");
    await expect(sheet).toBeHidden();

    // Grenzen pro Gruppe → Mitglieder.
    await page.goto(`${origin}/#settings/instance/limits`);
    const section = page.locator(".setting-group", { hasText: "Grenzen pro Gruppe" });
    await expect(section).toBeVisible({ timeout: 20_000 });
    await section.getByRole("button", { name: `Mitglieder von Verzeichnis · ${group}` }).click();
    const dialog = page.getByRole("dialog", { name: `Mitglieder von „${group}“` });
    await expect(dialog).toContainText("Noch keine Mitglieder.");
    await dialog.getByRole("searchbox", { name: "Person suchen" }).fill(other);
    await dialog.getByRole("button", { name: new RegExp(other) }).click();
    const member = dialog.getByRole("listitem").filter({ hasText: other });
    await expect(member).toContainText("von Hand");
    await page.screenshot({ path: `test-results/admin-verification/${info.project.name}-directory-members.png`, fullPage: true });
    await expect.poll(() => db.prepare("SELECT 1 ok FROM scim_group_members WHERE group_id=? AND user_id=?").get(scimId()!, olaf.uid)).toEqual({ ok: 1 });
    await member.getByRole("button", { name: `${other} entfernen` }).click();
    await expect(dialog).toContainText("Noch keine Mitglieder.");
    expect(db.prepare("SELECT 1 FROM scim_group_members WHERE group_id=? AND user_id=?").get(scimId()!, olaf.uid)).toBeUndefined();
    await dialog.getByRole("button", { name: "Schließen" }).first().click();
    await expect(dialog).toBeHidden();
    expect(errors).toEqual([]);
  } finally {
    db.prepare("DELETE FROM group_limits WHERE target=?").run(`dir:${group}`);
    db.prepare("DELETE FROM scim_groups WHERE display_name=?").run(group);
    await context.close();
    db.close();
  }
});
