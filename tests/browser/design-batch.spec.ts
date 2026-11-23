import { test, expect, type Page } from "@playwright/test";

// Design review (vote feedback): the date range of "Meine Aufgaben" as an
// option list, "Gruppieren" in one tap, the page menu in sections,
// formatted footnotes and a drawn cover.

const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";

async function signIn(page: Page) {
  if (process.env.TEST_ADMIN_EMAIL)
    await page.request.post("/api/auth/password", { headers: { origin }, data: { email: process.env.TEST_ADMIN_EMAIL, password: process.env.TEST_ADMIN_PASSWORD } });
  else await page.request.post("/api/auth/demo", { headers: { origin } });
  await page.request.post("/api/command", { headers: { origin }, data: { action: "profile.onboarded" } });
  await page.addInitScript(() => {
    try {
      localStorage.setItem("flowplan-app-promo", "1");
    } catch {}
  });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const command = async (data: Record<string, unknown>) => {
    const response = await page.request.post("/api/command", { headers: { origin }, data });
    expect(response.ok(), await response.text()).toBe(true);
    return response.json();
  };
  const create = async (title: string, kind: "document" | "database") =>
    (await command({ action: "page.create", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, title: `${title} ${Date.now()}`, kind })).id as string;
  return { command, create };
}

test("my tasks: the date range is a list of choices with the radio at the left", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await signIn(page);
  await page.goto("/#tasks");
  await page.getByRole("button", { name: /^Fälligkeit: / }).click();
  const panel = page.getByRole("dialog", { name: "Fälligkeit", exact: true });
  const overdue = panel.getByRole("radio", { name: /^Überfällig/ });
  await expect(panel.getByRole("radio", { name: /^Beliebig/ })).toBeChecked();
  // The radio keeps its size at the row's start; the title and its line
  // sit beside it (a radio at 100 % width was a bar across the row).
  const row = panel.locator("label").filter({ hasText: /^Überfällig/ });
  const radio = (await overdue.boundingBox())!;
  const box = (await row.boundingBox())!;
  expect(radio.width).toBeLessThan(24);
  expect(radio.x - box.x).toBeLessThan(16);
  const text = (await row.locator("span").first().boundingBox())!;
  expect(text.x).toBeGreaterThan(radio.x + radio.width);
  await expect(row.locator("small")).toHaveText("Fällig vor heute und noch offen");
  await row.click();
  await expect(panel).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Fälligkeit: Überfällig" })).toBeVisible();
  await page.getByRole("button", { name: "Fälligkeit: Überfällig" }).click();
  await expect(page.getByRole("dialog", { name: "Fälligkeit", exact: true }).getByRole("radio", { name: /^Überfällig/ })).toBeChecked();
  expect(errors).toEqual([]);
});

test("a database groups with one tap on a property", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const { command, create } = await signIn(page);
  const id = await create("Gruppen", "database");
  const read = async () => (await (await page.request.get(`/api/pages/${id}`)).json()).database;
  const database = await read();
  await command({
    action: "database.update",
    pageId: id,
    version: database.version,
    fields: [
      { id: "title", name: "Name", type: "text" },
      { id: "status", name: "Status", type: "select", options: ["Offen", "Erledigt"] },
    ],
    views: [{ id: "table", name: "Tabelle", type: "table", filters: [], sorts: [] }],
  });
  for (const [title, status] of [["Eins", "Offen"], ["Zwei", "Erledigt"]]) await command({ action: "row.create", pageId: id, cells: { title, status } });
  await page.goto(`/#page=${id}`);
  await page.getByRole("button", { name: /^Gruppieren/ }).click();
  const panel = page.getByRole("dialog", { name: "Gruppierung", exact: true });
  await expect(panel.getByRole("radio", { name: "Keine Gruppierung", exact: true })).toBeChecked();
  // Before grouping only the choices; the options of a grouping follow.
  await expect(panel.getByLabel("Untergruppen nach", { exact: true })).toHaveCount(0);
  await panel.getByRole("radio", { name: "Status", exact: true }).click();
  await expect.poll(async () => (await read()).views[0].groupBy).toBe("status");
  await expect(panel.getByRole("radio", { name: "Status", exact: true })).toBeChecked();
  await expect(panel.getByRole("checkbox", { name: "Leere Gruppen ausblenden" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("rowgroup", { name: "Gruppe Offen", exact: true })).toBeVisible();
  // And back in one tap.
  await page.getByRole("button", { name: /^Gruppieren/ }).click();
  await panel.getByRole("radio", { name: "Keine Gruppierung", exact: true }).click();
  await expect.poll(async () => (await read()).views[0].groupBy || "").toBe("");
  expect(errors).toEqual([]);
});

test("the page menu is grouped in labelled sections, appearance as a submenu", async ({ page }, info) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const { create } = await signIn(page);
  const id = await create("Menü", "document");
  await page.goto(`/#page=${id}`);
  await page.locator(".ProseMirror").first().waitFor();
  await page.getByRole("button", { name: "Seitenaktionen" }).first().click();
  const menu = page.getByRole("menu").last();
  for (const name of ["Bearbeiten", "Teilen & Export", "Ansicht", "Verwaltung"]) await expect(menu.getByRole("group", { name, exact: true })).toBeVisible();
  await expect(menu.getByRole("group", { name: "Bearbeiten", exact: true }).getByRole("menuitem", { name: "Duplizieren" })).toBeVisible();
  await expect(menu.getByRole("group", { name: "Teilen & Export", exact: true }).getByRole("menuitem", { name: "Exportieren" })).toBeVisible();
  await expect(menu.getByRole("group", { name: "Verwaltung", exact: true }).getByRole("menuitem", { name: "Versionsverlauf" })).toBeVisible();
  await expect(menu.getByRole("menuitem", { name: "In den Papierkorb" })).toBeVisible();
  if (info.project.name === "mobile") {
    // The sheet: appearance is a section of its own, no second level.
    await expect(menu.getByRole("group", { name: "Darstellung", exact: true }).getByRole("menuitem", { name: "Icon ändern" })).toBeVisible();
  } else {
    // A submenu: closed at first, opened with the right arrow.
    await expect(page.getByRole("menuitem", { name: "Icon ändern" })).toHaveCount(0);
    const appearance = menu.getByRole("menuitem", { name: "Darstellung", exact: true });
    await appearance.focus();
    await page.keyboard.press("ArrowRight");
    const sub = page.getByRole("menu").last();
    await expect(sub.getByRole("menuitem", { name: "Icon ändern" })).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await expect(sub.getByRole("menuitem", { name: "Cover ändern" })).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("dialog", { name: "Cover auswählen" })).toBeVisible();
  }
  expect(errors).toEqual([]);
});

test("footnotes take bold, italic, code and links – never HTML", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "Keyboard test on the desktop.");
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("dialog", (d) => {
    errors.push(`dialog: ${d.message()}`);
    void d.dismiss();
  });
  const { create } = await signIn(page);
  const id = await create("Formatierte Fußnoten", "document");
  await page.goto(`/#page=${id}`);
  const editor = page.locator(".ProseMirror").first();
  await editor.click();
  await page.keyboard.type("Behauptung");
  await page.keyboard.press("Control+Alt+f");
  const dialog = page.getByRole("dialog", { name: "Fußnote einfügen" });
  await expect(dialog).toContainText("**fett**, *kursiv*, `Code` und Links");
  const note = '**Wichtig** laut *Studie* `x < y` [Seite 4](https://example.test/s4) <img src=x onerror="alert(1)">';
  await dialog.getByLabel("Text der Fußnote").fill(note);
  await dialog.getByRole("button", { name: "Einfügen" }).click();
  const marker = editor.locator("sup.footnote-ref");
  await expect(marker).toHaveAttribute("data-footnote", note);
  // The tooltip without the marks.
  await expect(marker).toHaveAttribute("title", 'Wichtig laut Studie x < y Seite 4 (https://example.test/s4) <img src=x onerror="alert(1)">');
  const item = editor.locator("section.footnotes li .footnote-text");
  await expect(item.locator("strong")).toHaveText("Wichtig");
  await expect(item.locator("em")).toHaveText("Studie");
  await expect(item.locator("code")).toHaveText("x < y");
  await expect(item.locator("a")).toHaveAttribute("href", "https://example.test/s4");
  await expect(item.locator("a")).toHaveText("Seite 4");
  await expect(item.locator("img")).toHaveCount(0);
  await expect(item).toContainText('<img src=x onerror="alert(1)">');
  expect(errors).toEqual([]);
});

test("a cover can be drawn, saved and drawn on again", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "Drawn with the mouse.");
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const { create } = await signIn(page);
  const id = await create("Gezeichnetes Cover", "document");
  await page.goto(`/#page=${id}`);
  await page.locator(".ProseMirror").first().waitFor();
  const openCovers = async () => {
    await page.getByRole("button", { name: "Seitenaktionen" }).first().click();
    await page.getByRole("menuitem", { name: "Darstellung", exact: true }).click();
    // Over to the submenu the way a hand moves.
    const item = page.getByRole("menuitem", { name: "Cover ändern" });
    const box = (await item.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 12 });
    await item.click();
    return page.getByRole("dialog", { name: "Cover auswählen" });
  };
  let picker = await openCovers();
  await picker.getByRole("button", { name: "Zeichnen", exact: true }).click();
  const draw = page.getByRole("dialog", { name: "Cover zeichnen" });
  const save = draw.getByRole("button", { name: "Als Cover speichern" });
  await expect(save).toBeDisabled();
  const surface = draw.locator(".cover-draw-surface");
  const box = (await surface.boundingBox())!;
  // The canvas keeps the drawing's proportions (3 : 1).
  expect(Math.abs(box.width / box.height - 3)).toBeLessThan(0.1);
  await page.mouse.move(box.x + box.width * 0.2, box.y + box.height * 0.5);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) await page.mouse.move(box.x + box.width * (0.2 + i * 0.05), box.y + box.height * (0.5 + (i % 2 ? 0.2 : -0.2)), { steps: 2 });
  await page.mouse.up();
  await expect(save).toBeEnabled();
  await save.click();
  await expect(draw).toHaveCount(0);
  // The upload is chosen in the cover dialog; saving makes it the cover.
  await expect(picker.locator(".cover-preview img")).toBeVisible();
  await expect(picker.getByRole("button", { name: "Zeichnung bearbeiten" })).toBeVisible();
  await picker.getByRole("button", { name: "Speichern", exact: true }).click();
  await expect(picker).toHaveCount(0);
  await expect
    .poll(async () => String((await (await page.request.get(`/api/pages/${id}`)).json()).page.cover || ""))
    .toMatch(/^\/api\/files\//);
  const cover = String((await (await page.request.get(`/api/pages/${id}`)).json()).page.cover);
  const png = await (await page.request.get(cover)).body();
  expect(png.subarray(1, 4).toString("latin1")).toBe("PNG");
  expect(png.includes(Buffer.from("iTXtflowplan-ink"))).toBe(true);
  // Opened again: the strokes are back on the canvas.
  picker = await openCovers();
  await picker.getByRole("button", { name: "Zeichnung bearbeiten" }).click();
  const again = page.getByRole("dialog", { name: "Cover-Zeichnung bearbeiten" });
  await expect(again.getByRole("button", { name: "Als Cover speichern" })).toBeEnabled();
  await expect(again.locator(".cover-draw-surface path").first()).toBeAttached();
  await again.getByRole("button", { name: "Abbrechen" }).click();
  await expect(again).toHaveCount(0);
  expect(errors).toEqual([]);
});
