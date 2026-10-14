import { test, expect } from "@playwright/test";
import { createHash, randomBytes } from "node:crypto";

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
  await expect(page.getByText("Melde dich an, um Flowplan Desktop mit deinem Konto zu verbinden.")).toBeVisible();
  await page.getByRole("button", { name: "Lokalen Arbeitsbereich öffnen" }).click();
  await expect(page.getByRole("heading", { name: "Flowplan Desktop anmelden" })).toBeVisible({ timeout: 60_000 });
  await page.getByRole("button", { name: "In der Desktop-App anmelden" }).click();
  const link = await page.getByRole("link", { name: "Flowplan Desktop öffnen" }).getAttribute("href");
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
  await page.goto(`${origin}/api/auth/desktop?challenge=${challenge}`);
  await page.getByRole("button", { name: "In der Desktop-App anmelden" }).click();
  const second = new URL(String(await page.getByRole("link", { name: "Flowplan Desktop öffnen" }).getAttribute("href")));
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
