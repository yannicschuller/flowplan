import { test, expect } from "@playwright/test";

test("the template gallery offers several templates per category and creates pages from them", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "Same flow on mobile.");
  const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
  await page.request.post("/api/auth/demo", { headers: { origin } });
  await page.goto("/#home");
  await page.locator(".sidebar-tools").getByRole("button", { name: "Vorlagen" }).click();
  const dialog = page.getByRole("dialog", { name: "Vorlagen" });
  // Every category has at least three templates.
  for (const category of ["Projekte", "Meetings", "Wissen & Dokumentation", "Planung & Ziele", "Persönlich", "Sonstiges"]) {
    await dialog.getByRole("button", { name: category, exact: true }).click();
    expect(await dialog.locator(".template-grid > button").count(), category).toBeGreaterThanOrEqual(3);
  }
  // A database template with its example entries and views.
  await dialog.getByRole("button", { name: "Planung & Ziele", exact: true }).click();
  await dialog.locator(".template-grid > button", { hasText: "Budgetplanung" }).click();
  const title = `Budget ${Date.now()}`;
  await page.getByPlaceholder("Wie heißt deine Seite?").fill(title);
  await page.getByRole("button", { name: "Seite erstellen" }).click();
  await expect(page.locator(".data-table")).toContainText("Kampagne Herbst");
  await expect(page.locator(".data-table")).toContainText("-1.800,00 €");
  await expect(page.locator(".database-tabs")).toContainText("Plan und Ist");

  // Public gallery: the built-in template leads into the workspace.
  await page.goto("/templates?category=meetings");
  await expect(page.locator(".template-card", { hasText: "Retrospektive" })).toBeVisible();
  await page.locator(".template-card", { hasText: "Retrospektive" }).click();
  await expect(page.getByRole("heading", { name: /Retrospektive/ })).toBeVisible();
  await page.getByRole("link", { name: "In meinem Arbeitsbereich verwenden" }).click();
  // The name first (#213): the template's, Enter takes it.
  const create = page.getByRole("dialog", { name: "Neue Seite" });
  await expect(create.getByLabel("Name", { exact: true })).toHaveValue("Retrospektive");
  await create.getByLabel("Name", { exact: true }).press("Enter");
  await expect(page.getByLabel("Dokumentinhalt", { exact: true })).toContainText("Was lief gut?");
});

// #112: the "New page" dialog offers templates as well.
test("the New page dialog opens the template gallery and comes back to it", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "Same flow on mobile.");
  const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
  await page.request.post("/api/auth/demo", { headers: { origin } });
  await page.goto("/#home");
  await page.getByRole("button", { name: /Neue Seite/ }).first().click();
  const create = page.getByRole("dialog", { name: "Neue Seite" });
  await create.getByRole("radio", { name: /Aus Vorlage/ }).click();
  const gallery = page.getByRole("dialog", { name: "Vorlagen" });
  await expect(gallery).toBeVisible();
  await expect(create).toBeHidden();
  // Closing the gallery goes back to the dialog.
  await page.keyboard.press("Escape");
  await expect(create).toBeVisible();
  // A template from the gallery: the dialog says so and creates the page from it.
  await create.getByRole("radio", { name: /Aus Vorlage/ }).click();
  await gallery.getByRole("button", { name: "Meetings", exact: true }).click();
  await gallery.locator(".template-grid > button", { hasText: "Retrospektive" }).click();
  await expect(create.getByRole("radio", { name: /Vorlage gewählt/ })).toBeVisible();
  const title = `Retro ${Date.now()}`;
  await create.getByPlaceholder("Wie heißt deine Seite?").fill(title);
  await create.getByRole("button", { name: "Seite erstellen" }).click();
  await expect(page.getByLabel("Dokumentinhalt", { exact: true })).toContainText("Was lief gut?");
});

// #132: saved templates have their own category, first after "Alle".
test("the template gallery has a My templates category for saved templates", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "Same flow on mobile.");
  const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
  await page.request.post("/api/auth/demo", { headers: { origin } });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const saved = async () => (await (await page.request.get(`/api/templates?workspace=${boot.workspace.id}`)).json()) as unknown[];
  await page.goto("/#home");
  const dialog = page.getByRole("dialog", { name: "Vorlagen" });
  const pills = dialog.getByRole("navigation", { name: "Kategorien" }).getByRole("button");
  const mine = dialog.getByRole("button", { name: "Eigene Vorlagen", exact: true });
  if (!(await saved()).length) {
    await page.locator(".sidebar-tools").getByRole("button", { name: "Vorlagen" }).click();
    await expect(dialog.locator(".saved-templates")).toContainText("Noch keine gespeicherten Vorlagen.");
    // No saved templates: no category for them.
    await expect(mine).toHaveCount(0);
    await page.keyboard.press("Escape");
  }
  const command = async (data: Record<string, unknown>) => {
    const response = await page.request.post("/api/command", { headers: { origin }, data });
    expect(response.ok(), await response.text()).toBe(true);
    return response.json();
  };
  const name = `Meine Vorlage ${Date.now()}`;
  const source = await command({ action: "page.create", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, title: name, kind: "document" });
  await command({ action: "template.save", pageId: source.id, name, private: true });
  await page.reload();
  await page.locator(".sidebar-tools").getByRole("button", { name: "Vorlagen" }).click();
  await expect(pills.nth(1)).toHaveText("Eigene Vorlagen");
  await expect(pills.first()).toHaveText("Alle");
  await mine.click();
  await expect(mine).toHaveAttribute("aria-pressed", "true");
  // Only the saved templates: no built-in ones.
  await expect(dialog.locator(".template-grid")).toHaveCount(0);
  const row = dialog.locator(".saved-template-row", { hasText: name });
  await expect(row).toBeVisible();
  await row.getByRole("button", { name: "Verwenden" }).click();
  await expect(dialog).toBeHidden();
  // The "New page" dialog asks for the name first (#213).
  const create = page.getByRole("dialog", { name: "Neue Seite" });
  await expect(create.getByLabel("Name", { exact: true })).toHaveValue(name);
  await page.keyboard.press("Escape");
  await expect(create).toBeHidden();
  // Back to "Alle": built-in and saved templates again.
  await page.locator(".sidebar-tools").getByRole("button", { name: "Vorlagen" }).click();
  await dialog.getByRole("button", { name: "Alle", exact: true }).click();
  await expect(dialog.locator(".template-grid > button").first()).toBeVisible();
});

// #213: a page from a template takes the name typed for it; the template's
// name is only the start, selected so typing replaces it.
test("a page from a template keeps the name typed for it", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "Same flow on mobile.");
  const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
  await page.request.post("/api/auth/demo", { headers: { origin } });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const command = async (data: Record<string, unknown>) => {
    const response = await page.request.post("/api/command", { headers: { origin }, data });
    expect(response.ok(), await response.text()).toBe(true);
    return response.json();
  };
  const saved = `Wochenvorlage ${Date.now()}`;
  const source = await command({ action: "page.create", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, title: saved, kind: "document" });
  await command({ action: "template.save", pageId: source.id, name: saved, private: true });
  const titleOf = async (url: string) => {
    const id = /#page=([0-9a-f-]{36})/.exec(url)![1];
    return (await (await page.request.get(`/api/pages/${id}`)).json()).page.title as string;
  };
  await page.goto("/#home");
  const create = page.getByRole("dialog", { name: "Neue Seite" });
  const gallery = page.getByRole("dialog", { name: "Vorlagen" });
  const name = create.getByLabel("Name", { exact: true });

  // Typed first, then a built-in template: the name stays.
  await page.getByRole("button", { name: /Neue Seite/ }).first().click();
  const typed = `Retro KW ${Date.now()}`;
  await name.fill(typed);
  await create.getByRole("radio", { name: /Aus Vorlage/ }).click();
  await gallery.getByRole("button", { name: "Meetings", exact: true }).click();
  await gallery.locator(".template-grid > button", { hasText: "Retrospektive" }).click();
  await expect(create.getByRole("radio", { name: /Vorlage gewählt/ })).toBeVisible();
  await expect(create.locator(".np-desc")).toContainText("Retrospektive");
  await expect(name).toHaveValue(typed);
  await name.press("Enter");
  await expect(page.getByLabel("Dokumentinhalt", { exact: true })).toContainText("Was lief gut?");
  expect(await titleOf(page.url())).toBe(typed);

  // Nothing typed: the template's name, selected – typing replaces it.
  await page.goto("/#home");
  await page.getByRole("button", { name: /Neue Seite/ }).first().click();
  await create.getByRole("radio", { name: /Aus Vorlage/ }).click();
  await gallery.getByRole("button", { name: "Meetings", exact: true }).click();
  await gallery.locator(".template-grid > button", { hasText: "Retrospektive" }).click();
  await expect(name).toHaveValue("Retrospektive");
  await expect(name).toBeFocused();
  expect(await name.evaluate((el: HTMLInputElement) => [el.selectionStart, el.selectionEnd])).toEqual([0, "Retrospektive".length]);
  // Another template replaces the template's name, not a typed one.
  await create.getByRole("radio", { name: /Vorlage gewählt/ }).click();
  await gallery.getByRole("button", { name: "Meetings", exact: true }).click();
  await gallery.locator(".template-grid > button").filter({ hasNotText: "Retrospektive" }).first().click();
  await expect(name).not.toHaveValue("Retrospektive");
  const replaced = `Sprint ${Date.now()}`;
  await page.keyboard.type(replaced);
  await expect(name).toHaveValue(replaced);
  // Back to a kind of page: the template's name goes, a typed one stays.
  await create.getByRole("radio", { name: "Dokument", exact: true }).click();
  await expect(name).toHaveValue(replaced);
  await page.keyboard.press("Escape");

  // A saved template, from the dialog: the typed name as well.
  await page.getByRole("button", { name: /Neue Seite/ }).first().click();
  const own = `Protokoll ${Date.now()}`;
  await name.fill(own);
  await create.getByRole("radio", { name: /Aus Vorlage/ }).click();
  await gallery.getByRole("button", { name: "Eigene Vorlagen", exact: true }).click();
  await gallery.locator(".saved-template-row", { hasText: saved }).getByRole("button", { name: "Verwenden" }).click();
  await expect(create.locator(".np-desc")).toContainText(saved);
  await expect(name).toHaveValue(own);
  await create.getByRole("button", { name: "Seite erstellen" }).click();
  await expect(page).toHaveURL(/#page=/);
  await expect.poll(() => titleOf(page.url())).toBe(own);
  await command({ action: "page.delete", pageId: source.id });
});
