import { test, expect } from "@playwright/test";

// An ID property numbers records; WEB-1 in a document links to the record.
test("ticket numbers in a table and as links in text", async ({ page }, info) => {
  test.setTimeout(150_000);
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
  // Demo workspaces are separate, so the prefix is free in each run.
  const prefix = `T${Date.now().toString(36).toUpperCase().slice(-5)}`.replace(/[^A-Z0-9]/g, "");
  const db = await command({ action: "page.create", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, title: `Tickets ${info.project.name}`, kind: "database" });
  const read = async () => (await page.request.get(`/api/pages/${db.id}`)).json();
  const first = await read();
  await command({
    action: "database.update",
    pageId: db.id,
    version: first.database.version,
    fields: [...first.database.fields, { id: "key", name: "ID", type: "id", prefix }],
    views: first.database.views,
  });
  const row = await command({ action: "row.create", pageId: db.id, cells: { title: "Login kaputt" } });
  await page.goto(`/#page=${db.id}`);
  await expect(page.getByText(`${prefix}-1`, { exact: true }).first()).toBeVisible({ timeout: 30_000 });

  const doc = await command({ action: "page.create", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, title: "Notes", kind: "document" });
  await page.goto(`/#page=${doc.id}`);
  const editor = page.getByLabel("Dokumentinhalt", { exact: true });
  await editor.click();
  await page.keyboard.type(`Siehe ${prefix}-1 und ${prefix}-99.`);
  const ref = editor.locator(".ticket-ref");
  await expect(ref).toHaveCount(2);
  await ref.first().click({ modifiers: [process.platform === "darwin" ? "Meta" : "Control"] });
  await expect(page).toHaveURL(new RegExp(`row=${row.id}`), { timeout: 20_000 });
  expect(errors).toEqual([]);
});
