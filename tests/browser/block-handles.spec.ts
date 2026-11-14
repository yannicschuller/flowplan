import { test, expect, type Page } from "@playwright/test";

// Fewer block handles (#138): with a mouse the ⠿ handle shows at the block
// under the pointer and a handle with keyboard focus (not the block with
// the caret, #255); on touch screens only at the block with the caret, large enough to
// tap. Empty paragraphs have none unless they have the caret. "Always show
// block handles" (Settings › Appearance › Editor) brings back every handle.
async function fixture(page: Page, title: string) {
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
  await command({
    action: "document.sync",
    pageId: host.id,
    generation: (await read()).generation,
    update: Buffer.from(htmlState("<p>Alpha</p><p>Bravo</p><p></p><p>Charlie</p>")).toString("base64"),
  });
  return { host, command };
}
const opacity = (page: Page, name: string) =>
  page.getByRole("button", { name: `Blockaktionen: ${name}`, exact: true }).evaluate((el) => Number(getComputedStyle(el).opacity));

test("block handles show at the hovered block and with keyboard focus – or always, by choice", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "Touch: the next test.");
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const f = await fixture(page, `Handles ${Date.now()}`);
  await page.goto(`/#page=${f.host.id}`);
  const editor = page.getByLabel("Dokumentinhalt", { exact: true });
  const paragraph = (text: string) => editor.locator(":scope > p", { hasText: text });
  await expect(paragraph("Charlie")).toBeVisible({ timeout: 20_000 });
  const handles = page.locator(".document-block-handle");
  // No handle for the empty paragraph; the others are there but not shown.
  await expect(handles).toHaveCount(3);
  await page.mouse.move(5, 5);
  await expect.poll(() => opacity(page, "Absatz · Alpha")).toBe(0);
  // Hovering a block shows its handle.
  await paragraph("Bravo").hover();
  await expect(page.getByRole("button", { name: "Blockaktionen: Absatz · Bravo", exact: true })).toHaveClass(/hovered/);
  await expect.poll(() => opacity(page, "Absatz · Bravo")).toBeGreaterThan(0.3);
  await expect.poll(() => opacity(page, "Absatz · Alpha")).toBe(0);
  // The caret's block shows no handle once the mouse leaves (#255, like
  // Notion): with a mouse only the hovered block has one.
  await paragraph("Charlie").click();
  await page.mouse.move(5, 5);
  await expect(page.getByRole("button", { name: "Blockaktionen: Absatz · Charlie", exact: true })).toHaveClass(/active/);
  await expect.poll(() => opacity(page, "Absatz · Charlie")).toBe(0);
  await expect.poll(() => opacity(page, "Absatz · Bravo")).toBe(0);
  // The empty paragraph with the caret has its handle.
  await page.keyboard.press("ArrowUp");
  await expect(handles).toHaveCount(4);
  // Keyboard: a handle reached with (Shift+)Tab shows, with a ring, and Enter opens
  // its menu; dragging and the menu work as before.
  const alpha = page.getByRole("button", { name: "Blockaktionen: Absatz · Alpha", exact: true });
  await page.getByRole("button", { name: "Blockaktionen: Absatz · Bravo", exact: true }).focus();
  await page.keyboard.press("Shift+Tab");
  await expect(alpha).toBeFocused();
  await expect.poll(() => opacity(page, "Absatz · Alpha")).toBe(1);
  expect(await alpha.evaluate((el) => getComputedStyle(el).outlineStyle)).toBe("solid");
  await page.keyboard.press("Enter");
  // With a mouse, moving is in the "Verschieben" flyout (#238).
  await page.getByRole("menuitem", { name: "Verschieben", exact: true }).click();
  await page.getByRole("menuitem", { name: "Nach unten", exact: true }).click();
  await expect(editor.locator(":scope > p").filter({ hasText: /\S/ })).toHaveText(["Bravo", "Alpha", "Charlie"]);
  await page.screenshot({ path: "test-results/block-handles-desktop.png" });

  // "Always show block handles": every block, empty paragraphs too.
  await page.goto("/#settings/appearance");
  const always = page.getByRole("switch", { name: "Griffe immer anzeigen", exact: true });
  await expect(always).toHaveAttribute("aria-checked", "false");
  await always.click();
  await expect(always).toHaveAttribute("aria-checked", "true");
  await page.goto(`/#page=${f.host.id}`);
  await expect(paragraph("Charlie")).toBeVisible({ timeout: 20_000 });
  await page.mouse.move(5, 5);
  await expect.poll(() => handles.count()).toBeGreaterThanOrEqual(4);
  await expect.poll(() => opacity(page, "Absatz · Charlie")).toBeCloseTo(0.25, 2);
  await page.evaluate(() => localStorage.removeItem("flowplan.block-handles-always"));
  // Reading mode: no handles at all.
  await page.getByRole("button", { name: "Lesemodus", exact: true }).click();
  await expect(handles).toHaveCount(0);
  await page.getByRole("button", { name: "Bearbeiten", exact: true }).click();
  expect(errors).toEqual([]);
  await page.goto("/#home");
  await f.command({ action: "page.delete", pageId: f.host.id });
});

test("on touch screens only the block with the caret has a handle, at least 44 px to tap", async ({ page }, info) => {
  test.skip(info.project.name !== "mobile", "Touch only.");
  const f = await fixture(page, `Handles touch ${Date.now()}`);
  await page.goto(`/#page=${f.host.id}`);
  const editor = page.getByLabel("Dokumentinhalt", { exact: true });
  await expect(editor.locator(":scope > p", { hasText: "Charlie" })).toBeVisible({ timeout: 20_000 });
  const shown = () =>
    page.locator(".document-block-handle").evaluateAll((all) =>
      all.filter((el) => getComputedStyle(el).opacity !== "0").map((el) => el.getAttribute("aria-label")),
    );
  await expect.poll(shown).toEqual([]);
  await editor.locator(":scope > p", { hasText: "Bravo" }).tap();
  await expect.poll(shown).toEqual(["Blockaktionen: Absatz · Bravo"]);
  const bravo = page.getByRole("button", { name: "Blockaktionen: Absatz · Bravo", exact: true });
  const box = (await bravo.boundingBox())!;
  expect(box.height).toBeGreaterThanOrEqual(44);
  // The hidden handles do not catch taps.
  expect(
    await page.getByRole("button", { name: "Blockaktionen: Absatz · Alpha", exact: true }).evaluate((el) => getComputedStyle(el).pointerEvents),
  ).toBe("none");
  await bravo.tap();
  await expect(page.getByRole("menuitem", { name: "Nach oben", exact: true })).toBeVisible();
  await page.getByRole("menuitem", { name: "Nach oben", exact: true }).tap();
  await expect(editor.locator(":scope > p").filter({ hasText: /\S/ })).toHaveText(["Bravo", "Alpha", "Charlie"]);
  await page.screenshot({ path: "test-results/block-handles-mobile.png" });
  await page.goto("/#home");
  await f.command({ action: "page.delete", pageId: f.host.id });
});

// The handle's dots sit on the middle of the block's first text line (#226):
// the ⠿ character sat about 3 px above it in every font. Measured: the dots
// drawn (their circles) against the box the block's first character is
// drawn in, for every page font.
test("the handle's dots are centred on the first text line of paragraphs, headings and list items", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "Same geometry on touch screens.");
  const f = await fixture(page, `Handles centred ${Date.now()}`);
  const { htmlState } = await import("../../lib/document-server");
  const read = async () => (await page.request.get(`/api/pages/${f.host.id}`)).json();
  await f.command({
    action: "document.sync",
    pageId: f.host.id,
    generation: (await read()).generation,
    update: Buffer.from(
      htmlState(
        '<p>Paragraph</p><h1>Heading one</h1><h2>Heading two</h2><h3>Heading three</h3><ul><li><p>List item</p></li></ul><ul data-type="taskList"><li data-type="taskItem" data-checked="false"><p>Task item</p></li></ul><blockquote><p>Quote</p></blockquote>',
      ),
    ).toString("base64"),
  });
  await page.goto("/#home");
  await page.evaluate(() => localStorage.setItem("flowplan.block-handles-always", "true"));
  for (const font of ["sans", "serif", "mono"]) {
    await f.command({ action: "page.update", pageId: f.host.id, patch: { font } });
    await page.goto(`/#page=${f.host.id}`);
    await page.reload();
    const editor = page.getByLabel("Dokumentinhalt", { exact: true });
    await expect(editor.locator(":scope > blockquote")).toBeVisible({ timeout: 20_000 });
    await expect(page.getByRole("button", { name: "Blockaktionen: Zitat · Quote", exact: true })).toBeAttached();
    const texts = ["Paragraph", "Heading one", "Heading two", "Heading three", "List item", "Task item", "Quote"];
    const offsets = await page.evaluate((texts) =>
      [...document.querySelectorAll<HTMLElement>(".document-block-handle")].flatMap((handle) => {
        const dots = [...handle.querySelectorAll("circle")].map((c) => c.getBoundingClientRect());
        const dotsMiddle = dots.length ? (Math.min(...dots.map((r) => r.top)) + Math.max(...dots.map((r) => r.bottom))) / 2 : NaN;
        const label = handle.getAttribute("aria-label") || "";
        const text = label.split(" · ").pop()!;
        if (!texts.includes(text)) return [];
        const walker = document.createTreeWalker(document.querySelector(".ProseMirror")!, NodeFilter.SHOW_TEXT);
        let node: Node | null;
        while ((node = walker.nextNode()) && node.textContent !== text);
        const range = document.createRange();
        range.setStart(node!, 0);
        range.setEnd(node!, 1);
        const line = range.getBoundingClientRect();
        return [{ label, offset: Math.round((dotsMiddle - (line.top + line.bottom) / 2) * 100) / 100 }];
      }),
    texts);
    // The quote's first paragraph has none of its own (#278): the quote's
    // handle stands for it.
    expect(offsets).toHaveLength(texts.length);
    for (const { label, offset } of offsets) expect(Math.abs(offset), `${font}: ${label} (${offset} px)`).toBeLessThanOrEqual(1);
  }
  await page.evaluate(() => localStorage.removeItem("flowplan.block-handles-always"));
  await page.goto("/#home");
  await f.command({ action: "page.delete", pageId: f.host.id });
});
