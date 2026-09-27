import { test, expect } from "@playwright/test";

test("tokens, calendar subscriptions, e-mail channel and admin backup work from the interface", async ({ page, playwright }, info) => {
  test.skip(info.project.name !== "desktop", "Settings flows are the same on mobile.");
  const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
  await page.request.post("/api/auth/demo", { headers: { origin } });
  const boot = await (await page.request.get("/api/bootstrap")).json();

  // Personal API token: created once, then usable without the cookie.
  await page.goto("/#settings");
  await page.getByRole("button", { name: "API & Webhooks" }).click();
  const name = `Skript ${Date.now()}`;
  await page.getByRole("textbox", { name: "Name des Tokens" }).fill(name);
  await page.getByRole("button", { name: "Token erstellen" }).click();
  const token = (await page.locator(".integration-secret code").textContent())!.trim();
  expect(token).toMatch(/^fp_/);
  await expect(page.locator(".integration-list", { hasText: name })).toBeVisible();
  const bare = await playwright.request.newContext({ baseURL: origin });
  const withToken = await bare.get("/api/bootstrap", { headers: { Authorization: `Bearer ${token}` } });
  expect(withToken.ok()).toBe(true);
  expect((await withToken.json()).user.id).toBe(boot.user.id);
  const readOnly = await bare.post("/api/command", {
    headers: { Authorization: `Bearer ${token}` },
    data: { action: "page.create", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, title: "x" },
  });
  expect(readOnly.status()).toBe(403);
  expect((await bare.get("/api/bootstrap", { headers: { Authorization: "Bearer fp_wrongwrongwrongwrongwrong" } })).status()).toBe(401);

  // E-mail channel per notification kind.
  await page.getByRole("button", { name: "Benachrichtigungen" }).click();
  const mention = page.getByRole("checkbox", { name: "Erwähnungen per E-Mail" });
  await expect(mention).toBeChecked();
  await mention.uncheck();
  await expect.poll(async () => (await (await page.request.get("/api/bootstrap")).json()).notificationPrefs.mention.email).toBe(false);
  await mention.check();

  // Calendar subscription of a calendar view.
  const created = await page.request.post("/api/command", {
    headers: { origin },
    data: { action: "page.create", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, kind: "database", title: `Abo ${Date.now()}` },
  });
  const db = (await created.json()).id as string;
  const row = await page.request.post("/api/command", {
    headers: { origin },
    data: { action: "row.create", pageId: db, cells: { title: "Kalendertermin", date: "2026-10-12" } },
  });
  expect(row.ok()).toBe(true);
  await page.goto(`/#page=${db}`);
  await page.locator(".database-tabs").getByRole("button", { name: "Kalender", exact: true }).click();
  await page.getByRole("button", { name: "Abonnieren" }).click();
  await page.getByRole("button", { name: "Link erzeugen" }).click();
  const url = await page.getByRole("textbox", { name: "Abo-Link" }).inputValue();
  expect(url).toMatch(/\/api\/calendar\/[A-Za-z0-9_-]+\.ics$/);
  const ics = await bare.get(new URL(url).pathname);
  expect(ics.headers()["content-type"]).toContain("text/calendar");
  expect(await ics.text()).toContain("SUMMARY:Kalendertermin");
  await bare.dispose();

  // Administration: backup now, audit export, e-mail status.
  await page.goto("/#admin");
  await page.getByRole("button", { name: "Instanz" }).click();
  await expect(page.getByRole("heading", { name: "E-Mail-Versand" })).toBeVisible();
  await page.getByRole("button", { name: "Jetzt sichern" }).click();
  await expect(page.getByText("Sicherung erstellt.")).toBeVisible({ timeout: 20_000 });
  await page.getByRole("button", { name: "Aktivitätsprotokoll" }).click();
  const csv = await page.request.get("/api/admin/audit.csv");
  expect(csv.headers()["content-type"]).toContain("text/csv");
  expect(await csv.text()).toContain("\"Zeitpunkt\";\"Person\"");
});
