import { test, expect } from "@playwright/test";

test("published tables show formulas that only read public properties", async ({
  page,
  browser,
}, testInfo) => {
  const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
  await page.request.post("/api/auth/demo", { headers: { origin } });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const command = async (data: Record<string, unknown>) => {
    const response = await page.request.post("/api/command", {
      headers: { origin },
      data,
    });
    expect(response.ok(), await response.text()).toBe(true);
    return response.json();
  };
  const p = await command({
    action: "page.create",
    workspaceId: boot.workspace.id,
    spaceId: boot.spaces[0].id,
    title: `Preisliste ${testInfo.project.name} ${Date.now()}`,
    kind: "database",
  });
  const read = async () =>
    (await page.request.get(`/api/pages/${p.id}`)).json();
  await command({
    action: "database.update",
    pageId: p.id,
    version: (await read()).database.version,
    fields: [
      { id: "title", name: "Name", type: "text" },
      { id: "price", name: "Preis", type: "number" },
      { id: "qty", name: "Menge", type: "number" },
      { id: "owner", name: "Zuständig", type: "person" },
      {
        id: "total",
        name: "Summe",
        type: "formula",
        formula: 'prop("price") * prop("qty")',
      },
      {
        id: "who",
        name: "Kontakt",
        type: "formula",
        formula: 'concat("Von ", prop("owner"))',
      },
    ],
    views: [
      { id: "t", name: "Tabelle", type: "table", filters: [], sorts: [] },
    ],
  });
  const row = await command({
    action: "row.create",
    pageId: p.id,
    cells: { title: "Kaffee", price: 4, qty: 3, owner: boot.user.id },
  });
  await command({ action: "page.publish", pageId: p.id, enabled: true });
  const token = (await read()).page.public_token;
  const visitor = await browser.newContext();
  const guest = await visitor.newPage();
  await guest.goto(`${origin}/share/${token}`);
  const table = guest.locator(".data-table");
  await expect(table.locator("thead th")).toHaveText([
    "Name",
    "Preis",
    "Menge",
    "Summe",
  ]);
  await expect(table.locator("tbody tr").first()).toContainText("12");
  await expect(guest.locator("body")).not.toContainText(boot.user.name);
  await guest.goto(`${origin}/share/${token}?row=${row.id}`);
  await expect(guest.locator(".public-properties")).toContainText("Summe");
  await expect(guest.locator(".public-properties")).not.toContainText(
    "Kontakt",
  );
  await visitor.close();
  await command({ action: "page.delete", pageId: p.id });
});
