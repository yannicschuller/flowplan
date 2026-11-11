import { test, expect } from "@playwright/test";
import { createHash, randomBytes } from "node:crypto";
import { openPasswordForm } from "./sign-in-form";

// The desktop app signs in through the browser: a one-time code that only
// the holder of the verifier can redeem, once.
test("the desktop app signs in through the browser", async ({ browser }, testInfo) => {
  test.setTimeout(180_000);
  test.skip(testInfo.project.name !== "desktop", "One run covers the flow.");
  const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");

  // In the app, passkeys and SSO hand over to the browser.
  const app = await browser.newContext({ userAgent: "Mozilla/5.0 Chrome/140 Electron/38 FlowplanDesktop/1.1.0" });
  const appPage = await app.newPage();
  await appPage.goto(origin + "/");
  await expect(appPage.getByRole("link", { name: "Mit Passkey anmelden" })).toHaveAttribute("href", "/api/auth/desktop");

  // The browser: a broken link, then sign-in and confirmation.
  const web = await browser.newContext();
  const page = await web.newPage();
  await page.goto(`${origin}/api/auth/desktop?challenge=kaputt`);
  await expect(page.getByRole("heading", { name: "Link ungültig" })).toBeVisible();
  await page.goto(`${origin}/api/auth/desktop?challenge=${challenge}`);
  await expect(page).toHaveURL(new RegExp(`desktop=${challenge}`));
  await expect(page.getByText("Melde dich an, um die Flowplan-App mit deinem Konto zu verbinden.")).toBeVisible();
  await page.getByRole("button", { name: "Lokalen Arbeitsbereich öffnen" }).click();
  await expect(page.getByRole("heading", { name: "Bei der Flowplan-App anmelden" })).toBeVisible({ timeout: 60_000 });
  await page.getByRole("button", { name: "In der App anmelden" }).click();
  const link = await page.getByRole("link", { name: "Flowplan-App öffnen" }).getAttribute("href");
  const handoff = new URL(String(link));
  expect(handoff.protocol).toBe("flowplan:");
  expect(handoff.searchParams.get("server")).toBe(new URL(origin).origin);
  expect(handoff.searchParams.get("challenge")).toBe(challenge);
  const code = handoff.searchParams.get("code");

  // The app redeems it with its verifier – a wrong one burns the code.
  const redeem = (body: unknown) =>
    appPage.request.post(`${origin}/api/auth/desktop-redeem`, { headers: { origin }, data: body });
  expect((await redeem({ code, verifier: randomBytes(32).toString("base64url") })).status()).toBe(400);
  expect((await redeem({ code, verifier })).status()).toBe(400);

  // A fresh code with the right verifier signs the app in, once.
  // The app opens the browser again – a new tab. (In the tab that tried
  // to open flowplan:// Chromium ignores the next click on the form.)
  const again = await web.newPage();
  await again.goto(`${origin}/api/auth/desktop?challenge=${challenge}`);
  await again.getByRole("button", { name: "In der App anmelden" }).click();
  const second = new URL(String(await again.getByRole("link", { name: "Flowplan-App öffnen" }).getAttribute("href")));
  expect((await redeem({ code: second.searchParams.get("code"), verifier })).ok()).toBe(true);
  expect((await appPage.request.get(`${origin}/api/bootstrap`)).ok()).toBe(true);
  expect((await redeem({ code: second.searchParams.get("code"), verifier })).status()).toBe(400);

  // Without the confirmation click nothing is issued: a foreign site cannot
  // post the form (wrong origin).
  const forged = await web.request.post(`${origin}/api/auth/desktop`, {
    headers: { origin: "https://evil.example" },
    form: { challenge },
  });
  expect(forged.status()).toBe(403);
  await app.close();
  await web.close();
});

// The Windows desktop app (#165): passkeys with Windows Hello right in the
// app's window – the page's own button – and, when the prompt fails or is
// cancelled, "Im Browser anmelden" hands over to the browser after all. The
// app on macOS and Linux (and older apps) keep the hand-off; SSO always
// goes to the browser.
test("the Windows desktop app signs in with passkeys in its window", async ({ browser }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "One run covers it.");
  const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
  const agent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Electron/44.9.3 Safari/537.36 FlowplanDesktop/1.3.2";
  const app = await browser.newContext({ userAgent: agent });
  // The app's bridge (flowplan-desktop preload.js); Windows Hello cancelled.
  await app.addInitScript(() => {
    Object.defineProperty(window, "FlowplanDesktop", { value: Object.freeze({ platform: "desktop", version: "1.3.2", passkeys: "window" }) });
    (window as unknown as { asked: number }).asked = 0;
    navigator.credentials.get = () => {
      (window as unknown as { asked: number }).asked++;
      return Promise.reject(new DOMException("The operation either timed out or was not allowed.", "NotAllowedError"));
    };
  });
  const page = await app.newPage();
  await page.goto(origin + "/");
  await expect(page.getByRole("button", { name: "Mit Passkey anmelden" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Mit Passkey anmelden" })).toHaveCount(0);
  await expect(page.locator("[data-passkey-fallback]")).toHaveCount(0);
  await page.getByRole("button", { name: "Mit Passkey anmelden" }).click();
  await expect(page.locator(".login-column .error[role=alert]")).toHaveText("Anmeldung mit Passkey abgebrochen.");
  expect(await page.evaluate(() => (window as unknown as { asked: number }).asked)).toBe(1);
  const fallback = page.locator("[data-passkey-fallback] a");
  await expect(fallback).toHaveText("Im Browser anmelden");
  await expect(fallback).toHaveAttribute("href", "/api/auth/desktop");
  await app.close();

  // The app on macOS and Linux: the hand-off, as before.
  const other = await browser.newContext({ userAgent: agent.replace("Windows NT 10.0; Win64; x64", "Macintosh; Intel Mac OS X 10_15_7") });
  await other.addInitScript(() => {
    Object.defineProperty(window, "FlowplanDesktop", { value: Object.freeze({ platform: "desktop", version: "1.3.2", passkeys: "browser" }) });
  });
  const mac = await other.newPage();
  await mac.goto(origin + "/");
  await expect(mac.getByRole("link", { name: "Mit Passkey anmelden" })).toHaveAttribute("href", "/api/auth/desktop");
  await expect(mac.getByRole("button", { name: "Mit Passkey anmelden" })).toHaveCount(0);
  await other.close();
});

// The iOS and Android apps (FlowplanMobile/) hand over the same way.
test("the mobile app signs in with passkeys and SSO through the browser", async ({ browser }, testInfo) => {
  test.skip(testInfo.project.name !== "mobile", "One run covers it.");
  const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
  const app = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 FlowplanMobile/1.0.0",
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  const page = await app.newPage();
  await page.goto(origin + "/");
  await expect(page.getByRole("link", { name: "Mit Passkey anmelden" })).toHaveAttribute("href", "/api/auth/desktop");
  // Password managers fill in nothing in the app's web view (flowplan-app#5):
  // the same hand-off shows the password form in the system browser – a
  // link under the form, once "Mit E-Mail und Passwort" opened it.
  await expect(page.getByRole("link", { name: "Im Browser anmelden" })).toBeHidden();
  await openPasswordForm(page);
  await expect(page.getByRole("link", { name: "Im Browser anmelden" })).toHaveAttribute("href", "/api/auth/desktop");
  await expect(page.getByRole("link", { name: "Im Browser anmelden" })).toBeVisible();
  await app.close();
  // In a browser the page signs in itself.
  const web = await browser.newContext();
  const plain = await web.newPage();
  await plain.goto(origin + "/");
  await expect(plain.getByRole("button", { name: "Mit Passkey anmelden" })).toBeVisible();
  await openPasswordForm(plain);
  await expect(plain.getByRole("button", { name: "Anmelden", exact: true })).toBeVisible();
  await expect(plain.getByRole("link", { name: "Im Browser anmelden" })).toHaveCount(0);
  await web.close();
});

// "Im Browser anmelden" (flowplan-app#5): in the system browser the full
// sign-in with password and the code from the authenticator app – where
// password managers fill in both – ends in the hand-off to the app.
test("the mobile app signs in with password and two-factor code through the browser", async ({ browser }, testInfo) => {
  test.setTimeout(120_000);
  test.skip(!process.env.FLOWPLAN_DATA_DIR, "Needs the test server data directory.");
  test.skip(testInfo.project.name !== "mobile", "One run covers it; the instance setting is global.");
  const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
  const { totpCode } = await import("../../lib/totp");
  const { DatabaseSync } = await import("node:sqlite");
  const { join } = await import("node:path");
  const db = new DatabaseSync(join(process.env.FLOWPLAN_DATA_DIR!, "flowplan.sqlite"));
  db.exec("PRAGMA busy_timeout=5000;");
  const signup = (on: boolean) =>
    db
      .prepare("INSERT INTO instance_settings(key,value) VALUES('allowSignup',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
      .run(JSON.stringify(on));
  // The instance is set up already (otherwise the account would be its first).
  db.prepare("INSERT OR IGNORE INTO users(id,subject,name,email) VALUES(?,?,?,?)").run(
    "00000000-0000-4000-8000-0000000000aa",
    "seed:existing",
    "Bestehend",
    "existing@example.test",
  );
  const account = { name: "App Passwort", email: `app-totp-${Date.now()}@example.test`, password: "ein-langes-passwort" };
  const setup = await browser.newContext();
  try {
    signup(true);
    const registered = await setup.request.post(`${origin}/api/auth/register`, { headers: { origin }, data: account });
    expect(registered.ok(), await registered.text()).toBe(true);
  } finally {
    signup(false);
    db.close();
  }
  // An authenticator app for the account.
  const started = await setup.request.post(`${origin}/api/auth/totp-setup`, { headers: { origin }, data: {} });
  expect(started.ok(), await started.text()).toBe(true);
  const { secret } = (await started.json()) as { secret: string };
  const confirmed = await setup.request.post(`${origin}/api/auth/totp-confirm`, {
    headers: { origin },
    data: { code: totpCode(secret, Date.now()) },
  });
  expect(confirmed.ok(), await confirmed.text()).toBe(true);
  await setup.close();

  // The app's sign-in sheet opens the hand-off: the sign-in page with the password form.
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const sheet = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await sheet.newPage();
  await page.goto(`${origin}/api/auth/desktop?challenge=${challenge}`);
  await expect(page).toHaveURL(new RegExp(`desktop=${challenge}`));
  // The form is in the page (for password managers) before it is opened.
  await expect(page.locator("input[name=email]")).toHaveAttribute("autocomplete", "username webauthn");
  await openPasswordForm(page);
  await expect(page.locator("input[name=password]")).toHaveAttribute("autocomplete", "current-password");
  await page.locator("input[name=email]").fill(account.email);
  await page.locator("input[name=password]").fill(account.password);
  await page.getByRole("button", { name: "Anmelden", exact: true }).click();
  // The second step, with the code a password manager fills in.
  const code = page.locator("input[name=code]");
  await expect(code).toHaveAttribute("autocomplete", "one-time-code", { timeout: 20_000 });
  // A step later than the one the setup used (each step counts once).
  await code.fill(totpCode(secret, Date.now() + 30_000));
  await page.getByRole("button", { name: "Bestätigen" }).click();
  // Back to the hand-off, not into the workspace.
  await expect(page.getByRole("heading", { name: "Bei der Flowplan-App anmelden" })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(account.email)).toBeVisible();
  await page.getByRole("button", { name: "In der App anmelden" }).click();
  const handoff = new URL(String(await page.getByRole("link", { name: "Flowplan-App öffnen" }).getAttribute("href")));
  expect(handoff.searchParams.get("challenge")).toBe(challenge);

  // The app redeems the code: its web view is signed in as that account.
  const app = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 FlowplanMobile/1.0.3",
  });
  const redeemed = await app.request.post(`${origin}/api/auth/desktop-redeem`, {
    headers: { origin },
    data: { code: handoff.searchParams.get("code"), verifier },
  });
  expect(redeemed.ok(), await redeemed.text()).toBe(true);
  const boot = await app.request.get(`${origin}/api/bootstrap`);
  expect(boot.ok()).toBe(true);
  expect(JSON.stringify(await boot.json())).toContain(account.email);
  await sheet.close();
  await app.close();
});
