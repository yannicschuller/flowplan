import { test, expect } from "@playwright/test";

// A document can be opened for reading: no editing until switched back,
// remembered for this page on this device.
test("documents switch between reading and editing", async ({ page }) => {
  test.setTimeout(120_000);
  const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
  await page.request.post("/api/auth/demo", { headers: { origin } });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const created = await page.request.post("/api/command", {
    headers: { origin },
    data: { action: "page.create", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, title: `Lesen ${Date.now()}`, kind: "document" },
  });
  const pageId = (await created.json()).id;
  await page.goto(`/#page=${pageId}`);
  const content = page.getByLabel("Dokumentinhalt", { exact: true });
  await expect(content).toHaveAttribute("contenteditable", "true");
  await page.getByRole("button", { name: "Lesemodus" }).click();
  await expect(content).toHaveAttribute("contenteditable", "false");
  // Remembered after a reload.
  await page.reload();
  await expect(page.getByLabel("Dokumentinhalt", { exact: true })).toHaveAttribute("contenteditable", "false");
  await page.getByRole("button", { name: "Bearbeiten" }).click();
  await expect(page.getByLabel("Dokumentinhalt", { exact: true })).toHaveAttribute("contenteditable", "true");
  await page.request.post("/api/command", { headers: { origin }, data: { action: "page.delete", pageId } });
});

// Records read like pages (issue #25): reading mode by button and ⌘⌥E,
// remembered per record, and as a full page across the whole width.
test("records switch to reading and open across the full width", async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  test.skip(testInfo.project.name !== "desktop", "The width matters on a large screen.");
  const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
  await page.request.post("/api/auth/demo", { headers: { origin } });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const command = async (data: Record<string, unknown>) =>
    (await page.request.post("/api/command", { headers: { origin }, data })).json();
  const db = (await command({ action: "page.create", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, title: `Notizen ${Date.now()}`, kind: "database" })).id;
  const row = (await command({ action: "row.create", pageId: db, cells: { title: "Heizung" } })).id;
  await page.goto(`/#page=${db}&row=${row}`);
  const record = page.getByRole("dialog", { name: "Eintrag" });
  const content = record.getByLabel("Dokumentinhalt", { exact: true });
  await expect(content).toHaveAttribute("contenteditable", "true");
  await record.getByRole("button", { name: "Lesemodus" }).click();
  await expect(content).toHaveAttribute("contenteditable", "false");
  // Remembered for this record after a reload; ⌘⌥E switches back.
  await page.reload();
  await expect(record.getByLabel("Dokumentinhalt", { exact: true })).toHaveAttribute("contenteditable", "false");
  await page.keyboard.press("ControlOrMeta+Alt+KeyE");
  await expect(record.getByLabel("Dokumentinhalt", { exact: true })).toHaveAttribute("contenteditable", "true");
  // As a full page, across the whole width.
  await record.getByRole("button", { name: "Als Seite öffnen", exact: true }).click();
  const narrow = (await record.boundingBox())!.width;
  await record.getByRole("button", { name: "Volle Breite" }).click();
  await expect.poll(async () => (await record.boundingBox())!.width).toBeGreaterThan(narrow + 100);
  await record.getByRole("button", { name: "Volle Breite" }).click();
  await command({ action: "page.delete", pageId: db });
});
