import { test, expect, type Page } from "@playwright/test";

// "Beim Öffnen auf dem Handy: Schnellerfassung" (lib/start-screen.ts,
// components/start-capture.tsx): on a phone the bare address opens the
// quick capture with the title focused; a deep link opens its target;
// after saving "Noch eins" starts again and "Zur App" opens the workspace;
// offline the record waits in the queue and the workspace sends it.

const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
const IPHONE =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1";
test.use({ userAgent: IPHONE });
test.setTimeout(120_000);

async function setup(page: Page) {
  await page.request.post("/api/auth/demo", { headers: { origin } });
  const command = async (data: Record<string, unknown>) => {
    const response = await page.request.post("/api/command", { headers: { origin }, data });
    expect(response.ok(), await response.text()).toBe(true);
    return response.json();
  };
  await command({ action: "profile.onboarded" });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const tag = Date.now();
  const inbox = (await command({ action: "page.create", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, title: `Eingang ${tag}`, kind: "database" })).id as string;
  await command({ action: "capture.target", workspaceId: boot.workspace.id, pageId: inbox });
  const rows = async () => ((await (await page.request.get(`/api/pages/${inbox}`)).json()).rows || []) as { id: string }[];
  return { command, boot, inbox, rows, tag };
}

test.afterEach(async ({ page }) => {
  await page.request.post("/api/command", { headers: { origin }, data: { action: "profile.startScreen", startScreen: "home" } });
});

test("cold load on a phone shows the capture focused; save, “Noch eins”, “Zur App”", async ({ page }, info) => {
  test.skip(info.project.name !== "mobile", "phones only");
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const { command, rows, tag } = await setup(page);
  await command({ action: "profile.startScreen", startScreen: "capture" });

  await page.goto("/");
  const screen = page.getByRole("main", { name: "Erfassen" });
  await expect(screen).toBeVisible({ timeout: 30_000 });
  const title = screen.getByLabel("Titel");
  await expect(title).toBeFocused();
  // The default capture database is the target.
  await expect(screen).toContainText(`Eingang ${tag}`);

  await page.keyboard.type(`Gedanke ${tag}`);
  await screen.getByLabel("Text").fill("Unterwegs notiert");
  await screen.getByRole("button", { name: "Erfassen", exact: true }).click();
  await expect(screen.getByRole("status")).toHaveText(/Erfasst\./);
  const again = screen.getByRole("button", { name: "Noch eins" });
  await expect(again).toBeFocused();
  await expect.poll(async () => (await rows()).length).toBe(1);

  await again.click();
  await expect(title).toBeFocused();
  await expect(title).toHaveValue("");
  await title.fill(`Zweiter Gedanke ${tag}`);
  await screen.getByRole("button", { name: "Erfassen", exact: true }).click();
  await expect(screen.getByRole("status")).toHaveText(/Erfasst\./);
  await expect.poll(async () => (await rows()).length).toBe(2);

  // To the workspace: the start page.
  await screen.getByRole("button", { name: "Zur App" }).click();
  await expect(page.locator(".start-capture")).toHaveCount(0);
  await expect(page.locator(".home-grid")).toBeVisible({ timeout: 30_000 });
  expect(errors).toEqual([]);
});

test("deep links, the setting off and a tablet open the app", async ({ page }, info) => {
  test.skip(info.project.name !== "mobile", "phones only");
  const { command, boot } = await setup(page);
  await command({ action: "profile.startScreen", startScreen: "capture" });
  const doc = (await command({ action: "page.create", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, title: `Direkt ${Date.now()}`, kind: "document" })).id as string;

  await page.goto(`/#page=${doc}`);
  await expect(page.locator("textarea.page-title").first()).toBeVisible({ timeout: 30_000 });
  await expect(page.locator(".start-capture")).toHaveCount(0);

  await page.goto("/#inbox");
  await expect(page.locator(".start-capture")).toHaveCount(0);

  // A tablet's screen: the app.
  await page.setViewportSize({ width: 820, height: 1180 });
  await page.goto("about:blank");
  await page.goto("/");
  await expect(page.locator(".home-grid")).toBeVisible({ timeout: 30_000 });
  await expect(page.locator(".start-capture")).toHaveCount(0);

  // The setting off: the app on a phone too.
  await page.setViewportSize({ width: 390, height: 844 });
  await command({ action: "profile.startScreen", startScreen: "home" });
  await page.goto("about:blank");
  await page.goto("/");
  await expect(page.locator(".home-grid")).toBeVisible({ timeout: 30_000 });
  await expect(page.locator(".start-capture")).toHaveCount(0);
});

test("offline the capture waits on the device; the workspace sends it", async ({ page, context }, info) => {
  test.skip(info.project.name !== "mobile", "phones only");
  const { command, rows, tag } = await setup(page);
  await command({ action: "profile.startScreen", startScreen: "capture" });
  await page.goto("/");
  const screen = page.getByRole("main", { name: "Erfassen" });
  await expect(screen).toContainText(`Eingang ${tag}`, { timeout: 30_000 });

  await context.setOffline(true);
  await screen.getByLabel("Titel").fill(`Offline ${tag}`);
  await screen.getByRole("button", { name: "Erfassen", exact: true }).click();
  await expect(screen.getByRole("status")).toHaveText(/Gespeichert auf diesem Gerät/);
  expect((await rows()).length).toBe(0);
  await context.setOffline(false);

  // Sent once the connection is back (here or by the workspace).
  await screen.getByRole("button", { name: "Zur App" }).click();
  await expect.poll(async () => (await rows()).length, { timeout: 45_000 }).toBe(1);
});
