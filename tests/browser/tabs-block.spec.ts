import { test, expect, type Page } from "@playwright/test";

// The tabs block (#272): insert with /tabs, add, rename, reorder and delete
// tabs, type into a tab; switching tabs is no edit (nothing is synced, no
// version); the tab shown stays after a reload; print and the published
// page show every tab with its title.
async function setup(page: Page, title: string) {
  const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
  await page.request.post("/api/auth/demo", { headers: { origin } });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const command = async (data: Record<string, unknown>) => {
    const response = await page.request.post("/api/command", { headers: { origin }, data });
    expect(response.ok(), await response.text()).toBe(true);
    return response.json();
  };
  const host = await command({
    action: "page.create",
    workspaceId: boot.workspace.id,
    spaceId: boot.spaces[0].id,
    title: `${title} ${Date.now()}`,
  });
  const read = async () => (await page.request.get(`/api/pages/${host.id}`)).json();
  return { origin, command, host, read };
}
// The welcome of a new account, if it shows.
async function dismissWelcome(page: Page) {
  const welcome = page.getByRole("dialog", { name: "Willkommen bei Flowplan" });
  await welcome.waitFor({ timeout: 3000 }).then(() => page.keyboard.press("Escape"), () => {});
}

test("tabs: insert, add, rename, type, switch, delete with undo", async ({ page }, info) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const mobile = info.project.name === "mobile";
  const f = await setup(page, "Tabs");
  await page.goto(`/#page=${f.host.id}`);
  await dismissWelcome(page);
  const editor = page.getByLabel("Dokumentinhalt", { exact: true });
  await editor.click();
  await page.keyboard.type("/tabs");
  await page.getByRole("option", { name: /^Tabs/ }).first().click();
  const tablist = editor.getByRole("tablist", { name: "Tabs" });
  await expect(tablist.getByRole("tab")).toHaveText(["Tab 1", "Tab 2"]);
  await expect(tablist.getByRole("tab", { name: "Tab 1" })).toHaveAttribute("aria-selected", "true");
  // Writing starts in the first tab.
  await page.keyboard.type("Inhalt eins");
  await expect.poll(async () => (await f.read()).html, { timeout: 15000 }).toContain("Inhalt eins");

  // Rename by double click (on phones through the menu).
  if (mobile) {
    await editor.getByRole("button", { name: "Tab-Aktionen" }).click();
    await page.getByRole("menuitem", { name: "Umbenennen" }).click();
  } else await tablist.getByRole("tab", { name: "Tab 1" }).dblclick();
  const rename = editor.getByRole("textbox", { name: "Name des Tabs" });
  await rename.fill("Überblick");
  await rename.press("Enter");
  await expect(tablist.getByRole("tab")).toHaveText(["Überblick", "Tab 2"]);

  // Switch to the second tab and type there.
  await tablist.getByRole("tab", { name: "Tab 2" }).click();
  await expect(tablist.getByRole("tab", { name: "Tab 2" })).toHaveAttribute("aria-selected", "true");
  const panels = editor.getByRole("tabpanel");
  await expect(panels.filter({ visible: true })).toHaveCount(1);
  await expect(editor.getByText("Inhalt eins")).toBeHidden();
  await panels.filter({ visible: true }).locator("p").click();
  await page.keyboard.type("Inhalt zwei");
  await expect.poll(async () => (await f.read()).html, { timeout: 15000 }).toMatch(/Überblick[\s\S]*Inhalt eins[\s\S]*Tab 2[\s\S]*Inhalt zwei/);

  // Add a third tab: it opens with its name to type.
  await editor.getByRole("button", { name: "Tab hinzufügen" }).click();
  await editor.getByRole("textbox", { name: "Name des Tabs" }).fill("Drittens");
  await page.keyboard.press("Enter");
  await expect(tablist.getByRole("tab")).toHaveText(["Überblick", "Tab 2", "Drittens"]);
  await expect(tablist.getByRole("tab", { name: "Drittens" })).toHaveAttribute("aria-selected", "true");

  // Keyboard: ← → switch, the focus follows.
  await tablist.getByRole("tab", { name: "Drittens" }).focus();
  await page.keyboard.press("ArrowLeft");
  await expect(tablist.getByRole("tab", { name: "Tab 2" })).toBeFocused();
  await expect(tablist.getByRole("tab", { name: "Tab 2" })).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Home");
  await expect(tablist.getByRole("tab", { name: "Überblick" })).toHaveAttribute("aria-selected", "true");

  // Switching sends nothing and makes no version.
  await expect.poll(async () => (await f.read()).html, { timeout: 15000 }).toContain("Drittens");
  await page.waitForTimeout(1500);
  const before = await f.read();
  const synced: string[] = [];
  page.on("request", (request) => {
    if (request.method() === "POST" && /document\.sync/.test(request.postData() || "")) synced.push(request.url());
  });
  for (const name of ["Tab 2", "Drittens", "Überblick", "Tab 2"]) {
    await tablist.getByRole("tab", { name, exact: true }).click();
    await expect(tablist.getByRole("tab", { name, exact: true })).toHaveAttribute("aria-selected", "true");
  }
  await page.waitForTimeout(2500);
  expect(synced).toEqual([]);
  const after = await f.read();
  expect(after.html).toBe(before.html);
  expect(after.generation).toBe(before.generation);
  expect((after.snapshots || []).length).toBe((before.snapshots || []).length);

  // The tab shown stays after a reload (this device).
  await page.reload();
  await dismissWelcome(page);
  await expect(page.getByLabel("Dokumentinhalt", { exact: true }).getByRole("tab", { name: "Tab 2" })).toHaveAttribute("aria-selected", "true");

  // Reorder: by dragging with a mouse, through the menu on phones.
  const strip = page.getByLabel("Dokumentinhalt", { exact: true }).getByRole("tablist", { name: "Tabs" });
  if (mobile) {
    await page.getByRole("button", { name: "Tab-Aktionen" }).click();
    await page.getByRole("menuitem", { name: "Nach rechts verschieben" }).click();
  } else {
    const from = (await strip.getByRole("tab", { name: "Tab 2" }).boundingBox())!;
    const to = (await strip.getByRole("tab", { name: "Drittens" }).boundingBox())!;
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
    await page.mouse.down();
    await page.mouse.move(to.x + to.width - 4, to.y + to.height / 2, { steps: 8 });
    await page.mouse.up();
  }
  await expect(strip.getByRole("tab")).toHaveText(["Überblick", "Drittens", "Tab 2"]);
  await expect(strip.getByRole("tab", { name: "Tab 2" })).toHaveAttribute("aria-selected", "true");
  await expect.poll(async () => (await f.read()).html, { timeout: 15000 }).toMatch(/Überblick[\s\S]*Drittens[\s\S]*Tab 2[\s\S]*Inhalt zwei/);

  // Delete with Delete on the focused tab; undo brings it back.
  await strip.getByRole("tab", { name: "Drittens" }).click();
  await strip.getByRole("tab", { name: "Drittens" }).press("Delete");
  await expect(strip.getByRole("tab")).toHaveText(["Überblick", "Tab 2"]);
  await page.getByRole("button", { name: "Rückgängig", exact: true }).last().click();
  await expect(strip.getByRole("tab")).toHaveText(["Überblick", "Drittens", "Tab 2"]);
  expect(errors).toEqual([]);
});

test("tabs: print and the published page show every tab with its title", async ({ page, browser }) => {
  const f = await setup(page, "Tabs drucken");
  const { htmlState } = await import("../../lib/document-server");
  await f.command({
    action: "document.sync",
    pageId: f.host.id,
    generation: (await f.read()).generation,
    update: Buffer.from(
      htmlState(
        '<p>Vorher</p><div data-tabs="true" data-block-id="tabsprint"><section data-tab="true"><h4 class="editor-tab-title">Erster Tab</h4><div data-tab-body="true"><p>Text eins</p></div></section>' +
          '<section data-tab="true"><h4 class="editor-tab-title">Zweiter Tab</h4><div data-tab-body="true"><p>Text zwei</p></div></section></div>',
      ),
    ).toString("base64"),
  });
  await page.goto(`/#page=${f.host.id}`);
  const editor = page.getByLabel("Dokumentinhalt", { exact: true });
  await expect(editor.getByRole("tab")).toHaveText(["Erster Tab", "Zweiter Tab"]);
  await expect(editor.getByText("Text zwei")).toBeHidden();
  // Printed: no strip, every tab with its title.
  await page.emulateMedia({ media: "print" });
  await expect(editor.getByRole("tablist")).toBeHidden();
  await expect(editor.getByText("Text eins")).toBeVisible();
  await expect(editor.getByText("Text zwei")).toBeVisible();
  await expect(editor.locator(".editor-tab-title", { hasText: "Zweiter Tab" })).toBeVisible();
  await page.emulateMedia({ media: "screen" });

  // Published: the tabs one after another, each title a heading.
  await f.command({ action: "page.publish", pageId: f.host.id, enabled: true });
  const token = (await f.read()).page.public_token;
  const visitor = await (await browser.newContext()).newPage();
  await visitor.goto(`${f.origin}/share/${token}`);
  await expect(visitor.getByRole("heading", { name: "Erster Tab" })).toBeVisible();
  await expect(visitor.getByRole("heading", { name: "Zweiter Tab" })).toBeVisible();
  await expect(visitor.getByText("Text eins")).toBeVisible();
  await expect(visitor.getByText("Text zwei")).toBeVisible();
  await visitor.context().close();
});

test("tabs: two people edit different tabs at the same time (Yjs)", async ({ page, browser }, info) => {
  test.skip(info.project.name !== "desktop", "One layout is enough for the sync.");
  const f = await setup(page, "Tabs gemeinsam");
  const { htmlState } = await import("../../lib/document-server");
  await f.command({
    action: "document.sync",
    pageId: f.host.id,
    generation: (await f.read()).generation,
    update: Buffer.from(
      htmlState(
        '<div data-tabs="true" data-block-id="tabsboth"><section data-tab="true"><h4 class="editor-tab-title">Anna</h4><div data-tab-body="true"><p>A:</p></div></section>' +
          '<section data-tab="true"><h4 class="editor-tab-title">Ben</h4><div data-tab-body="true"><p>B:</p></div></section></div>',
      ),
    ).toString("base64"),
  });
  const other = await browser.newContext({ storageState: await page.context().storageState() });
  const second = await other.newPage();
  try {
    await page.goto(`/#page=${f.host.id}`);
    await dismissWelcome(page);
    await second.goto(`${f.origin}/#page=${f.host.id}`);
    await dismissWelcome(second);
    const one = page.getByLabel("Dokumentinhalt", { exact: true });
    const two = second.getByLabel("Dokumentinhalt", { exact: true });
    await two.getByRole("tab", { name: "Ben" }).click();
    // Each sees their own tab; the other one's tab is unchanged.
    await expect(one.getByRole("tab", { name: "Anna" })).toHaveAttribute("aria-selected", "true");
    await one.locator("p", { hasText: "A:" }).click();
    await page.keyboard.press("End");
    await two.locator("p", { hasText: "B:" }).click();
    await second.keyboard.press("End");
    await page.keyboard.type(" von Anna");
    await second.keyboard.type(" von Ben");
    await expect(one.getByRole("tab", { name: "Anna" })).toHaveAttribute("aria-selected", "true");
    await expect(two.getByRole("tab", { name: "Ben" })).toHaveAttribute("aria-selected", "true");
    await expect.poll(async () => (await f.read()).html, { timeout: 20000 }).toMatch(/A: von Anna[\s\S]*B: von Ben/);
    // Both editors have both texts.
    await one.getByRole("tab", { name: "Ben" }).click();
    await expect(one.locator("p", { hasText: "B: von Ben" })).toBeVisible({ timeout: 15000 });
    await two.getByRole("tab", { name: "Anna" }).click();
    await expect(two.locator("p", { hasText: "A: von Anna" })).toBeVisible({ timeout: 15000 });
  } finally {
    await other.close();
  }
});
