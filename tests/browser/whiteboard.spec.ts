import { join } from "node:path";
import { boardDraw, boardInsert, boardModeration, boardView } from "./whiteboard-ui";
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
  // Phones show the saving state in the actions menu.
  if (testInfo.project.name === "mobile")
    await wb.getByRole("button", { name: "Ansicht und Aktionen" }).click();
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
  await page.locator(".slash-menu").getByRole("option", { name: /^Whiteboard/ }).first().click();
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
  await boardDraw(wb, "Stift");
  await drag(at(60, -100), at(200, 40));
  await expect(wb.locator(".wb-pen")).toHaveCount(1);
  // Undo removes the stroke, redo brings it back.
  await wb.getByRole("button", { name: "Rückgängig", exact: true }).click();
  await expect(wb.locator(".wb-pen")).toHaveCount(0);
  await wb.getByRole("button", { name: "Wiederholen", exact: true }).click();
  await expect(wb.locator(".wb-pen")).toHaveCount(1);
  // Emoji and a card that opens a page.
  await boardInsert(wb, "Emoji");
  const emoji = page.getByRole("dialog", { name: "Emoji einfügen" });
  await emoji.getByPlaceholder(/Rakete/).fill("Rakete");
  await emoji.getByRole("button", { name: /🚀/ }).first().click();
  await expect(wb.locator(".wb-emoji")).toContainText("🚀");
  await boardInsert(wb, "Seite verknüpfen");
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
  await boardView(wb, "Als SVG exportieren");
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

test("board templates and presenting frames", async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const { command, board } = await setup(
    page,
    `Vorlagen ${testInfo.project.name} ${Date.now()}`,
  );
  await page.goto(`/#page=${board.id}`);
  const wb = page.getByLabel("Whiteboard", { exact: true });
  // Templates wait in the "+" panel (phones: the sheet behind "Weitere Werkzeuge").
  const templates = () => boardInsert(wb, "Vorlagen");
  await templates();
  await page
    .getByRole("dialog", { name: "Vorlagen" })
    .locator('[data-template="mindmap"]')
    .click();
  await expect(wb.locator(".wb-shape")).toHaveCount(5);
  await expect(wb.locator(".wb-connector")).toHaveCount(4);
  await templates();
  await page
    .getByRole("dialog", { name: "Vorlagen" })
    .locator('[data-template="retro"]')
    .click();
  await expect(wb.locator(".wb-frame")).toHaveCount(3);
  await expect
    .poll(
      async () =>
        (await (await page.request.get(`/api/pages/${board.id}`)).json()).html,
    )
    .toContain("Zentrales Thema");
  // Presenting walks through the frames.
  await wb.getByRole("button", { name: "Präsentieren" }).click();
  const bar = wb.locator(".wb-present");
  await expect(bar).toContainText("1 / 3");
  await bar.getByRole("button", { name: "Nächster Rahmen" }).click();
  await expect(bar).toContainText("2 / 3");
  await page.keyboard.press("ArrowRight");
  await expect(bar).toContainText("Maßnahmen · 3 / 3");
  await page.keyboard.press("Escape");
  await expect(bar).toHaveCount(0);
  await page.screenshot({
    path: `test-results/whiteboard/templates-${testInfo.project.name}.png`,
  });
  expect(errors).toEqual([]);
  await command({ action: "page.delete", pageId: board.id });
});

test("comment pins, tables, voting, timer and full screen", async ({
  page,
  browser,
}, testInfo) => {
  test.skip(testInfo.project.name === "mobile", "Desktop-Zeigergesten");
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const { command, board } = await setup(page, `Workshop ${Date.now()}`);
  await page.goto(`/#page=${board.id}`);
  const wb = page.getByLabel("Whiteboard", { exact: true });
  const canvas = wb.locator(".wb-canvas");
  const box = (await canvas.boundingBox())!;
  const cx = box.x + box.width / 2,
    cy = box.y + box.height / 2;
  // Table: create, type into cells with Tab, add a row.
  await wb.getByRole("button", { name: "Tabelle", exact: true }).click();
  await page.mouse.click(cx - 150, cy - 120);
  await expect(wb.locator(".wb-table")).toHaveCount(1);
  const table = (await wb.locator("g.wb-table").boundingBox())!;
  await page.mouse.dblclick(table.x + 20, table.y + 10);
  await page.keyboard.type("Thema");
  await page.keyboard.press("Tab");
  await page.keyboard.type("Owner");
  await page.keyboard.press("Escape");
  await expect(wb.locator(".wb-cell").nth(0)).toHaveText("Thema");
  await expect(wb.locator(".wb-cell").nth(1)).toHaveText("Owner");
  await wb.locator("g.wb-table").click();
  await wb.getByRole("button", { name: "+ Zeile" }).click();
  await expect(wb.locator(".wb-cell")).toHaveCount(12);
  // A sticky to vote on, then a comment pin with a reply.
  await page.keyboard.press("Escape");
  await canvas.dblclick({
    position: { x: box.width / 2 + 200, y: box.height / 2 + 60 },
  });
  await expect(wb.locator("textarea").first()).toBeFocused();
  await page.keyboard.type("Option A");
  await page.keyboard.press("Escape");
  await wb.getByRole("button", { name: "Kommentar", exact: true }).click();
  // Clicks above may have scrolled the page; measure the canvas again.
  const now = (await canvas.boundingBox())!;
  await page.mouse.click(now.x + now.width / 2 + 60, now.y + now.height / 2 + 150);
  const comment = wb.getByRole("dialog", { name: "Kommentar" });
  await comment.getByLabel("Kommentar schreiben").fill("Bitte prüfen");
  await comment.getByRole("button", { name: "Senden" }).click();
  await comment.getByLabel("Antworten").fill("Erledige ich");
  await comment.getByRole("button", { name: "Senden" }).click();
  await expect(comment.locator(".wb-comment-message")).toHaveCount(2);
  await comment.getByRole("button", { name: "Erledigt" }).click();
  await expect(comment).toContainText("Erledigter Kommentar");
  await comment.getByRole("button", { name: "Kommentar schließen" }).click();
  await expect(wb.locator("g.wb-comment")).toContainText("2");
  // Voting.
  await boardModeration(wb, "Abstimmung");
  await wb
    .getByRole("dialog", { name: "Abstimmung" })
    .getByRole("button", { name: "Abstimmung starten" })
    .click();
  await wb.getByRole("button", { name: /Stimme für Option A: 0/ }).click();
  await expect(
    wb.getByRole("button", { name: /Stimme für Option A: 1/ }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(wb.locator(".wb-results")).toContainText("Option A");
  await wb.getByRole("button", { name: "Abstimmung beenden" }).click();
  // Timer.
  await boardModeration(wb, "Timer");
  await wb
    .getByRole("dialog", { name: "Timer einstellen" })
    .getByRole("button", { name: "1 Min" })
    .click();
  const timer = wb.getByRole("timer");
  await expect(timer).toContainText(/0:5\d|1:00/);
  await timer.getByRole("button", { name: "Pause" }).click();
  await expect(timer.getByRole("button", { name: "Weiter" })).toBeVisible();
  // Everything reaches a second person.
  await expect(wb.getByText("Gespeichert", { exact: true })).toBeVisible({
    timeout: 10000,
  });
  const other = await browser.newContext({ viewport: page.viewportSize()! });
  const second = await other.newPage();
  await second.request.post(`${origin}/api/auth/demo`, { headers: { origin } });
  await second.goto(`${origin}/#page=${board.id}`);
  const b = second.getByLabel("Whiteboard", { exact: true });
  await expect(b.getByRole("timer")).toContainText(/0:5\d|1:00/);
  await expect(b.locator(".wb-cell").nth(0)).toHaveText("Thema");
  await expect(
    b.getByRole("button", { name: /Stimme für Option A: 1/ }),
  ).toBeVisible();
  await other.close();
  await expect
    .poll(
      async () =>
        (await (await page.request.get(`/api/pages/${board.id}`)).json()).html,
    )
    .toContain("Bitte prüfen");
  // Full screen covers the page and ends again.
  await boardView(wb, "Vollbild");
  await expect(wb).toHaveClass(/wb-fullscreen/);
  const full = (await wb.boundingBox())!;
  expect(full.width).toBeGreaterThanOrEqual(page.viewportSize()!.width - 1);
  await page.screenshot({ path: "test-results/whiteboard/workshop.png" });
  await boardView(wb, "Vollbild beenden");
  await expect(wb).not.toHaveClass(/wb-fullscreen/);
  expect(errors).toEqual([]);
  await command({ action: "page.delete", pageId: board.id });
});

test("desktop: a short tool rail, the + panel with search, moderation top right, one bar bottom left", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name === "mobile", "Desktop layout");
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const { command, board } = await setup(page, `Leiste ${Date.now()}`);
  await page.goto(`/#page=${board.id}`);
  const wb = page.getByLabel("Whiteboard", { exact: true });
  const rail = wb.getByRole("toolbar", { name: "Werkzeuge" });
  await expect(rail).toBeVisible();
  // Select, pan, eight creation tools (pen, eraser and laser as one) and "+".
  await expect(rail.getByRole("button")).toHaveCount(11);
  for (const name of ["Abstimmung", "Timer", "Bild", "Vorlagen", "Rückgängig", "Stempel"])
    await expect(rail.getByRole("button", { name, exact: true })).toHaveCount(0);
  // Shortcuts still reach the tools that left the rail.
  await wb.focus();
  await page.keyboard.press("e");
  const plus = rail.getByRole("button", { name: "Einfügen und mehr" });
  await expect(plus).toHaveClass(/active/);
  await page.keyboard.press("k");
  await expect(rail.getByRole("button", { name: "Zeichnen" })).toHaveAttribute("aria-pressed", "true");
  await expect(wb.locator(".wb-draw-switch").getByRole("button", { name: "Laserpointer" })).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("x");
  await expect(wb.locator(".wb-draw-switch").getByRole("button", { name: "Radierer" })).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("Escape");
  await expect(rail.getByRole("button", { name: "Zeichnen" })).toHaveAttribute("aria-pressed", "false");
  await expect(plus).not.toHaveClass(/active/);
  // The "+" panel: search first, Enter takes the first match.
  await plus.click();
  await expect(plus).toHaveAttribute("aria-expanded", "true");
  const panel = wb.getByRole("dialog", { name: "Einfügen und mehr" });
  for (const name of ["Einfügen", "Vorlagen & Bibliothek"])
    await expect(panel.getByRole("heading", { name })).toBeVisible();
  const search = panel.getByRole("searchbox");
  await expect(search).toBeFocused();
  await search.fill("stemp");
  await expect(panel.getByRole("button")).toHaveCount(1);
  await page.keyboard.press("Enter");
  await expect(panel).toHaveCount(0);
  await expect(plus).toHaveClass(/active/);
  await expect(plus).toHaveAttribute("title", "Stempel (E)");
  await page.keyboard.press("Escape");
  // Escape closes it and gives the keyboard back to "+"; so does a click outside.
  await plus.click();
  await expect(search).toHaveValue("");
  await search.fill("nichts dergleichen");
  await expect(panel.getByText("Nichts gefunden.")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(panel).toHaveCount(0);
  await expect(plus).toBeFocused();
  await plus.click();
  await wb.locator(".wb-canvas").click({ position: { x: 600, y: 120 } });
  await expect(panel).toHaveCount(0);
  // Moderation: one button top right with its menu.
  const moderation = wb.getByRole("button", { name: "Moderation", exact: true });
  await moderation.click();
  await expect(moderation).toHaveAttribute("aria-expanded", "true");
  const menu = wb.getByRole("dialog", { name: "Moderation" });
  for (const name of ["Abstimmung", "Timer", "Privater Modus", "Schätzen", "Alle zu mir holen", "Folge mir"])
    await expect(menu.getByRole("button", { name, exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await expect(moderation).toBeFocused();
  const [mod, box] = [(await moderation.boundingBox())!, (await wb.boundingBox())!];
  expect(mod.x + mod.width).toBeGreaterThan(box.x + box.width - 40);
  expect(mod.y).toBeLessThan(box.y + 40);
  // Undo, redo, zoom and the actions menu share one bar bottom left.
  const bottom = wb.getByRole("toolbar", { name: "Ansicht" });
  for (const name of ["Rückgängig", "Wiederholen", "Vergrößern", "Verkleinern", "Ansicht und Aktionen"])
    await expect(bottom.getByRole("button", { name, exact: true })).toBeVisible();
  const bar = (await bottom.boundingBox())!;
  expect(bar.x).toBeLessThan(box.x + 80);
  expect(bar.y + bar.height).toBeGreaterThan(box.y + box.height - 40);
  expect(errors).toEqual([]);
  await command({ action: "page.delete", pageId: board.id });
});

test("phones get one tool bar, a tool sheet and one actions menu, nothing clipped", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "mobile", "Phone layout");
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const { command, board } = await setup(page, `Handy ${Date.now()}`);
  await page.goto(`/#page=${board.id}`);
  const wb = page.getByLabel("Whiteboard", { exact: true });
  await expect(wb).toBeVisible();
  const skip = page.getByRole("button", { name: "Überspringen" });
  if (await skip.isVisible()) await skip.click();
  const dock = wb.getByRole("toolbar", { name: "Werkzeuge" });
  // Inside the viewport, above the tab bar, no horizontal scrolling.
  // (In full screen the board covers the tab bar.)
  const fits = async (selector: string) =>
    page.evaluate((selector) => {
      const box = document.querySelector(selector)!.getBoundingClientRect();
      const bar = document.querySelector(".mobile-tab-bar");
      const covered = !!document.querySelector(".whiteboard.wb-fullscreen");
      const barTop = bar && !covered && getComputedStyle(bar).display !== "none" ? bar.getBoundingClientRect().top : innerHeight;
      return {
        overflow: document.documentElement.scrollWidth - innerWidth,
        inside: box.left >= 0 && box.right <= innerWidth && box.top >= 0 && box.bottom <= Math.min(innerHeight, barTop) + 0.5,
      };
    }, selector);
  // The page opens with the whole board and its tools in view.
  expect(await fits(".wb-dock")).toEqual({ overflow: 0, inside: true });
  await expect(dock.getByRole("button")).toHaveCount(7);
  await expect(wb.getByRole("button", { name: "Als PNG exportieren" })).toHaveCount(0);
  await expect(wb.locator(".wb-empty")).toContainText("Unten ein Werkzeug wählen");
  const hint = (await wb.locator(".wb-empty span").boundingBox())!;
  const bar = (await dock.boundingBox())!;
  expect(hint.y + hint.height).toBeLessThanOrEqual(bar.y);
  // The other tools wait in a sheet – the same sections as the "+" panel on
  // larger screens, with a search.
  await dock.getByRole("button", { name: "Weitere Werkzeuge" }).click();
  const sheet = wb.getByRole("dialog", { name: "Weitere Werkzeuge" });
  await expect(sheet.getByRole("heading", { name: "Einfügen" })).toBeVisible();
  await expect(sheet.getByRole("heading", { name: "Vorlagen & Bibliothek" })).toBeVisible();
  expect((await fits(".wb-sheet")).inside).toBe(true);
  // Long names ("Verbindungslinie", "Mermaid/PlantUML importieren …") stay
  // inside their tiles.
  const overflowing = await sheet.locator(".wb-sheet-grid button").evaluateAll((tiles) =>
    tiles
      .filter((tile) => {
        const outer = tile.getBoundingClientRect(),
          label = tile.querySelector("span")!.getBoundingClientRect();
        return label.left < outer.left - 0.5 || label.right > outer.right + 0.5;
      })
      .map((tile) => tile.textContent),
  );
  expect(overflowing).toEqual([]);
  // Not focused by itself (no keyboard over the sheet), filters by name.
  await expect(sheet.getByRole("searchbox")).not.toBeFocused();
  await sheet.getByRole("searchbox").fill("rahm");
  await expect(sheet.getByRole("button")).toHaveCount(1);
  await sheet.getByRole("button", { name: "Rahmen", exact: true }).click();
  await expect(sheet).toHaveCount(0);
  await expect(dock.getByRole("button", { name: "Weitere Werkzeuge" })).toHaveClass(/active/);
  // Pen, eraser and laser share the draw button, with a switch in its options.
  await dock.getByRole("button", { name: "Zeichnen" }).click();
  await wb.locator(".wb-draw-switch").getByRole("button", { name: "Radierer" }).click();
  await expect(dock.getByRole("button", { name: "Zeichnen" })).toHaveAttribute("aria-pressed", "true");
  // Moderation sits top right, next to the actions.
  await wb.locator(".wb-corner-end").getByRole("button", { name: "Moderation" }).click();
  const moderation = wb.getByRole("dialog", { name: "Moderation" });
  for (const name of ["Abstimmung", "Timer", "Privater Modus", "Schätzen", "Alle zu mir holen"])
    await expect(moderation.getByRole("button", { name, exact: true })).toBeVisible();
  expect((await fits(".wb-moderation")).inside).toBe(true);
  await page.keyboard.press("Escape");
  await expect(moderation).toHaveCount(0);
  // View and export actions sit in one menu.
  await wb.getByRole("button", { name: "Ansicht und Aktionen" }).click();
  const menu = wb.getByRole("dialog", { name: "Ansicht und Aktionen" });
  for (const name of ["Alles anzeigen", "Vollbild", "Kommentare ausblenden", "Als SVG exportieren", "Als PNG exportieren"])
    await expect(menu.getByRole("button", { name, exact: true })).toBeVisible();
  expect((await fits(".wb-actions")).inside).toBe(true);
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  // Other phone sizes, upright and sideways.
  for (const [width, height] of [[320, 568], [360, 740], [430, 932], [844, 390], [390, 844]]) {
    await page.setViewportSize({ width, height });
    await wb.evaluate((el) => el.scrollIntoView({ block: "end" }));
    await expect(dock).toBeVisible();
    expect(await fits(".wb-dock"), `${width}×${height}`).toEqual({ overflow: 0, inside: true });
    expect(await fits(".wb-corner-end"), `${width}×${height}`).toEqual({ overflow: 0, inside: true });
  }
  // Full screen keeps the bar.
  await wb.getByRole("button", { name: "Ansicht und Aktionen" }).click();
  await menu.getByRole("button", { name: "Vollbild", exact: true }).click();
  await expect(wb).toHaveClass(/wb-fullscreen/);
  expect(await fits(".wb-dock")).toEqual({ overflow: 0, inside: true });
  await wb.getByRole("button", { name: "Ansicht und Aktionen" }).click();
  await menu.getByRole("button", { name: "Vollbild beenden" }).click();
  await expect(wb).not.toHaveClass(/wb-fullscreen/);
  expect(errors).toEqual([]);
  await command({ action: "page.delete", pageId: board.id });
});
