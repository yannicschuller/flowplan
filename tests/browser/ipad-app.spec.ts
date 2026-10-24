import { test, expect, type Page } from "@playwright/test";

// The page in the iPad app (flowplan-app): the app's window.FlowplanApp takes
// the shortcuts for its key commands (holding ⌘ lists them) and opens pages
// in new windows (lib/app-shortcuts.ts, lib/native-app.ts). A stand-in
// records what the page hands it.
type Calls = { shortcuts: { action: string; title: string; input: string; modifiers: string[]; hidden?: boolean }[][]; windows: string[] };

async function asIPadApp(page: Page) {
  await page.addInitScript(() => {
    const calls: Calls = { shortcuts: [], windows: [] };
    (window as unknown as { __app: Calls }).__app = calls;
    (window as unknown as { FlowplanApp: unknown }).FlowplanApp = {
      platform: "ios",
      version: "1.0.0",
      refresh: () => {},
      haptic: () => {},
      shortcuts: (list: Calls["shortcuts"][number]) => calls.shortcuts.push(list),
      openWindow: (url: string) => calls.windows.push(url),
    };
  });
  const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
  await page.request.post("/api/auth/demo", { headers: { origin } });
  return origin;
}
const app = (page: Page) => page.evaluate(() => (window as unknown as { __app: Calls }).__app);

test("the shortcuts become the app's key commands and run when the app reports them", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "One run covers the bridge.");
  await asIPadApp(page);
  await page.goto("/#home");
  await expect.poll(async () => (await app(page)).shortcuts.length).toBeGreaterThan(0);
  const list = (await app(page)).shortcuts.at(-1)!;
  // Titles in the page's language, combinations as key commands.
  expect(list).toContainEqual({ action: "search", title: "Suchen und Befehle", input: "k", modifiers: expect.any(Array) });
  expect(list.find((c) => c.action === "shortcuts")).toMatchObject({ title: "Tastenkürzel", input: "/" });
  // "?" stays with the page.
  expect(list.some((c) => c.input === "?")).toBe(false);

  // The app reports a pressed key command: the page runs it.
  await page.evaluate(() => (window as unknown as { FlowplanShortcuts: { run: (a: string) => boolean } }).FlowplanShortcuts.run("search"));
  await expect(page.getByRole("dialog", { name: "Schnellsuche" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "Schnellsuche" })).toHaveCount(0);
  // Unknown actions do nothing.
  expect(await page.evaluate(() => (window as unknown as { FlowplanShortcuts: { run: (a: string) => boolean } }).FlowplanShortcuts.run("deleteEverything"))).toBe(false);

  // When the key reaches the page as well, the action runs once: the
  // sidebar folds away and stays away.
  const shell = page.locator(".app-shell");
  await expect(shell).not.toHaveClass(/desktop-collapsed/);
  await page.evaluate(() => {
    (window as unknown as { FlowplanShortcuts: { run: (a: string) => boolean } }).FlowplanShortcuts.run("sidebar");
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "b", code: "KeyB", ctrlKey: true, altKey: true, bubbles: true, cancelable: true }));
  });
  await expect(shell).toHaveClass(/desktop-collapsed/);
  await page.waitForTimeout(400);
  await expect(shell).toHaveClass(/desktop-collapsed/);
  // A later press is a new one.
  await page.keyboard.press("Control+Alt+B");
  await expect(shell).not.toHaveClass(/desktop-collapsed/);
});

test("a page's menu opens it in a new window of the app", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "Right click is for mouse users.");
  const origin = await asIPadApp(page);
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const title = `Fenster ${Date.now()}`;
  const created = await (
    await page.request.post("/api/command", {
      headers: { origin },
      data: { action: "page.create", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, kind: "document", title },
    })
  ).json();
  await page.goto("/#home");
  await page.locator(`.page-nav[data-page-id="${created.id}"]`).click({ button: "right" });
  const menu = page.getByRole("menu", { name: `Aktionen für ${title}` });
  await expect(menu.getByRole("menuitem", { name: "In neuem Tab öffnen" })).toHaveCount(0);
  await menu.getByRole("menuitem", { name: "In neuem Fenster öffnen" }).click();
  await expect.poll(async () => (await app(page)).windows).toEqual([expect.stringContaining(`#page=${created.id}`)]);
});
