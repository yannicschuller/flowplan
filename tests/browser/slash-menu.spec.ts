import { test, expect } from "@playwright/test";

test("typing / opens a small menu at the caret; /h2 and Enter make a heading", async ({
  page,
}, info) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
  await page.request.post("/api/auth/demo", { headers: { origin } });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const created = await (
    await page.request.post("/api/command", {
      headers: { origin },
      data: {
        action: "page.create",
        workspaceId: boot.workspace.id,
        spaceId: boot.spaces[0].id,
        title: `Slash ${info.project.name} ${Date.now()}`,
        kind: "document",
      },
    })
  ).json();
  await page.goto(`/#page=${created.id}`);
  const editor = page.getByLabel("Dokumentinhalt", { exact: true });
  await editor.click();
  const menu = page.locator(".slash-menu");

  // "/h2" + Enter: the query disappears, the line becomes a heading.
  await page.keyboard.type("/");
  await expect(menu).toBeVisible();
  await expect(page.locator(".modal, [role=dialog][aria-modal=true]")).toHaveCount(0);
  await page.keyboard.type("h2");
  await expect(menu.locator("button").first()).toContainText("Überschrift 2");
  await page.keyboard.press("Enter");
  await expect(menu).toHaveCount(0);
  await page.keyboard.type("Ziele");
  await expect(editor.locator("h2")).toHaveText("Ziele");
  await expect(editor).not.toContainText("/h2");

  // Arrow keys move through the list; Escape keeps the typed text.
  await page.keyboard.press("Enter");
  await page.keyboard.type("/");
  await expect(menu.locator('button[data-active="true"]')).toContainText("Text");
  await page.keyboard.press("ArrowDown");
  await expect(menu.locator('button[data-active="true"]')).toContainText("Überschrift 1");
  await page.keyboard.press("ArrowUp");
  await page.keyboard.type("todo");
  await page.keyboard.press("Enter");
  await expect(editor.locator('ul[data-type="taskList"]')).toHaveCount(1);
  await page.keyboard.type("Erledigen");

  // A slash inside a word closes by itself when nothing matches.
  await page.keyboard.press("Enter");
  await page.keyboard.press("Enter");
  await page.keyboard.type("und/oder weiter");
  await expect(menu).toHaveCount(0);
  await expect(editor).toContainText("und/oder weiter");
  await page.keyboard.type(" /xyz");
  await expect(menu).toHaveCount(0);
  await page.keyboard.press("Escape");

  // The toolbar button opens the same menu with a search field.
  await page.getByRole("button", { name: "Block hinzufügen", exact: true }).click();
  await expect(menu.getByLabel("Block suchen")).toBeFocused();
  await menu.getByLabel("Block suchen").fill("trenn");
  await page.keyboard.press("Enter");
  await expect(editor.locator("hr")).toHaveCount(1);
  expect(errors).toEqual([]);
});
