import { test, expect } from "@playwright/test";

// Issue #22: records can be linked like pages. "@" finds them, the record
// has "Copy link", and it lists the pages that link to it.
test("records are linked from the text, copied as link and list their backlinks", async ({ page, context }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "One run covers it.");
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin });
  await page.request.post("/api/auth/demo", { headers: { origin } });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const command = async (data: Record<string, unknown>) => {
    const response = await page.request.post("/api/command", { headers: { origin }, data });
    expect(response.ok(), await response.text()).toBe(true);
    return response.json();
  };
  const tag = `${Date.now()}`;
  const create = async (title: string, kind = "document") =>
    (await command({ action: "page.create", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, title, kind })).id as string;
  const notes = await create(`Notizen ${tag}`, "database");
  const heating = (await command({ action: "row.create", pageId: notes, cells: { title: `Heizung Wartung ${tag}` } })).id as string;
  const doc = await create(`Haus ${tag}`);

  // "@" in the text: the record is found by its title and inserted as link.
  await page.goto(`/#page=${doc}`);
  const editor = page.locator(".ProseMirror").first();
  await editor.click();
  await page.keyboard.press("@");
  const dialog = page.getByRole("dialog", { name: "Seite, Eintrag oder Person erwähnen" });
  await dialog.getByRole("combobox").fill(`Heizung Wartung ${tag}`);
  await dialog.getByRole("option", { name: new RegExp(`Heizung Wartung ${tag}.*Notizen ${tag}`) }).click();
  const inserted = editor.getByRole("link", { name: `Heizung Wartung ${tag}` });
  await expect(inserted).toHaveAttribute("href", `/#page=${notes}&row=${heating}`);
  // Stored on the server before going on.
  await expect
    .poll(async () => ((await (await page.request.get(`/api/pages/${doc}`)).json()).html as string).includes(`row=${heating}`), { timeout: 15000 })
    .toBe(true);

  // The record lists the page under "Linked from".
  await page.goto(`/#page=${notes}&row=${heating}`);
  const record = page.getByRole("dialog", { name: "Eintrag" });
  const linked = record.getByRole("region", { name: "Verknüpft von" });
  await expect(linked.getByRole("link", { name: `Haus ${tag}` })).toHaveAttribute("href", `#page=${doc}`);
  await expect(linked).toContainText("im Text verlinkt");

  // "Copy link" puts the record's address on the clipboard.
  await record.getByRole("button", { name: "Link kopieren" }).click();
  await expect(page.getByText("Link kopiert")).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(`${origin}/#page=${notes}&row=${heating}`);
  expect(errors).toEqual([]);
});

// Issue #191: "Show related pages and backlinks" (Settings › Appearance) off
// hides Linked from, Related pages and Unlinked mentions below pages and
// records, after a reload too; on brings them back.
test("related pages and backlinks can be hidden below pages and records", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "One run covers it.");
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
  await page.request.post("/api/auth/demo", { headers: { origin } });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const command = async (data: Record<string, unknown>) => {
    const response = await page.request.post("/api/command", { headers: { origin }, data });
    expect(response.ok(), await response.text()).toBe(true);
    return response.json();
  };
  const tag = `${Date.now()}`;
  const create = async (title: string, kind = "document") =>
    (await command({ action: "page.create", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, title, kind })).id as string;
  const notes = await create(`Notizen ${tag}`, "database");
  const record = (await command({ action: "row.create", pageId: notes, cells: { title: `Heizung ${tag}` } })).id as string;
  const target = await create(`Ziel ${tag}`);
  const source = await create(`Quelle ${tag}`);
  const { htmlState } = await import("../../lib/document-server");
  await command({
    action: "document.sync",
    pageId: source,
    generation: (await (await page.request.get(`/api/pages/${source}`)).json()).generation,
    update: Buffer.from(
      htmlState(`<p><a href="/#page=${target}">Ziel ${tag}</a> und <a href="/#page=${notes}&amp;row=${record}">Heizung ${tag}</a></p>`),
    ).toString("base64"),
  });

  const pageLinks = page.locator(".backlinks");
  const recordLinks = () => page.getByRole("dialog", { name: "Eintrag" }).getByRole("region", { name: "Verknüpft von" });
  // On by default.
  await page.goto(`/#page=${target}`);
  await expect(pageLinks).toContainText(`Quelle ${tag}`, { timeout: 20_000 });
  await page.goto(`/#page=${notes}&row=${record}`);
  await expect(recordLinks().getByRole("link", { name: `Quelle ${tag}` })).toBeVisible({ timeout: 20_000 });
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "Eintrag" })).toHaveCount(0);

  // Off: gone below the page and the record, also after a reload.
  await page.goto("/#settings/appearance");
  const shown = page.getByRole("switch", { name: "Verwandte Seiten und Rückverweise anzeigen", exact: true });
  await expect(shown).toHaveAttribute("aria-checked", "true");
  await shown.click();
  await expect(shown).toHaveAttribute("aria-checked", "false");
  // Not loaded either.
  const loads: string[] = [];
  page.on("request", (r) => {
    const path = new URL(r.url()).pathname;
    if (path === "/api/related" || /\/(backlinks|unlinked)$/.test(path)) loads.push(path);
  });
  await page.goto(`/#page=${target}`);
  await page.reload();
  await expect(page.locator(".ProseMirror").first()).toBeVisible({ timeout: 20_000 });
  await page.waitForTimeout(1500);
  await expect(pageLinks).toHaveCount(0);
  await expect(page.locator(".related-pages, .unlinked-mentions")).toHaveCount(0);
  await page.goto(`/#page=${notes}&row=${record}`);
  const dialog = page.getByRole("dialog", { name: "Eintrag" });
  await expect(dialog).toBeVisible({ timeout: 20_000 });
  await expect(dialog.getByText(`Heizung ${tag}`).first()).toBeVisible();
  await page.waitForTimeout(1500);
  await expect(dialog.locator(".row-backlinks, .related-pages, .unlinked-mentions")).toHaveCount(0);
  expect(loads).toEqual([]);

  // On again: back.
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await page.goto("/#settings/appearance");
  await shown.click();
  await expect(shown).toHaveAttribute("aria-checked", "true");
  await page.goto(`/#page=${notes}&row=${record}`);
  await expect(recordLinks().getByRole("link", { name: `Quelle ${tag}` })).toBeVisible({ timeout: 20_000 });
  expect(errors).toEqual([]);
});
