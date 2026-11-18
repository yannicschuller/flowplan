import { test, expect, type Page } from "@playwright/test";
import { diagramPng } from "../helpers/png";

// Flashcards phase 6 (docs/specs/flashcards.md §5.5): the mask editor of
// image occlusion from the image tools of a record's document – drawing
// with the mouse, tapping a polygon on touch screens, moving, resizing,
// the keyboard, groups, labels and the mode – and the cards in the focus
// mode: the masks asked covered and highlighted, opened when revealed,
// with screen reader texts. STUDY_SCREENSHOTS=<dir> keeps pictures of the
// editor and a card (light and dark).
const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
const shots = process.env.STUDY_SCREENSHOTS || "";

async function shot(page: Page, name: string, project: string) {
  if (!shots) return;
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.waitForTimeout(250);
    await page.screenshot({ path: `${shots}/fc6-${name}-${project === "mobile" ? 390 : 1440}-${scheme}.png` });
  }
  await page.emulateMedia({ colorScheme: "light" });
}
async function signedIn(page: Page) {
  await page.request.post("/api/auth/demo", { headers: { origin } });
  await page.request.post("/api/command", { headers: { origin }, data: { action: "profile.onboarded" } });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const command = async (data: Record<string, unknown>) => {
    const response = await page.request.post("/api/command", { headers: { origin }, data });
    expect(response.ok(), await response.text()).toBe(true);
    return response.json();
  };
  return { boot, command };
}
// A flashcards database with one image occlusion record whose document
// holds the diagram (with `masks`, if given).
async function occlusionRecord(page: Page, title: string, masks?: unknown) {
  const { boot, command } = await signedIn(page);
  const pageId = (await command({ action: "page.create", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, title, kind: "database", databaseKind: "flashcards" })).id as string;
  const row = await command({ action: "row.create", pageId, cells: { title: "Welche Region ist markiert?", back: "Atlas, Seite 12", type: "Bildverdeckung" } });
  const upload = await page.request.post("/api/upload", { headers: { origin }, multipart: { pageId, file: { name: "atlas.png", mimeType: "image/png", buffer: diagramPng() } } });
  expect(upload.ok(), await upload.text()).toBe(true);
  const { url } = await upload.json();
  const attr = masks ? ` data-occlusion="${JSON.stringify(masks).replace(/&/g, "&amp;").replace(/"/g, "&quot;")}"` : "";
  const { htmlState } = await import("../../lib/document-server");
  const { generation } = await (await page.request.get(`/api/pages/${pageId}/rows/${row.id}`)).json();
  await command({
    action: "row.document.sync",
    pageId,
    rowId: row.id,
    generation,
    update: Buffer.from(htmlState(`<p>Karte der Regionen</p><img src="${url}" alt="Karte mit fünf Regionen"${attr}>`)).toString("base64"),
  });
  const total = async () => (await command({ action: "study.queue", pageId, zone: "Europe/Berlin", limit: 0 })).total as number;
  return { pageId, rowId: row.id as string, command, total };
}
async function openEditor(page: Page, pageId: string, rowId: string) {
  await page.goto(`/#page=${pageId}&row=${rowId}`);
  const image = page.locator(".ProseMirror img").first();
  await expect(image).toBeVisible({ timeout: 30_000 });
  await image.click();
  await page.getByRole("button", { name: "Weitere Bildaktionen" }).first().click();
  await page.getByRole("menuitem", { name: "Bildverdeckung bearbeiten (Lernkarten)" }).click();
  const editor = page.getByRole("dialog", { name: "Bildverdeckung bearbeiten" });
  await expect(editor.locator(".occlusion-edit-layer")).toBeVisible();
  return editor;
}
// A point of the picture (proportions) on the screen.
async function at(page: Page, x: number, y: number) {
  const box = (await page.locator(".occlusion-edit-layer").boundingBox())!;
  return { x: box.x + box.width * x, y: box.y + box.height * y };
}

test("the mask editor: drawing, moving, resizing, keyboard, groups, labels and mode", async ({ page }, info) => {
  test.setTimeout(180_000);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const { pageId, rowId, total } = await occlusionRecord(page, `Bildverdeckung ${info.project.name} ${Date.now()}`);
  expect(await total()).toBe(0);
  const editor = await openEditor(page, pageId, rowId);
  await expect(editor).toContainText("Noch keine Masken");
  const mobile = info.project.name === "mobile";
  if (!mobile) {
    // A rectangle by dragging, an ellipse with its tool.
    let p = await at(page, 0.1, 0.2);
    await page.mouse.move(p.x, p.y);
    await page.mouse.down();
    p = await at(page, 0.32, 0.55);
    await page.mouse.move(p.x, p.y, { steps: 5 });
    await page.mouse.up();
    await editor.getByRole("radio", { name: "Ellipse" }).click();
    p = await at(page, 0.45, 0.58);
    await page.mouse.move(p.x, p.y);
    await page.mouse.down();
    p = await at(page, 0.7, 0.85);
    await page.mouse.move(p.x, p.y, { steps: 5 });
    await page.mouse.up();
    await expect(editor.locator(".occlusion-list li")).toHaveCount(2);
    // Moved by dragging, resized at its lower right corner.
    p = await at(page, 0.57, 0.71);
    await page.mouse.move(p.x, p.y);
    await page.mouse.down();
    p = await at(page, 0.6, 0.71);
    await page.mouse.move(p.x, p.y, { steps: 4 });
    await page.mouse.up();
    const handle = (await editor.locator(".occlusion-handle.corner-2").boundingBox())!;
    await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
    await page.mouse.down();
    await page.mouse.move(handle.x + 30, handle.y + 20, { steps: 4 });
    await page.mouse.up();
  } else {
    // On a phone: a polygon by tapping its corners, then "Polygon fertig".
    await editor.getByRole("radio", { name: "Polygon (Ecken antippen)" }).click();
    for (const [x, y] of [
      [0.42, 0.12],
      [0.62, 0.12],
      [0.62, 0.42],
      [0.42, 0.42],
    ]) {
      const p = await at(page, x, y);
      await page.touchscreen.tap(p.x, p.y);
    }
    await editor.getByRole("button", { name: "Polygon fertig" }).click();
    await expect(editor.locator(".occlusion-list li")).toHaveCount(1);
    await expect(editor.locator(".occlusion-edit-mask polygon")).toHaveCount(1);
  }
  // The keyboard: a mask added in the middle, moved with the arrow keys.
  await editor.getByRole("button", { name: "Maske hinzufügen" }).click();
  const count = mobile ? 2 : 3;
  await expect(editor.locator(".occlusion-list li")).toHaveCount(count);
  const before = await editor.locator(".occlusion-edit-mask.selected rect").first().getAttribute("x");
  await editor.locator(".occlusion-edit-layer").focus();
  await page.keyboard.press("Shift+ArrowLeft");
  await expect.poll(async () => Number(await editor.locator(".occlusion-edit-mask.selected rect").first().getAttribute("x"))).toBeLessThan(Number(before));
  // Labels; two masks grouped into one card (chosen in the list – also on
  // touch screens; Escape ends the selection first, not the dialog).
  await editor.getByLabel("Beschriftung von Maske 1").fill("Nordregion");
  await page.keyboard.press("Escape");
  await expect(editor.locator(".occlusion-list li.selected")).toHaveCount(0);
  await editor.locator(".occlusion-pick").nth(count - 2).click();
  await editor.locator(".occlusion-pick").nth(count - 1).click();
  await editor.getByRole("button", { name: "Gruppieren", exact: true }).click();
  await expect(editor).toContainText(`${count} Masken · ${count - 1} Karten`);
  await editor.getByLabel("Eine verdecken, Rest sichtbar").check();
  await editor.getByLabel("Alternativtext des Bildes").fill("Karte mit fünf Regionen");
  // The preview of a card: covered, then revealed.
  await editor.getByRole("button", { name: "Vorschau der Karte" }).click();
  await expect(editor.locator(".occlusion-preview .occlusion-mask.asked").first()).toBeVisible();
  await editor.getByRole("button", { name: "Aufdecken" }).click();
  await expect(editor.locator(".occlusion-preview .occlusion-mask.open").first()).toBeVisible();
  await editor.getByRole("button", { name: "Vorschau der Karte" }).click();
  await page.keyboard.press("Escape");
  await editor.locator(".occlusion-pick").first().click();
  await expect(editor.locator(".occlusion-handle")).toHaveCount(4);
  await shot(page, "editor", info.project.name);
  // Undo and redo.
  await page.keyboard.press("Control+z");
  await page.keyboard.press("Control+Shift+z");
  await editor.getByRole("button", { name: "Speichern" }).click();
  await expect(editor).toBeHidden();
  // The cards follow once the document is saved.
  await expect.poll(total, { timeout: 30_000 }).toBe(count - 1);
  // Opened again: the masks are there.
  await page.keyboard.press("Escape");
  const again = await openEditor(page, pageId, rowId);
  await expect(again.locator(".occlusion-list li")).toHaveCount(count);
  await expect(again.getByLabel("Beschriftung von Maske 1")).toHaveValue("Nordregion");
  await expect(again.getByLabel("Eine verdecken, Rest sichtbar")).toBeChecked();
  await again.getByRole("button", { name: "Abbrechen" }).click();
  expect(errors).toEqual([]);
});

test("an image occlusion card in the focus mode: covered, highlighted, revealed", async ({ page }, info) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const masks = {
    v: 1,
    mode: "hide-all",
    masks: [
      { id: "0a000000-0000-4000-8000-000000000001", shape: "ellipse", x: 0.07, y: 0.17, w: 0.28, h: 0.44, label: "Nordregion" },
      { id: "0a000000-0000-4000-8000-000000000002", shape: "rect", x: 0.39, y: 0.11, w: 0.24, h: 0.32, label: "Hochland" },
      { id: "0a000000-0000-4000-8000-000000000003", shape: "rect", x: 0.69, y: 0.19, w: 0.24, h: 0.24, group: "0b000000-0000-4000-8000-000000000001", label: "Küste" },
      { id: "0a000000-0000-4000-8000-000000000004", shape: "polygon", x: 0, y: 0, w: 0, h: 0, points: [[0.07, 0.69], [0.33, 0.69], [0.33, 0.89], [0.07, 0.89]], group: "0b000000-0000-4000-8000-000000000001" },
    ],
  };
  const { pageId, total } = await occlusionRecord(page, `Bildkarten ${info.project.name} ${Date.now()}`, masks);
  expect(await total()).toBe(3);
  await page.goto(`/#page=${pageId}`);
  await page.getByRole("button", { name: "Lernen starten" }).click();
  const focus = page.getByRole("dialog", { name: /^Lernen: / });
  const card = focus.locator(".occlusion-card");
  await expect(card.locator(".occlusion-mask.asked").first()).toBeVisible({ timeout: 30_000 });
  // Cover all: the others covered too, only the card's highlighted.
  await expect(card.locator(".occlusion-mask")).toHaveCount(4);
  await expect(card.locator("figcaption")).toHaveText(/^Bild: Karte mit fünf Regionen\. Bereich \d von 3 verdeckt\.$/);
  await expect(focus.locator(".study-context")).toContainText("Welche Region ist markiert?");
  await shot(page, "card", info.project.name);
  // Revealed (a tap on a phone, Space elsewhere): opened, the label is the answer.
  if (info.project.name === "mobile") await card.tap();
  else await page.keyboard.press("Space");
  await expect(card.locator(".occlusion-mask.open").first()).toBeVisible();
  await expect(card.locator("figcaption")).toContainText("aufgedeckt");
  await expect(focus.locator(".occlusion-answer")).toHaveText(/Nordregion|Hochland|Küste/);
  await expect(focus.locator(".study-extra")).toContainText("Atlas, Seite 12");
  await expect(focus.locator('.sr-only[aria-live="polite"]')).toContainText(/Antwort: (Nordregion|Hochland|Küste)/);
  await shot(page, "card-revealed", info.project.name);
  await focus.getByRole("button", { name: /^Gut/ }).click();
  // The record's other cards wait for tomorrow (siblings); this one comes
  // back in its learning step, covered again.
  await expect(focus.locator(".study-count-chip.learning")).toHaveText("Lernen 1", { timeout: 30_000 });
  await expect(card.locator(".occlusion-mask.open")).toHaveCount(0);
  expect(errors).toEqual([]);
});
