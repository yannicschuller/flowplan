import { test, expect, type Page } from "@playwright/test";
import { DatabaseSync } from "node:sqlite";
import { randomUUID, randomBytes, createHash } from "node:crypto";
import { join } from "node:path";

const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
async function setup(page: Page, title: string) {
  await page.request.post("/api/auth/demo", { headers: { origin } });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const command = async (data: Record<string, unknown>) => {
    const r = await page.request.post("/api/command", { headers: { origin }, data });
    expect(r.ok(), await r.text()).toBe(true);
    return r.json();
  };
  const board = await command({ action: "page.create", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, title, kind: "whiteboard" });
  return { boot, command, board };
}

test("mind map, arranging, stamps, drawn shapes, hidden voting, symbols and record cards", async ({ page }, info) => {
  test.skip(info.project.name === "mobile", "Desktop pointer gestures");
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const { boot, command, board } = await setup(page, `Board-Extras ${Date.now()}`);
  const db = await command({ action: "page.create", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, title: `Aufgaben ${Date.now()}`, kind: "database", starterTemplate: "tasks" });
  await page.goto(`/#page=${board.id}`);
  const wb = page.getByLabel("Whiteboard", { exact: true });
  const canvas = wb.locator(".wb-canvas");
  const box = (await canvas.boundingBox())!;
  const at = (x: number, y: number) => ({ x: box.x + box.width / 2 + x, y: box.y + box.height / 2 + y });

  // Mind map: a note, Tab adds two branches, laid out to the right.
  await canvas.dblclick({ position: { x: box.width / 2 - 300, y: box.height / 2 } });
  await page.keyboard.type("Zentrale Idee");
  await page.keyboard.press("Escape");
  await page.keyboard.press("Tab");
  await expect(wb.locator("textarea.wb-editor")).toBeFocused();
  await page.keyboard.type("Ast eins");
  await page.keyboard.press("Escape");
  await expect(wb.locator(".wb-connector")).toHaveCount(1);
  // Back to the root: select it and add a second branch.
  await wb.locator(".wb-sticky", { hasText: "Zentrale Idee" }).click();
  await page.keyboard.press("Tab");
  await expect(wb.locator("textarea.wb-editor")).toBeFocused();
  await page.keyboard.type("Ast zwei");
  await page.keyboard.press("Escape");
  await expect(wb.locator(".wb-connector")).toHaveCount(2);
  const root = (await wb.locator(".wb-sticky", { hasText: "Zentrale Idee" }).boundingBox())!;
  const one = (await wb.locator(".wb-sticky", { hasText: "Ast eins" }).boundingBox())!;
  const two = (await wb.locator(".wb-sticky", { hasText: "Ast zwei" }).boundingBox())!;
  expect(one.x).toBeGreaterThan(root.x + root.width);
  expect(Math.abs(one.x - two.x)).toBeLessThan(2);
  expect(Math.abs((one.y + two.y + two.height) / 2 - (root.y + root.height / 2))).toBeLessThan(4);

  // Arrange: align the two branches left and stack them as a row.
  await page.keyboard.down("Shift");
  await wb.locator(".wb-sticky", { hasText: "Ast eins" }).click();
  await page.keyboard.up("Shift");
  await wb.getByRole("button", { name: "Anordnen" }).click();
  await wb.getByRole("menuitem", { name: "Als Zeile stapeln" }).click();
  const a = (await wb.locator(".wb-sticky", { hasText: "Ast eins" }).boundingBox())!;
  const b = (await wb.locator(".wb-sticky", { hasText: "Ast zwei" }).boundingBox())!;
  expect(Math.abs(a.y - b.y)).toBeLessThan(2);
  await page.keyboard.press("Escape");

  // Stamps on a note.
  await wb.getByRole("button", { name: "Stempel", exact: true }).click();
  await wb.getByRole("button", { name: "Stempel ⭐" }).click();
  const target = (await wb.locator(".wb-sticky", { hasText: "Zentrale Idee" }).boundingBox())!;
  await page.mouse.click(target.x + target.width / 2, target.y + target.height / 2);
  await expect(wb.locator(".wb-stamps")).toContainText("⭐");
  await page.keyboard.press("Escape");

  // A roughly drawn rectangle becomes a clean rectangle.
  await wb.getByRole("button", { name: "Stift", exact: true }).click();
  await wb.getByLabel("Formen erkennen").check();
  const start = at(150, 120);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  for (const [dx, dy] of [[160, 2], [162, 100], [2, 102], [0, 4]] as const)
    await page.mouse.move(start.x + dx, start.y + dy, { steps: 8 });
  await page.mouse.up();
  await expect(wb.locator(".wb-shape")).toHaveCount(1);
  await expect(wb.locator(".wb-pen")).toHaveCount(0);

  // Hidden voting: the result waits for the end.
  await wb.getByRole("button", { name: "Abstimmung", exact: true }).click();
  const panel = wb.getByRole("dialog", { name: "Abstimmung" });
  await panel.getByLabel(/Verdeckt abstimmen/).check();
  await panel.getByRole("button", { name: "Abstimmung starten" }).click();
  await wb.getByRole("button", { name: /Stimme für Zentrale Idee/ }).click();
  await expect(panel).toContainText("Ergebnis erscheint");
  await panel.getByRole("button", { name: "Abstimmung beenden" }).click();
  await expect(panel.getByRole("list", { name: "Ergebnis" })).toContainText("Zentrale Idee");
  await wb.getByRole("button", { name: "Abstimmung", exact: true }).click();

  // A symbol from the icon library.
  await wb.getByRole("button", { name: "Bilder und Symbole suchen" }).click();
  const media = page.getByRole("dialog", { name: "Bilder und Symbole" });
  await media.getByRole("tab", { name: "Symbole" }).click();
  await media.getByLabel("Symbole suchen").fill("rakete");
  await media.getByRole("button", { name: "Symbol Rocket" }).click();
  await expect(wb.locator(".wb-icon-glyph svg")).toHaveCount(1);

  // A database record as a live card.
  await wb.getByRole("button", { name: "Seite verknüpfen" }).click();
  const cards = page.getByRole("dialog", { name: "Seite verknüpfen" });
  await cards.getByLabel("Seiten suchen").fill("Aufgaben");
  await cards.getByRole("button", { name: new RegExp(`Eintrag aus „${db.title ?? "Aufgaben"}`) }).first().click();
  await cards.locator(".wb-card-list button").nth(1).click();
  await expect(wb.locator(".wb-row-card strong")).not.toHaveText(/nicht verfügbar/, { timeout: 12_000 });
  await expect(wb.getByText("Gespeichert", { exact: true })).toBeVisible({ timeout: 10_000 });
  expect(errors).toEqual([]);
});

test("laser pointer and follow me reach the other person", async ({ page, browser }, info) => {
  test.skip(info.project.name === "mobile", "Mouse cursors");
  test.skip(!process.env.FLOWPLAN_DATA_DIR, "Needs the isolated test data directory");
  const { boot, board } = await setup(page, `Laser ${Date.now()}`);
  const db = new DatabaseSync(join(process.env.FLOWPLAN_DATA_DIR!, "flowplan.sqlite"));
  const uid = randomUUID(),
    token = randomBytes(32).toString("hex");
  db.prepare("INSERT INTO users(id,subject,name,email) VALUES(?,?,?,?)").run(uid, uid, "Lea Laser", `${uid}@test.invalid`);
  db.prepare("INSERT INTO members VALUES(?,?,?)").run(boot.workspace.id, uid, "editor");
  db.prepare("INSERT INTO sessions VALUES(?,?,?,?)").run(createHash("sha256").update(token).digest("hex"), uid, "[]", Date.now() + 3600000);
  db.close();
  const context = await browser.newContext({ viewport: page.viewportSize() });
  await context.addCookies([{ name: "flowplan_session", value: token, url: origin }]);
  const other = await context.newPage();
  await page.goto(`/#page=${board.id}`);
  await other.goto(`${origin}/#page=${board.id}`);
  const canvas = (p: Page) => p.locator("svg.wb-canvas");
  await expect(canvas(page)).toBeVisible();
  await expect(canvas(other)).toBeVisible();

  // Lea points with the laser: the trail shows on the first screen.
  await other.getByRole("button", { name: "Laserpointer" }).click();
  const area = (await canvas(other).boundingBox())!;
  await other.mouse.move(area.x + 200, area.y + 200);
  await other.mouse.move(area.x + 400, area.y + 260, { steps: 10 });
  await expect(page.locator(".wb-laser circle").first()).toBeAttached({ timeout: 3000 });

  // Lea presents: the first person's view follows hers.
  await other.getByRole("button", { name: "Auswählen", exact: true }).click();
  await other.getByRole("button", { name: "Folge mir" }).click();
  await expect(page.locator(".wb-presenting")).toContainText("Du folgst Lea Laser");
  const before = await page.getByRole("button", { name: "Zoom zurücksetzen" }).textContent();
  await other.getByRole("button", { name: "Vergrößern" }).click();
  await other.getByRole("button", { name: "Vergrößern" }).click();
  await expect(page.getByRole("button", { name: "Zoom zurücksetzen" })).not.toHaveText(before || "", { timeout: 5000 });
  await page.locator(".wb-presenting").getByRole("button", { name: "Nicht mehr folgen" }).click();
  await expect(page.locator(".wb-presenting")).toContainText("präsentiert");
  await other.locator(".wb-presenting").getByRole("button", { name: "Beenden" }).click();
  await expect(page.locator(".wb-presenting")).toHaveCount(0);
  await context.close();
});
