import { test, expect } from "@playwright/test";
import { randomUUID, randomBytes, createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";

// Limits per group (Administration → Grenzen & Aufbewahrung): an
// administrator gives a directory group more storage; a member of that
// group (pushed over SCIM, no workspace or mapping needed) sees it under
// "Deine Grenzen" with the group named, and the administration's account
// panel says where it comes from. A second group is an add-on
// ("Zusätzlich (Add-on)"): its storage comes on top, and both are named.
test("limits per group: set by an administrator, shown to a member", async ({ browser }, info) => {
  test.skip(!process.env.FLOWPLAN_DATA_DIR, "FLOWPLAN_DATA_DIR of the test server is required.");
  test.setTimeout(150_000);
  const errors: string[] = [];
  const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
  const db = new DatabaseSync(join(process.env.FLOWPLAN_DATA_DIR!, "flowplan.sqlite"));
  db.exec("PRAGMA busy_timeout=5000;");
  const session = (groups: string[], name: string) => {
    const uid = randomUUID(),
      token = randomBytes(32).toString("hex");
    db.prepare("INSERT INTO users(id,subject,name,email,onboarded_at) VALUES(?,?,?,?,?)").run(uid, `group-limits:${uid}`, name, `${uid}@example.test`, Date.now());
    db.prepare("INSERT INTO sessions(token,user_id,groups_json,expires) VALUES(?,?,?,?)").run(createHash("sha256").update(token).digest("hex"), uid, JSON.stringify(groups), Date.now() + 600000);
    return { uid, token };
  };
  const mobile = info.project.name === "mobile" ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } : {};
  const open = async (token: string) => {
    const context = await browser.newContext({ ...mobile, locale: "de-DE" });
    await context.addCookies([{ name: "flowplan_session", value: token, url: origin, httpOnly: true, sameSite: "Lax" }]);
    const p = await context.newPage();
    p.on("pageerror", (e) => errors.push(e.message));
    return { context, page: p };
  };
  const stamp = Date.now();
  const group = `Plus ${stamp}`;
  const addon = `+50 GB ${stamp}`;
  const name = `Mara ${stamp}`;
  const member = session([], name);
  // The directory pushed the group with Mara as a member (lib/scim.ts).
  const scimGroup = randomUUID();
  db.prepare("INSERT INTO scim_groups(id,display_name,version,created_at,updated_at) VALUES(?,?,1,?,?)").run(scimGroup, group, Date.now(), Date.now());
  db.prepare("INSERT INTO scim_group_members(group_id,user_id) VALUES(?,?)").run(scimGroup, member.uid);
  const scimAddon = randomUUID();
  db.prepare("INSERT INTO scim_groups(id,display_name,version,created_at,updated_at) VALUES(?,?,1,?,?)").run(scimAddon, addon, Date.now(), Date.now());
  db.prepare("INSERT INTO scim_group_members(group_id,user_id) VALUES(?,?)").run(scimAddon, member.uid);
  const adminSession = session(["flowplan-admins"], `Admin ${stamp}`);
  const admin = await open(adminSession.token);
  const me = await open(member.token);
  try {
    await admin.page.goto(`${origin}/#admin/limits`);
    const section = admin.page.locator(".setting-group", { hasText: "Grenzen pro Gruppe" });
    await expect(section).toBeVisible({ timeout: 20_000 });
    // The group is offered by the picker; here it is added by its name.
    await section.getByLabel("Verzeichnisgruppe nach Name").fill(group);
    await section.getByRole("button", { name: "Hinzufügen" }).click();
    const storage = section.getByLabel(`Verzeichnis · ${group}: Speicher`, { exact: true });
    await expect(storage).toBeVisible();
    await storage.fill("2000");
    await storage.press("Enter");
    await expect
      .poll(() => (db.prepare("SELECT limits FROM group_limits WHERE target=?").get(`dir:${group}`) as { limits: string } | undefined)?.limits)
      .toBe(JSON.stringify({ storageMb: 2000 }));
    // The add-on group: marked "Zusätzlich (Add-on)", then its 50 GB.
    await section.getByLabel("Verzeichnisgruppe nach Name").fill(addon);
    await section.getByRole("button", { name: "Hinzufügen" }).click();
    const mode = section.getByRole("combobox", { name: `Verzeichnis · ${addon}: Art des Speichers` });
    await expect(mode).toBeVisible();
    await mode.selectOption("add");
    const stored = () => JSON.parse((db.prepare("SELECT limits FROM group_limits WHERE target=?").get(`dir:${addon}`) as { limits: string } | undefined)?.limits || "null");
    await expect.poll(stored).toEqual({ storageMode: "add" });
    await expect(section).toContainText("Zusätzlich (Add-on): der Speicher der Gruppe kommt zur Grenze der Person dazu");
    const extra = section.getByLabel(`Verzeichnis · ${addon}: Speicher`, { exact: true });
    await extra.fill("51200");
    await extra.press("Enter");
    await expect.poll(stored).toEqual({ storageMode: "add", storageMb: 51200 });
    await admin.page.screenshot({ path: `test-results/admin-verification/${info.project.name}-group-limits.png`, fullPage: true });

    // The member sees the sum and where it comes from: 2,000 MB + 50 GB.
    await me.page.goto(`${origin}/#settings/account`);
    const limits = me.page.locator(".setting-group", { hasText: "Deine Grenzen" });
    await expect(limits).toContainText("53.200 MB", { timeout: 20_000 });
    await expect(limits).toContainText(`2.000 MB aus Gruppe ${group} + 50 GB aus Gruppe ${addon}`);
    await me.page.screenshot({ path: `test-results/admin-verification/${info.project.name}-my-group-limits.png`, fullPage: true });

    // The administration's account panel names the group as the source.
    await admin.page.goto(`${origin}/#admin/users`);
    await admin.page.getByRole("searchbox", { name: "Benutzer suchen" }).fill(name);
    const row = admin.page.locator(".user-row", { hasText: name });
    await row.getByRole("button", { name, exact: true }).click();
    const sheet = admin.page.getByRole("dialog", { name, exact: true });
    await expect(sheet).toContainText(`2.000 MB aus Gruppe Verzeichnis · ${group} + 50 GB aus Gruppe Verzeichnis · ${addon}`);
    expect(errors).toEqual([]);
  } finally {
    db.prepare("DELETE FROM group_limits WHERE target IN (?,?)").run(`dir:${group}`, `dir:${addon}`);
    db.prepare("DELETE FROM scim_groups WHERE id IN (?,?)").run(scimGroup, scimAddon);
    await me.context.close();
    await admin.context.close();
    db.close();
  }
});
