import { test, expect, type Page } from "@playwright/test";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";

// "Passkey hinzufügen" in the iPhone/iPad/Android app (lib/app-passkey.ts):
// the page gets a one-time link and hands it to the app's bridge
// (FlowplanApp.addPasskey); the app opens it in the system's sign-in sheet –
// here a second browser context without the app's cookies, with Chrome's
// virtual authenticator. WebAuthn needs a host name: a server on
// http://localhost (PASSKEY_BASE_URL), like local-auth.spec.ts.
const setSignup = (on: boolean) => {
  const db = new DatabaseSync(join(process.env.FLOWPLAN_DATA_DIR!, "flowplan.sqlite"));
  db.exec("PRAGMA busy_timeout=5000;");
  db.prepare("INSERT INTO instance_settings(key,value) VALUES('allowSignup',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify(on));
  db.prepare("INSERT OR IGNORE INTO users(id,subject,name,email) VALUES(?,?,?,?)").run("00000000-0000-4000-8000-0000000000aa", "seed:existing", "Bestehend", "existing@example.test");
  db.close();
};
const register = async (page: Page, email: string) => {
  await page.goto("/register");
  await page.getByLabel("Name").fill("App Person");
  await page.getByLabel("E-Mail-Adresse").fill(email);
  await page.locator("input[name=password]").fill("ein-langes-passwort");
  await page.getByRole("button", { name: "Konto erstellen" }).click();
  await expect(page.getByLabel("Dokumentinhalt", { exact: true }).or(page.locator(".sidebar"))).toBeVisible({ timeout: 20_000 });
  const intro = page.getByRole("dialog", { name: "Willkommen bei Flowplan" });
  await intro.getByRole("button", { name: "Überspringen" }).click();
  await expect(intro).toBeHidden();
};
const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 FlowplanMobile/1.0.18";
const SAFARI = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
const STATE = "app-state-0123456789abcdef";
const RETURN = `flowplan://passkey?state=${STATE}`;

test("the app adds a passkey in the system's sign-in sheet", async ({ browser }, info) => {
  test.setTimeout(180_000);
  const base = process.env.PASSKEY_BASE_URL;
  test.skip(!base || !process.env.FLOWPLAN_DATA_DIR, "Needs PASSKEY_BASE_URL (a server on http://localhost).");
  test.skip(info.project.name !== "desktop", "Virtual authenticator on desktop Chromium.");

  // The app's web view: the bridge with addPasskey (apps after 1.0.17).
  const app = await browser.newContext({ baseURL: base, userAgent: IPHONE });
  const links: string[] = [];
  await app.exposeBinding("__flowplanAddPasskey", (_source, url: string) => void links.push(url));
  await app.addInitScript(() => {
    (window as unknown as { FlowplanApp: unknown }).FlowplanApp = Object.freeze({
      platform: "ios",
      version: "1.0.18",
      addPasskey: (url: string) => (window as unknown as { __flowplanAddPasskey: (url: string) => void }).__flowplanAddPasskey(String(url)),
      openInBrowser: () => {},
    });
  });
  const page = await app.newPage();
  // The sheet: Safari without the app's cookies, with an authenticator.
  const sheetContext = await browser.newContext({ baseURL: base, userAgent: SAFARI });
  const sheet = await sheetContext.newPage();
  const cdp = await sheetContext.newCDPSession(sheet);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true },
  });
  const email = `app-passkey-${Date.now()}@example.test`;
  try {
    setSignup(true);
    await register(page, email);
    await page.goto("/#settings/account/passkeys");
    // The app's own way again – not "Im Browser hinzufügen".
    await expect(page.getByRole("button", { name: "Im Browser hinzufügen" })).toHaveCount(0);
    await page.getByRole("button", { name: "Passkey hinzufügen" }).click();
    await expect.poll(() => links.length).toBe(1);
    const link = new URL(links[0]);
    expect(link.origin).toBe(new URL(base!).origin);
    expect(link.pathname).toBe("/passkey-add");
    expect(link.searchParams.get("token")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    await expect(page.getByRole("button", { name: "Passkey hinzufügen" })).toBeDisabled();

    // A callback to anywhere but the app is refused, and the link stays usable.
    await sheet.goto(`${link.href}&return=${encodeURIComponent("https://evil.example/?state=" + STATE)}`);
    await expect(sheet.getByRole("heading", { name: "Link ungültig" })).toBeVisible();
    await expect(sheet.locator('a[href^="https://evil"]')).toHaveCount(0);

    // The sheet as the app opens it: the account named, the token gone from the address.
    await sheet.goto(`${link.href}&return=${encodeURIComponent(RETURN)}`);
    await expect(sheet.getByRole("heading", { name: "Passkey hinzufügen" })).toBeVisible();
    await expect(sheet.getByText(email)).toBeVisible();
    await expect.poll(() => new URL(sheet.url()).searchParams.has("token")).toBe(false);
    await expect(sheet.getByRole("link", { name: "Abbrechen" })).toHaveAttribute("href", `${RETURN}&status=cancelled`);
    await sheet.getByRole("button", { name: "Passkey anlegen" }).click();
    await expect(sheet.getByRole("heading", { name: "Passkey angelegt" })).toBeVisible({ timeout: 20_000 });
    await expect(sheet.getByRole("link", { name: "Zurück zur App" })).toHaveAttribute("href", `${RETURN}&status=added`);

    // The app reports back; the page reloads its list.
    await page.evaluate(() => window.dispatchEvent(new CustomEvent("flowplan:passkey", { detail: { status: "added" } })));
    await expect(page.getByRole("status").filter({ hasText: "Passkey angelegt" })).toBeVisible();
    await expect(page.locator(".passkey-list li")).toHaveCount(1);
    await expect(page.locator(".passkey-list li")).toContainText("Passkey · iPhone");

    // Once: the same link again does nothing.
    await sheet.goto(`${link.href}&return=${encodeURIComponent(RETURN)}`);
    await expect(sheet.getByRole("heading", { name: "Link abgelaufen" })).toBeVisible();
    await expect(sheet.getByRole("link", { name: "Zurück zur App" })).toHaveAttribute("href", `${RETURN}&status=failed`);
    const reuse = await sheet.request.post("/api/auth/passkey-app-options", { headers: { origin: new URL(base!).origin }, data: { token: link.searchParams.get("token") } });
    expect(reuse.status()).toBe(400);

    // A cancelled sheet: the page frees the button and shows nothing wrong.
    await page.getByRole("button", { name: "Passkey hinzufügen" }).click();
    await expect.poll(() => links.length).toBe(2);
    await page.evaluate(() => window.dispatchEvent(new CustomEvent("flowplan:passkey", { detail: { status: "cancelled" } })));
    await expect(page.getByRole("button", { name: "Passkey hinzufügen" })).toBeEnabled();
    await expect(page.locator(".save-state.error")).toHaveCount(0);
    await expect(page.locator(".passkey-list li")).toHaveCount(1);

    // An older app (no addPasskey) keeps the way through the browser.
    const older = await browser.newContext({ baseURL: base, userAgent: IPHONE, storageState: await app.storageState() });
    await older.addInitScript(() => {
      (window as unknown as { FlowplanApp: unknown }).FlowplanApp = Object.freeze({ platform: "ios", version: "1.0.17", openInBrowser: () => {} });
    });
    const olderPage = await older.newPage();
    await olderPage.goto("/#settings/account/passkeys");
    await expect(olderPage.getByRole("button", { name: "Im Browser hinzufügen" })).toBeVisible({ timeout: 20_000 });
    await expect(olderPage.getByRole("button", { name: "Passkey hinzufügen" })).toHaveCount(0);
    await older.close();
  } finally {
    setSignup(false);
    await sheetContext.close();
    await app.close();
  }
});

// The desktop app on a Mac (FlowplanDesktop.addPasskeyInBrowser): the link
// opens in the default browser without a callback – the passkey goes to the
// iCloud Keychain – and the window asks the instance until it is there.
test("the desktop app adds a passkey in the default browser", async ({ browser }, info) => {
  test.setTimeout(180_000);
  const base = process.env.PASSKEY_BASE_URL;
  test.skip(!base || !process.env.FLOWPLAN_DATA_DIR, "Needs PASSKEY_BASE_URL (a server on http://localhost).");
  test.skip(info.project.name !== "desktop", "Virtual authenticator on desktop Chromium.");
  const MAC_APP = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Electron/45.0.0 Safari/537.36 FlowplanDesktop/1.3.12";
  const MAC_SAFARI = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15";
  const desktop = await browser.newContext({ baseURL: base, userAgent: MAC_APP });
  const links: string[] = [];
  await desktop.exposeBinding("__flowplanPasskeyLink", (_source, url: string) => void links.push(url));
  await desktop.addInitScript(() => {
    const open = (url: string) => (window as unknown as { __flowplanPasskeyLink: (url: string) => Promise<void> }).__flowplanPasskeyLink(String(url)).then(() => true);
    (window as unknown as { FlowplanDesktop: unknown }).FlowplanDesktop = Object.freeze({ platform: "desktop", version: "1.3.12", passkeys: "window", addPasskeyInBrowser: open });
  });
  const page = await desktop.newPage();
  const browserContext = await browser.newContext({ baseURL: base, userAgent: MAC_SAFARI });
  const tab = await browserContext.newPage();
  const cdp = await browserContext.newCDPSession(tab);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true },
  });
  const email = `desktop-passkey-${Date.now()}@example.test`;
  try {
    setSignup(true);
    await register(page, email);
    await page.goto("/#settings/account/passkeys");
    // Touch ID in the window as well: the choice, the Keychain first.
    await page.getByRole("button", { name: "Passkey hinzufügen" }).click();
    const choice = page.getByRole("group", { name: "Wo soll der Passkey liegen?" });
    await expect(choice.getByRole("button", { name: "Nur in dieser App (Touch ID)" })).toBeVisible();
    await choice.getByRole("button", { name: "Im Schlüsselbund (iCloud)" }).click();
    await expect.poll(() => links.length).toBe(1);
    await expect(page.getByText("Im Browser fortfahren …")).toBeVisible();
    const link = new URL(links[0]);
    expect(link.pathname).toBe("/passkey-add");
    expect([...link.searchParams.keys()]).toEqual(["token"]);
    // The window's own session can ask whether the link was used yet.
    const status = await page.request.post("/api/auth/passkey-app-status", { headers: { origin: new URL(base!).origin }, data: { token: link.searchParams.get("token") } });
    expect((await status.json()).status).toBe("waiting");

    // The default browser: no way back but closing the window.
    await tab.goto(link.href);
    await expect(tab.getByRole("heading", { name: "Passkey hinzufügen" })).toBeVisible();
    await expect(tab.getByRole("link", { name: "Abbrechen" })).toHaveCount(0);
    await tab.getByRole("button", { name: "Passkey anlegen" }).click();
    await expect(tab.getByRole("heading", { name: "Passkey angelegt" })).toBeVisible({ timeout: 20_000 });
    await expect(tab.getByText("Du kannst dieses Fenster schließen")).toBeVisible();
    await expect(tab.getByRole("link", { name: "Zurück zur App" })).toHaveCount(0);

    // The app's window sees it by itself.
    await expect(page.getByRole("status").filter({ hasText: "Passkey angelegt" })).toBeVisible({ timeout: 15_000 });
    await expect(page.locator(".passkey-list li")).toHaveCount(1);
    await expect(page.locator(".passkey-list li")).toContainText("Passkey · Mac");

    // The passkey signs in, here in the browser.
    await tab.goto("/login");
    await tab.getByRole("button", { name: "Mit Passkey anmelden" }).click();
    await expect(tab.locator(".sidebar")).toBeVisible({ timeout: 20_000 });

    // Cancelled in the window: the waiting ends, nothing else changes.
    await page.getByRole("button", { name: "Passkey hinzufügen" }).click();
    await choice.getByRole("button", { name: "Im Schlüsselbund (iCloud)" }).click();
    await expect.poll(() => links.length).toBe(2);
    await page.getByRole("button", { name: "Abbrechen" }).click();
    await expect(page.getByRole("button", { name: "Passkey hinzufügen" })).toBeEnabled({ timeout: 10_000 });
    await expect(page.locator(".passkey-list li")).toHaveCount(1);
  } finally {
    setSignup(false);
    await browserContext.close();
    await desktop.close();
  }
});
