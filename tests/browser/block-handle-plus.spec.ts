import { test, expect, type Page } from "@playwright/test";

// The block handle like Notion (#236): "+" left of ⠿ adds a block below
// (⌥/Alt: above) with the "/" menu open; a gap between handle and text;
// the handle in full colour with a tooltip; the block tinted while its
// menu is open; handles for blocks inside toggles, callouts and quotes;
// the whole row, page margin included, shows the handle.
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

test("“+” adds a block below or above with the slash menu, the handle keeps a gap and marks its block", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "Mouse only: touch screens have no “+”.");
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const f = await fixture(page, `Plus ${Date.now()}`, "<p>Alpha</p><p>Bravo mit einem längeren Text</p><ul><li><p>Punkt eins</p></li></ul><p>Charlie</p>");
  await page.goto(`/#page=${f.host.id}`);
  const editor = page.getByLabel("Dokumentinhalt", { exact: true });
  await expect(editor.getByText("Charlie")).toBeVisible({ timeout: 20_000 });
  const bravo = editor.locator(":scope > p", { hasText: "Bravo" });

  // Hovering shows "+" and ⠿ left of the text, with a gap to it.
  await bravo.hover();
  const grip = handle(page, "Bravo mit einem längeren Text");
  await expect(grip).toHaveClass(/hovered/);
  await expect.poll(() => grip.evaluate((el) => Number(getComputedStyle(el).opacity))).toBe(1);
  await expect(grip).toHaveAttribute("title", "Ziehen zum Verschieben · Klicken für Menü");
  const plus = page.getByRole("button", { name: /^Block darunter einfügen: .*Bravo/ });
  await expect(plus).toBeVisible();
  const text = (await bravo.evaluate((p) => {
    const range = document.createRange();
    range.selectNodeContents(p);
    return range.getBoundingClientRect().left;
  })) as number;
  const g = (await grip.boundingBox())!,
    p = (await plus.boundingBox())!;
  expect(text - (g.x + g.width)).toBeGreaterThanOrEqual(12);
  expect(p.x + p.width).toBeLessThanOrEqual(g.x + 1);
  // Hovering the handle gives it a background.
  await grip.hover();
  await expect.poll(() => grip.evaluate((el) => getComputedStyle(el).backgroundColor)).not.toBe("rgba(0, 0, 0, 0)");

  // The page margin far left of the text shows the row's handle too.
  const box = (await bravo.boundingBox())!;
  await page.mouse.move(box.x - 130, box.y + 6);
  await expect(grip).toHaveClass(/hovered/);
  const charlie = editor.locator(":scope > p", { hasText: "Charlie" });
  const c = (await charlie.boundingBox())!;
  await page.mouse.move(c.x - 130, c.y + 6);
  await expect(handle(page, "Charlie")).toHaveClass(/hovered/);

  // "+" adds an empty block below with the slash menu open.
  await bravo.hover();
  await plus.click();
  await expect(page.locator(".slash-menu")).toBeVisible();
  await page.keyboard.type("Über");
  await page.keyboard.press("Escape");
  const texts = editor.locator(":scope > p").filter({ hasText: /\S/ });
  await expect(texts).toHaveText(["Alpha", "Bravo mit einem längeren Text", "/Über", "Charlie"]);

  // ⌥/Alt-click: above.
  await editor.locator(":scope > p", { hasText: "Alpha" }).hover();
  await page.keyboard.down("Alt");
  await page.getByRole("button", { name: /^Block darunter einfügen: .*Alpha/ }).click();
  await page.keyboard.up("Alt");
  await expect(page.locator(".slash-menu")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(texts).toHaveText(["/", "Alpha", "Bravo mit einem längeren Text", "/Über", "Charlie"]);

  // A list item: "+" adds an item below it.
  await editor.getByText("Punkt eins").hover();
  await page.getByRole("button", { name: /^Block darunter einfügen: .*Punkt eins/ }).click();
  await expect(page.locator(".slash-menu")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(editor.locator("ul > li")).toHaveCount(2);

  // ⠿ opens the menu and tints its block until the menu closes.
  await bravo.hover();
  await grip.click();
  await expect(page.getByRole("menu")).toBeVisible();
  const marked = page.locator(".document-block-marked");
  await expect(marked).toHaveCount(1);
  const m = (await marked.boundingBox())!,
    b = (await bravo.boundingBox())!;
  expect(Math.abs(m.y - b.y)).toBeLessThan(4);
  expect(Math.abs(m.height - b.height)).toBeLessThan(6);
  await page.screenshot({ path: "test-results/block-handle-plus-marked.png" });
  // Esc closes the menu and keeps the block chosen (#264); a second Esc
  // ends the choice.
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu")).toHaveCount(0);
  await expect(marked).toHaveCount(1);
  await expect(page.locator(".block-selection-focus")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(marked).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("blocks inside toggles, callouts and quotes have handles of their own", async ({ page }, info) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const phone = info.project.name === "mobile";
  const f = await fixture(
    page,
    `Nested ${info.project.name} ${Date.now()}`,
    '<p>Oben</p><details><summary>Mehr</summary><div><p>Innen eins</p><p>Innen zwei</p></div></details><aside data-callout="note"><p>Im Hinweis</p><p>Hinweis zwei</p></aside><blockquote><p>Im Zitat</p></blockquote><p>Unten</p>',
  );
  await page.goto(`/#page=${f.host.id}`);
  const editor = page.getByLabel("Dokumentinhalt", { exact: true });
  await expect(editor.getByText("Innen zwei")).toBeVisible({ timeout: 20_000 });
  if (phone) {
    // Touch: the caret's block has the handle, inside a toggle too.
    await editor.getByText("Innen zwei").tap();
    await expect(handle(page, "Innen zwei")).toHaveClass(/active/);
    await expect(page.locator(".document-block-add")).toHaveCount(0);
    await handle(page, "Innen zwei").tap();
    await expect(page.getByRole("menuitem", { name: "Nach oben", exact: true })).toBeVisible();
    await page.getByRole("menuitem", { name: "Nach oben", exact: true }).tap();
    await expect(editor.locator("details p")).toHaveText(["Innen zwei", "Innen eins"]);
    expect(errors).toEqual([]);
    return;
  }
  // Hovering a block in a toggle shows its own handle and "+".
  await editor.getByText("Innen zwei").hover();
  await expect(handle(page, "Innen zwei")).toHaveClass(/hovered/);
  await expect(page.getByRole("button", { name: /^Block darunter einfügen: .*Innen zwei/ })).toBeVisible();
  // Its menu turns it into a heading inside the toggle.
  await handle(page, "Innen zwei").click();
  await page.getByRole("menuitem", { name: /Umwandeln in/ }).click();
  await page.getByRole("menuitemradio", { name: "Überschrift 2", exact: true }).click();
  await expect(editor.locator("details h2")).toHaveText("Innen zwei");
  // Dragged out of the toggle, below "Unten".
  await editor.getByText("Innen eins").hover();
  const grip = handle(page, "Innen eins");
  const from = (await grip.boundingBox())!;
  const to = (await editor.locator(":scope > p", { hasText: "Unten" }).boundingBox())!;
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x + 10, to.y + to.height - 2, { steps: 12 });
  await expect(page.locator(".document-block-drop")).toBeVisible();
  await page.mouse.up();
  await expect(editor.locator(":scope > p").last()).toHaveText("Innen eins");
  await expect(editor.locator("details p")).toHaveCount(0);

  // A callout: its blocks have handles, and the callout keeps its own.
  await editor.getByText("Hinweis zwei").hover();
  await expect(handle(page, "Hinweis zwei")).toHaveClass(/hovered/);
  const callout = editor.locator("aside");
  const c = (await callout.boundingBox())!;
  // Left of the box: the callout's own handle.
  await page.mouse.move(c.x - 60, c.y + c.height - 8);
  await expect(page.getByRole("button", { name: /^Blockaktionen: Hinweis/ })).toHaveClass(/hovered/);
  await page.getByRole("button", { name: /^Blockaktionen: Hinweis/ }).click();
  await expect(page.getByRole("menuitem", { name: "Hinweistyp" })).toBeVisible();
  await page.keyboard.press("Escape");
  // A quote's paragraph too.
  await editor.getByText("Im Zitat").hover();
  await expect(handle(page, "Im Zitat", "Absatz")).toHaveClass(/hovered/);
  await page.screenshot({ path: "test-results/block-handle-nested.png" });
  expect(errors).toEqual([]);
});
