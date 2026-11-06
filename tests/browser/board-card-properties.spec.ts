import { test, expect } from "@playwright/test";

// Issue #130: board and gallery cards show every visible property with a
// value; empty properties and the footer date take no slot.
test("board and gallery cards show every filled property", async ({ page }, info) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
  await page.request.post("/api/auth/demo", { headers: { origin } });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const command = async (data: Record<string, unknown>) => {
    const response = await page.request.post("/api/command", { headers: { origin }, data });
    expect(response.ok(), await response.text()).toBe(true);
    return response.json();
  };
  const db = await command({ action: "page.create", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, title: `Cards ${info.project.name}`, kind: "database" });
  const first = await (await page.request.get(`/api/pages/${db.id}`)).json();
  await command({
    action: "database.update",
    pageId: db.id,
    version: first.database.version,
    fields: [
      { id: "title", name: "Name", type: "text" },
      { id: "status", name: "Status", type: "select", options: ["Offen"] },
      { id: "due", name: "Fällig", type: "date" },
      { id: "note", name: "Notiz", type: "text" },
      { id: "owner", name: "Team", type: "text" },
      { id: "area", name: "Bereich", type: "text" },
      { id: "budget", name: "Budget", type: "number" },
      { id: "place", name: "Ort", type: "text" },
    ],
    views: [
      { id: "board", name: "Board", type: "board", groupBy: "status", filters: [], sorts: [], fieldOrder: ["title", "status", "due", "note", "owner", "area", "budget", "place"] },
      { id: "gallery", name: "Galerie", type: "gallery", filters: [], sorts: [], hiddenFields: ["status"], gallery: { cover: "none", fit: "cover", size: "medium" } },
    ],
  });
  await command({
    action: "row.create",
    pageId: db.id,
    cells: { title: "Karte", status: "Offen", due: "2026-11-06", note: "", owner: "Nord", area: "Vertrieb", budget: 0, place: "Berlin" },
  });
  await page.goto(`/#page=${db.id}`);
  const card = page.locator(".record-card", { hasText: "Karte" });
  // Before #130 only the 2nd–4th properties had a chance (status, the
  // footer date and the empty note), so Team, Bereich, Budget and Ort were
  // missing.
  await expect(card.locator(".card-properties > span")).toHaveText(["Offen", "Nord", "Vertrieb", "0", "Berlin"], { timeout: 30_000 });
  await expect(card.locator(".card-bottom")).toContainText("2026");
  await page.getByRole("group", { name: "Ansichten" }).getByRole("button", { name: "Galerie" }).click();
  const tile = page.locator(".gallery .record-card", { hasText: "Karte" });
  await expect(tile.locator(".card-properties > span")).toHaveText(["Nord", "Vertrieb", "0", "Berlin"]);
  expect(errors).toEqual([]);
});
