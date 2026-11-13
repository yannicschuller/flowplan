import { test, expect, type Page } from "@playwright/test";

// Calmer handles (#255, like Notion): with a mouse the handle shows only at
// the hovered block, never at the caret's block, and typing hides it until
// the mouse moves again; the handle of a paragraph indented with Tab sits
// where its text starts; while dragging, the block that receives the drop
// (list item, list, toggle, callout, column) is tinted.
const RESULTS = process.env.BLOCK_HANDLE_SHOTS || "test-results";

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
  return host;
}
const shown = (page: Page) =>
  page.locator(".document-block-handle").evaluateAll((all) =>
    all.filter((el) => Number(getComputedStyle(el).opacity) > 0.05).map((el) => el.getAttribute("aria-label")),
  );

test("only the hovered block shows its handle; typing hides it; indented text takes its handle along (#255)", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "Mouse: hover.");
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const host = await fixture(page, `Griffe ${Date.now()}`, '<p>Alpha</p><p>Bravo</p><p data-indent="2">Eingerückt</p><p>Ende</p>');
  await page.goto(`/#page=${host.id}`);
  const editor = page.getByLabel("Dokumentinhalt", { exact: true });
  const paragraph = (text: string) => editor.locator(":scope > p", { hasText: text });
  await expect(paragraph("Ende")).toBeVisible({ timeout: 20_000 });

  // The caret in "Alpha", the mouse over "Bravo": one handle, Bravo's.
  await paragraph("Alpha").click();
  await paragraph("Bravo").hover();
  await expect.poll(() => shown(page)).toEqual(["Blockaktionen: Absatz · Bravo"]);
  // Typing: no handle at all, neither the caret's nor the hovered one.
  await page.keyboard.type("x");
  await expect.poll(() => shown(page)).toEqual([]);
  await expect(page.locator(".document-block-add")).toHaveCount(0);
  // The mouse moves: the hovered block's handle is back.
  await paragraph("Bravo").hover({ position: { x: 20, y: 5 } });
  await expect.poll(() => shown(page)).toEqual(["Blockaktionen: Absatz · Bravo"]);

  // Keyboard: Escape chooses the caret's block, its handle shows (selected)
  // and ⌘/ opens its menu.
  await paragraph("Alphax").click();
  await page.mouse.move(5, 5);
  await expect.poll(() => shown(page)).toEqual([]);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "Blockaktionen: Absatz · Alphax", exact: true })).toHaveClass(/selected/);
  await page.keyboard.press("ControlOrMeta+/");
  await expect(page.getByRole("menu", { name: "Absatz · Alphax" })).toBeVisible();
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");

  // The indented paragraph: its handle beside where its text starts.
  await paragraph("Eingerückt").hover();
  const indented = page.getByRole("button", { name: "Blockaktionen: Absatz · Eingerückt", exact: true });
  await expect(indented).toHaveClass(/hovered/);
  const text = (await paragraph("Eingerückt").evaluate((el) => {
    const range = document.createRange();
    range.selectNodeContents(el);
    const r = range.getBoundingClientRect();
    return { x: r.x };
  }))!;
  const grip = (await indented.boundingBox())!;
  expect(grip.x + grip.width).toBeLessThanOrEqual(text.x);
  expect(text.x - (grip.x + grip.width)).toBeLessThan(24);
  const plain = (await page.getByRole("button", { name: "Blockaktionen: Absatz · Ende", exact: true }).boundingBox())!;
  expect(grip.x - plain.x).toBeGreaterThan(40);
  await page.screenshot({ path: `${RESULTS}/block-handle-indent.png`, clip: { x: 300, y: 300, width: 900, height: 300 } });
  expect(errors).toEqual([]);
});

test("while dragging, the block that receives the drop is tinted and the tint follows the line (#255)", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "Mouse: dragging by the handle.");
  const host = await fixture(
    page,
    `Ziel ${Date.now()}`,
    "<p>Oben</p><ul><li><p>Eins</p></li><li><p>Zwei</p></li></ul><p>Mitte</p><aside data-callout=\"note\"><p>Hinweis</p></aside><p>Ziehen</p><p>Ende</p>",
  );
  await page.goto(`/#page=${host.id}`);
  const editor = page.getByLabel("Dokumentinhalt", { exact: true });
  await expect(editor.getByText("Ende", { exact: true })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText("Gespeichert", { exact: true })).toBeVisible({ timeout: 15_000 });
  const tint = page.locator(".document-block-drop-container");
  await editor.getByText("Ziehen", { exact: true }).hover();
  const grip = (await page.getByRole("button", { name: "Blockaktionen: Absatz · Ziehen", exact: true }).boundingBox())!;
  await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
  await page.mouse.down();
  await page.mouse.move(grip.x + grip.width / 2, grip.y + 30, { steps: 4 });
  // Between the list items: the list.
  const eins = (await editor.locator("li", { hasText: "Eins" }).boundingBox())!;
  const list = (await editor.locator(":scope > ul").boundingBox())!;
  await page.mouse.move(eins.x + 10, eins.y + eins.height - 2, { steps: 12 });
  await expect(page.locator(".document-block-drop")).toBeVisible();
  await expect(tint).toBeVisible();
  await page.waitForTimeout(200);
  let box = (await tint.boundingBox())!;
  expect(box.x).toBeLessThanOrEqual(list.x + 1);
  expect(box.y).toBeLessThanOrEqual(list.y + 1);
  expect(box.y + box.height).toBeGreaterThanOrEqual(list.y + list.height - 1);
  const background = await tint.evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(background).not.toBe("rgba(0, 0, 0, 0)");
  await page.screenshot({ path: `${RESULTS}/block-drop-container.png`, clip: { x: 300, y: 300, width: 1000, height: 400 } });
  // Into the callout: the callout.
  const note = (await editor.locator("[data-callout]").first().boundingBox())!;
  await page.mouse.move(note.x + 60, note.y + note.height - 4, { steps: 10 });
  await page.waitForTimeout(200);
  box = (await tint.boundingBox())!;
  expect(Math.abs(box.y + box.height / 2 - (note.y + note.height / 2))).toBeLessThan(6);
  // Between top-level paragraphs: no tint.
  const mitte = (await editor.getByText("Mitte", { exact: true }).boundingBox())!;
  await page.mouse.move(mitte.x + 10, mitte.y + 2, { steps: 10 });
  await expect(page.locator(".document-block-drop")).toBeVisible();
  await expect(tint).toHaveCount(0);
  await page.keyboard.press("Escape");
  await page.mouse.up();
  await expect(tint).toHaveCount(0);
});
