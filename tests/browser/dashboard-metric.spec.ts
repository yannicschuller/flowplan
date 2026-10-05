import { test, expect } from "@playwright/test";

// A metric card in a document: choose a database and a calculation, the
// number appears and is saved with the page.
test("insert a metric from a database into a document", async ({ page }) => {
  test.setTimeout(150_000);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
  await page.request.post("/api/auth/demo", { headers: { origin } });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const command = async (data: Record<string, unknown>) => (await page.request.post("/api/command", { headers: { origin }, data })).json();
  const title = `Hours ${Date.now()}`;
  const source = (await command({ action: "page.create", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, title, kind: "database" })).id;
  const db = await (await page.request.get(`/api/pages/${source}`)).json();
  const version = db.database?.version ?? db.version;
  await command({
    action: "database.update",
    pageId: source,
    version,
    fields: [
      { id: "title", name: "Name", type: "text" },
      { id: "hours", name: "Stunden", type: "number" },
    ],
    views: [{ id: "table", name: "Tabelle", type: "table", filters: [], sorts: [] }],
  });
  for (const hours of [3, 4.5]) await command({ action: "row.create", pageId: source, cells: { title: "x", hours } });
  const pageId = (await command({ action: "page.create", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, title: `Dashboard ${Date.now()}`, kind: "document" })).id;

  await page.goto(`/#page=${pageId}`);
  const editor = page.getByLabel("Dokumentinhalt", { exact: true });
  await editor.click();
  await page.keyboard.type("/Kennzahl");
  await page.keyboard.press("Enter");
  const card = editor.locator(".metric-block");
  await expect(card).toBeVisible();
  await card.getByLabel("Datenbank").selectOption({ label: title });
  await expect(card.locator(".metric-value")).toHaveText("2", { timeout: 20_000 });
  await card.getByLabel("Berechnung").selectOption({ label: "Summe" });
  await expect(card.locator(".metric-value")).toHaveText("7,5");
  await card.getByLabel("Beschriftung").fill("Stunden gesamt");
  await card.getByLabel("Beschriftung").press("Enter");
  await card.getByRole("button", { name: "Fertig" }).click();
  await expect(card.locator(".metric-label")).toHaveText("Stunden gesamt");
  await expect
    .poll(async () => (await (await page.request.get(`/api/pages/${pageId}`)).json()).html, { timeout: 20_000 })
    .toContain("data-metric");
  expect(errors).toEqual([]);
});
