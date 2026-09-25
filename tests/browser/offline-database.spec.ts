import { test, expect } from "@playwright/test";

test("database records are edited offline and conflicts are resolved on reconnect", async ({
  page,
  context,
  browser,
}, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
  await page.request.post("/api/auth/demo", { headers: { origin } });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  // A second device changes the same record while this one is offline.
  const other = await browser.newContext();
  await other.request.post(`${origin}/api/auth/demo`, { headers: { origin } });
  const command = async (
    data: Record<string, unknown>,
    from = page.request,
  ) => {
    const response = await from.post(`${origin}/api/command`, {
      headers: { origin },
      data,
    });
    expect(response.ok(), await response.text()).toBe(true);
    return response.json();
  };
  const read = async () =>
    (await other.request.get(`${origin}/api/pages/${p.id}`)).json();
  const p = await command({
    action: "page.create",
    workspaceId: boot.workspace.id,
    spaceId: boot.spaces[0].id,
    title: `Offline ${testInfo.project.name} ${Date.now()}`,
    kind: "database",
  });
  await command({
    action: "database.update",
    pageId: p.id,
    version: (await read()).database.version,
    fields: [
      { id: "title", name: "Name", type: "text" },
      { id: "note", name: "Notiz", type: "text" },
      { id: "place", name: "Ort", type: "text" },
    ],
    views: [
      { id: "t", name: "Tabelle", type: "table", filters: [], sorts: [] },
    ],
  });
  const alpha = await command({
    action: "row.create",
    pageId: p.id,
    cells: { title: "Alpha", note: "Alt", place: "Berlin" },
  });
  await page.goto(`/#page=${p.id}`);
  await expect(page.locator(".title-cell")).toHaveText(["Alpha"]);

  await context.setOffline(true);
  const alphaRow = page.locator("tr", {
    has: page.locator(".title-cell", { hasText: "Alpha" }),
  });
  await alphaRow.locator("td").nth(2).click();
  const input = alphaRow.getByLabel("Notiz", { exact: true });
  await input.fill("Offline-Notiz");
  await input.press("Tab");
  await expect(alphaRow).toContainText("Offline-Notiz");
  await page.getByRole("button", { name: "Neue Zeile" }).click();
  const entry = page.getByRole("dialog", { name: "Eintrag", exact: true });
  if (await entry.isVisible())
    await entry.getByRole("button", { name: "Schließen", exact: true }).click();
  await expect(page.locator(".title-cell")).toHaveText([
    "Alpha",
    "Neue Aufgabe",
  ]);
  await expect(page.locator(".offline-pending")).toContainText(
    "2 Offline-Änderungen warten",
  );
  // The waiting changes survive a reload on this device.
  await page
    .evaluate(() =>
      Object.keys(localStorage).filter((k) =>
        k.startsWith("flowplan-offline-queue"),
      ),
    )
    .then((keys) => expect(keys.length).toBeGreaterThan(0));

  // Meanwhile the note and the place change on the other device.
  await command(
    {
      action: "row.update",
      pageId: p.id,
      rowId: alpha.id,
      version: 1,
      cells: { note: "Fremd", place: "Hamburg" },
    },
    other.request,
  );
  await context.setOffline(false);
  const dialog = page.getByRole("dialog", {
    name: "Konflikt mit Offline-Änderungen",
  });
  await expect(dialog).toBeVisible({ timeout: 15000 });
  await expect(dialog).toContainText("Offline-Notiz");
  await expect(dialog).toContainText("Fremd");
  await dialog
    .getByRole("button", { name: "Meine Änderung übernehmen" })
    .click();
  await expect(dialog).toHaveCount(0);
  await expect(page.locator(".offline-pending")).toHaveCount(0);
  await expect
    .poll(async () =>
      (await read()).rows
        .map((r: { cells: Record<string, string> }) =>
          [r.cells.title, r.cells.note ?? "", r.cells.place ?? ""].join("|"),
        )
        .sort(),
    )
    .toEqual(["Alpha|Offline-Notiz|Hamburg", "Neue Aufgabe||"]);
  await page.screenshot({
    path: `test-results/offline-database/${testInfo.project.name}.png`,
  });
  await other.close();
  expect(errors).toEqual([]);
  await command({ action: "page.delete", pageId: p.id });
});
