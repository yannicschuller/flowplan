import { join } from "node:path";
import { test, expect, type Page } from "@playwright/test";

const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
async function setup(page: Page, title: string) {
  await page.request.post("/api/auth/demo", { headers: { origin } });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const command = async (data: Record<string, unknown>) => {
    const r = await page.request.post("/api/command", {
      headers: { origin },
      data,
    });
    expect(r.ok(), await r.text()).toBe(true);
    return r.json();
  };
  const board = await command({
    action: "page.create",
    workspaceId: boot.workspace.id,
    spaceId: boot.spaces[0].id,
    title,
    kind: "whiteboard",
  });
  return { boot, command, board };
}
const items = async (page: Page, id: string) => {
  const data = await (await page.request.get(`/api/pages/${id}`)).json();
  return data.html as string;
};

test("whiteboards hold notes, shapes and connectors that persist", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name === "mobile", "Desktop-Zeigergesten");
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const { command, board } = await setup(page, `Board ${Date.now()}`);
  await page.goto(`/#page=${board.id}`);
  const wb = page.getByLabel("Whiteboard", { exact: true });
  await expect(wb).toBeVisible();
  const canvas = wb.locator(".wb-canvas");
  const box = (await canvas.boundingBox())!;
  // A sticky note by double click, with text.
  await canvas.dblclick({
    position: { x: box.width / 2 - 200, y: box.height / 2 },
  });
  await page.keyboard.type("Idee eins");
  await page.keyboard.press("Escape");
  await expect(wb.locator(".wb-sticky")).toContainText("Idee eins");
  // A rectangle by dragging with the shape tool.
  await wb.getByRole("button", { name: "Form", exact: true }).click();
  await page.mouse.move(
    box.x + box.width / 2 + 60,
    box.y + box.height / 2 - 40,
  );
  await page.mouse.down();
  await page.mouse.move(
    box.x + box.width / 2 + 220,
    box.y + box.height / 2 + 60,
    { steps: 5 },
  );
  await page.mouse.up();
  await expect(wb.locator(".wb-shape")).toHaveCount(1);
  await page.keyboard.press("Enter");
  await page.keyboard.type("Prozess");
  await page.keyboard.press("Escape");
  // A connector from the note to the rectangle.
  await wb
    .getByRole("button", { name: "Verbindungslinie", exact: true })
    .click();
  const sticky = (await wb.locator(".wb-sticky").boundingBox())!;
  const shape = (await wb.locator(".wb-shape").boundingBox())!;
  await page.mouse.move(
    sticky.x + sticky.width / 2,
    sticky.y + sticky.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(shape.x + shape.width / 2, shape.y + shape.height / 2, {
    steps: 8,
  });
  await page.mouse.up();
  await expect(wb.locator(".wb-connector")).toHaveCount(1);
  // Moving the note keeps the connector attached.
  await page.keyboard.press("Escape");
  await page.mouse.move(sticky.x + 20, sticky.y + 20);
  await page.mouse.down();
  await page.mouse.move(sticky.x + 20, sticky.y + 160, { steps: 6 });
  await page.mouse.up();
  await expect(wb.getByText("Gespeichert", { exact: true })).toBeVisible({
    timeout: 10000,
  });
  await expect.poll(() => items(page, board.id)).toContain("Idee eins");
  await expect.poll(() => items(page, board.id)).toContain("Prozess");
  await page.screenshot({ path: "test-results/whiteboard/board.png" });
  await page.reload();
  await expect(
    page.getByLabel("Whiteboard", { exact: true }).locator(".wb-sticky"),
  ).toContainText("Idee eins");
  await expect(
    page.getByLabel("Whiteboard", { exact: true }).locator(".wb-connector"),
  ).toHaveCount(1);
  expect(errors).toEqual([]);
  await command({ action: "page.delete", pageId: board.id });
});

test("two people see each other's board changes live", async ({
  page,
  browser,
}, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const { command, board } = await setup(
    page,
    `Live ${testInfo.project.name} ${Date.now()}`,
  );
  const other = await browser.newContext({
    viewport: page.viewportSize()!,
    isMobile: testInfo.project.name === "mobile",
  });
  try {
    const second = await other.newPage();
    second.on("pageerror", (e) => errors.push(e.message));
    await second.request.post(`${origin}/api/auth/demo`, {
      headers: { origin },
    });
    await page.goto(`/#page=${board.id}`);
    await second.goto(`${origin}/#page=${board.id}`);
    const a = page.getByLabel("Whiteboard", { exact: true }),
      b = second.getByLabel("Whiteboard", { exact: true });
    await expect(b).toBeVisible();
    // Keyboard creation works on touch devices too: N, then click places a note.
    await a.focus();
    await page.keyboard.press("n");
    const box = (await a.locator(".wb-canvas").boundingBox())!;
    await a
      .locator(".wb-canvas")
      .click({ position: { x: box.width / 2, y: box.height / 2 } });
    await page.keyboard.type("Von A");
    await page.keyboard.press("Escape");
    await expect(b.locator(".wb-sticky")).toContainText("Von A", {
      timeout: 15000,
    });
    // B changes the colour; A sees it.
    await b.locator(".wb-sticky").click();
    await b.getByRole("button", { name: "Farbe #b2f2bb" }).click();
    await expect(a.locator(".wb-sticky rect").first()).toHaveAttribute(
      "fill",
      "#b2f2bb",
      { timeout: 15000 },
    );
  } finally {
    await other.close();
  }
  expect(errors).toEqual([]);
  await command({ action: "page.delete", pageId: board.id });
});

test("whiteboards are embedded in documents and open from there", async ({
  page,
}, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const tag = `${testInfo.project.name} ${Date.now()}`;
  const { boot, command, board } = await setup(page, `Eingebettet ${tag}`);
  // Content through the API: one note.
  await page.goto(`/#page=${board.id}`);
  const wb = page.getByLabel("Whiteboard", { exact: true });
  await wb.focus();
  await page.keyboard.press("n");
  const box = (await wb.locator(".wb-canvas").boundingBox())!;
  await wb
    .locator(".wb-canvas")
    .click({ position: { x: box.width / 2, y: box.height / 2 } });
  await page.keyboard.type("Sichtbar im Dokument");
  await page.keyboard.press("Escape");
  await expect(wb.getByText("Gespeichert", { exact: true })).toBeVisible({
    timeout: 10000,
  });
  const doc = await command({
    action: "page.create",
    workspaceId: boot.workspace.id,
    spaceId: boot.spaces[0].id,
    title: `Dokument ${tag}`,
  });
  await page.goto(`/#page=${doc.id}`);
  const content = page.getByLabel("Dokumentinhalt", { exact: true });
  await content.click();
  await page.keyboard.type("/");
  await page.getByRole("button", { name: /^Whiteboard/ }).click();
  const picker = page.getByRole("dialog", { name: "Whiteboard einbetten" });
  await picker.getByLabel("Whiteboard suchen").fill(`Eingebettet ${tag}`);
  await picker.getByRole("button", { name: `Eingebettet ${tag}` }).click();
  const embed = content.locator(".whiteboard-embed");
  await expect(embed).toContainText(`Eingebettet ${tag}`);
  await expect(embed.locator(".wb-sticky")).toContainText(
    "Sichtbar im Dokument",
  );
  await expect
    .poll(
      async () =>
        (await (await page.request.get(`/api/pages/${doc.id}`)).json()).html,
    )
    .toContain(`data-whiteboard="${board.id}"`);
  await embed.getByRole("link", { name: /Öffnen/ }).click();
  await expect(page).toHaveURL(new RegExp(`page=${board.id}`));
  await expect(page.getByLabel("Whiteboard", { exact: true })).toBeVisible();
  expect(errors).toEqual([]);
  await command({ action: "page.delete", pageId: doc.id });
  await command({ action: "page.delete", pageId: board.id });
});

test("pen, frames, emoji, page cards, images, undo and export work", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name === "mobile", "Desktop-Zeigergesten");
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const tag = `${Date.now()}`;
  const { boot, command, board } = await setup(page, `Werkzeuge ${tag}`);
  const target = await command({
    action: "page.create",
    workspaceId: boot.workspace.id,
    spaceId: boot.spaces[0].id,
    title: `Zielseite ${tag}`,
  });
  await page.goto(`/#page=${board.id}`);
  const wb = page.getByLabel("Whiteboard", { exact: true });
  const canvas = wb.locator(".wb-canvas");
  const box = (await canvas.boundingBox())!;
  const at = (x: number, y: number) => ({
    x: box.x + box.width / 2 + x,
    y: box.y + box.height / 2 + y,
  });
  const drag = async (
    from: { x: number; y: number },
    to: { x: number; y: number },
  ) => {
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(to.x, to.y, { steps: 8 });
    await page.mouse.up();
  };
  // Frame with a note inside; moving the frame carries the note.
  await wb.getByRole("button", { name: "Rahmen", exact: true }).click();
  await drag(at(-300, -150), at(0, 150));
  await expect(wb.locator(".wb-frame")).toHaveCount(1);
  await wb.getByRole("button", { name: "Notizzettel", exact: true }).click();
  await page.mouse.click(at(-150, 0).x, at(-150, 0).y);
  await page.keyboard.type("Im Rahmen");
  await page.keyboard.press("Escape");
  const noteBefore = (await wb.locator(".wb-sticky").boundingBox())!;
  await page.keyboard.press("Escape");
  await drag(at(-290, -140), at(-240, -140));
  await expect
    .poll(async () => (await wb.locator(".wb-sticky").boundingBox())!.x)
    .toBeGreaterThan(noteBefore.x + 30);
  // Pen stroke.
  await wb.getByRole("button", { name: "Stift", exact: true }).click();
  await drag(at(60, -100), at(200, 40));
  await expect(wb.locator(".wb-pen")).toHaveCount(1);
  // Undo removes the stroke, redo brings it back.
  await wb.getByRole("button", { name: "Rückgängig", exact: true }).click();
  await expect(wb.locator(".wb-pen")).toHaveCount(0);
  await wb.getByRole("button", { name: "Wiederholen", exact: true }).click();
  await expect(wb.locator(".wb-pen")).toHaveCount(1);
  // Emoji and a card that opens a page.
  await wb.getByRole("button", { name: "Emoji", exact: true }).click();
  const emoji = page.getByRole("dialog", { name: "Emoji einfügen" });
  await emoji.getByPlaceholder(/Rakete/).fill("Rakete");
  await emoji.getByRole("button", { name: /🚀/ }).first().click();
  await expect(wb.locator(".wb-emoji")).toContainText("🚀");
  await wb
    .getByRole("button", { name: "Seite verknüpfen", exact: true })
    .click();
  const cards = page.getByRole("dialog", { name: "Seite verknüpfen" });
  await cards.getByLabel("Seiten suchen").fill(`Zielseite ${tag}`);
  await cards
    .getByRole("button", { name: new RegExp(`Zielseite ${tag}`) })
    .click();
  await expect(wb.locator(".wb-card")).toContainText(`Zielseite ${tag}`);
  // Duplicate and lock.
  await page.keyboard.press("ControlOrMeta+d");
  await expect(wb.locator(".wb-card")).toHaveCount(2);
  await wb.getByRole("button", { name: "Sperren", exact: true }).click();
  await expect(wb.locator(".wb-item.locked")).toHaveCount(1);
  // An image by file.
  await wb
    .getByLabel("Bild für das Whiteboard")
    .setInputFiles(join(process.cwd(), "tests/fixtures/scan.png"));
  await expect(wb.locator(".wb-image image")).toHaveCount(1);
  await expect(wb.getByText("Gespeichert", { exact: true })).toBeVisible({
    timeout: 10000,
  });
  await page.screenshot({ path: "test-results/whiteboard/tools.png" });
  // SVG export.
  const download = page.waitForEvent("download");
  await wb.getByRole("button", { name: "Als SVG exportieren" }).click();
  expect((await download).suggestedFilename()).toBe("whiteboard.svg");
  // The card opens its page on double click (the image on top goes first).
  await wb.focus();
  await page.keyboard.press("Delete");
  await expect(wb.locator(".wb-image")).toHaveCount(0);
  await wb.locator(".wb-card").last().dblclick();
  await expect(page).toHaveURL(new RegExp(`page=${target.id}`));
  expect(errors).toEqual([]);
  await command({ action: "page.delete", pageId: board.id });
  await command({ action: "page.delete", pageId: target.id });
});
