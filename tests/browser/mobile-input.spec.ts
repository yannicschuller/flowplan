import { test, expect, type Browser, type BrowserContext, type Page } from "@playwright/test";

// Input on phones and across systems: removing a date really removes it
// (components/date-input.tsx), shortcut hints only where a keyboard is
// (lib/keyboard-hints.ts) and shortcuts written for the device's system, not
// the account's (lib/device-os.ts, lib/keymap.ts).
const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
const shots = process.env.INPUT_SCREENSHOTS;
const UA = {
  mac: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
  windows: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
};

async function command(page: Page, data: Record<string, unknown>) {
  const response = await page.request.post("/api/command", { headers: { origin }, data });
  expect(response.ok(), await response.text()).toBe(true);
  return response.json();
}

test("removing a date with a tap removes it and keeps it removed after a reload", async ({ page }, info) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.request.post("/api/auth/demo", { headers: { origin } });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const p = await command(page, {
    action: "page.create",
    workspaceId: boot.workspace.id,
    spaceId: boot.spaces[0].id,
    title: `Fällig ${info.project.name} ${Date.now()}`,
    kind: "database",
  });
  const read = async () => (await page.request.get(`/api/pages/${p.id}`)).json();
  await command(page, {
    action: "database.update",
    pageId: p.id,
    version: (await read()).database.version,
    fields: [
      { id: "title", name: "Name", type: "text" },
      { id: "due", name: "Fällig am", type: "date" },
    ],
    views: [{ id: "table", name: "Tabelle", type: "table", filters: [], sorts: [] }],
  });
  const row = await command(page, { action: "row.create", pageId: p.id, cells: { title: "Steuer", due: "2026-11-03" } });

  await page.goto(`/#page=${p.id}&row=${row.id}`);
  const dialog = page.getByRole("dialog", { name: "Eintrag", exact: true });
  const date = dialog.getByLabel("Fällig am", { exact: true });
  await expect(date).toHaveValue("2026-11-03");
  // No <label> around the date: WebKit would pass the tap on "Datum
  // entfernen" to the date input and open the picker instead.
  expect(await date.evaluate((el) => !!el.closest("label"))).toBe(false);
  const remove = dialog.getByRole("button", { name: "Fällig am entfernen" });
  if (info.project.name === "mobile") await remove.tap();
  else await remove.click();
  await expect(date).toHaveValue("");
  // The picker did not open: the date input did not take the focus.
  expect(await date.evaluate((el) => el === document.activeElement)).toBe(false);
  await expect.poll(async () => (await read()).rows[0].cells.due ?? "", { timeout: 15000 }).toBe("");
  // Leaving the field does not bring the old date back.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.waitForTimeout(300);
  expect((await read()).rows[0].cells.due ?? "").toBe("");

  await page.reload();
  await expect(page.getByRole("dialog", { name: "Eintrag", exact: true }).getByLabel("Fällig am", { exact: true })).toHaveValue("");
  await expect(page.getByRole("button", { name: "Fällig am entfernen" })).toHaveCount(0);

  // With the keyboard: the focus stays in the field.
  if (info.project.name === "desktop") {
    await command(page, { action: "row.update", pageId: p.id, rowId: row.id, version: (await read()).rows[0].version, cells: { due: "2026-12-24" } });
    await page.reload();
    const again = page.getByRole("dialog", { name: "Eintrag", exact: true });
    await expect(again.getByLabel("Fällig am", { exact: true })).toHaveValue("2026-12-24");
    await again.getByRole("button", { name: "Fällig am entfernen" }).focus();
    await page.keyboard.press("Enter");
    await expect(again.getByLabel("Fällig am", { exact: true })).toBeFocused();
    await expect.poll(async () => (await read()).rows[0].cells.due ?? "", { timeout: 15000 }).toBe("");
  }
  expect(errors).toEqual([]);
});

// One account, two computers.
async function signedInAs(browser: Browser, userAgent: string, storageState?: Awaited<ReturnType<BrowserContext["storageState"]>>) {
  const context = await browser.newContext({ userAgent, storageState, viewport: { width: 1280, height: 900 }, locale: "de-DE" });
  const page = await context.newPage();
  return { context, page };
}

test("the shortcut overview writes the keys of the device's system, for the same account", async ({ browser }, info) => {
  test.skip(info.project.name !== "desktop", "Keyboards: the desktop run.");
  const mac = await signedInAs(browser, UA.mac);
  await mac.page.request.post("/api/auth/demo", { headers: { origin } });
  // An own combination, stored once for the account.
  await command(mac.page, { action: "shortcuts.save", bindings: { search: ["Mod+Shift+Y"] } });
  const saved = await mac.context.storageState();
  const windows = await signedInAs(browser, UA.windows, saved);

  for (const [name, device, own, fixed, press] of [
    ["mac", mac, "⇧ ⌘ Y", "⌥ ⌘ N", "Meta+Shift+Y"],
    ["windows", windows, "Ctrl + Shift + Y", "Ctrl + Alt + N", "Control+Shift+Y"],
  ] as const) {
    const page = device.page;
    await page.goto("/#home");
    await expect(page.locator("html")).toHaveAttribute("data-keyboard-hints", "on");
    // The sidebar's search hint follows the own combination.
    await expect(page.locator(".main-nav .keycap")).toHaveText(own);
    await page.evaluate(() => window.dispatchEvent(new Event("flowplan:shortcuts")));
    const dialog = page.getByRole("dialog", { name: "Tastenkürzel" });
    await expect(dialog).toBeVisible();
    await expect(dialog.locator('[data-action="search"] kbd')).toHaveText([own]);
    await expect(dialog.locator('[data-action="capture"] kbd')).toHaveText([fixed]);
    if (name === "mac") {
      await expect(dialog.getByText("Angezeigt für Apple-Tastaturen")).toBeVisible();
      await expect(dialog.locator("kbd", { hasText: "Ctrl" })).toHaveCount(0);
    } else await expect(dialog.locator("kbd", { hasText: "⌘" })).toHaveCount(0);
    if (shots) await dialog.screenshot({ path: `${shots}/input-shortcuts-${name}.png` });
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    // The keys work the same way: ⌘ on the Mac, Ctrl on Windows.
    await page.keyboard.press(press);
    await expect(page.getByRole("dialog", { name: "Schnellsuche" })).toBeVisible();
    await page.keyboard.press("Escape");
  }
  await command(mac.page, { action: "shortcuts.save", bindings: {} });
  await mac.context.close();
  await windows.context.close();
});

test("no shortcut hints on a phone without a keyboard – in the browser and in the app", async ({ page }, info) => {
  test.skip(info.project.name !== "mobile", "Touch screens: the mobile run.");
  await page.request.post("/api/auth/demo", { headers: { origin } });
  await command(page, { action: "profile.onboarded" });
  await page.goto("/#home");
  await expect(page.locator("html")).toHaveAttribute("data-keyboard-hints", "off");
  // The home page has no "⌘ K" line.
  await expect(page.locator(".home-footnote")).toBeVisible();
  await expect(page.locator(".home-footnote .kbd-hint")).toHaveCount(0);
  await expect(page.getByText(/⌘|Ctrl \+/)).toHaveCount(0);
  // Titles carry no combinations either.
  const titles = await page.evaluate(() => [...document.querySelectorAll("[title]")].map((el) => el.getAttribute("title") || ""));
  expect(titles.filter((t) => /⌘|Ctrl|Strg/.test(t))).toEqual([]);
  // The sidebar's search has no ⌘K badge.
  await page.getByRole("button", { name: "Navigation öffnen" }).tap();
  const search = page.locator(".main-nav button", { hasText: "Suchen" });
  await expect(search).toBeVisible();
  await expect(search.locator(".keycap")).toHaveCount(0);
  await page.waitForTimeout(500);
  if (shots) await page.screenshot({ path: `${shots}/input-mobile-sidebar.png` });
  // The quick search shows no ↵ / esc keys.
  await search.tap();
  const palette = page.getByRole("dialog", { name: "Schnellsuche" });
  await expect(palette).toBeVisible();
  await expect(palette.locator("kbd").first()).toBeAttached();
  for (const kbd of await palette.locator("kbd").all()) await expect(kbd).toBeHidden();
  if (shots) await page.screenshot({ path: `${shots}/input-mobile-search.png` });

  // In the app (window.FlowplanApp), too.
  await page.addInitScript(() => {
    (window as unknown as { FlowplanApp: unknown }).FlowplanApp = { platform: "ios", version: "1.0.0" };
  });
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-keyboard-hints", "off");
  await expect(page.locator(".home-footnote .kbd-hint")).toHaveCount(0);

  // A hardware keyboard gives itself away: the hints come back.
  await page.evaluate(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true })));
  await expect(page.locator("html")).toHaveAttribute("data-keyboard-hints", "on");
  await expect(page.locator(".home-footnote .kbd-hint")).toHaveCount(1);
});
