// Whiteboard navigation, structure, content and presentation: groups,
// minimap, frames panel and presentation order, search with the tag filter,
// element links, lists and links in notes, tags, embeds, cropping, the
// template gallery with own templates, exports and the presenter view.
import { test, expect, type Page } from "@playwright/test";
import * as Y from "yjs";

const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
// Screenshots for the documentation, when asked for (SHOTS=<folder>).
const shots = process.env.SHOTS || "";
async function shot(page: Page, name: string) {
  if (shots) await page.screenshot({ path: `${shots}/${name}.png` });
}

type Seed = Record<string, unknown> & { id: string };
async function setup(page: Page, title: string, items: Seed[] = []) {
  await page.request.post("/api/auth/demo", { headers: { origin } });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const command = async (data: Record<string, unknown>) => {
    const r = await page.request.post("/api/command", { headers: { origin }, data });
    expect(r.ok(), await r.text()).toBe(true);
    return r.json();
  };
  // Past the introduction new accounts see first.
  await command({ action: "profile.onboarded" });
  const board = await command({ action: "page.create", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, title, kind: "whiteboard" });
  if (items.length) {
    const data = await (await page.request.get(`/api/pages/${board.id}`)).json();
    const doc = new Y.Doc();
    Y.applyUpdate(doc, Buffer.from(data.whiteboard.state, "base64"));
    const before = Y.encodeStateVector(doc);
    const map = doc.getMap<Y.Map<unknown>>("items");
    items.forEach((item, z) => {
      const entry = new Y.Map<unknown>();
      for (const [key, value] of Object.entries({ z, ...item })) if (key !== "id") entry.set(key, value);
      map.set(item.id, entry);
    });
    await command({
      action: "whiteboard.sync",
      pageId: board.id,
      generation: data.whiteboard.generation,
      update: Buffer.from(Y.encodeStateAsUpdate(doc, before)).toString("base64"),
    });
  }
  return { boot, command, board };
}
const frame = (id: string, x: number, y: number, text: string, extra: Record<string, unknown> = {}): Seed => ({
  id,
  type: "frame",
  x,
  y,
  w: 600,
  h: 400,
  text,
  fill: "#ffffff",
  ...extra,
});
const note = (id: string, x: number, y: number, text: string, extra: Record<string, unknown> = {}): Seed => ({
  id,
  type: "sticky",
  x,
  y,
  w: 200,
  h: 200,
  text,
  fill: "#fff6b6",
  fontSize: 16,
  ...extra,
});
// The view and actions bar: on narrow boards behind "Ansicht und Aktionen".
async function viewAction(page: Page, name: string) {
  const wb = page.getByLabel("Whiteboard", { exact: true });
  const toggle = wb.getByRole("button", { name: "Ansicht und Aktionen" });
  if (await toggle.isVisible()) await toggle.click();
  await wb.getByRole("button", { name, exact: true }).first().click();
}

test("groups move and lock as one; double click enters the group", async ({ page }, info) => {
  test.skip(info.project.name === "mobile", "Desktop pointer gestures");
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const { board } = await setup(page, `Gruppen ${Date.now()}`, [note("a", 0, 0, "Eins"), note("b", 260, 0, "Zwei"), note("c", 0, 320, "Drei")]);
  await page.goto(`/#page=${board.id}`);
  const wb = page.getByLabel("Whiteboard", { exact: true });
  await expect(wb.locator(".wb-toolbar")).toBeVisible();
  const one = wb.locator(".wb-sticky", { hasText: "Eins" }),
    two = wb.locator(".wb-sticky", { hasText: "Zwei" });
  await one.click();
  await page.keyboard.down("Shift");
  await two.click();
  await page.keyboard.up("Shift");
  await page.keyboard.press("ControlOrMeta+g");
  await page.keyboard.press("Escape");
  // One click selects the group.
  await one.click();
  await expect(wb.locator(".wb-item.selected")).toHaveCount(2);
  await expect(wb.getByRole("button", { name: "Gruppierung aufheben" })).toBeVisible();
  await shot(page, "groups");
  // Dragging moves both.
  const before = (await two.boundingBox())!;
  const box = (await one.boundingBox())!;
  await page.mouse.move(box.x + 30, box.y + 30);
  await page.mouse.down();
  await page.mouse.move(box.x + 130, box.y + 90, { steps: 6 });
  await page.mouse.up();
  const after = (await two.boundingBox())!;
  expect(after.x - before.x).toBeGreaterThan(60);
  // Locking locks both.
  await wb.getByRole("button", { name: "Sperren" }).click();
  await expect(wb.locator(".wb-item.locked")).toHaveCount(2);
  await wb.getByRole("button", { name: "Entsperren" }).click();
  await wb.focus();
  // Duplicating copies the group as a new group.
  await page.keyboard.press("ControlOrMeta+d");
  await expect(wb.locator(".wb-sticky", { hasText: "Eins" })).toHaveCount(2);
  await expect(wb.locator(".wb-item.selected")).toHaveCount(2);
  await page.keyboard.press("ControlOrMeta+z");
  await expect(wb.locator(".wb-sticky", { hasText: "Eins" })).toHaveCount(1);
  // A double click enters the group: only the element is selected.
  await page.keyboard.press("Escape");
  await one.dblclick();
  await expect(wb.locator(".wb-item.selected")).toHaveCount(1);
  await expect(wb.locator(".wb-group-outline")).toHaveCount(1);
  await page.keyboard.press("Escape");
  // Ungrouping.
  await one.click();
  await page.keyboard.press("ControlOrMeta+Shift+g");
  await page.keyboard.press("Escape");
  await one.click();
  await expect(wb.locator(".wb-item.selected")).toHaveCount(1);
  expect(errors).toEqual([]);
});

test("frames panel: order, hidden frame, notes; presenting shows only the frame; minimap", async ({ page }, info) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const { board } = await setup(page, `Rahmen ${Date.now()}`, [
    frame("f1", 0, 0, "Erster"),
    frame("f2", 700, 0, "Zweiter"),
    frame("f3", 0, 500, "Dritter"),
    note("n1", 40, 60, "Im ersten"),
    note("n2", 740, 60, "Im zweiten"),
  ]);
  await page.goto(`/#page=${board.id}`);
  const wb = page.getByLabel("Whiteboard", { exact: true });
  await expect(wb.locator(".wb-toolbar")).toBeVisible();
  await viewAction(page, "Rahmenübersicht");
  const panel = wb.getByRole("complementary", { name: "Rahmen" });
  await expect(panel.locator(".wb-frame-row")).toHaveCount(3);
  await expect(panel.locator("input.wb-frame-name").first()).toHaveValue("Erster");
  await shot(page, `frames-panel-${info.project.name}`);
  // Move "Dritter" first with the keyboard on its grip, hide "Zweiter".
  await panel.getByRole("button", { name: "„Dritter“ verschieben (Alt+Pfeiltasten)" }).focus();
  await page.keyboard.press("Alt+ArrowUp");
  await page.keyboard.press("Alt+ArrowUp");
  await expect(panel.locator("input.wb-frame-name").first()).toHaveValue("Dritter");
  await panel.locator(".wb-frame-row", { has: page.locator('input[value="Zweiter"]') }).getByRole("button", { name: "In der Präsentation ausblenden" }).click();
  // Speaker notes for "Erster".
  await panel.locator(".wb-frame-row", { has: page.locator('input[value="Erster"]') }).getByRole("button", { name: "Sprechernotizen" }).click();
  await panel.getByLabel("Sprechernotizen zu „Erster“").fill("Hier die Zahlen nennen.");
  // Rename "Erster".
  const name = panel.locator('input.wb-frame-name[value="Erster"]');
  await name.fill("Start");
  await name.press("Enter");
  await expect(wb.locator(".wb-frame-title", { hasText: "Start" })).toBeVisible();
  // Presenting: Dritter, then Start; Zweiter is skipped.
  await panel.getByRole("button", { name: "Präsentieren" }).first().click();
  await expect(wb.locator(".wb-present")).toContainText("Dritter · 1 / 2");
  await expect(wb.locator('[data-item="n1"]')).toHaveClass(/wb-offstage/);
  await page.keyboard.press("ArrowRight");
  await expect(wb.locator(".wb-present")).toContainText("Start · 2 / 2");
  await expect(wb.locator('[data-item="n1"]')).not.toHaveClass(/wb-offstage/);
  await expect(wb.locator('[data-item="n2"]')).toHaveClass(/wb-offstage/);
  await wb.getByRole("button", { name: "Sprechernotizen" }).click();
  await expect(wb.locator(".wb-present-notes")).toContainText("Hier die Zahlen nennen.");
  await shot(page, `presenting-${info.project.name}`);
  // The presenter view gets the slides and notes.
  const [presenter] = await Promise.all([page.waitForEvent("popup"), wb.getByRole("button", { name: "Referentenansicht" }).click()]);
  await expect(presenter.locator(".presenter-notes")).toContainText("Hier die Zahlen nennen.");
  await expect(presenter.locator(".presenter-counter")).toContainText("Folie 2 von 2");
  await presenter.getByRole("button", { name: "Zurück" }).click();
  await expect(wb.locator(".wb-present")).toContainText("Dritter · 1 / 2");
  await presenter.close();
  await page.keyboard.press("Escape");
  await expect(wb.locator(".wb-present")).toHaveCount(0);
  await expect(wb.locator('[data-item="n1"]')).not.toHaveClass(/wb-offstage/);
  // Minimap: on, a click moves the view.
  await viewAction(page, "Minikarte");
  // On phones the actions sheet stays open for toggles: close it first.
  const toggle = wb.getByRole("button", { name: "Ansicht und Aktionen" });
  if ((await toggle.isVisible()) && (await toggle.getAttribute("aria-expanded")) === "true") await toggle.click();
  const minimap = wb.getByRole("slider", { name: /Minikarte/ });
  await expect(minimap).toBeVisible();
  const zoomBefore = await wb.locator("[data-world]").getAttribute("transform");
  const mini = (await minimap.boundingBox())!;
  await page.mouse.click(mini.x + mini.width * 0.9, mini.y + mini.height * 0.2);
  await expect.poll(() => wb.locator("[data-world]").getAttribute("transform")).not.toBe(zoomBefore);
  await shot(page, `minimap-${info.project.name}`);
  // Undo takes the hidden frame back.
  expect(errors).toEqual([]);
});

test("search with tag filter, element links, lists and links in notes", async ({ page, context }, info) => {
  test.skip(info.project.name === "mobile", "Keyboard shortcuts");
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const { board } = await setup(page, `Suche ${Date.now()}`, [
    frame("ziel", 2400, 1600, "Zielrahmen"),
    note("a", 0, 0, "Budget planen\n- Miete\n- Strom", { tags: ["Finanzen"] }),
    note("b", 300, 0, "Team-Event", { tags: ["Team"] }),
    note("c", 600, 0, "Budget prüfen [Zum Ziel](#item=ziel)", { tags: ["Finanzen"] }),
    { id: "t", type: "table", x: 0, y: 300, w: 300, h: 100, cells: [["Posten", "Budget"], ["a", "b"]], header: true },
  ]);
  await page.goto(`/#page=${board.id}`);
  const wb = page.getByLabel("Whiteboard", { exact: true });
  await expect(wb.locator(".wb-toolbar")).toBeVisible();
  // Lists render as lists.
  await expect(wb.locator('[data-item="a"] li')).toHaveCount(2);
  await wb.focus();
  await page.keyboard.press("ControlOrMeta+f");
  const search = wb.getByRole("search");
  await search.getByLabel("Suchbegriff").fill("budget");
  await expect(search).toContainText("1/3");
  await page.keyboard.press("Enter");
  await expect(search).toContainText("2/3");
  await expect(wb.locator(".wb-search-hit.current")).toHaveCount(1);
  await shot(page, "search");
  // Only notes tagged "Finanzen".
  await search.getByLabel("Nur Zettel mit Schlagwort").selectOption("Finanzen");
  await expect(wb.locator('[data-item="b"]')).toHaveClass(/wb-dim/);
  await expect(wb.locator('[data-item="a"]')).not.toHaveClass(/wb-dim/);
  await shot(page, "tag-filter");
  await page.keyboard.press("Escape");
  await expect(wb.locator(".wb-dim")).toHaveCount(0);
  // An element link inside a note flies to the frame.
  await wb.locator('[data-item="c"] .wb-link').click();
  await expect(wb.locator('[data-item="ziel"]')).toHaveClass(/selected/);
  // "Link zu diesem Element kopieren" and opening such a link.
  await wb.getByRole("button", { name: "Link zu diesem Element kopieren" }).click();
  const link = await page.evaluate(() => navigator.clipboard.readText());
  expect(link).toContain(`#page=${board.id}&item=ziel`);
  await page.goto("/#home");
  await page.goto(link);
  await expect(page.getByLabel("Whiteboard", { exact: true }).locator('[data-item="ziel"]')).toHaveClass(/selected/);
  await expect(page).toHaveURL(new RegExp(`#page=${board.id}$`));
  // Typing a list: Enter continues it.
  const wb2 = page.getByLabel("Whiteboard", { exact: true });
  // The search flies back to the note.
  await wb2.focus();
  await page.keyboard.press("ControlOrMeta+f");
  await wb2.getByRole("search").getByLabel("Suchbegriff").fill("Team-Event");
  await expect(wb2.locator(".wb-search-hit.current")).toHaveCount(1);
  await page.keyboard.press("Escape");
  await wb2.locator('[data-item="b"]').dblclick();
  const editor = wb2.locator("textarea.wb-editor");
  await editor.press("ControlOrMeta+End");
  await editor.press("Enter");
  await editor.type("- erstens");
  await editor.press("Enter");
  await editor.type("zweitens");
  await expect(editor).toHaveValue("Team-Event\n- erstens\n- zweitens");
  await editor.press("Escape");
  await expect(wb2.locator('[data-item="b"] li')).toHaveCount(2);
  // A tag added in the style bar shows as a chip.
  await wb2.locator('[data-item="b"]').click();
  await wb2.getByRole("button", { name: "Schlagwörter" }).click();
  await wb2.getByLabel("Neues Schlagwort").fill("Wichtig");
  await wb2.getByLabel("Neues Schlagwort").press("Enter");
  await expect(wb2.locator('[data-item="b"] .wb-tag', { hasText: "Wichtig" })).toBeVisible();
  await shot(page, "rich-text-tags");
  expect(errors).toEqual([]);
});

test("embeds load only on click; template gallery and own templates; export dialog", async ({ page }, info) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const frames: string[] = [];
  page.on("request", (r) => /youtube/.test(r.url()) && frames.push(r.url()));
  // Nothing of YouTube ever loads in the test: the player address is answered locally.
  await page.route(/youtube-nocookie\.com/, (route) => route.fulfill({ status: 200, contentType: "text/html", body: "<p>player</p>" }));
  const { board } = await setup(page, `Einbettung ${Date.now()}`, [note("a", 0, 0, "Hallo")]);
  await page.goto(`/#page=${board.id}`);
  const wb = page.getByLabel("Whiteboard", { exact: true });
  await expect(wb.locator(".wb-toolbar")).toBeVisible();
  const insert = async (name: string) => {
    const more = wb.getByRole("button", { name: "Weitere Werkzeuge" });
    if (await more.isVisible()) await more.click();
    await wb.getByRole("button", { name, exact: true }).first().click();
  };
  await insert("Einbetten");
  const dialog = page.getByRole("dialog", { name: "Einbetten" });
  await dialog.locator("#wb-embed-url").fill("https://evil.example/video");
  await dialog.getByRole("button", { name: "Einbetten" }).click();
  await expect(dialog.getByRole("alert")).toContainText("lässt sich nicht einbetten");
  await dialog.locator("#wb-embed-url").fill("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
  await dialog.getByRole("button", { name: "Einbetten" }).click();
  await expect(dialog).toHaveCount(0);
  const embed = wb.locator("g.wb-embed");
  await expect(embed).toContainText("YouTube");
  await expect(wb.locator("iframe")).toHaveCount(0);
  expect(frames).toEqual([]);
  await shot(page, `embed-preview-${info.project.name}`);
  await wb.getByRole("button", { name: "YouTube laden" }).click();
  const iframe = wb.locator("iframe");
  await expect(iframe).toHaveAttribute("src", "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ");
  await expect(iframe).toHaveAttribute("sandbox", "allow-scripts allow-same-origin allow-presentation");
  await wb.getByRole("button", { name: "Einbettung schließen" }).click();
  await expect(iframe).toHaveCount(0);

  // Template gallery: search, insert a template.
  await insert("Vorlagen");
  const gallery = page.getByRole("dialog", { name: "Vorlagen" });
  await gallery.getByLabel("Vorlagen suchen").fill("eisenhower");
  await expect(gallery.locator(".wb-template-card")).toHaveCount(1);
  await shot(page, `template-gallery-${info.project.name}`);
  await gallery.locator('[data-template="eisenhower"]').click();
  await expect(wb.locator(".wb-frame-title", { hasText: "Sofort erledigen" })).toBeVisible();
  // Save the board as an own template and find it again.
  await insert("Vorlagen");
  await gallery.getByRole("tab", { name: "Als Vorlage speichern" }).click();
  const own = `Unsere Matrix ${Date.now()}`;
  await gallery.getByLabel("Name").fill(own);
  await gallery.getByRole("button", { name: "Als Vorlage speichern" }).click();
  await expect(gallery.getByRole("tab", { name: "Eigene Vorlagen" })).toHaveAttribute("aria-selected", "true");
  await expect(gallery.locator(".wb-template-card", { hasText: own })).toBeVisible();
  await gallery.getByRole("button", { name: `Vorlage „${own}“ einfügen` }).click();
  await expect(wb.locator(".wb-frame-title", { hasText: "Sofort erledigen" })).toHaveCount(2);

  // Export dialog: PDF with one page per frame.
  await viewAction(page, "Exportieren … (PNG, SVG, PDF)");
  const exporting = page.getByRole("dialog", { name: "Exportieren" });
  await exporting.getByRole("radio", { name: "PDF" }).click();
  await exporting.getByLabel("Was exportieren").selectOption("board");
  await exporting.getByRole("radio", { name: "Eine Seite pro Rahmen" }).click();
  await shot(page, `export-${info.project.name}`);
  const [download] = await Promise.all([page.waitForEvent("download"), exporting.getByRole("button", { name: "Exportieren" }).click()]);
  expect(download.suggestedFilename()).toMatch(/\.pdf$/);
  const bytes = await (await import("node:fs/promises")).readFile((await download.path())!);
  expect(bytes.subarray(0, 5).toString()).toBe("%PDF-");
  // PNG of a frame at 2×.
  await viewAction(page, "Exportieren … (PNG, SVG, PDF)");
  await exporting.getByLabel("Was exportieren").selectOption({ label: "Rahmen: Sofort erledigen" });
  await exporting.getByRole("radio", { name: "2×" }).click();
  const [png] = await Promise.all([page.waitForEvent("download"), exporting.getByRole("button", { name: "Exportieren" }).click()]);
  expect(png.suggestedFilename()).toBe("Sofort erledigen.png");
  const image = await (await import("node:fs/promises")).readFile((await png.path())!);
  expect(image.readUInt32BE(16)).toBeGreaterThan(900);
  expect(errors).toEqual([]);
});
