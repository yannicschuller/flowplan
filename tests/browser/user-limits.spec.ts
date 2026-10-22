import { test, expect } from "@playwright/test";
import { randomUUID, randomBytes, createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";

// Admins set limits per person (and defaults for everyone); the person sees
// them in the settings and the language chosen in the profile sticks.
test("limits per person, shown to the person, and a fixed language", async ({ page, browser }, info) => {
  test.skip(!process.env.FLOWPLAN_DATA_DIR, "FLOWPLAN_DATA_DIR of the test server is required.");
  test.setTimeout(150_000);
  const errors: string[] = [];
  const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
  const db = new DatabaseSync(join(process.env.FLOWPLAN_DATA_DIR!, "flowplan.sqlite"));
  db.exec("PRAGMA busy_timeout=5000;");
  const session = (groups: string[], name: string) => {
    const uid = randomUUID(),
      token = randomBytes(32).toString("hex");
    db.prepare("INSERT INTO users(id,subject,name,email,onboarded_at) VALUES(?,?,?,?,?)").run(uid, `limits:${uid}`, name, `${uid}@example.test`, Date.now());
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
  const name = `Lena ${Date.now()}`;
  const person = session([], name);
  // The person's workspace exists after the first visit.
  const me = await open(person.token);
  await me.page.goto(`${origin}/#home`);
  await expect(me.page.locator(".sidebar, .workspace-switch").first()).toBeAttached({ timeout: 20_000 });

  const adminSession = session(["flowplan-admins"], "Admin Grenzen");
  const admin = await open(adminSession.token);
  try {
    await admin.page.goto(`${origin}/#admin/users`);
    const row = admin.page.locator(".user-row", { hasText: name });
    await row.getByRole("button", { name: "Verwalten" }).click();
    await row.getByLabel(`Speicher für ${name}`).fill("200");
    await row.getByLabel(`Eigene Arbeitsbereiche für ${name}`).fill("3");
    await row.getByRole("button", { name: "Grenzen speichern" }).click();
    await expect.poll(() => (db.prepare("SELECT limits FROM users WHERE id=?").get(person.uid) as { limits: string }).limits).toBe(JSON.stringify({ storageMb: 200, workspaces: 3 }));
    await expect(row.locator(".usage-meter")).toHaveCount(2);
    await admin.page.screenshot({ path: `test-results/admin-verification/${info.project.name}-user-limits.png`, fullPage: true });

    // The person sees what applies to them.
    await me.page.goto(`${origin}/#settings/account`);
    await me.page.reload();
    const limits = me.page.locator(".setting-group", { hasText: "Deine Grenzen" });
    await expect(limits).toContainText("0 MB / 200 MB");
    await expect(limits).toContainText("1 / 3");
    await expect(limits).toContainText("10 MB");
    await me.page.screenshot({ path: `test-results/admin-verification/${info.project.name}-my-limits.png`, fullPage: true });

    // Fixed language: English everywhere from now on.
    await me.page.goto(`${origin}/#settings/appearance`);
    await me.page.getByRole("combobox", { name: "Sprache" }).selectOption("en");
    await expect(me.page.getByRole("heading", { name: "Appearance & language" })).toBeVisible({ timeout: 20_000 });
    expect((db.prepare("SELECT language FROM users WHERE id=?").get(person.uid) as { language: string }).language).toBe("en");
    // Another device with a German browser switches to English as well.
    const other = await open(person.token);
    await other.page.goto(`${origin}/#settings`);
    await expect(other.page.getByRole("heading", { name: "Settings" })).toBeVisible({ timeout: 20_000 });
    await other.context.close();
    await me.page.getByRole("combobox", { name: "Language" }).selectOption("");
    await expect(me.page.getByRole("heading", { name: "Darstellung & Sprache" })).toBeVisible({ timeout: 20_000 });
    expect(errors).toEqual([]);
  } finally {
    await me.context.close();
    await admin.context.close();
    db.close();
  }
});
