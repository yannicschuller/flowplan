import { test, expect, type Page } from "@playwright/test";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";

// Accounts with e-mail and password, and passkeys, next to optional SSO.
const setSignup = (on: boolean) => {
  const db = new DatabaseSync(join(process.env.FLOWPLAN_DATA_DIR!, "flowplan.sqlite"));
  db.exec("PRAGMA busy_timeout=5000;");
  db.prepare(
    "INSERT INTO instance_settings(key,value) VALUES('allowSignup',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
  ).run(JSON.stringify(on));
  // The instance is set up already (otherwise the next account is its first).
  db.prepare("INSERT OR IGNORE INTO users(id,subject,name,email) VALUES(?,?,?,?)").run(
    "00000000-0000-4000-8000-0000000000aa",
    "seed:existing",
    "Bestehend",
    "existing@example.test",
  );
  db.close();
};
const register = async (page: Page, email: string, password: string) => {
  await page.goto("/register");
  await page.getByLabel("Name").fill("Test Person");
  await page.getByLabel("E-Mail-Adresse").fill(email);
  await page.locator("input[name=password]").fill(password);
  await page.getByRole("button", { name: "Konto erstellen" }).click();
  await expect(page.getByLabel("Dokumentinhalt", { exact: true }).or(page.locator(".sidebar"))).toBeVisible({ timeout: 20_000 });
};

test("create an account, sign out, sign in with the password and change it", async ({ browser }, info) => {
  test.skip(!process.env.FLOWPLAN_DATA_DIR, "Needs the test server data directory.");
  test.skip(info.project.name !== "desktop", "Instance setting is global.");
  const context = await browser.newContext();
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const email = `person-${Date.now()}@example.test`;
  try {
    // Closed sign-ups: the page offers signing in only.
    setSignup(false);
    await page.goto("/register");
    await expect(page.getByRole("button", { name: "Konto erstellen" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Anmelden", exact: true })).toBeVisible();

    setSignup(true);
    // Too short a password is refused before anything is created.
    await page.goto("/register");
    await page.getByLabel("Name").fill("Test Person");
    await page.getByLabel("E-Mail-Adresse").fill(email);
    await page.locator("input[name=password]").fill("kurz");
    await page.getByRole("button", { name: "Konto erstellen" }).click();
    await expect(page.locator("input[name=password]")).toHaveJSProperty("validity.valid", false);
    await register(page, email, "ein-langes-passwort");

    // Settings: the profile offers name, password and passkeys.
    await page.goto("/#settings");
    await page.getByRole("button", { name: /Allgemein/ }).first().click().catch(() => {});
    await expect(page.getByRole("heading", { name: "Passkeys" })).toBeVisible();
    await page.getByLabel("Bisheriges Passwort").fill("ein-langes-passwort");
    await page.getByLabel("Neues Passwort", { exact: true }).fill("ganz-neues-passwort");
    await page.getByLabel("Neues Passwort wiederholen").fill("ganz-neues-passwort");
    await page.getByRole("button", { name: "Passwort ändern" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Passwort geändert" })).toBeVisible();

    // Sign out and in again with the new password; a wrong one is refused.
    await context.clearCookies();
    await page.goto("/login");
    await page.getByLabel("E-Mail-Adresse").fill(email);
    await page.locator("input[name=password]").fill("ein-langes-passwort");
    await page.getByRole("button", { name: "Anmelden", exact: true }).click();
    await expect(page.locator(".login-card [role=alert]")).toContainText("stimmt nicht");
    await page.locator("input[name=password]").fill("ganz-neues-passwort");
    await page.getByRole("button", { name: "Anmelden", exact: true }).click();
    await expect(page.locator(".sidebar")).toBeVisible({ timeout: 20_000 });
    expect(errors).toEqual([]);
  } finally {
    setSignup(false);
    await context.close();
  }
});

// WebAuthn needs a host name (not an IP address): run against a server on
// http://localhost (PASSKEY_BASE_URL) with Chrome's virtual authenticator.
test("add a passkey and sign in with it", async ({ browser }, info) => {
  const base = process.env.PASSKEY_BASE_URL;
  test.skip(!base || !process.env.FLOWPLAN_DATA_DIR, "Needs PASSKEY_BASE_URL (a server on http://localhost).");
  test.skip(info.project.name !== "desktop", "Virtual authenticator on desktop Chromium.");
  const context = await browser.newContext({ baseURL: base });
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true },
  });
  const email = `passkey-${Date.now()}@example.test`;
  try {
    setSignup(true);
    await register(page, email, "ein-langes-passwort");
    await page.goto("/#settings");
    await expect(page.getByRole("heading", { name: "Passkeys" })).toBeVisible();
    await page.getByRole("button", { name: "Passkey hinzufügen" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Passkey angelegt" })).toBeVisible();
    await expect(page.locator(".passkey-list li")).toHaveCount(1);
    await context.clearCookies();
    await page.goto("/login");
    await page.getByRole("button", { name: "Mit Passkey anmelden" }).click();
    await expect(page.locator(".sidebar")).toBeVisible({ timeout: 20_000 });
  } finally {
    setSignup(false);
    await context.close();
  }
});
