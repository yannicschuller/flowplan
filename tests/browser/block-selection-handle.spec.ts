import { test, expect, type Page } from "@playwright/test";

// The handle chooses its block, like Notion (#264): a click on ⠿ opens the
// menu and chooses the block; Esc closes the menu and keeps it chosen, so
// ⇧↑/⇧↓ extend the choice and ⌘A chooses all blocks; ⇧↓ while the menu is
// open closes it and extends; a second Esc ends the choice. ⌘A in the text
// first selects the block's text, then all blocks – only their tint, no
// text highlight. The same in a record of a database.
const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
async function command(page: Page, data: Record<string, unknown>) {
  const response = await page.request.post("/api/command", { headers: { origin }, data });
  expect(response.ok(), await response.text()).toBe(true);
  return response.json();
}
async function fixture(page: Page, title: string, html: string) {
  await page.request.post("/api/auth/demo", { headers: { origin } });
  await command(page, { action: "profile.onboarded" });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const host = await command(page, { action: "page.create", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, kind: "document", title });
  const read = async () => (await page.request.get(`/api/pages/${host.id}`)).json();
  const { htmlState } = await import("../../lib/document-server");
  await command(page, { action: "document.sync", pageId: host.id, generation: (await read()).generation, update: Buffer.from(htmlState(html)).toString("base64") });
  return { host, boot };
}
const HTML = "<p>Alpha</p><p>Bravo</p><p>Charlie</p><p>Delta</p><p>Echo</p>";
// The texts of the tinted blocks, top to bottom.
const marked = (page: Page) =>
  page.evaluate(() => {
    const editor = [...document.querySelectorAll<HTMLElement>(".ProseMirror")].find((e) => e.getAttribute("aria-label") === "Dokumentinhalt" && e.offsetParent)!;
    const blocks = [...editor.querySelectorAll<HTMLElement>(":scope > p")];
    return [...document.querySelectorAll<HTMLElement>(".document-block-marked")]
      .map((m) => m.getBoundingClientRect())
      .sort((a, b) => a.top - b.top)
      .map((r) => blocks.find((b) => Math.abs(b.getBoundingClientRect().top - r.top) < 6)?.textContent ?? "?")
      // (The empty paragraph at the end of the page counts too, unnamed.)
      .filter(Boolean);
  });
// The text highlighted in the page (the browser's selection).
const highlighted = (page: Page) => page.evaluate(() => String(window.getSelection() ?? ""));
const grip = (page: Page, text: string) => page.getByRole("button", { name: `Blockaktionen: Absatz · ${text}`, exact: true });

test("click on a handle, Esc: ⇧↓/⇧↑ and ⌘A act on the chosen block (#264)", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "Mouse and keyboard.");
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const f = await fixture(page, `Griff-Auswahl ${Date.now()}`, HTML);
  await page.goto(`/#page=${f.host.id}`);
  const editor = page.getByLabel("Dokumentinhalt", { exact: true });
  await expect(editor.getByText("Echo")).toBeVisible({ timeout: 20_000 });
  const p = (text: string) => editor.locator(":scope > p", { hasText: text });

  // (1) Click → menu and tint; Esc → menu closed, block still chosen.
  await p("Bravo").hover();
  await grip(page, "Bravo").click();
  await expect(page.getByRole("menu")).toBeVisible();
  await expect.poll(() => marked(page)).toEqual(["Bravo"]);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu")).toHaveCount(0);
  await expect.poll(() => marked(page)).toEqual(["Bravo"]);
  await expect(page.locator(".block-selection-focus")).toBeFocused();
  // ⇧↓ ⇧↓: three blocks; ⇧↑ shrinks.
  await page.keyboard.press("Shift+ArrowDown");
  await page.keyboard.press("Shift+ArrowDown");
  await expect.poll(() => marked(page)).toEqual(["Bravo", "Charlie", "Delta"]);
  await page.keyboard.press("Shift+ArrowUp");
  await expect.poll(() => marked(page)).toEqual(["Bravo", "Charlie"]);
  // A second Esc ends the choice.
  await page.keyboard.press("Escape");
  await expect(page.locator(".document-block-marked")).toHaveCount(0);

  // ⇧↓ while the menu is open: the menu closes, the choice grows.
  await p("Charlie").hover();
  await grip(page, "Charlie").click();
  await expect(page.getByRole("menu")).toBeVisible();
  await page.keyboard.press("Shift+ArrowDown");
  await expect(page.getByRole("menu")).toHaveCount(0);
  await expect.poll(() => marked(page)).toEqual(["Charlie", "Delta"]);
  await page.keyboard.press("Escape");
  await expect(page.locator(".document-block-marked")).toHaveCount(0);

  // (2) Click → Esc → ⌘A: all blocks.
  await p("Delta").hover();
  await grip(page, "Delta").click();
  await page.keyboard.press("Escape");
  await expect.poll(() => marked(page)).toEqual(["Delta"]);
  await page.keyboard.press("ControlOrMeta+a");
  await expect.poll(() => marked(page)).toEqual(["Alpha", "Bravo", "Charlie", "Delta", "Echo"]);
  await page.keyboard.press("Escape");
  await expect(page.locator(".document-block-marked")).toHaveCount(0);

  // An action from the menu ends the choice and returns to the text.
  await p("Alpha").hover();
  await grip(page, "Alpha").click();
  await page.getByRole("menuitem", { name: "Duplizieren" }).click();
  await expect(editor.locator(":scope > p").filter({ hasText: /\S/ })).toHaveText(["Alpha", "Alpha", "Bravo", "Charlie", "Delta", "Echo"]);
  await expect(page.locator(".document-block-marked")).toHaveCount(0);
  await expect(editor).toBeFocused();

  // (3) Caret in the text: ⌘A selects the block's text, ⌘A again all
  // blocks – only the tint, no text highlight.
  await p("Charlie").click();
  await page.keyboard.press("ControlOrMeta+a");
  await expect.poll(() => highlighted(page)).toBe("Charlie");
  await expect(page.locator(".document-block-marked")).toHaveCount(0);
  await page.keyboard.press("ControlOrMeta+a");
  await expect.poll(() => marked(page)).toEqual(["Alpha", "Alpha", "Bravo", "Charlie", "Delta", "Echo"]);
  await expect.poll(() => highlighted(page)).toBe("");
  await page.screenshot({ path: "test-results/block-selection-handle-all.png" });
  // Esc ends it; a click into the text gives the caret back.
  await page.keyboard.press("Escape");
  await expect(page.locator(".document-block-marked")).toHaveCount(0);
  await p("Echo").click();
  await page.keyboard.type("!");
  await expect(p("Echo!")).toHaveCount(1);
  expect(errors).toEqual([]);
});

test("the same in a record of a database (#264)", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "Mouse and keyboard.");
  await page.request.post("/api/auth/demo", { headers: { origin } });
  await command(page, { action: "profile.onboarded" });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const db = await command(page, { action: "page.create", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, title: `Einträge ${Date.now()}`, kind: "database" });
  const read = async () => (await page.request.get(`/api/pages/${db.id}`)).json();
  await command(page, {
    action: "database.update",
    pageId: db.id,
    version: (await read()).database.version,
    fields: [{ id: "title", name: "Name", type: "text" }],
    views: [{ id: "table", name: "Tabelle", type: "table", filters: [], sorts: [] }],
  });
  const row = await command(page, { action: "row.create", pageId: db.id, cells: { title: "Eintrag" } });
  await page.goto(`/#page=${db.id}&row=${row.id}`);
  const dialog = page.getByRole("dialog", { name: "Eintrag", exact: true });
  const editor = dialog.getByLabel("Dokumentinhalt", { exact: true });
  await expect(editor).toBeVisible({ timeout: 20_000 });
  await editor.click();
  await page.keyboard.type("Eins");
  await page.keyboard.press("Enter");
  await page.keyboard.type("Zwei");
  await page.keyboard.press("Enter");
  await page.keyboard.type("Drei");
  const p = (text: string) => editor.locator(":scope > p", { hasText: text });
  await expect(p("Drei")).toBeVisible();

  await p("Eins").hover();
  await dialog.getByRole("button", { name: "Blockaktionen: Absatz · Eins", exact: true }).click();
  await expect(page.getByRole("menu")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu")).toHaveCount(0);
  await expect(dialog).toBeVisible();
  await expect.poll(() => marked(page)).toEqual(["Eins"]);
  await page.keyboard.press("Shift+ArrowDown");
  await page.keyboard.press("Shift+ArrowDown");
  await expect.poll(() => marked(page)).toEqual(["Eins", "Zwei", "Drei"]);
  await page.keyboard.press("Shift+ArrowUp");
  await expect.poll(() => marked(page)).toEqual(["Eins", "Zwei"]);
  await page.keyboard.press("ControlOrMeta+a");
  await expect.poll(() => marked(page)).toEqual(["Eins", "Zwei", "Drei"]);
  // Esc ends the choice; the record stays open.
  await page.keyboard.press("Escape");
  await expect(page.locator(".document-block-marked")).toHaveCount(0);
  await expect(dialog).toBeVisible();

  // ⌘A in the text: the block's text, then all blocks.
  await p("Zwei").click();
  await page.keyboard.press("ControlOrMeta+a");
  await expect.poll(() => highlighted(page)).toBe("Zwei");
  await page.keyboard.press("ControlOrMeta+a");
  await expect.poll(() => marked(page)).toEqual(["Eins", "Zwei", "Drei"]);
  await expect.poll(() => highlighted(page)).toBe("");
  await page.keyboard.press("Escape");
  await expect(page.locator(".document-block-marked")).toHaveCount(0);
  await expect(dialog).toBeVisible();
});
