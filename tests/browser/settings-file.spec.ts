import { test, expect } from "@playwright/test";
import { randomUUID, randomBytes, createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";

// The instance settings file (#447, Administration → Instanz → Einstellungen
// exportieren / importieren, lib/settings-file.ts): an administrator exports
// the file (a download named after the host and the day, without secrets),
// checks it unchanged (no changes), changes the instance's name in it,
// checks again (the change in words), is refused a secret's value, applies
// the file, and the name is stored.
test("settings file: export, check, apply", async ({ browser }, info) => {
  test.skip(!process.env.FLOWPLAN_DATA_DIR, "FLOWPLAN_DATA_DIR of the test server is required.");
  test.setTimeout(120_000);
  const errors: string[] = [];
  const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
  const db = new DatabaseSync(join(process.env.FLOWPLAN_DATA_DIR!, "flowplan.sqlite"));
  db.exec("PRAGMA busy_timeout=5000;");
  const uid = randomUUID(),
    token = randomBytes(32).toString("hex");
  db.prepare("INSERT INTO users(id,subject,name,email,onboarded_at) VALUES(?,?,?,?,?)").run(uid, `settings-file:${uid}`, "Admin", `${uid}@example.test`, Date.now());
  db.prepare("INSERT INTO sessions(token,user_id,groups_json,expires) VALUES(?,?,?,?)").run(createHash("sha256").update(token).digest("hex"), uid, JSON.stringify(["flowplan-admins"]), Date.now() + 600000);
  const mobile = info.project.name === "mobile" ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } : {};
  const context = await browser.newContext({ ...mobile, locale: "de-DE", acceptDownloads: true });
  await context.addCookies([{ name: "flowplan_session", value: token, url: origin, httpOnly: true, sameSite: "Lax" }]);
  const page = await context.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  // The name goes back afterwards.
  const savedName = db.prepare("SELECT value FROM instance_settings WHERE key='name'").get() as { value: string } | undefined;
  const name = `Spec ${Date.now()}`;
  try {
    await page.goto(`${origin}/#settings/instance/general/settings-file`);
    const section = page.locator("section#settings-file");
    await expect(section).toBeVisible({ timeout: 20_000 });

    // Export: a download, and the same file in the field.
    const [download] = await Promise.all([page.waitForEvent("download"), section.getByRole("button", { name: "Exportieren" }).click()]);
    const host = new URL(origin).host.replace(/[^A-Za-z0-9.-]+/g, "-");
    expect(download.suggestedFilename()).toBe(`flowplan-settings-${host}-${new Date().toISOString().slice(0, 10)}.json`);
    const file = JSON.parse(readFileSync((await download.path())!, "utf8"));
    expect(file.format).toBe("flowplan-settings");
    expect(file.version).toBe(1);
    expect(Object.keys(file)).toEqual(expect.arrayContaining(["instance", "ai", "limits"]));
    expect(file.ai.apiKey).toEqual({ set: expect.any(Boolean) });
    const field = section.getByLabel("Einstellungsdatei (JSON)");
    await expect(field).not.toHaveValue("");

    // Unchanged: nothing to do.
    await section.getByRole("button", { name: "Prüfen" }).click();
    const result = section.getByRole("status", { name: "Ergebnis der Prüfung" });
    await expect(result).toContainText("Keine Änderungen – alles ist schon so eingestellt.");
    await expect(section.getByRole("button", { name: "Übernehmen" })).toBeDisabled();

    // A secret's value is refused, with its place in the file.
    await field.fill(JSON.stringify({ ...file, ai: { ...file.ai, apiKey: `sk-${randomBytes(8).toString("hex")}` } }, null, 2));
    await section.getByRole("button", { name: "Prüfen" }).click();
    await expect(result).toContainText("ai.apiKey: hier darf kein Geheimnis stehen");
    await expect(section.getByRole("button", { name: "Übernehmen" })).toBeDisabled();

    // Another name: the change in words, nothing stored by the check.
    await field.fill(JSON.stringify({ ...file, instance: { ...file.instance, name } }, null, 2));
    await section.getByRole("button", { name: "Prüfen" }).click();
    await expect(result).toContainText("1 Änderungen:");
    await expect(result).toContainText(`instance.name:`);
    await expect(result).toContainText(`„${name}“`);
    expect((db.prepare("SELECT value FROM instance_settings WHERE key='name'").get() as { value: string } | undefined)?.value).not.toBe(JSON.stringify(name));
    await page.screenshot({ path: `test-results/admin-verification/${info.project.name}-settings-file-check.png`, fullPage: true });

    page.once("dialog", (d) => void d.accept());
    await section.getByRole("button", { name: "Übernehmen" }).click();
    await expect(section).toContainText("1 Änderungen übernommen.");
    await expect.poll(() => (db.prepare("SELECT value FROM instance_settings WHERE key='name'").get() as { value: string } | undefined)?.value).toBe(JSON.stringify(name));

    // The same file again: no changes.
    await section.getByRole("button", { name: "Prüfen" }).click();
    await expect(result).toContainText("Keine Änderungen – alles ist schon so eingestellt.");
    expect(errors).toEqual([]);
  } finally {
    if (savedName) db.prepare("UPDATE instance_settings SET value=? WHERE key='name'").run(savedName.value);
    else db.prepare("DELETE FROM instance_settings WHERE key='name'").run();
    await context.close();
    db.close();
  }
});
