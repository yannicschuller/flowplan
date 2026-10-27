import { test, expect, type Page } from "@playwright/test";

// Diagrams on whiteboards: shape library, Mermaid import, auto layout,
// "Als Mermaid kopieren", clickable prototypes and the timeline element.
const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
const shots = process.env.WB_DIAGRAM_SCREENSHOTS;
async function setup(page: Page, title: string) {
  await page.request.post("/api/auth/demo", { headers: { origin } });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const command = async (data: Record<string, unknown>) => {
    const r = await page.request.post("/api/command", { headers: { origin }, data });
    expect(r.ok(), await r.text()).toBe(true);
    return r.json();
  };
  // Past the introduction new accounts see first.
  await command({ action: "profile.onboarded", workspaceId: boot.workspace.id });
  const board = await command({ action: "page.create", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, title, kind: "whiteboard" });
  return { boot, command, board };
}
const FLOW = `flowchart TD
  subgraph Start [Startseite]
    A([Los]) --> B{Angemeldet?}
  end
  subgraph Ziel [Konto]
    C[Profil]
  end
  B -->|Ja| C
  click A callback`;

test("shape library, Mermaid import, auto layout, copy as Mermaid and a clickable prototype", async ({ page, context }, info) => {
  test.skip(info.project.name === "mobile", "Desktop panels and pointer gestures");
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin });
  const { board } = await setup(page, `Diagramme ${Date.now()}`);
  await page.goto(`/#page=${board.id}`);
  const wb = page.getByLabel("Whiteboard", { exact: true });
  await expect(wb.locator(".wb-canvas")).toBeVisible();

  // Shape library: search in German, insert with Enter, then by click.
  await wb.getByRole("button", { name: "Formenbibliothek", exact: true }).click();
  const library = wb.getByRole("dialog", { name: "Formenbibliothek" });
  await expect(library).toBeVisible();
  await library.getByRole("searchbox", { name: "Formen suchen" }).fill("Gateway");
  await expect(library.getByRole("button", { name: "Exklusives Gateway" })).toBeVisible();
  await expect(library.getByRole("button", { name: "Prozess", exact: true })).toHaveCount(0);
  await library.getByRole("searchbox", { name: "Formen suchen" }).press("Enter");
  await expect(wb.locator('[data-lib^="bpmn:gateway"]')).toHaveCount(1);
  await library.getByRole("radio", { name: "UML" }).click();
  await library.getByRole("searchbox", { name: "Formen suchen" }).fill("");
  await library.getByRole("button", { name: "Klasse", exact: true }).click();
  await expect(wb.locator('[data-lib="uml:class"]')).toHaveCount(1);
  await expect(wb.locator('[data-lib="uml:class"]')).toContainText("Kunde");
  if (shots) await page.screenshot({ path: `${shots}/desktop-library-light.png` });
  await library.getByRole("button", { name: "Formenbibliothek schließen" }).click();
  await expect(library).toHaveCount(0);
  // Clear the board for the diagram.
  await wb.locator(".wb-canvas").click({ position: { x: 500, y: 40 } });
  await wb.focus();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.press("Delete");
  await expect(wb.locator(".wb-item")).toHaveCount(0);

  // Mermaid import: preview, skipped line, editable shapes and frames.
  await wb.getByRole("button", { name: "Mermaid/PlantUML importieren …" }).click();
  const dialog = page.getByRole("dialog", { name: "Diagramm importieren" });
  await dialog.getByLabel("Diagrammtext").fill(FLOW);
  await expect(dialog.getByRole("status")).toContainText("Mermaid · Flussdiagramm · 3 Elemente");
  await expect(dialog.getByRole("status")).toContainText("Zeile 9: click A callback");
  await dialog.getByRole("button", { name: "Importieren", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(wb.locator('[data-lib="flow:terminator"]')).toContainText("Los");
  await expect(wb.locator('[data-lib="flow:decision"]')).toContainText("Angemeldet?");
  await expect(wb.locator(".wb-connector")).toHaveCount(2);
  await expect(wb.locator(".wb-frame")).toHaveCount(2);
  // Broken text: the dialog explains it.
  await wb.getByRole("button", { name: "Mermaid/PlantUML importieren …" }).click();
  await dialog.getByLabel("Diagrammtext").fill("gantt\n  title Plan");
  await expect(dialog.getByRole("status")).toContainText("lässt sich nicht als bearbeitbares Diagramm übernehmen");
  await expect(dialog.getByRole("button", { name: "Importieren", exact: true })).toBeDisabled();
  await dialog.getByRole("button", { name: "Abbrechen" }).click();

  // Auto layout left to right, one undo step.
  const pos = async (lib: string) => (await wb.locator(`[data-lib="${lib}"]`).boundingBox())!;
  const before = await pos("flow:decision");
  const start = await pos("flow:terminator");
  expect(before.y).toBeGreaterThan(start.y + start.height - 2);
  // The import leaves its items selected; start from an empty selection.
  await page.keyboard.press("Escape");
  await wb.locator('[data-lib="flow:terminator"]').click();
  await page.keyboard.down("Shift");
  await wb.locator('[data-lib="flow:decision"]').click();
  await wb.locator('[data-lib="flow:process"]').click();
  await page.keyboard.up("Shift");
  await wb.getByRole("button", { name: "Automatisch anordnen" }).click();
  await wb.getByRole("menuitem", { name: "Von links nach rechts" }).click();
  await expect.poll(async () => (await pos("flow:decision")).x).toBeGreaterThan(start.x + start.width - 2);
  const after = await pos("flow:decision");
  expect(Math.abs(after.y + after.height / 2 - ((await pos("flow:terminator")).y + (await pos("flow:terminator")).height / 2))).toBeLessThan(3);
  await page.keyboard.press("ControlOrMeta+z");
  await expect.poll(async () => Math.round((await pos("flow:decision")).x)).toBe(Math.round(before.x));

  // Copy as Mermaid.
  await wb.locator(".wb-canvas").click({ position: { x: 500, y: 40 } });
  await wb.getByRole("button", { name: "Als Mermaid kopieren" }).click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toContain("flowchart");
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  expect(copied).toContain('(["Los"])');
  expect(copied).toContain('{"Angemeldet?"}');
  expect(copied).toMatch(/-->\|"Ja"\|/);

  // Prototype: the start button leads to the account frame.
  await wb.locator('[data-lib="flow:terminator"]').click();
  await wb.getByRole("combobox", { name: "Bei Klick" }).selectOption({ label: "Bei Klick → Konto" });
  await expect(wb.locator(".wb-link-badges circle")).toHaveCount(1);
  await wb.locator('[data-lib="flow:process"]').click();
  await wb.getByRole("combobox", { name: "Bei Klick" }).selectOption({ label: "Bei Klick → zurück" });
  await expect(wb.locator(".wb-link-badges circle")).toHaveCount(2);
  await wb.locator(".wb-canvas").click({ position: { x: 500, y: 40 } });
  await wb.getByRole("button", { name: "Prototyp abspielen" }).click();
  const player = page.getByRole("dialog", { name: "Prototyp" });
  await expect(player).toBeVisible();
  await expect(player.locator(".wb-player-bar strong")).toHaveText("Startseite");
  if (shots) await page.screenshot({ path: `${shots}/desktop-prototype.png` });
  await player.getByRole("button", { name: "Gehe zu Konto" }).click();
  await expect(player.locator(".wb-player-bar strong")).toHaveText("Konto");
  await player.getByRole("button", { name: "Gehe zu Zurück" }).press("Enter");
  await expect(player.locator(".wb-player-bar strong")).toHaveText("Startseite");
  await player.getByRole("button", { name: "Gehe zu Konto" }).click();
  await player.getByRole("button", { name: "Neu starten" }).click();
  await expect(player.locator(".wb-player-bar strong")).toHaveText("Startseite");
  await page.keyboard.press("Escape");
  await expect(player).toHaveCount(0);

  // The SVG export draws the library shapes.
  const download = page.waitForEvent("download");
  await wb.getByRole("button", { name: "Als SVG exportieren" }).click();
  const file = await (await download).path();
  const svg = (await import("node:fs")).readFileSync(file!, "utf8");
  expect(svg).toContain("Angemeldet?");
  expect(errors).toEqual([]);
});

test("timeline: insert, edit, drag a bar, undo", async ({ page }, info) => {
  test.skip(info.project.name === "mobile", "Desktop pointer gestures");
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const { board } = await setup(page, `Roadmap ${Date.now()}`);
  await page.goto(`/#page=${board.id}`);
  const wb = page.getByLabel("Whiteboard", { exact: true });
  await expect(wb.locator(".wb-canvas")).toBeVisible();
  await wb.getByRole("button", { name: "Zeitleiste", exact: true }).click();
  const timeline = wb.locator(".wb-item.wb-timeline");
  await expect(timeline).toHaveCount(1);
  await expect(timeline).toContainText("Roadmap");
  await expect(timeline).toContainText("Team A");
  await expect(timeline.locator(".wb-timeline-bar")).toHaveCount(2);
  // Today is marked.
  await expect(timeline.locator('path[stroke="#e03131"]')).toHaveCount(1);

  // Drag the first bar a week to the right while the timeline is selected.
  const bar = timeline.locator(".wb-timeline-bar").first();
  const title = async () => (await bar.locator("title").textContent()) || "";
  const was = await title();
  const box = (await bar.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 60, box.y + box.height / 2, { steps: 6 });
  await page.mouse.up();
  await expect.poll(title).not.toBe(was);
  await page.keyboard.press("ControlOrMeta+z");
  await expect.poll(title).toBe(was);

  // Editor: weeks, a new bar, a renamed lane.
  await wb.getByRole("button", { name: "Zeitleiste bearbeiten" }).click();
  const editor = page.getByRole("dialog", { name: "Zeitleiste bearbeiten" });
  await editor.getByLabel("Zeitskala").selectOption({ label: "Wochen" });
  await editor.getByRole("listitem").filter({ has: page.getByLabel("Name der Spur") }).first().getByLabel("Name der Spur").fill("Design");
  await editor.getByRole("button", { name: "Balken hinzufügen" }).click();
  await expect(editor.getByLabel("Titel des Balkens")).toHaveCount(3);
  await editor.getByLabel("Titel des Balkens").last().fill("Testphase");
  if (shots) await page.screenshot({ path: `${shots}/desktop-timeline-editor.png` });
  await page.keyboard.press("Escape");
  await expect(timeline).toContainText("Design");
  await expect(timeline).toContainText("KW");
  await expect(timeline.locator(".wb-timeline-bar")).toHaveCount(3);
  await expect(timeline.locator(".wb-timeline-bar").last().locator("title")).toContainText("Testphase");
  if (shots) {
    await page.screenshot({ path: `${shots}/desktop-timeline-light.png` });
    await page.emulateMedia({ colorScheme: "dark" });
    await wb.getByRole("button", { name: "Formenbibliothek", exact: true }).click();
    await page.screenshot({ path: `${shots}/desktop-timeline-library-dark.png` });
    await page.emulateMedia({ colorScheme: "light" });
  }
  expect(errors).toEqual([]);
});

test("phone: the shape library is a sheet", async ({ page }, info) => {
  test.skip(info.project.name !== "mobile", "Phone layout");
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const { board } = await setup(page, `Telefon ${Date.now()}`);
  await page.goto(`/#page=${board.id}`);
  const wb = page.getByLabel("Whiteboard", { exact: true });
  await expect(wb.locator(".wb-canvas")).toBeVisible();
  // The tools that do not fit sit in the "more" sheet.
  const direct = wb.getByRole("button", { name: "Formenbibliothek", exact: true });
  if (!(await direct.isVisible())) await wb.getByRole("button", { name: "Weitere Werkzeuge" }).click();
  await page.getByRole("button", { name: "Formenbibliothek", exact: true }).click();
  const sheet = page.getByRole("dialog", { name: "Formenbibliothek" });
  await expect(sheet).toBeVisible();
  const box = (await sheet.boundingBox())!;
  expect(box.width).toBeLessThanOrEqual(390);
  await sheet.getByRole("searchbox", { name: "Formen suchen" }).fill("Schaltfläche");
  if (shots) await page.screenshot({ path: `${shots}/phone-library.png` });
  await sheet.getByRole("button", { name: "Hauptschaltfläche" }).click();
  await expect(sheet).toHaveCount(0);
  await expect(wb.locator('[data-lib="wf:button-primary"], [data-lib^="wf:button"]')).toHaveCount(1);
  const scroll = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(scroll).toBeLessThanOrEqual(0);
  if (shots) await page.screenshot({ path: `${shots}/phone-board.png` });
  expect(errors).toEqual([]);
});
