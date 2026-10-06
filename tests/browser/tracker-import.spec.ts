import { test, expect } from "@playwright/test";

// A Trello export becomes a database with its cards.
test("import a Trello board from the settings", async ({ page }) => {
  test.setTimeout(150_000);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
  await page.request.post("/api/auth/demo", { headers: { origin } });
  const name = `Trello ${Date.now()}`;
  const board = {
    name,
    lists: [{ id: "l1", name: "Ideen" }],
    cards: [{ id: "c1", name: "Erste Karte", idList: "l1", labels: [] }],
  };
  await page.goto("/#settings");
  await page.getByRole("button", { name: "Daten" }).or(page.getByRole("tab", { name: "Daten" })).first().click();
  await page.getByLabel("Jira- oder Trello-Export importieren").setInputFiles({ name: "board.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(board)) });
  await expect(page.getByText(name).first()).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText("Erste Karte").first()).toBeVisible();
  expect(errors).toEqual([]);
});
