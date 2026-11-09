import { test, expect, devices, type Page } from "@playwright/test";

// Issue #186: on a phone the properties of a record fold into one line
// (a few values as chips, "+N Eigenschaften") so the record's text comes up.
// The choice holds for every record of the database on phones – larger
// screens keep their own – and the values stay editable after unfolding.
const { defaultBrowserType: _browser, ...iPhone } = devices["iPhone 15"];
const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
const shots = process.env.RECORD_FOLD_SHOTS;

async function setup(page: Page) {
  await page.addLocatorHandler(page.getByRole("dialog", { name: "Willkommen bei Flowplan" }), (intro) =>
    intro.getByRole("button", { name: "Überspringen" }).click(),
  );
  // The hint that Flowplan is also an app (components/app-promo.tsx) has
  // been seen.
  await page.addInitScript(() => localStorage.setItem("flowplan-app-promo", "1"));
  await page.request.post("/api/auth/demo", { headers: { origin } });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const command = async (data: Record<string, unknown>) => {
    const response = await page.request.post("/api/command", { headers: { origin }, data });
    expect(response.ok(), await response.text()).toBe(true);
    return response.json();
  };
  const db = await command({
    action: "page.create",
    workspaceId: boot.workspace.id,
    spaceId: boot.spaces[0].id,
    title: `Aufgaben ${Date.now()}`,
    kind: "database",
  });
  const data = await (await page.request.get(`/api/pages/${db.id}`)).json();
  const fields = [
    { id: "title", name: "Name", type: "text" },
    { id: "status", name: "Status", type: "select", options: ["Offen", "In Arbeit", "Erledigt"] },
    { id: "prio", name: "Priorität", type: "select", options: ["Hoch", "Niedrig"] },
    { id: "due", name: "Fällig", type: "date" },
    { id: "kind", name: "Typ", type: "text" },
    { id: "owner", name: "Verantwortlich", type: "person" },
    { id: "budget", name: "Budget", type: "number" },
  ];
  await command({ action: "database.update", pageId: db.id, version: data.database.version, fields, views: data.database.views });
  const cells = (title: string) => ({ title, status: "In Arbeit", prio: "Hoch", due: "2026-11-20", kind: "Bug", owner: boot.user.id, budget: 120 });
  const first = await command({ action: "row.create", pageId: db.id, cells: cells("Login reparieren") });
  const second = await command({ action: "row.create", pageId: db.id, cells: cells("Release vorbereiten") });
  return { db: db.id as string, first: first.id as string, second: second.id as string };
}

test.describe("on an iPhone", () => {
  test.use({ ...iPhone, locale: "de-DE" });

  test("folding in one record folds every record of the database; values stay editable", async ({ page, browser }) => {
    test.setTimeout(120_000);
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    const { db, first, second } = await setup(page);
    await page.goto(`/#page=${db}&row=${first}`);
    const entry = page.getByRole("dialog", { name: "Eintrag", exact: true });
    const group = entry.getByRole("group", { name: "Eigenschaften", exact: true });
    // Six properties: folded by default on a phone.
    const summary = group.getByRole("button", { name: /^Eigenschaften ausklappen/ });
    await expect(summary).toBeVisible();
    await expect(summary).toHaveAttribute("aria-expanded", "false");
    await expect(summary).toContainText("In Arbeit");
    await expect(summary).toContainText("Hoch");
    await expect(summary).toContainText("+4 Eigenschaften");
    await expect(entry.getByLabel("Budget")).toBeHidden();
    if (shots) await page.screenshot({ path: `${shots}/186-iphone-collapsed.png` });
    // Unfold: the values are there and editable; focus on the chevron.
    await summary.click();
    const toggle = group.getByRole("button", { name: "Eigenschaften", exact: true });
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await expect(toggle).toBeFocused();
    if (shots) await page.screenshot({ path: `${shots}/186-iphone-expanded.png` });
    const budget = entry.getByLabel("Budget");
    await expect(budget).toBeVisible();
    await budget.fill("250");
    await budget.blur();
    await expect
      .poll(async () => (await (await page.request.get(`/api/pages/${db}`)).json()).rows.find((r: { id: string }) => r.id === first).cells.budget)
      .toBe(250);
    // Fold again (stored for phones), then another record opens folded.
    await toggle.click();
    await expect(summary).toBeFocused();
    await expect
      .poll(async () => (await (await page.request.get(`/api/pages/${db}`)).json()).recordPropertiesCollapsed, { timeout: 15_000 })
      .toEqual({ phone: true, desktop: null });
    await page.goto(`/#page=${db}&row=${second}`);
    await expect(entry.getByRole("heading").getByText("Release vorbereiten").or(entry.getByRole("textbox", { name: /Titel/ }))).toBeVisible();
    await expect(group.getByRole("button", { name: /^Eigenschaften ausklappen/ })).toBeVisible();
    // Keyboard: Enter unfolds.
    await group.getByRole("button", { name: /^Eigenschaften ausklappen/ }).focus();
    await page.keyboard.press("Enter");
    await expect(group.getByRole("button", { name: "Eigenschaften", exact: true })).toHaveAttribute("aria-expanded", "true");
    // Unfolded is now the phone's choice again; folded again for the dark shots.
    await group.getByRole("button", { name: "Eigenschaften", exact: true }).click();
    if (shots) {
      await page.emulateMedia({ colorScheme: "dark" });
      await page.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"));
      await page.screenshot({ path: `${shots}/186-iphone-collapsed-dark.png` });
      await group.getByRole("button", { name: /^Eigenschaften ausklappen/ }).click();
      await page.screenshot({ path: `${shots}/186-iphone-expanded-dark.png` });
      await group.getByRole("button", { name: "Eigenschaften", exact: true }).click();
    }

    // The same person on a larger screen: the properties open, untouched by
    // the phone's choice.
    const desktop = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: "de-DE", storageState: await page.context().storageState() });
    const large = await desktop.newPage();
    await large.addLocatorHandler(large.getByRole("dialog", { name: "Willkommen bei Flowplan" }), (intro) =>
      intro.getByRole("button", { name: "Überspringen" }).click(),
    );
    await large.goto(`/#page=${db}&row=${second}`);
    const desk = large.getByRole("dialog", { name: "Eintrag", exact: true });
    await expect(desk.getByRole("button", { name: "Eigenschaften", exact: true })).toHaveAttribute("aria-expanded", "true");
    await expect(desk.getByLabel("Budget")).toBeVisible();
    await desktop.close();
    expect(errors).toEqual([]);
  });
});

test.describe("on a larger screen", () => {
  test.use({ viewport: { width: 1440, height: 1000 }, locale: "de-DE" });

  test("open by default; folding there leaves phones alone; printing shows all", async ({ page }) => {
    const { db, first, second } = await setup(page);
    await page.goto(`/#page=${db}&row=${first}`);
    const entry = page.getByRole("dialog", { name: "Eintrag", exact: true });
    const toggle = entry.getByRole("button", { name: "Eigenschaften", exact: true });
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await expect(entry.getByLabel("Budget")).toBeVisible();
    await toggle.click();
    const summary = entry.getByRole("button", { name: /^Eigenschaften ausklappen/ });
    await expect(summary).toContainText("In Arbeit");
    await expect(summary).toContainText("+3 Eigenschaften");
    await expect
      .poll(async () => (await (await page.request.get(`/api/pages/${db}`)).json()).recordPropertiesCollapsed, { timeout: 15_000 })
      .toEqual({ phone: null, desktop: true });
    await page.goto(`/#page=${db}&row=${second}`);
    await expect(entry.getByRole("button", { name: /^Eigenschaften ausklappen/ })).toBeVisible();
    // Printed: every property, no folded line.
    await page.emulateMedia({ media: "print" });
    await expect(entry.getByLabel("Budget")).toBeVisible();
    await expect(entry.getByRole("button", { name: /^Eigenschaften ausklappen/ })).toBeHidden();
  });
});
