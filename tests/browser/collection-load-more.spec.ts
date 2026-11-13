import { test, expect } from "@playwright/test";

// A collection with more than 500 matches (#270): the first 500 show, "Mehr
// laden" appends the rest – in the list and in the table.
test("Mehr laden reaches every match of a large collection", async ({ page }, testInfo) => {
  test.setTimeout(240_000);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
  await page.request.post("/api/auth/demo", { headers: { origin } });
  await page.request.post("/api/command", { headers: { origin }, data: { action: "profile.onboarded" } });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const command = async (data: Record<string, unknown>) => {
    const res = await page.request.post("/api/command", { headers: { origin }, data });
    expect(res.ok(), await res.text()).toBe(true);
    return await res.json();
  };
  const tag = `Massen${testInfo.project.name}${Date.now()}`;
  const db = await command({ action: "page.create", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, title: `Belege ${tag}`, kind: "database" });
  const titleField = (await (await page.request.get(`/api/pages/${db.id}`)).json()).database.fields[0].id as string;
  const COUNT = 523;
  let next = 0;
  await Promise.all(
    Array.from({ length: 8 }, async () => {
      while (next < COUNT) {
        const n = next++;
        await command({ action: "row.create", pageId: db.id, cells: { [titleField]: `${tag} ${n}` } });
      }
    }),
  );
  const collection = await command({ action: "collection.create", workspaceId: boot.workspace.id, name: `Sammlung ${tag}`, query: `title:${tag} type:record` });
  await page.goto(`/#collection/${collection.id}`);
  await expect(page.getByRole("heading", { name: `Sammlung ${tag}` })).toBeVisible();
  await expect(page.getByText(`${COUNT} Treffer`, { exact: true })).toBeVisible({ timeout: 30_000 });
  const list = page.getByRole("list", { name: "Treffer" });
  await expect(list.getByRole("listitem")).toHaveCount(500);
  await expect(page.getByText(`500 von ${COUNT} Treffern`)).toBeVisible();
  await page.getByRole("button", { name: "Mehr laden" }).click();
  await expect(list.getByRole("listitem")).toHaveCount(COUNT);
  await expect(page.getByRole("button", { name: "Mehr laden" })).toHaveCount(0);
  // Every record once.
  const titles = await list.locator("strong").evaluateAll((els) => els.map((e) => e.firstChild?.textContent ?? ""));
  expect(new Set(titles).size).toBe(COUNT);
  // A change in the workspace refreshes the results without falling back
  // to the first page.
  await command({ action: "row.create", pageId: db.id, cells: { [titleField]: `${tag} neu` } });
  await expect(page.getByText(`${COUNT + 1} Treffer`, { exact: true })).toBeVisible({ timeout: 20_000 });
  await expect(list.getByRole("listitem")).toHaveCount(COUNT + 1);

  // The table: loaded matches stay after switching; a fresh visit pages again.
  await page.getByRole("button", { name: "Tabelle" }).click();
  const table = page.getByRole("region", { name: "Treffer als Tabelle" });
  await expect(table.locator("tbody tr")).toHaveCount(COUNT + 1);
  await page.reload();
  await expect(table.locator("tbody tr")).toHaveCount(500, { timeout: 30_000 });
  await page.getByRole("button", { name: "Mehr laden" }).click();
  await expect(table.locator("tbody tr")).toHaveCount(COUNT + 1);
  await page.getByRole("button", { name: "Liste" }).click();
  expect(errors).toEqual([]);
});
