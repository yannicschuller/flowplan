import { test, expect, type Page } from "@playwright/test";

// #190: related records show their icon (emoji or uploaded image) in front
// of their title in relation cells and in the relation picker; records
// without an icon look as before.
// #192: a plain click on a related record of another database opens it on
// top of the current table – editable as in its own database – and closing
// it (or Back) returns to the table; Ctrl/⌘-click and "In Datenbank öffnen"
// go to the record in its own database.
async function setup(page: Page, tag: string) {
  const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
  await page.request.post("/api/auth/demo", { headers: { origin } });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const command = async (data: Record<string, unknown>) => {
    const response = await page.request.post("/api/command", { headers: { origin }, data });
    expect(response.ok(), await response.text()).toBe(true);
    return response.json();
  };
  const read = async (id: string) => (await page.request.get(`/api/pages/${id}`)).json();
  const db = async (title: string) =>
    (await command({ action: "page.create", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, title, kind: "database" })).id as string;
  const schema = async (id: string, fields: unknown[]) =>
    command({
      action: "database.update",
      pageId: id,
      version: (await read(id)).database.version,
      fields,
      views: [{ id: "t", name: "Tabelle", type: "table", filters: [], sorts: [] }],
    });
  const customers = await db(`Kunden ${tag}`),
    tasks = await db(`Aufgaben ${tag}`);
  await schema(customers, [
    { id: "title", name: "Name", type: "text" },
    { id: "revenue", name: "Umsatz", type: "number" },
  ]);
  await schema(tasks, [
    { id: "title", name: "Name", type: "text" },
    { id: "customer", name: "Kunde", type: "relation", relationPage: customers },
  ]);
  const row = async (pageId: string, cells: Record<string, unknown>) => (await command({ action: "row.create", pageId, cells })).id as string;
  const acme = await row(customers, { title: "Acme" }),
    logo = await row(customers, { title: "Logo AG" }),
    plain = await row(customers, { title: "Ohne Symbol" });
  await command({ action: "row.appearance", pageId: customers, rowId: acme, version: 1, icon: "🚀" });
  // An uploaded image as the icon (a /api/files/… address).
  const png = Buffer.from(
    await page.evaluate(() => {
      const c = document.createElement("canvas");
      c.width = c.height = 32;
      const ctx = c.getContext("2d")!;
      ctx.fillStyle = "#e8590c";
      ctx.fillRect(0, 0, 32, 32);
      return c.toDataURL("image/png").split(",")[1];
    }),
    "base64",
  );
  const upload = await page.request.post("/api/upload", {
    headers: { origin },
    multipart: { pageId: customers, file: { name: "logo.png", mimeType: "image/png", buffer: png } },
  });
  expect(upload.ok(), await upload.text()).toBe(true);
  const logoUrl = (await upload.json()).url as string;
  expect(logoUrl).toMatch(/^\/api\/files\//);
  await command({ action: "row.appearance", pageId: customers, rowId: logo, version: 1, icon: logoUrl });
  const task = await row(tasks, { title: "Anruf", customer: [acme, logo, plain] });
  return { command, read, customers, tasks, acme, logo, plain, task };
}

test("relation cells show record icons and open related records on top of the table", async ({ page, context }, testInfo) => {
  test.setTimeout(180_000);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const tag = `${testInfo.project.name}${Date.now()}`;
  const { command, read, customers, tasks, acme, task } = await setup(page, tag);
  const shots = `test-results/relation-records/${testInfo.project.name}`;

  await page.goto(`/#page=${tasks}`);
  // The introduction a new account sees first.
  const skip = page.getByRole("button", { name: "Überspringen" });
  if (await skip.waitFor({ timeout: 5000 }).then(() => true, () => false)) await skip.click();
  const cell = page.locator(".data-table .relation-links").first();
  const link = (name: string) => cell.getByRole("link", { name, exact: true });
  // #190: the emoji, the uploaded image (loaded), nothing for the third.
  await expect(link("Acme")).toBeVisible();
  await expect(link("Acme").locator(".page-emoji")).toHaveText("🚀");
  const image = link("Logo AG").locator("img.page-image-icon");
  await expect(image).toBeVisible();
  await expect.poll(() => image.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth)).toBeGreaterThan(0);
  await expect(link("Ohne Symbol").locator(".relation-icon")).toHaveCount(0);
  await expect(link("Ohne Symbol")).not.toHaveClass(/relation-with-icon/);
  await cell.screenshot({ path: `${shots}-relation-icons.png` });

  // #192: a plain click opens the customer on top of the tasks (no page
  // load: the marker stays).
  await page.evaluate(() => ((window as unknown as { __stay: boolean }).__stay = true));
  const stayed = () => page.evaluate(() => (window as unknown as { __stay?: boolean }).__stay === true);
  const entry = page.getByRole("dialog", { name: "Eintrag", exact: true });
  await link("Acme").click();
  await expect(entry.getByRole("heading", { name: "Acme", exact: true })).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`#page=${tasks}$`));
  await expect(entry.locator(".related-record-origin")).toContainText(`Kunden ${tag}`);
  await expect(entry.getByRole("link", { name: "In Datenbank öffnen" })).toBeVisible();
  await expect(entry.locator(".ProseMirror").first()).toBeVisible();
  await page.screenshot({ path: `${shots}-overlay.png` });
  // Edits save to the customer, as in its own database.
  const revenue = entry.getByLabel("Umsatz", { exact: true });
  await revenue.fill("42");
  await revenue.press("Enter");
  await expect
    .poll(async () => ((await read(customers)).rows as { id: string; cells: Record<string, unknown> }[]).find((r) => r.id === acme)?.cells.revenue)
    .toBe(42);
  // Closing returns to the tasks, as they were.
  await entry.getByRole("button", { name: "Schließen", exact: true }).first().click();
  await expect(entry).toBeHidden();
  await expect(page).toHaveURL(new RegExp(`#page=${tasks}$`));
  await expect(link("Acme")).toBeVisible();
  expect(await stayed()).toBe(true);

  // Back closes the overlay and stays in the tasks.
  await link("Acme").click();
  await expect(entry.getByRole("heading", { name: "Acme", exact: true })).toBeVisible();
  await page.goBack();
  await expect(entry).toBeHidden();
  await expect(page).toHaveURL(new RegExp(`#page=${tasks}$`));
  await expect(link("Acme")).toBeVisible();
  expect(await stayed()).toBe(true);

  // The relation picker of the task shows the icons too (#190).
  await page.goto(`/#page=${tasks}&row=${task}`);
  const options = entry.locator(".relation-options");
  await expect(options.locator("label", { hasText: "Acme" }).locator(".page-emoji")).toHaveText("🚀");
  await expect(options.locator("label", { hasText: "Logo AG" }).locator("img.page-image-icon")).toBeVisible();
  await expect(options.locator("label", { hasText: "Ohne Symbol" }).locator(".relation-icon")).toHaveCount(0);
  await page.goto(`/#page=${tasks}`);
  await expect(entry).toBeHidden();

  // "In Datenbank öffnen" goes to the customer in its database; Back
  // returns to the tasks.
  await link("Acme").click();
  await entry.getByRole("link", { name: "In Datenbank öffnen" }).click();
  await expect(page).toHaveURL(new RegExp(`page=${customers}.*row=${acme}`));
  await expect(entry.getByRole("heading", { name: "Acme", exact: true })).toBeVisible();
  await expect(entry.locator(".related-record-origin")).toHaveCount(0);
  await page.goBack();
  await expect(page).toHaveURL(new RegExp(`#page=${tasks}$`));
  await expect(entry).toBeHidden();
  await expect(link("Acme")).toBeVisible();

  // Ctrl/⌘-click keeps the link: the customer in its database, in a new tab.
  const [tab] = await Promise.all([context.waitForEvent("page"), link("Acme").click({ modifiers: ["ControlOrMeta"] })]);
  // (A new tab starts at about:blank before it navigates.)
  await tab.waitForURL(new RegExp(`page=${customers}.*row=${acme}`));
  await tab.close();
  await expect(page).toHaveURL(new RegExp(`#page=${tasks}$`));
  await expect(entry).toBeHidden();

  expect(errors).toEqual([]);
  for (const id of [tasks, customers]) await command({ action: "page.delete", pageId: id });
});
