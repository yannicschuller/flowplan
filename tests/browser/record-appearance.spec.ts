import { test, expect } from "@playwright/test";

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==",
  "base64",
);

test("records get their own icon and cover, shown in dialog, table and gallery", async ({
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
  const p = await command({
    action: "page.create",
    workspaceId: boot.workspace.id,
    spaceId: boot.spaces[0].id,
    title: `Datensatzbilder ${testInfo.project.name} ${Date.now()}`,
    kind: "database",
  });
  const read = async () =>
    (await page.request.get(`/api/pages/${p.id}`)).json();
  const initial = await read();
  await command({
    action: "database.update",
    pageId: p.id,
    version: initial.database.version,
    fields: [{ id: "title", name: "Name", type: "text" }],
    views: [
      { id: "table", name: "Tabelle", type: "table", filters: [], sorts: [] },
      {
        id: "gallery",
        name: "Galerie",
        type: "gallery",
        filters: [],
        sorts: [],
        gallery: { cover: "record", fit: "cover", size: "medium" },
      },
    ],
  });
  const row = await command({
    action: "row.create",
    pageId: p.id,
    cells: { title: "Messestand" },
  });
  const find = async () =>
    (await read()).rows.find((r: { id: string }) => r.id === row.id);
  await page.goto(`/#page=${p.id}&row=${row.id}`);
  const entry = page.getByRole("dialog", { name: "Eintrag", exact: true });
  await expect(entry).toBeVisible();
  await entry.getByRole("button", { name: "Symbol hinzufügen" }).click();
  const iconDialog = page.getByRole("dialog", {
    name: "Symbol des Eintrags",
    exact: true,
  });
  await iconDialog
    .getByRole("searchbox", { name: "Emoji suchen", exact: true })
    .fill("Rakete");
  await iconDialog
    .getByRole("button", { name: "Rakete 🚀", exact: true })
    .click();
  await expect.poll(async () => (await find()).icon).toBe("🚀");
  await expect(
    entry.getByRole("heading", { name: "Messestand", exact: true }),
  ).toContainText("🚀");

  await entry.getByRole("button", { name: "Cover hinzufügen" }).click();
  const coverDialog = page.getByRole("dialog", {
    name: "Cover auswählen",
    exact: true,
  });
  await coverDialog.locator('input[type="file"]').setInputFiles({
    name: "stand.png",
    mimeType: "image/png",
    buffer: png,
  });
  // Records store no focal position.
  await expect(coverDialog.getByLabel("Vertikale Coverposition")).toHaveCount(
    0,
  );
  await coverDialog
    .getByRole("button", { name: "Speichern", exact: true })
    .click();
  await expect
    .poll(async () => (await find()).cover)
    .toMatch(/^\/api\/files\//);
  await expect(entry.locator(".row-cover img")).toBeVisible();
  await page.screenshot({
    path: `test-results/record-appearance-verification/${testInfo.project.name}-dialog.png`,
  });
  await entry.getByRole("button", { name: "Schließen", exact: true }).click();
  await expect(
    page.locator(".title-cell").filter({ hasText: "Messestand" }),
  ).toContainText("🚀");
  await page.getByRole("button", { name: "Galerie", exact: true }).click();
  const cover = (await find()).cover;
  await expect(
    page.locator(`.gallery-cover img[src="${cover}"]`),
  ).toBeVisible();
  expect(errors).toEqual([]);
  await command({ action: "page.delete", pageId: p.id });
});
