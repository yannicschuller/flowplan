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
  // A new account starts with the introduction.
  const intro = page.getByRole("dialog", { name: "Willkommen bei Flowplan" });
  await intro.getByRole("button", { name: "Überspringen" }).click();
  await expect(intro).toBeHidden();
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

    // Settings: "Anmeldung & Sicherheit" offers password and passkeys; the
    // password form opens under its row.
    await page.goto("/#settings/account");
    await expect(page.getByRole("heading", { name: "Anmeldung & Sicherheit" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Passkey hinzufügen" })).toBeVisible();
    await page.getByRole("button", { name: "Passwort ändern …" }).click();
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

// An invitation (Settings → Members → copy link) while sign-ups are closed:
// the link offers creating the account for the invited address, and the
// new account lands in the workspace.
test("an invitation link creates the account while sign-ups are closed", async ({ browser }, info) => {
  test.skip(!process.env.FLOWPLAN_DATA_DIR, "Needs the test server data directory.");
  const stamp = `${Date.now()}-${info.project.name}`;
  // The account setSignup puts in place invites to its workspace.
  const owner = "00000000-0000-4000-8000-0000000000aa",
    workspace = "00000000-0000-4000-8000-0000000000ab";
  const invite = (email: string, token: string) => {
    const db = new DatabaseSync(join(process.env.FLOWPLAN_DATA_DIR!, "flowplan.sqlite"));
    db.exec("PRAGMA busy_timeout=5000;");
    db.prepare("INSERT OR IGNORE INTO workspaces(id,name,created_by) VALUES(?,?,?)").run(workspace, "Eingeladen", owner);
    db.prepare("INSERT INTO invites(id,workspace_id,email,role,created_by,guest,created_at,token) VALUES(?,?,?,?,?,0,?,?)").run(
      crypto.randomUUID(),
      workspace,
      email,
      "editor",
      owner,
      Date.now(),
      token,
    );
    db.close();
  };
  const member = (email: string) => {
    const db = new DatabaseSync(join(process.env.FLOWPLAN_DATA_DIR!, "flowplan.sqlite"));
    const row = db
      .prepare("SELECT 1 FROM members m JOIN local_accounts a ON a.user_id=m.user_id WHERE a.email=? AND m.workspace_id=?")
      .get(email, workspace);
    db.close();
    return !!row;
  };
  const context = await browser.newContext();
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const email = `invited-${stamp}@example.test`,
    token = `einladung-${stamp}`;
  try {
    setSignup(false);
    invite(email, token);
    // The copied link: signing in, or creating the account for the address.
    await page.goto(`/?invite=${token}`);
    await page.getByRole("button", { name: "Konto erstellen" }).click();
    const address = page.getByLabel("E-Mail-Adresse");
    await expect(address).toHaveValue(email);
    await expect(address).toHaveJSProperty("readOnly", true);
    await expect(page.getByText("Die Einladung gilt für diese Adresse.")).toBeVisible();
    await page.getByLabel("Name").fill("Eingeladene Person");
    await page.locator("input[name=password]").fill("ein-langes-passwort");
    await page.getByRole("button", { name: "Konto erstellen" }).click();
    await expect(page.getByLabel("Dokumentinhalt", { exact: true }).or(page.locator(".sidebar"))).toBeVisible({ timeout: 20_000 });
    // Signed in, the link takes the invitation over.
    await expect(page.getByText("Einladung angenommen")).toBeVisible();
    expect(member(email)).toBe(true);

    // A used or unknown link offers signing in only.
    await context.clearCookies();
    for (const path of [`/?invite=${token}`, `/register?invite=${token}`, "/register?invite=unbekannt-0123456789abcdef"]) {
      await page.goto(path);
      await expect(page.getByRole("button", { name: "Anmelden", exact: true })).toBeVisible();
      await expect(page.getByRole("button", { name: "Konto erstellen" })).toHaveCount(0);
      await expect(page.getByLabel("Name")).toHaveCount(0);
    }
    // /register with a valid link opens the form for the invited address.
    const second = `zweite-${stamp}@example.test`;
    invite(second, `einladung-zwei-${stamp}`);
    await page.goto(`/register?invite=einladung-zwei-${stamp}`);
    await expect(page.getByLabel("Name")).toBeVisible();
    await expect(page.getByLabel("E-Mail-Adresse")).toHaveValue(second);
    expect(errors).toEqual([]);
  } finally {
    // The open second invitation goes; the first one was used.
    const db = new DatabaseSync(join(process.env.FLOWPLAN_DATA_DIR!, "flowplan.sqlite"));
    db.exec("PRAGMA busy_timeout=5000;");
    db.prepare("DELETE FROM invites WHERE workspace_id=?").run(workspace);
    db.close();
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
    await page.goto("/#settings/account/passkeys");
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
