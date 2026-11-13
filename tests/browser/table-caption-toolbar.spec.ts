import { test, expect } from "@playwright/test";

// A table's caption comes from its row and column menus (#240: the old bar
// under the table and the "Add caption" button are gone); the "+" bar
// under the table never covers the caption.
test("the table caption is added from the handle menu and stays clear of the + bar", async ({ page }, info) => {
  test.skip(info.project.name === "mobile", "pointing with a mouse");
  const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
  await page.request.post("/api/auth/demo", { headers: { origin } });
  const command = async (data: Record<string, unknown>) => {
    const response = await page.request.post("/api/command", { headers: { origin }, data });
    expect(response.ok(), await response.text()).toBe(true);
    return response.json();
  };
  await command({ action: "profile.onboarded" });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const host = await command({
    action: "page.create",
    workspaceId: boot.workspace.id,
    spaceId: boot.spaces[0].id,
    title: `Tabelle Beschriftung ${info.project.name} ${Date.now()}`,
    kind: "document",
  });
  const { htmlState } = await import("../../lib/document-server");
  const html = "<table><tbody><tr><th><p>Aufgabe</p></th><th><p>x</p></th></tr><tr><td><p>a</p></td><td><p>1</p></td></tr><tr><td><p>b</p></td><td><p>2</p></td></tr></tbody></table><p>Danach.</p>";
  const generation = (await (await page.request.get(`/api/pages/${host.id}`)).json()).generation;
  await command({ action: "document.sync", pageId: host.id, generation, update: Buffer.from(htmlState(html)).toString("base64") });
  await page.goto(`/#page=${host.id}`);
  const editor = page.getByLabel("Dokumentinhalt", { exact: true });
  await expect(editor.locator("table")).toBeVisible({ timeout: 30_000 });
  await expect(editor.locator(".block-caption-add:visible")).toHaveCount(0);
  await editor.locator("td", { hasText: "b" }).hover();
  await page.getByRole("button", { name: "Zeile 3", exact: true }).click();
  await page.getByRole("menu", { name: "Zeile" }).getByRole("menuitem", { name: "Beschriftung" }).click();
  await page.keyboard.type("Seite 31");
  const caption = editor.locator(".block-caption-field").first();
  await expect(caption).toHaveValue("Seite 31");
  await editor.locator("td", { hasText: "b" }).hover();
  const add = page.getByRole("button", { name: "Zeile hinzufügen" });
  await expect(add).toBeVisible();
  const a = (await add.boundingBox())!;
  const b = (await caption.boundingBox())!;
  expect(a.y + a.height <= b.y || b.y + b.height <= a.y, JSON.stringify({ a, b })).toBe(true);
  // Nor the text after the table.
  const after = (await editor.locator("p", { hasText: "Danach." }).boundingBox())!;
  expect(a.y + a.height).toBeLessThanOrEqual(after.y);
});
