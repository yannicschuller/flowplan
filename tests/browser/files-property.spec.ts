import { test, expect } from "@playwright/test";

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==",
  "base64",
);

test("files & media cells upload several files, add links, remove entries and show chips", async ({
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
    title: `Medien ${testInfo.project.name} ${Date.now()}`,
    kind: "database",
  });
  const read = async () =>
    (await page.request.get(`/api/pages/${p.id}`)).json();
  const initial = await read();
  await command({
    action: "database.update",
    pageId: p.id,
    version: initial.database.version,
    fields: [
      { id: "title", name: "Name", type: "text" },
      { id: "media", name: "Anhänge", type: "files" },
    ],
    views: [
      { id: "table", name: "Tabelle", type: "table", filters: [], sorts: [] },
    ],
  });
  const row = await command({
    action: "row.create",
    pageId: p.id,
    cells: { title: "Angebot" },
  });
  const media = async () =>
    (await read()).rows.find((r: { id: string }) => r.id === row.id).cells
      .media;
  await page.goto(`/#page=${p.id}&row=${row.id}`);
  const entry = page.getByRole("dialog", { name: "Eintrag", exact: true });
  const group = entry.getByRole("group", { name: "Anhänge", exact: true });
  await group.getByLabel("Anhänge: Datei hochladen").setInputFiles([
    { name: "foto.png", mimeType: "image/png", buffer: png },
    {
      name: "angebot.pdf",
      mimeType: "application/pdf",
      buffer: Buffer.from("%PDF-1.4\n"),
    },
  ]);
  await expect.poll(async () => (await media())?.length).toBe(2);
  await expect(group.getByRole("link", { name: "foto.png" })).toBeVisible();
  await expect(group.getByRole("link", { name: "angebot.pdf" })).toBeVisible();
  await expect(group.locator("img.file-thumb")).toHaveCount(1);
  await group
    .getByLabel("Anhänge: Link einfügen")
    .fill("https://example.com/unterlagen/plan.pdf");
  await group.getByRole("button", { name: "Hinzufügen", exact: true }).click();
  await expect.poll(async () => (await media())?.length).toBe(3);
  await expect(group.getByRole("link", { name: "plan.pdf" })).toBeVisible();
  await group.getByLabel("Anhänge: Link einfügen").fill("javascript:alert(1)");
  await group.getByRole("button", { name: "Hinzufügen", exact: true }).click();
  await expect(group.getByRole("alert")).toContainText("http(s)");
  await group
    .getByRole("button", { name: "angebot.pdf entfernen", exact: true })
    .click();
  await expect.poll(async () => (await media())?.length).toBe(2);
  await page.screenshot({
    path: `test-results/files-property-verification/${testInfo.project.name}-dialog.png`,
  });
  await entry.getByRole("button", { name: "Schließen", exact: true }).click();
  const cell = page.locator("tbody tr").first().locator(".file-cell");
  await expect(cell.locator(".file-chip")).toHaveText(["foto.png", "plan.pdf"]);
  expect(errors).toEqual([]);
  await command({ action: "page.delete", pageId: p.id });
});
