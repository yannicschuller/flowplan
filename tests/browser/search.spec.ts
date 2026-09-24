import { test, expect } from "@playwright/test";

test("quick search finds compound words and records, filters by kind and opens entries", async ({
  page,
}, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
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
  const tag = `${testInfo.project.name}${Date.now()}`;
  const p = await command({
    action: "page.create",
    workspaceId: boot.workspace.id,
    spaceId: boot.spaces[0].id,
    title: `Suchziel ${tag}`,
    kind: "database",
  });
  const initial = await (await page.request.get(`/api/pages/${p.id}`)).json();
  await command({
    action: "database.update",
    pageId: p.id,
    version: initial.database.version,
    fields: [
      { id: "title", name: "Name", type: "text" },
      { id: "note", name: "Notiz", type: "text" },
    ],
    views: [
      { id: "t", name: "Tabelle", type: "table", filters: [], sorts: [] },
    ],
  });
  const row = await command({
    action: "row.create",
    pageId: p.id,
    cells: {
      title: `Wartung ${tag}`,
      note: `Heizungsüberprüfung im Kellerraum ${tag}`,
    },
  });
  await page.goto(`/#page=${p.id}`);
  await expect(page.locator(".data-table")).toBeVisible();
  await page.keyboard.press("ControlOrMeta+k");
  const dialog = page.getByRole("dialog", {
    name: "Schnellsuche",
    exact: true,
  });
  await expect(dialog).toBeVisible();
  const input = dialog.getByPlaceholder(
    "Seiten, Inhalte und Einträge finden …",
  );
  // Part of a compound word, without umlaut and in other case.
  await input.fill(`UBERPRUFUNG im kellerraum ${tag}`);
  const hit = dialog.getByRole("button", {
    name: new RegExp(`Wartung ${tag}`),
  });
  await expect(hit).toBeVisible();
  await expect(hit.locator("mark")).toHaveCount(1);
  await expect(hit).toContainText(`Eintrag in Suchziel ${tag}`);
  await page.screenshot({
    path: `test-results/search-verification/${testInfo.project.name}-results.png`,
  });
  await dialog.getByRole("radio", { name: "Dokumente", exact: true }).click();
  await expect(dialog.getByText("Nichts gefunden.")).toBeVisible();
  await dialog.getByRole("radio", { name: "Einträge", exact: true }).click();
  await expect(hit).toBeVisible();
  await hit.click();
  const entry = page.getByRole("dialog", { name: "Eintrag", exact: true });
  await expect(entry).toBeVisible();
  await expect(
    entry.getByRole("heading", { name: `Wartung ${tag}`, exact: true }),
  ).toBeVisible();
  expect(page.url()).toContain(`row=${row.id}`);

  // Changes are searchable right away.
  const current = (await (await page.request.get(`/api/pages/${p.id}`)).json())
    .rows[0];
  await command({
    action: "row.update",
    pageId: p.id,
    rowId: row.id,
    version: current.version,
    cells: { note: `Dachrinne ${tag}` },
  });
  const results = await (
    await page.request.get(
      `/api/search?workspace=${boot.workspace.id}&q=${encodeURIComponent(`Kellerraum ${tag}`)}`,
    )
  ).json();
  expect(results).toEqual([]);
  expect(errors).toEqual([]);
  await command({ action: "page.delete", pageId: p.id });
});
