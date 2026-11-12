import { test, expect, type Page } from "@playwright/test";

// The block menu like Notion (#238): a search field over every action and
// block type (↵ runs the first hit), "Umwandeln in" as a flyout with all
// block types (H4, toggle headings, equation, page, columns), block
// colours, shortcuts beside the entries, comment and AI; a toggle turns
// back into other blocks (#244).
async function fixture(page: Page, title: string, html: string) {
  const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
  await page.request.post("/api/auth/demo", { headers: { origin } });
  const command = async (data: Record<string, unknown>) => {
    const response = await page.request.post("/api/command", { headers: { origin }, data });
    expect(response.ok(), await response.text()).toBe(true);
    return response.json();
  };
  await command({ action: "profile.onboarded" });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const host = await command({ action: "page.create", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, kind: "document", title });
  const read = async () => (await page.request.get(`/api/pages/${host.id}`)).json();
  const { htmlState } = await import("../../lib/document-server");
  await command({ action: "document.sync", pageId: host.id, generation: (await read()).generation, update: Buffer.from(htmlState(html)).toString("base64") });
  return { host, command, read };
}
const handle = (page: Page, text: string, kind = "[^·]+") => page.getByRole("button", { name: new RegExp(`^Blockaktionen: ${kind} · ${text}$`) });

test("search, flyouts, all block types, colours and shortcuts in the block menu", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "Phones: the next test.");
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const f = await fixture(
    page,
    `Menu ${Date.now()}`,
    "<p>Alpha</p><p>Bravo</p><p>Charlie</p><details><summary>Klappe</summary><div><p>Drinnen</p></div></details><p>Neue Seite hier</p><p>Ende</p>",
  );
  await page.goto(`/#page=${f.host.id}`);
  const editor = page.getByLabel("Dokumentinhalt", { exact: true });
  await expect(editor.getByText("Ende")).toBeVisible({ timeout: 20_000 });
  const open = async (text: string, kind?: string) => {
    await editor.getByText(text, { exact: true }).first().hover();
    await handle(page, text, kind).click();
    await expect(page.getByRole("searchbox", { name: "Aktionen und Blocktypen suchen" })).toBeVisible();
  };

  // Typing filters; "toggle" finds "Aufklappbarer Block" in "Umwandeln in", ↵ applies it.
  await open("Alpha");
  await page.keyboard.type("toggle");
  const search = page.getByRole("searchbox", { name: "Aktionen und Blocktypen suchen" });
  await expect(search).toBeFocused();
  await expect(page.getByRole("menuitemradio", { name: /^Aufklappbarer Block/ })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Duplizieren" })).toHaveCount(0);
  await page.keyboard.press("Enter");
  await expect(editor.locator("details")).toHaveCount(2);
  await expect(editor.locator("details").first().locator(".toggle-title")).toHaveText("Alpha");
  // No hit: a note.
  await open("Bravo");
  await page.keyboard.type("xyzzy");
  await expect(page.getByRole("status").filter({ hasText: "Keine passende Aktion" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(search).toHaveValue("");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu")).toHaveCount(0);

  // "Umwandeln in" as a flyout beside the menu, by keyboard (→) and mouse.
  await open("Bravo");
  const turn = page.getByRole("menuitem", { name: "Umwandeln in …" });
  await turn.focus();
  await page.keyboard.press("ArrowRight");
  const flyout = page.getByRole("menu", { name: "Umwandeln in …" });
  await expect(flyout).toBeVisible();
  await expect(page.getByRole("menu")).toHaveCount(2);
  const names = await flyout.getByRole("menuitemradio").allTextContents();
  for (const name of [
    "Text",
    "Überschrift 1",
    "Überschrift 4",
    "Aufzählung",
    "Nummerierte Liste",
    "Aufgabenliste",
    "Aufklappbarer Block",
    "Aufklappbare Überschrift 1",
    "Aufklappbare Überschrift 4",
    "Zitat",
    "Hinweis",
    "Code",
    "Formel",
  ])
    expect(names.some((n) => n.startsWith(name)), name).toBe(true);
  await expect(flyout.getByRole("menuitem", { name: "Seite" })).toBeVisible();
  await expect(flyout.getByRole("menuitem", { name: "2 Spalten" })).toBeVisible();
  // Shortcuts beside the entries.
  await expect(flyout.getByRole("menuitemradio", { name: /^Überschrift 2/ }).locator(".block-menu-shortcut")).toHaveText(/Alt.*2|⌥.*2/);
  // The focus in the flyout, on its first entry that applies (not "Text": it is one).
  await expect(flyout.getByRole("menuitemradio", { name: /^Überschrift 1/ })).toBeFocused();
  // ← back to its entry; the flyout closes.
  await page.keyboard.press("ArrowLeft");
  await expect(turn).toBeFocused();
  await expect(page.getByRole("menu")).toHaveCount(1);
  // The mouse opens it too; H4 applies.
  await turn.hover();
  await expect(flyout).toBeVisible();
  await flyout.getByRole("menuitemradio", { name: /^Überschrift 4/ }).click();
  await expect(editor.locator("h4")).toHaveText("Bravo");
  await expect(page.getByRole("menu")).toHaveCount(0);

  // Shortcuts on the main level.
  await open("Charlie");
  await expect(page.getByRole("menuitem", { name: "Duplizieren" }).locator(".block-menu-shortcut")).toHaveText(/D/);
  await expect(page.getByRole("menuitem", { name: "Kommentieren" })).toBeVisible();
  // Colour: a background for the block.
  await page.getByRole("menuitem", { name: "Farbe" }).hover();
  const colours = page.getByRole("menu", { name: "Farbe" });
  await expect(colours).toBeVisible();
  await expect(colours.getByRole("menuitemradio")).toHaveCount(20);
  await colours.getByRole("menuitemradio", { name: "Grün (Hintergrund)" }).click();
  await expect(editor.locator('p[data-block-color="green-background"]')).toHaveText("Charlie");
  await open("Charlie");
  await page.getByRole("menuitem", { name: "Farbe" }).hover();
  await colours.getByRole("menuitemradio", { name: "Rot", exact: true }).click();
  await expect(editor.locator('p[data-block-color="red"]')).toHaveText("Charlie");
  expect(await editor.locator('p[data-block-color="red"]').evaluate((p) => getComputedStyle(p).color)).not.toBe(
    await editor.getByText("Ende", { exact: true }).evaluate((p) => getComputedStyle(p).color),
  );
  // ⌘D / Ctrl+D duplicates the block with the caret.
  await editor.getByText("Charlie", { exact: true }).click();
  await page.keyboard.press("ControlOrMeta+d");
  await expect(editor.locator('p[data-block-color="red"]')).toHaveCount(2);

  // A toggle into a heading (#244): its title the text, its content after it.
  await open("Klappe", "Toggle");
  await page.getByRole("menuitem", { name: "Umwandeln in …" }).hover();
  await page.getByRole("menu", { name: "Umwandeln in …" }).getByRole("menuitemradio", { name: /^Überschrift 2/ }).click();
  await expect(editor.locator(":scope > h2")).toHaveText("Klappe");
  await expect(editor.locator(":scope > h2 + p")).toHaveText("Drinnen");
  // A toggle heading from a toggle.
  await expect(editor.locator("details[data-heading]")).toHaveCount(0);

  // A paragraph becomes a sub-page; a link takes its place.
  await open("Neue Seite hier");
  await page.getByRole("menuitem", { name: "Umwandeln in …" }).hover();
  await page.getByRole("menu", { name: "Umwandeln in …" }).getByRole("menuitem", { name: "Seite" }).click();
  const link = editor.getByRole("link", { name: "Neue Seite hier" });
  await expect(link).toBeVisible();
  const href = await link.getAttribute("href");
  expect(href).toMatch(/#page=[0-9a-f-]{36}$/);
  const child = await (await page.request.get(`/api/pages/${href!.split("=")[1]}`)).json();
  expect(child.page?.title ?? child.title).toBe("Neue Seite hier");

  // Comment on a block: the comment form opens for its text.
  await open("Ende");
  await page.getByRole("menuitem", { name: "Kommentieren" }).click();
  await expect(page.getByLabel("Kommentar zur Textstelle", { exact: true })).toBeVisible();
  await page.screenshot({ path: "test-results/block-menu-search.png" });
  expect(errors).toEqual([]);
});

test("on phones the block menu keeps its levels in place, with the search field", async ({ page }, info) => {
  test.skip(info.project.name !== "mobile", "Touch only.");
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const f = await fixture(page, `Menu phone ${Date.now()}`, "<p>Alpha</p><p>Bravo</p>");
  await page.goto(`/#page=${f.host.id}`);
  const editor = page.getByLabel("Dokumentinhalt", { exact: true });
  await expect(editor.getByText("Bravo")).toBeVisible({ timeout: 20_000 });
  await editor.getByText("Alpha").tap();
  await handle(page, "Alpha").tap();
  await expect(page.getByRole("searchbox", { name: "Aktionen und Blocktypen suchen" })).toBeVisible();
  // Moving stays on the first level on phones.
  await expect(page.getByRole("menuitem", { name: "Nach unten", exact: true })).toBeVisible();
  await page.getByRole("menuitem", { name: "Umwandeln in …" }).tap();
  await expect(page.getByRole("button", { name: "Zurück" })).toBeVisible();
  await page.getByRole("menuitemradio", { name: "Überschrift 4", exact: true }).tap();
  await expect(editor.locator("h4")).toHaveText("Alpha");
  expect(errors).toEqual([]);
});
