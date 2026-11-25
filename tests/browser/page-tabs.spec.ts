import { test, expect, type Page } from "@playwright/test";
import { DatabaseSync } from "node:sqlite";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { join } from "node:path";

// #444: "/Seite" makes a linked sub-page (of a page and of a record) and
// opens it with its title ready for typing; a new tab with Alt+T or the
// "+" of the tab bar picks its page in the quick search (Esc: no tab);
// pinned tabs lead their frame, show their icon only, survive Alt+W and
// "close other tabs" and a reload.
const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
const shots = process.env.PAGE_TABS_SHOTS;

async function demo(page: Page) {
  await page.request.post("/api/auth/demo", { headers: { origin } });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const command = async (data: Record<string, unknown>) => {
    const response = await page.request.post("/api/command", { headers: { origin }, data });
    expect(response.ok(), await response.text()).toBe(true);
    return response.json();
  };
  return { boot, command };
}
const pageOf = async (page: Page, id: string) => (await (await page.request.get(`/api/pages/${id}`)).json()).page;
const hashPage = (page: Page) => new URL(page.url()).hash.match(/page=([0-9a-f-]{36})/)?.[1] ?? null;

test("/page makes a linked sub-page of the page and of a record and opens it", async ({ page }, info) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const { boot, command } = await demo(page);
  const tag = `${info.project.name}${Date.now()}`;
  const host = await command({ action: "page.create", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, title: `Aufgabe ${tag}`, kind: "document" });
  await page.goto(`/#page=${host.id}`);
  const editor = page.getByLabel("Dokumentinhalt", { exact: true });
  await editor.click();
  await page.keyboard.type("Kontext: ");
  const menu = page.locator(".slash-menu");
  for (const query of ["page", "newpage", "unterseite", "neue seite"]) {
    await page.keyboard.type(`/${query}`);
    await expect(menu.getByRole("option", { selected: true })).toContainText("Seite");
    await expect(menu.getByRole("option", { selected: true })).toContainText("Neue Unterseite anlegen");
    await page.keyboard.press("Escape");
    for (const _ of `/${query}`) await page.keyboard.press("Backspace");
  }
  await page.keyboard.type("/seite");
  await expect(menu.getByRole("option", { selected: true })).toContainText("Neue Unterseite anlegen");
  await page.keyboard.press("Enter");

  // The new page opens, its title "Ohne Titel" selected: typing replaces it.
  await expect.poll(() => hashPage(page), { timeout: 30_000 }).not.toBe(host.id);
  const created = hashPage(page)!;
  const title = page.locator("textarea.page-title").first();
  await expect(title).toHaveValue("Ohne Titel", { timeout: 30_000 });
  await expect(title).toBeFocused();
  await page.keyboard.type(`Notizen ${tag}`);
  await expect(title).toHaveValue(`Notizen ${tag}`);
  await title.press("Tab");
  expect((await pageOf(page, created)).parent_id).toBe(host.id);
  await expect.poll(async () => (await pageOf(page, created)).title, { timeout: 30_000 }).toBe(`Notizen ${tag}`);

  // Back on the host: the link to it, after the text, renamed along.
  await page.goBack();
  const link = editor.locator(`a[href="/#page=${created}"]`);
  await expect(link).toBeVisible({ timeout: 30_000 });
  await expect(editor).toContainText("Kontext:");
  await expect.poll(async () => (await page.request.get(`/api/pages/${host.id}`)).text(), { timeout: 30_000 }).toContain(`Notizen ${tag}`);
  if (shots) await page.screenshot({ path: join(shots, `subpage-link-${info.project.name}.png`) });

  // In a record's document: a sub-page below the record (#231).
  const db = await command({ action: "page.create", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, title: `Anforderungen ${tag}`, kind: "database", databaseKind: "empty" });
  const record = await command({ action: "row.create", pageId: db.id, cells: { title: `Schnittstelle ${tag}` } });
  await page.goto(`/#page=${db.id}&row=${record.id}&full=1`);
  const recordEditor = page.locator(".record-page").getByLabel("Dokumentinhalt", { exact: true });
  await recordEditor.click();
  await page.keyboard.type("/page");
  await expect(menu.getByRole("option", { selected: true })).toContainText("Unterseite des Eintrags");
  await page.keyboard.press("Enter");
  await expect.poll(() => new URL(page.url()).hash, { timeout: 30_000 }).not.toContain("row=");
  const sub = hashPage(page)!;
  await expect(page.locator("textarea.page-title").first()).toHaveValue("Ohne Titel", { timeout: 30_000 });
  const stored = await pageOf(page, sub);
  expect([stored.parent_id, stored.parent_row_id]).toEqual([db.id, record.id]);
  await page.goBack();
  await expect(page.locator(".record-page").locator(`a[href="/#page=${sub}"]`).first()).toBeVisible({ timeout: 30_000 });
  expect(errors).toEqual([]);
});

async function tabsUser(page: Page) {
  const db = new DatabaseSync(join(process.env.FLOWPLAN_DATA_DIR!, "flowplan.sqlite"));
  db.exec("PRAGMA busy_timeout=5000;");
  const uid = randomUUID(),
    token = randomBytes(32).toString("hex");
  db.prepare("INSERT INTO users(id,subject,name,email,onboarded_at) VALUES(?,?,?,?,?)").run(uid, `page-tabs:${uid}`, "Pia Pin", `${uid}@example.test`, Date.now());
  db.prepare("INSERT INTO sessions(token,user_id,groups_json,expires) VALUES(?,?,?,?)").run(createHash("sha256").update(token).digest("hex"), uid, "[]", Date.now() + 3_600_000);
  db.close();
  await page.context().addCookies([{ name: "flowplan_session", value: token, url: origin, httpOnly: true, sameSite: "Lax" }]);
  const command = async (data: Record<string, unknown>) => {
    const response = await page.request.post("/api/command", { headers: { origin }, data });
    expect(response.ok(), await response.text()).toBe(true);
    return response.json();
  };
  await command({ action: "workspace.create", name: "Tabs" });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const create = async (title: string) =>
    (await command({ action: "page.create", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, title, kind: "document" })).id as string;
  return { a: await create("Seite A"), b: await create("Seite B"), c: await create("Seite C"), d: await create("Seite D") };
}
const tree = (page: Page, id: string) => page.locator(`.page-nav[data-page-id="${id}"] .page-nav-title`).first();
const bar = (page: Page) => page.locator(`.frame-tabs[data-tab-frame="0"]`);
const tabsOf = (page: Page) => bar(page).getByRole("tab");
const titles = (page: Page) => tabsOf(page).locator(".frame-tab-title");
const mainTitle = (page: Page) => page.locator(".split-primary textarea.page-title");

test("new tab with Alt+T and +, pinned tabs", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "Tabs are for tablets and computers.");
  test.skip(!process.env.FLOWPLAN_DATA_DIR, "Needs the test server data directory.");
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const { a, b } = await tabsUser(page);
  await page.goto(`/#page=${a}`);
  await expect(mainTitle(page)).toHaveValue("Seite A", { timeout: 30_000 });
  const search = page.getByRole("dialog", { name: "Schnellsuche", exact: true });
  const field = search.getByRole("combobox", { name: "Suchen oder Befehl" });
  const pick = async (name: string) => {
    await field.fill(name);
    await expect(search.locator("#palette-list [role=option]").first()).toContainText(name, { timeout: 15_000 });
    await field.press("Enter");
    await expect(search).toHaveCount(0);
  };

  // Alt+T with one tab: the search for the new tab; Esc leaves one tab.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press("Alt+t");
  await expect(search).toBeVisible();
  await expect(field).toHaveAttribute("placeholder", "Seite für den neuen Tab suchen …");
  await page.keyboard.press("Escape");
  await expect(search).toHaveCount(0);
  await expect(page.locator(".frame-tabs")).toHaveCount(0);
  await page.keyboard.press("Alt+t");
  await pick("Seite B");
  await expect(titles(page)).toHaveText(["Seite A", "Seite B"]);
  await expect(mainTitle(page)).toHaveValue("Seite B");
  await expect(page).toHaveURL(new RegExp(`#page=${b}$`));

  // The "+" at the end of the bar.
  await bar(page).getByRole("button", { name: "Neuer Tab" }).click();
  await expect(search).toBeVisible();
  await pick("Seite C");
  await expect(titles(page)).toHaveText(["Seite A", "Seite B", "Seite C"]);
  await expect(mainTitle(page)).toHaveValue("Seite C");
  // Even from the editor's title field (⌥T would type a character on the Mac).
  await mainTitle(page).focus();
  await page.keyboard.press("Alt+t");
  await pick("Seite D");
  await expect(titles(page)).toHaveText(["Seite A", "Seite B", "Seite C", "Seite D"]);
  await expect(mainTitle(page)).toHaveValue("Seite D");

  // Pin C: it moves to the front, its icon only, no ×, named still.
  await tabsOf(page).nth(2).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Anheften" }).click();
  await expect(titles(page)).toHaveText(["Seite C", "Seite A", "Seite B", "Seite D"]);
  const pinned = tabsOf(page).nth(0);
  await expect(pinned).toHaveClass(/pinned/);
  await expect(pinned).toHaveAccessibleName("Seite C (angeheftet)");
  await expect(pinned.getByRole("button")).toHaveCount(0);
  const box = (await pinned.boundingBox())!;
  expect(box.width).toBeLessThan(50);
  if (shots) await page.screenshot({ path: join(shots, "tabs-pinned.png") });

  // Alt+W and the middle button leave a pinned tab alone.
  await pinned.click();
  await expect(mainTitle(page)).toHaveValue("Seite C");
  await page.locator(".split-primary .main-scroll").click({ position: { x: 5, y: 5 } });
  await page.keyboard.press("Alt+w");
  await pinned.click({ button: "middle" });
  await expect(titles(page)).toHaveText(["Seite C", "Seite A", "Seite B", "Seite D"]);

  // A new tab from the pinned one goes after the pinned ones.
  await page.keyboard.press("Alt+t");
  await pick("Seite A");
  // A is open already: that tab is shown, no second one.
  await expect(titles(page)).toHaveText(["Seite C", "Seite A", "Seite B", "Seite D"]);
  await expect(tabsOf(page).nth(1)).toHaveAttribute("aria-selected", "true");

  // "Andere Tabs schließen" on D keeps the pinned C.
  await tabsOf(page).nth(3).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Andere Tabs schließen" }).click();
  await expect(titles(page)).toHaveText(["Seite C", "Seite D"]);

  // A reload keeps the pin.
  await page.reload();
  await expect(mainTitle(page)).toHaveValue("Seite D", { timeout: 30_000 });
  await expect(titles(page)).toHaveText(["Seite C", "Seite D"]);
  await expect(tabsOf(page).nth(0)).toHaveClass(/pinned/);

  // Keyboard: the context menu of the focused tab, "Lösen".
  await tabsOf(page).nth(0).focus();
  await page.keyboard.press("Shift+F10");
  await page.getByRole("menuitem", { name: "Lösen" }).click();
  await expect(tabsOf(page).nth(0)).not.toHaveClass(/pinned/);
  await expect(tabsOf(page).nth(0).getByRole("button", { name: "Seite C schließen" })).toHaveCount(1);

  // A command picked after "+" opens its screen in the new tab, not in the
  // one in front (My tasks).
  await bar(page).getByRole("button", { name: "Neuer Tab" }).click();
  await pick("Meine Aufgaben");
  await expect(titles(page)).toHaveCount(3);
  await expect(titles(page)).toContainText(["Seite C", "Seite D", "Meine Aufgaben"]);
  await expect(tabsOf(page).filter({ hasText: "Meine Aufgaben" })).toHaveAttribute("aria-selected", "true");
  await expect(page).toHaveURL(/#tasks$/);
  expect(errors).toEqual([]);
});

test("tab groups: create from the menu, rename, add, colour, collapse and expand, reload, close", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "Tabs are for tablets and computers.");
  test.skip(!process.env.FLOWPLAN_DATA_DIR, "Needs the test server data directory.");
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const { a, b, c, d } = await tabsUser(page);
  await page.goto(`/#page=${a}`);
  await expect(mainTitle(page)).toHaveValue("Seite A", { timeout: 30_000 });
  for (const id of [b, c, d]) await tree(page, id).click({ modifiers: ["ControlOrMeta"] });
  await expect(titles(page)).toHaveText(["Seite A", "Seite B", "Seite C", "Seite D"]);

  // A new group from B's menu; its name is asked for right there.
  await tabsOf(page).nth(1).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Zu neuer Gruppe hinzufügen" }).click();
  const name = bar(page).getByRole("textbox", { name: "Name der Gruppe" });
  await expect(name).toBeFocused();
  await expect(name).toHaveValue("Gruppe");
  await page.keyboard.type("Recherche");
  await page.keyboard.press("Enter");
  const chip = bar(page).locator(".frame-tab-group");
  await expect(chip).toHaveAccessibleName("Gruppe Recherche, 1 Tab");
  await expect(chip).toBeFocused();
  await expect(tabsOf(page).nth(1)).toHaveClass(/grouped/);

  // C joins it.
  await tabsOf(page).nth(2).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Zu Gruppe hinzufügen" }).click();
  await page.getByRole("menuitem", { name: "Recherche" }).click();
  await expect(chip).toHaveAccessibleName("Gruppe Recherche, 2 Tabs");
  await expect(tabsOf(page).nth(2)).toHaveClass(/grouped/);
  await expect(tabsOf(page).nth(3)).not.toHaveClass(/grouped/);

  // Colour from the chip's menu.
  await chip.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Farbe" }).click();
  await page.getByRole("menuitemradio", { name: "Grün" }).click();
  await expect(chip).toHaveClass(/opt-green/);
  if (shots)
    for (const scheme of ["light", "dark"] as const) {
      await page.evaluate((s) => document.documentElement.setAttribute("data-theme", s), scheme);
      await page.waitForTimeout(200);
      await bar(page).screenshot({ path: join(shots, `tab-group-${scheme}.png`) });
    }

  // Collapse with the active tab inside: the tab after the group is shown.
  await tabsOf(page).nth(1).click();
  await expect(mainTitle(page)).toHaveValue("Seite B");
  await chip.click();
  await expect(chip).toHaveAttribute("aria-expanded", "false");
  await expect(chip).toHaveAccessibleName("Gruppe Recherche, 2 Tabs, eingeklappt");
  await expect(titles(page)).toHaveText(["Seite A", "Seite D"]);
  await expect(mainTitle(page)).toHaveValue("Seite D");
  // Keyboard: the chip is in the roving focus; Enter expands.
  await tabsOf(page).nth(1).focus();
  await page.keyboard.press("ArrowLeft");
  await expect(chip).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(titles(page)).toHaveText(["Seite A", "Seite B", "Seite C", "Seite D"]);
  // Collapsed again; a reload keeps the group, its colour and state.
  await page.keyboard.press("Enter");
  await expect(titles(page)).toHaveText(["Seite A", "Seite D"]);
  await page.reload();
  await expect(mainTitle(page)).toHaveValue("Seite D", { timeout: 30_000 });
  await expect(chip).toHaveAccessibleName("Gruppe Recherche, 2 Tabs, eingeklappt");
  await expect(chip).toHaveClass(/opt-green/);

  // Rename from the menu (Shift+F10 on the focused chip).
  await chip.focus();
  await page.keyboard.press("Shift+F10");
  await page.getByRole("menuitem", { name: "Umbenennen" }).click();
  await expect(name).toBeFocused();
  await page.keyboard.type("Quellen");
  await page.keyboard.press("Enter");
  await expect(chip).toHaveAccessibleName("Gruppe Quellen, 2 Tabs, eingeklappt");

  // Close the group: its tabs go.
  await chip.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Gruppe schließen" }).click();
  await expect(titles(page)).toHaveText(["Seite A", "Seite D"]);
  await expect(chip).toHaveCount(0);
  await expect(mainTitle(page)).toHaveValue("Seite D");
  expect(errors).toEqual([]);
});
