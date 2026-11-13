import { test, expect, type Page } from "@playwright/test";

// Choosing blocks like Notion (#237): a rectangle dragged from the page
// margin chooses every block it touches (tinted, no circles, nothing
// moves); Esc in a block chooses it, ↑/↓ move the choice, ⇧↑/⇧↓ and
// ⇧-click extend it, ⌘A twice chooses all; Delete, ⌘D, ⌘⇧↑/↓, Tab, the
// clipboard, "/" and dragging act on all chosen blocks; Esc or a click
// into the text ends it.
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
const HTML = "<p>Alpha</p><p>Bravo</p><p>Charlie</p><p>Delta</p><p>Echo</p><ul><li><p>Eins</p></li><li><p>Zwei</p></li><li><p>Drei</p></li></ul><p>Ende</p>";
const texts = (page: Page) =>
  page.getByLabel("Dokumentinhalt", { exact: true }).locator(":scope > p").filter({ hasText: /\S/ }).allTextContents();
// The texts of the tinted blocks, top to bottom.
const marked = (page: Page) =>
  page.evaluate(() => {
    const editor = document.querySelector<HTMLElement>(".ProseMirror")!;
    const blocks = [...editor.querySelectorAll<HTMLElement>(":scope > p, :scope > ul > li, :scope > ul")];
    return [...document.querySelectorAll<HTMLElement>(".document-block-marked")]
      .map((m) => m.getBoundingClientRect())
      .sort((a, b) => a.top - b.top)
      .map((r) => {
        const hit = blocks.find((b) => {
          const box = b.getBoundingClientRect();
          return Math.abs(box.top - r.top) < 6 && Math.abs(box.bottom - r.bottom) < 6;
        });
        return hit?.tagName === "UL" ? "list" : (hit?.textContent ?? "?");
      });
  });

test("a rectangle from the margin chooses blocks; keys act on all of them", async ({ page, context }, info) => {
  test.skip(info.project.name !== "desktop", "Mouse and keyboard; touch keeps the selection mode with circles.");
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const f = await fixture(page, `Auswahl ${Date.now()}`, HTML);
  await page.goto(`/#page=${f.host.id}`);
  const editor = page.getByLabel("Dokumentinhalt", { exact: true });
  await expect(editor.getByText("Ende")).toBeVisible({ timeout: 20_000 });
  const p = (text: string) => editor.locator(":scope > p", { hasText: text });

  // The rectangle: from the margin left of Bravo down to Delta.
  const before = await Promise.all(["Bravo", "Charlie", "Delta"].map(async (t) => (await p(t).boundingBox())!));
  const b = before[0],
    d = before[2];
  await page.mouse.move(b.x - 120, b.y + 4);
  await page.mouse.down();
  await page.mouse.move(b.x - 60, b.y + 20, { steps: 4 });
  // Live while dragging.
  await expect.poll(() => marked(page)).toEqual(["Bravo"]);
  await page.mouse.move(b.x + 40, d.y + 6, { steps: 8 });
  await expect(page.locator(".block-select-band")).toBeVisible();
  await expect.poll(() => marked(page)).toEqual(["Bravo", "Charlie", "Delta"]);
  await page.mouse.up();
  await expect(page.locator(".block-select-band")).toHaveCount(0);
  await expect.poll(() => marked(page)).toEqual(["Bravo", "Charlie", "Delta"]);
  // No circles, nothing moved, no text selected.
  await expect(page.locator(".document-block-pick")).toHaveCount(0);
  const after = await Promise.all(["Bravo", "Charlie", "Delta"].map(async (t) => (await p(t).boundingBox())!));
  after.forEach((box, i) => expect(Math.abs(box.y - before[i].y) + Math.abs(box.x - before[i].x)).toBeLessThan(1));
  expect(await page.evaluate(() => String(window.getSelection() ?? ""))).toBe("");
  await page.screenshot({ path: "test-results/block-selection-band.png" });

  // ⌘D duplicates all three.
  await page.keyboard.press("ControlOrMeta+d");
  await expect.poll(() => texts(page)).toEqual(["Alpha", "Bravo", "Charlie", "Delta", "Bravo", "Charlie", "Delta", "Echo", "Ende"]);
  // Delete removes the chosen ones (the copies) and ends the choice.
  await page.keyboard.press("Delete");
  await expect.poll(() => texts(page)).toEqual(["Alpha", "Bravo", "Charlie", "Delta", "Echo", "Ende"]);
  await expect(page.locator(".document-block-marked")).toHaveCount(0);

  // Esc in a block chooses it; ↓ moves the choice, ⇧↓ extends it.
  await p("Alpha").click();

  await page.keyboard.press("Escape");
  await expect.poll(() => marked(page)).toEqual(["Alpha"]);
  await page.keyboard.press("ArrowDown");
  await expect.poll(() => marked(page)).toEqual(["Bravo"]);
  await page.keyboard.press("Shift+ArrowDown");
  await expect.poll(() => marked(page)).toEqual(["Bravo", "Charlie"]);
  // ⌘⇧↓ moves both down.
  await page.keyboard.press("ControlOrMeta+Shift+ArrowDown");
  await expect.poll(() => texts(page)).toEqual(["Alpha", "Delta", "Bravo", "Charlie", "Echo", "Ende"]);
  await expect.poll(() => marked(page)).toEqual(["Bravo", "Charlie"]);
  // Esc ends it.
  await page.keyboard.press("Escape");
  await expect(page.locator(".document-block-marked")).toHaveCount(0);

  // ⇧-click on a handle extends the choice to that block.
  await p("Alpha").click();
  await page.keyboard.press("Escape");
  await expect.poll(() => marked(page)).toEqual(["Alpha"]);
  await p("Delta").hover();
  await page.keyboard.down("Shift");
  await page.getByRole("button", { name: "Blockaktionen: Absatz · Delta", exact: true }).click();
  await page.keyboard.up("Shift");
  await expect.poll(() => marked(page)).toEqual(["Alpha", "Delta"]);
  // "/" opens the block menu for both.
  await page.keyboard.press("/");
  await expect(page.getByRole("menu", { name: "2 Blöcke" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu")).toHaveCount(0);
  // Copy and paste: the blocks again after the chosen ones.
  await expect.poll(() => marked(page)).toEqual(["Alpha", "Delta"]);
  await page.keyboard.press("ControlOrMeta+c");
  await page.keyboard.press("ControlOrMeta+v");
  await expect.poll(() => texts(page)).toEqual(["Alpha", "Delta", "Alpha", "Delta", "Bravo", "Charlie", "Echo", "Ende"]);
  // Dragging a chosen handle moves all chosen blocks.
  await p("Bravo").click();
  await page.keyboard.press("Escape");
  await page.keyboard.press("Shift+ArrowDown");
  await expect.poll(() => marked(page)).toEqual(["Bravo", "Charlie"]);
  await p("Bravo").hover();
  const grip = (await page.getByRole("button", { name: "Blockaktionen: Absatz · Bravo", exact: true }).boundingBox())!;
  const top = (await p("Alpha").first().boundingBox())!;
  await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
  await page.mouse.down();
  await page.mouse.move(grip.x + 10, top.y + 2, { steps: 12 });
  await page.mouse.up();
  await expect.poll(() => texts(page)).toEqual(["Bravo", "Charlie", "Alpha", "Delta", "Alpha", "Delta", "Echo", "Ende"]);

  // A rectangle over list items only: the items; Tab nests the lower two.
  const zwei = (await editor.locator("li", { hasText: "Zwei" }).boundingBox())!;
  const drei = (await editor.locator("li", { hasText: "Drei" }).boundingBox())!;
  await page.mouse.move(zwei.x - 140, zwei.y + 3);
  await page.mouse.down();
  await page.mouse.move(zwei.x - 20, drei.y + 6, { steps: 8 });
  await page.mouse.up();
  await expect.poll(() => marked(page)).toEqual(["Zwei", "Drei"]);
  await page.keyboard.press("Tab");
  await expect(editor.locator(":scope > ul > li", { hasText: "Eins" }).locator("ul > li")).toHaveText(["Zwei", "Drei"]);
  await page.keyboard.press("Shift+Tab");
  await expect(editor.locator(":scope > ul > li")).toHaveCount(3);

  // ⌘A twice: first the text, then all blocks.
  await p("Ende").click();
  await page.keyboard.press("ControlOrMeta+a");
  await expect(page.locator(".document-block-marked")).toHaveCount(0);
  await page.keyboard.press("ControlOrMeta+a");
  await expect.poll(async () => (await marked(page)).length).toBeGreaterThanOrEqual(9);
  // A click into the text ends it; the caret is there.
  await p("Echo").click();
  await expect(page.locator(".document-block-marked")).toHaveCount(0);
  await expect(editor).toBeFocused();
  expect(errors).toEqual([]);
});

test("touch keeps the selection mode with circles and its bar", async ({ page }, info) => {
  test.skip(info.project.name !== "mobile", "Touch only.");
  const f = await fixture(page, `Auswahl touch ${Date.now()}`, HTML);
  await page.goto(`/#page=${f.host.id}`);
  const editor = page.getByLabel("Dokumentinhalt", { exact: true });
  await expect(editor.getByText("Ende")).toBeVisible({ timeout: 20_000 });
  await editor.getByText("Bravo").tap();
  await page.getByRole("button", { name: "Blockaktionen: Absatz · Bravo", exact: true }).tap();
  await page.getByRole("menuitem", { name: "Mehrere auswählen", exact: true }).tap();
  await expect(page.locator(".document-block-pick").first()).toBeVisible();
  await page.getByRole("checkbox", { name: "Absatz · Charlie" }).tap();
  await expect(page.getByRole("toolbar", { name: "Ausgewählte Blöcke" })).toContainText("2 Blöcke");
  await page.getByRole("button", { name: "Fertig" }).tap();
  await expect(page.locator(".document-block-pick")).toHaveCount(0);
});
