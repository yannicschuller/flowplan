import { test, expect, type Page } from "@playwright/test";

// The personal start page (components/home): customizing it – add, remove,
// reorder, resize and configure widgets –, the layout surviving a reload,
// one column on phones and ticking off a record from the tasks widget.
const kinds = (page: Page) => page.locator(".home-grid > .home-widget").evaluateAll((els) => els.map((el) => (el as HTMLElement).dataset.widgetId!));

test("customize the start page and tick off a task from it", async ({ page }, info) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
  await page.request.post("/api/auth/demo", { headers: { origin } });
  await page.request.post("/api/command", { headers: { origin }, data: { action: "profile.onboarded" } });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const database = boot.pages.find((p: { kind: string }) => p.kind === "database");
  // Start from the default start page (a demo account may be reused).
  for (let i = 0; i < 2; i++)
    await page.request.post("/api/command", { headers: { origin }, data: { action: "home.reset", workspaceId: boot.workspace.id, scope: "personal" } });
  await page.goto("/#home");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();

  // Customize: the bar, tools on each widget.
  await page.getByRole("button", { name: "Anpassen" }).click();
  const bar = page.getByRole("toolbar", { name: "Startseite anpassen" });
  await expect(bar).toBeVisible();
  await expect(page.getByRole("button", { name: "Begrüßung verschieben" })).toBeVisible();

  // Add a scratchpad and a tasks widget from the gallery.
  await bar.getByRole("button", { name: "Widget hinzufügen" }).click();
  await page.getByRole("dialog", { name: "Widget hinzufügen" }).getByRole("button", { name: /^Notizzettel/ }).click();
  await expect(page.locator('[data-widget-kind="notes"]')).toHaveCount(1);
  await bar.getByRole("button", { name: "Widget hinzufügen" }).click();
  await page.getByRole("dialog", { name: "Widget hinzufügen" }).getByRole("button", { name: /^Meine Aufgaben/ }).click();
  const tasks = page.locator('[data-widget-kind="tasks"]');
  await expect(tasks).toHaveCount(1);

  // Configure it: the open records of a database view.
  await page.getByRole("button", { name: "Meine Aufgaben einstellen" }).click();
  const settings = page.getByRole("dialog", { name: "Meine Aufgaben einstellen" });
  await settings.getByRole("radio", { name: "Ansicht einer Datenbank" }).check();
  await settings.getByRole("combobox", { name: "Datenbank" }).selectOption(database.id);
  await expect(settings.getByRole("combobox", { name: "Ansicht" })).toBeVisible();
  await settings.getByRole("radio", { name: "Alle offenen" }).check();
  await settings.getByRole("textbox", { name: "Überschrift" }).fill("Roadmap offen");
  await settings.getByRole("button", { name: "Übernehmen" }).click();
  await expect(settings).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Roadmap offen verschieben" })).toBeVisible();

  // Reorder with the buttons and the keyboard.
  let order = await kinds(page);
  const tasksId = order[order.length - 1];
  const notesId = order[order.length - 2];
  await page.getByRole("button", { name: "Roadmap offen nach oben" }).click();
  order = await kinds(page);
  expect(order.indexOf(tasksId)).toBeLessThan(order.indexOf(notesId));
  const handle = page.getByRole("button", { name: "Roadmap offen verschieben" });
  await handle.focus();
  await page.keyboard.press("Home");
  expect((await kinds(page))[0]).toBe(tasksId);
  await expect(handle).toBeFocused();
  await page.keyboard.press("ArrowDown");
  expect((await kinds(page))[1]).toBe(tasksId);

  // Drag with the pointer (desktop): the scratchpad onto the widget before it.
  if (info.project.name === "desktop") {
    const before = await kinds(page);
    const at = before.indexOf(notesId);
    const handleBox = page.getByRole("button", { name: "Notizzettel verschieben" });
    await handleBox.scrollIntoViewIfNeeded();
    const from = await handleBox.boundingBox();
    const to = await page.locator(`[data-widget-id="${before[at - 1]}"]`).boundingBox();
    await page.mouse.move(from!.x + from!.width / 2, from!.y + from!.height / 2);
    await page.mouse.down();
    await page.mouse.move(to!.x + 20, to!.y + to!.height / 2, { steps: 12 });
    await page.mouse.up();
    expect((await kinds(page)).indexOf(notesId)).toBe(at - 1);
  }

  // Resize: the tasks widget takes the whole row.
  await page.getByRole("button", { name: /^Größe von Roadmap offen/ }).click();
  await page.getByRole("menuitemradio", { name: "Volle Breite" }).click();
  await expect(page.locator(`[data-widget-id="${tasksId}"]`)).toHaveClass(/size-full/);

  // Remove "Recently viewed".
  await page.getByRole("button", { name: "Zuletzt angesehen entfernen" }).click();
  await expect(page.locator('[data-widget-id="visited"]')).toHaveCount(0);

  await bar.getByRole("button", { name: "Fertig" }).click();
  await expect(bar).toHaveCount(0);
  const saved = await kinds(page);

  // Kept after a reload, on every device (stored on the server).
  await page.reload();
  await expect(page.getByRole("heading", { name: "Roadmap offen" })).toBeVisible();
  expect(await kinds(page)).toEqual(saved);
  await expect(page.locator(`[data-widget-id="${tasksId}"]`)).toHaveClass(/size-full/);
  const stored = (await (await page.request.get("/api/bootstrap")).json()).home;
  expect(stored.source).toBe("workspace");
  expect(stored.layout.widgets.find((w: { id: string }) => w.id === tasksId).config).toMatchObject({ source: "view", pageId: database.id, filter: "open", title: "Roadmap offen" });

  // The scratchpad keeps its text.
  const pad = page.getByRole("textbox", { name: "Notizzettel" });
  await pad.fill("Anruf um 15 Uhr");
  await expect.poll(async () => JSON.stringify((await (await page.request.get("/api/bootstrap")).json()).home.layout)).toContain("Anruf um 15 Uhr");

  // Phones: one column – every widget as wide as the grid.
  if (info.project.name === "mobile") {
    const grid = await page.locator(".home-grid").boundingBox();
    for (const box of await page.locator(".home-grid > .home-widget").evaluateAll((els) => els.map((el) => el.getBoundingClientRect().toJSON())))
      expect(Math.abs(box.width - grid!.width)).toBeLessThan(2);
  }

  // Tick off the first open record from the widget.
  const widget = page.locator(`[data-widget-id="${tasksId}"]`);
  const box = widget.getByRole("checkbox").first();
  await expect(box).toBeEnabled();
  const label = (await box.getAttribute("aria-label"))!;
  const title = label.replace(/ erledigt$/, "");
  await box.check();
  await expect(widget.getByRole("checkbox", { name: label })).toHaveCount(0, { timeout: 15_000 });
  const data = await (await page.request.post("/api/home/data", { headers: { origin }, data: { workspaceId: boot.workspace.id, widgets: [{ id: "x", kind: "tasks", config: { source: "view", pageId: database.id, filter: "open", max: 10 } }] } })).json();
  expect(JSON.stringify(data.widgets[0].data.items)).not.toContain(`"text":"${title}"`);
  expect(errors).toEqual([]);
});

// The development demo account is shared by all browser tests: leave its
// start page as it was.
test.afterEach(async ({ page }) => {
  const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
  const boot = await (await page.request.get("/api/bootstrap")).json();
  for (let i = 0; i < 2; i++)
    await page.request.post("/api/command", { headers: { origin }, data: { action: "home.reset", workspaceId: boot.workspace.id, scope: "personal" } });
});
