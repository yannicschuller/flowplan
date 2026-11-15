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

// #299: a record's icon on a card sits on the title's first line with room
// before the title – library icons (SVG) had neither, unlike emoji.
test("a card's icon lines up with the title's first line and keeps a gap", async ({ page }, info) => {
  test.setTimeout(120_000);
  const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
  await page.request.post("/api/auth/demo", { headers: { origin } });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const command = async (data: Record<string, unknown>) => {
    const response = await page.request.post("/api/command", { headers: { origin }, data });
    expect(response.ok(), await response.text()).toBe(true);
    return response.json();
  };
  const db = await command({ action: "page.create", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, title: `Card icons ${info.project.name}`, kind: "database" });
  const first = await (await page.request.get(`/api/pages/${db.id}`)).json();
  await command({
    action: "database.update",
    pageId: db.id,
    version: first.database.version,
    fields: [
      { id: "title", name: "Name", type: "text" },
      { id: "status", name: "Status", type: "select", options: ["Offen"] },
    ],
    views: [{ id: "board", name: "Board", type: "board", groupBy: "status", filters: [], sorts: [], fieldOrder: ["title", "status"] }],
  });
  const title = "Reorder report blocks and sections, and move blocks between sections";
  const row = await command({ action: "row.create", pageId: db.id, cells: { title, status: "Offen" } });
  const rows = (await (await page.request.get(`/api/pages/${db.id}`)).json()).rows as { id: string; version: number }[];
  const version = rows.find((r) => r.id === (row.id ?? row.row?.id))!.version;
  await command({ action: "row.appearance", pageId: db.id, rowId: row.id ?? row.row?.id, version, icon: "icon:Rocket:#337ea9" });
  await page.goto(`/#page=${db.id}`);
  const strong = page.locator(".record-card", { hasText: "Reorder" }).locator("> strong");
  await expect(strong.locator("svg")).toBeVisible({ timeout: 30_000 });
  const at = await strong.evaluate((el) => {
    const icon = el.querySelector("svg")!.getBoundingClientRect();
    const text = [...el.childNodes].find((n) => n.nodeType === 3)!;
    const range = document.createRange();
    range.setStart(text, 0);
    range.setEnd(text, 1);
    const letter = range.getBoundingClientRect();
    return { gap: letter.left - icon.right, iconMid: (icon.top + icon.bottom) / 2, letterMid: (letter.top + letter.bottom) / 2 };
  });
  expect(at.gap).toBeGreaterThanOrEqual(4);
  expect(Math.abs(at.iconMid - at.letterMid)).toBeLessThanOrEqual(3);
});
