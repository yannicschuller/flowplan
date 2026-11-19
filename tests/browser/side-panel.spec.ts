import { test, expect, type CDPSession, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { samplePdf } from "../helpers/pdf";

// The docked side panel (#392, components/side-panel.tsx): a record of a
// timeline beside the view (the view narrows, another bar switches the
// record, ↑/↓, Escape, the width kept), on phones a page of its own; a PDF
// beside a document or notebook (components/pdf-panel.tsx) with the shared
// annotations of the viewer, and a region taken with the lasso into the
// page beside it as a picture whose caption leads back to the PDF page.
// SIDE_PANEL_SCREENSHOTS=<dir> saves pictures of each state.
test.use({ hasTouch: true });

const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
const shots = process.env.SIDE_PANEL_SCREENSHOTS || "";
type Point = { x: number; y: number };

// The document state for some HTML (lib/document-server.ts), built in a
// child process: Playwright's own module loader cannot load sanitize-html.
const htmlUpdate = (html: string) =>
  execFileSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "--input-type=module",
      "-e",
      `import { htmlState } from "./lib/document-server.ts"; process.stdout.write(Buffer.from(htmlState(${JSON.stringify(html)})).toString("base64"));`,
    ],
    { cwd: new URL("../..", import.meta.url).pathname, stdio: ["ignore", "pipe", "ignore"] },
  ).toString();

async function pen(cdp: CDPSession, points: Point[]) {
  const base = { pointerType: "pen" as const, button: "left" as const, buttons: 1 };
  await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: points[0].x, y: points[0].y, clickCount: 1, force: 0.4, ...base });
  for (const p of points.slice(1)) await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: p.x, y: p.y, force: 0.5, ...base });
  const last = points[points.length - 1];
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: last.x, y: last.y, clickCount: 1, ...base });
}
const path = (from: Point, to: Point, steps = 12) =>
  Array.from({ length: steps + 1 }, (_, i) => ({ x: from.x + ((to.x - from.x) * i) / steps, y: from.y + ((to.y - from.y) * i) / steps + Math.sin(i) * 5 }));
// A diagonal mouse drag: the lasso takes the box as a rectangle.
async function drag(page: Page, from: Point, to: Point) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 8 });
  await page.mouse.up();
}
async function shoot(page: Page, name: string, project: string) {
  if (!shots) return;
  for (const scheme of ["light", "dark"] as const) {
    await page.evaluate((s) => (document.documentElement.dataset.theme = s), scheme);
    await page.waitForTimeout(250);
    await page.screenshot({ path: `${shots}/${name}-${project}-${scheme}.png` });
  }
  await page.evaluate(() => (document.documentElement.dataset.theme = "light"));
}

async function setup(page: Page) {
  await page.request.post("/api/auth/demo", { headers: { origin } });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const command = async (data: Record<string, unknown>) => {
    const response = await page.request.post("/api/command", { headers: { origin }, data });
    if (!response.ok()) throw new Error(await response.text());
    return response.json();
  };
  await command({ action: "profile.onboarded" });
  const create = async (title: string, kind: string) =>
    (await command({ action: "page.create", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, title, kind })).id as string;
  const upload = async (pageId: string, name: string, lines: string[]) => {
    const uploaded = await page.request.post("/api/upload", {
      headers: { origin },
      multipart: { pageId, file: { name, mimeType: "application/pdf", buffer: samplePdf(lines) } },
    });
    return (await uploaded.json()) as { id: string; url: string };
  };
  return { boot, command, create, upload };
}

test("timeline records dock beside the view: switch, ↑/↓, Escape, width kept; phones get the page", async ({ page }, info) => {
  const mobile = info.project.name === "mobile";
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const { command, create } = await setup(page);
  const id = await create(`Projektplan ${Date.now()}`, "database");
  await command({
    action: "database.update",
    pageId: id,
    version: 1,
    fields: [
      { id: "title", name: "Name", type: "text" },
      { id: "start", name: "Beginn", type: "date" },
      { id: "end", name: "Ende", type: "date" },
    ],
    views: [{ id: "timeline", name: "Timeline", type: "timeline", filters: [], sorts: [], dateField: "start", endDateField: "end", recordOpen: "side", timeline: { scale: "month", showWeekends: true } }],
  });
  const rows: string[] = [];
  for (const [title, start, end] of [["Entwurf", "2026-11-02", "2026-11-12"], ["Prüfung", "2026-11-10", "2026-11-20"], ["Abgabe", "2026-11-24", "2026-11-25"]])
    rows.push((await command({ action: "row.create", pageId: id, cells: { title, start, end } })).id);
  await page.goto(`/#page=${id}`);
  const timeline = page.getByRole("region", { name: "Timeline", exact: true });
  await expect(timeline).toBeVisible({ timeout: 30_000 });
  const name = (row: string) => page.locator(`.timeline-entry[data-row-id="${row}"] .timeline-name`);
  if (mobile) {
    // Too narrow to dock: the record as a page of its own, not the overlay.
    await name(rows[0]).click();
    await expect(page.locator(".record-page")).toBeVisible();
    await expect(page.locator(".side-panel")).toHaveCount(0);
    await expect(page.locator(".modal.modal-side")).toHaveCount(0);
    await shoot(page, "record-phone-page", info.project.name);
    expect(errors).toEqual([]);
    return;
  }
  const before = (await timeline.boundingBox())!.width;
  await name(rows[0]).click();
  const panel = page.getByRole("complementary", { name: "Eintrag „Entwurf“" });
  await expect(panel).toBeVisible();
  await expect(page.locator(".app-shell")).toHaveClass(/side-dock-open/);
  // The view narrows to the room left; nothing lies over it.
  await expect.poll(async () => (await timeline.boundingBox())!.width).toBeLessThan(before - 300);
  await expect(page.locator(".modal.modal-side")).toHaveCount(0);
  await expect(page.locator(`.timeline-entry[data-row-id="${rows[0]}"]`)).toHaveAttribute("data-docked", "");
  await shoot(page, "record-docked", info.project.name);
  // Another bar's record replaces it; the view stays clickable.
  await name(rows[1]).click();
  await expect(page.getByRole("complementary", { name: "Eintrag „Prüfung“" })).toBeVisible();
  // ↑/↓: the record before or after it in the view.
  await page.keyboard.press("ArrowDown");
  await expect(page.getByRole("complementary", { name: "Eintrag „Abgabe“" })).toBeVisible();
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("ArrowUp");
  await expect(page.getByRole("complementary", { name: "Eintrag „Entwurf“" })).toBeVisible();
  // The width: dragged (here with the keyboard) and kept after a reload.
  const handle = page.getByRole("separator", { name: "Breite des Seitenfensters" });
  const wide = (await page.locator(".side-panel").boundingBox())!.width;
  await handle.focus();
  for (let i = 0; i < 4; i++) await page.keyboard.press("Shift+ArrowLeft");
  await expect.poll(async () => (await page.locator(".side-panel").boundingBox())!.width).toBeGreaterThan(wide + 150);
  const dragged = Math.round((await page.locator(".side-panel").boundingBox())!.width);
  // Escape closes it, the view gets its width back.
  await page.locator(".side-panel-heading").focus();
  await page.keyboard.press("Escape");
  await expect(page.locator(".side-panel")).toHaveCount(0);
  await expect.poll(async () => (await timeline.boundingBox())!.width).toBeGreaterThan(before - 5);
  await page.reload();
  await expect(timeline).toBeVisible({ timeout: 30_000 });
  await name(rows[2]).click();
  await expect(page.getByRole("complementary", { name: "Eintrag „Abgabe“" })).toBeVisible();
  await expect.poll(async () => Math.round((await page.locator(".side-panel").boundingBox())!.width)).toBe(dragged);
  // ×: closed.
  await page.getByRole("button", { name: "Seitenfenster schließen" }).click();
  await expect(page.locator(".side-panel")).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("a PDF beside a document: shared annotations, page and zoom kept while writing, a region into the text", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "Pen and the mouse lasso run on the desktop project.");
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const { command, create, upload, boot } = await setup(page);
  const id = await create(`Mitschrift ${Date.now()}`, "document");
  const { url } = await upload(id, "Vertrag.pdf", ["Seite eins", "Seite zwei"]);
  const data = await (await page.request.get(`/api/pages/${id}`)).json();
  await command({
    action: "document.sync",
    workspaceId: boot.workspace.id,
    pageId: id,
    generation: data.generation,
    update: htmlUpdate(`<p>Notizen zum Vertrag</p><div data-pdf="${url}" data-title="Vertrag.pdf" class="pdf-block"><a href="${url}">Vertrag.pdf</a></div><p>Ende</p>`),
  });
  await page.goto(`/#page=${id}`);
  const editor = page.getByLabel("Dokumentinhalt", { exact: true });
  const card = editor.getByRole("button", { name: "PDF „Vertrag.pdf“ öffnen" });
  await expect(card).toBeVisible({ timeout: 30_000 });
  // Right-click: "Im Seitenfenster öffnen".
  await card.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Im Seitenfenster öffnen" }).click();
  const panel = page.getByRole("complementary", { name: "PDF „Vertrag.pdf“ im Seitenfenster" });
  await expect(panel).toBeVisible();
  await expect(panel.locator(".pdf-page-wrap .ink-layer")).toHaveCount(2, { timeout: 15_000 });
  await expect.poll(() => panel.locator("canvas.pdf-page").first().evaluate((c: HTMLCanvasElement) => c.width), { timeout: 15_000 }).toBeGreaterThan(200);
  // The pen is ready at once for who may edit the annotations.
  await expect(panel.getByRole("button", { name: "Anmerken" })).toHaveAttribute("aria-pressed", "true");
  const tools = panel.getByRole("toolbar", { name: "Werkzeuge zum Anmerken" });
  await expect(tools.getByRole("radio", { name: "Stift", exact: true })).toHaveAttribute("aria-checked", "true");
  const cdp = await page.context().newCDPSession(page);
  const first = (await panel.locator('.pdf-page-wrap[data-page="1"]').boundingBox())!;
  await pen(cdp, path({ x: first.x + 40, y: first.y + 80 }, { x: first.x + 220, y: first.y + 120 }));
  await expect(panel.locator('.pdf-page-wrap[data-page="1"] .ink-strokes > g[clip-path] > path:not(.ink-draft):not(.ink-lasso)')).toHaveCount(1);
  // Saved as written: the PDF's own annotations, those of the viewer.
  await expect(tools.getByRole("status")).toHaveText("Gespeichert", { timeout: 10_000 });
  await expect.poll(async () => ((await (await page.request.get(`${url}/ink`)).json()).doc.pages["1"] || []).length, { timeout: 10_000 }).toBe(1);
  await shoot(page, "pdf-panel-document", info.project.name);

  // Zoom in, then write in the document: the panel keeps its zoom.
  await panel.getByRole("button", { name: "Vergrößern" }).click();
  await expect(panel.getByText("125 %")).toBeVisible();
  await editor.getByText("Notizen zum Vertrag").click();
  await page.keyboard.press("End");
  await page.keyboard.type(" – Frist prüfen");
  await expect(editor).toContainText("Notizen zum Vertrag – Frist prüfen");
  await expect(panel.getByText("125 %")).toBeVisible();
  await panel.getByRole("button", { name: "An Breite anpassen" }).click();

  // A region with the lasso: a picture in the text, its caption the PDF page.
  await panel.getByRole("button", { name: "Bereich" }).click();
  const page1 = (await panel.locator('.pdf-page-wrap[data-page="1"]').boundingBox())!;
  await drag(page, { x: page1.x + 20, y: page1.y + 20 }, { x: page1.x + page1.width - 40, y: page1.y + 140 });
  const insert = panel.getByRole("button", { name: "Einfügen" });
  await expect(insert).toBeEnabled({ timeout: 10_000 });
  await shoot(page, "pdf-panel-region", info.project.name);
  await insert.click();
  const caption = editor.getByRole("link", { name: "Vertrag.pdf, S. 1" });
  await expect(caption).toBeVisible({ timeout: 15_000 });
  await expect(caption).toHaveAttribute("href", `${url}#pdf-page=1`);
  await expect(editor.locator("img")).toHaveCount(1);
  // Escape closes the panel; the caption opens it again (also while editing).
  await panel.locator(".side-panel-heading").focus();
  await page.keyboard.press("Escape");
  await expect(panel).toHaveCount(0);
  await caption.click();
  await expect(page.getByRole("complementary", { name: /Vertrag\.pdf/ })).toBeVisible();
  // The viewer shows the same annotations.
  await page.getByRole("button", { name: "Seitenfenster schließen" }).click();
  await card.click();
  const viewer = page.getByRole("dialog", { name: "Vertrag.pdf" });
  await expect(viewer.locator('.pdf-page-wrap[data-page="1"] .ink-strokes > g[clip-path] > path:not(.ink-draft):not(.ink-lasso)')).toHaveCount(1, { timeout: 15_000 });
  expect(errors).toEqual([]);
});

test("a PDF attached to a notebook: the strip, the panel beside the sheets, a region into a sheet", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "The mouse lasso and dragging run on the desktop project.");
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const { create } = await setup(page);
  const id = await create(`Seminar ${Date.now()}`, "notebook");
  await page.goto(`/#page=${id}`);
  await expect(page.locator(".notebook-sheet")).toHaveCount(1, { timeout: 30_000 });
  const controls = page.getByRole("toolbar", { name: "Notizbuch" });
  await controls.getByRole("button", { name: "Weitere Aktionen" }).click();
  await page.getByRole("menuitem", { name: "PDF einfügen …" }).click();
  await page.getByRole("radio", { name: /Als Anhang/ }).check();
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "PDF wählen …" }).click();
  await (await chooser).setFiles({ name: "Skript.pdf", mimeType: "application/pdf", buffer: samplePdf(["Kapitel eins", "Kapitel zwei"]) });
  // Whole, beside the sheets: no new sheets, a strip, the panel opened.
  const strip = page.getByRole("group", { name: "Anhänge" });
  await expect(strip.getByRole("button", { name: "„Skript.pdf“ im Seitenfenster öffnen" })).toBeVisible({ timeout: 20_000 });
  await expect(page.locator(".notebook-sheet")).toHaveCount(1);
  const panel = page.getByRole("complementary", { name: "PDF „Skript.pdf“ im Seitenfenster" });
  await expect(panel.locator(".pdf-page-wrap .ink-layer")).toHaveCount(2, { timeout: 15_000 });
  await expect.poll(() => panel.locator("canvas.pdf-page").first().evaluate((c: HTMLCanvasElement) => c.width), { timeout: 15_000 }).toBeGreaterThan(200);
  // The notebook was worked in last: "Einfügen" goes onto its sheet.
  await page.locator(".notebook-sheet").first().click({ position: { x: 5, y: 5 } }).catch(() => {});
  await panel.getByRole("button", { name: "Bereich" }).click();
  const page1 = (await panel.locator('.pdf-page-wrap[data-page="1"]').boundingBox())!;
  await drag(page, { x: page1.x + 20, y: page1.y + 20 }, { x: page1.x + page1.width - 40, y: page1.y + 160 });
  await expect(panel.getByRole("button", { name: "Einfügen" })).toBeEnabled({ timeout: 10_000 });
  await panel.getByRole("button", { name: "Einfügen" }).click();
  const sheet = page.locator(".notebook-sheet").first();
  await expect(sheet.locator(".ink-layer image")).toHaveCount(1, { timeout: 15_000 });
  const chip = sheet.getByRole("link", { name: "Skript.pdf, S. 1" }).first();
  await expect(chip).toBeVisible();
  await shoot(page, "pdf-panel-notebook", info.project.name);
  // Saved with its source: the PDF page it came from.
  await expect
    .poll(
      async () => {
        const data = await (await page.request.get(`/api/pages/${id}`)).json();
        const items = data.notebook.sheets[0].ink.pages[data.notebook.sheets[0].id] || [];
        return items.find((i: { type: string }) => i.type === "image")?.source?.page ?? 0;
      },
      { timeout: 15_000 },
    )
    .toBe(1);
  // A second region dragged onto the sheet.
  await drag(page, { x: page1.x + 30, y: page1.y + 200 }, { x: page1.x + page1.width - 60, y: page1.y + 300 });
  const region = panel.locator(".pdf-region.is-ready");
  await expect(region).toBeVisible({ timeout: 10_000 });
  await region.dragTo(sheet, { targetPosition: { x: 200, y: 500 } });
  await expect(sheet.locator(".ink-layer image")).toHaveCount(2, { timeout: 15_000 });
  // The caption opens the panel at that page (here: it is open already).
  await page.getByRole("button", { name: "Seitenfenster schließen" }).click();
  await expect(panel).toHaveCount(0);
  await chip.click();
  await expect(page.getByRole("complementary", { name: /Skript\.pdf/ })).toBeVisible();
  expect(errors).toEqual([]);
});

test("phones: a long press on a PDF opens the menu, the panel is a bottom sheet", async ({ page }, info) => {
  test.skip(info.project.name !== "mobile", "The sheet is for phones.");
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const { command, create, upload, boot } = await setup(page);
  const id = await create(`Unterwegs ${Date.now()}`, "document");
  const { url } = await upload(id, "Fahrplan.pdf", ["Linie 1", "Linie 2"]);
  const data = await (await page.request.get(`/api/pages/${id}`)).json();
  await command({
    action: "document.sync",
    workspaceId: boot.workspace.id,
    pageId: id,
    generation: data.generation,
    update: htmlUpdate(`<p>Abfahrt</p><div data-pdf="${url}" data-title="Fahrplan.pdf" class="pdf-block"><a href="${url}">Fahrplan.pdf</a></div>`),
  });
  await page.goto(`/#page=${id}`);
  const card = page.getByLabel("Dokumentinhalt", { exact: true }).getByRole("button", { name: "PDF „Fahrplan.pdf“ öffnen" });
  await expect(card).toBeVisible({ timeout: 30_000 });
  const box = (await card.boundingBox())!;
  const cdp = await page.context().newCDPSession(page);
  const at = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [at] });
  await page.waitForTimeout(800);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await page.getByRole("menuitem", { name: "Im Seitenfenster öffnen" }).tap();
  const panel = page.getByRole("complementary", { name: "PDF „Fahrplan.pdf“ im Seitenfenster" });
  await expect(panel).toBeVisible();
  // No viewer came up from the held finger.
  await expect(page.getByRole("dialog", { name: "Fahrplan.pdf" })).toHaveCount(0);
  await expect(panel).toHaveClass(/is-sheet/);
  const sheet = (await panel.boundingBox())!;
  expect(sheet.y).toBeGreaterThan(200);
  expect(Math.round(sheet.width)).toBe(390);
  await expect(panel.locator(".pdf-page-wrap .ink-layer")).toHaveCount(2, { timeout: 15_000 });
  await shoot(page, "pdf-panel-phone", info.project.name);
  await panel.getByRole("button", { name: "Seitenfenster schließen" }).tap();
  await expect(panel).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("published timelines on wide windows: the record beside the view; narrow windows open its page", async ({ page, browser }, info) => {
  const mobile = info.project.name === "mobile";
  const { command, create } = await setup(page);
  const id = await create(`Öffentlicher Plan ${Date.now()}`, "database");
  await command({
    action: "database.update",
    pageId: id,
    version: 1,
    fields: [
      { id: "title", name: "Name", type: "text" },
      { id: "start", name: "Beginn", type: "date" },
      { id: "end", name: "Ende", type: "date" },
    ],
    views: [{ id: "timeline", name: "Timeline", type: "timeline", filters: [], sorts: [], dateField: "start", endDateField: "end", timeline: { scale: "month", showWeekends: true } }],
  });
  for (const [title, start, end] of [["Entwurf", "2026-11-02", "2026-11-12"], ["Prüfung", "2026-11-10", "2026-11-20"]])
    await command({ action: "row.create", pageId: id, cells: { title, start, end } });
  await command({ action: "page.publish", pageId: id, enabled: true });
  const token = (await (await page.request.get(`/api/pages/${id}`)).json()).page.public_token;
  const context = await browser.newContext(mobile ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } : { viewport: { width: 1440, height: 1000 } });
  const visitor = await context.newPage();
  const errors: string[] = [];
  visitor.on("pageerror", (e) => errors.push(e.message));
  await visitor.goto(`${origin}/share/${token}`);
  const entry = visitor.locator(".timeline-entry .timeline-name", { hasText: "Entwurf" });
  await expect(entry).toBeVisible({ timeout: 20_000 });
  await entry.click();
  if (mobile) {
    // Narrow: the record's own page, with its way back.
    await expect(visitor).toHaveURL(/[?&]row=/);
    await expect(visitor.locator(".side-panel")).toHaveCount(0);
  } else {
    const panel = visitor.getByRole("complementary", { name: "Eintrag „Entwurf“" });
    await expect(panel).toBeVisible();
    await expect(panel.locator(".public-record-body h1")).toHaveText("Entwurf");
    // The page stays where it is.
    expect(visitor.url()).not.toMatch(/row=/);
    await shoot(visitor, "record-published", info.project.name);
    await visitor.keyboard.press("ArrowDown");
    await expect(visitor.getByRole("complementary", { name: "Eintrag „Prüfung“" })).toBeVisible();
    await visitor.keyboard.press("Escape");
    await expect(visitor.locator(".side-panel")).toHaveCount(0);
  }
  expect(errors).toEqual([]);
  await context.close();
});
