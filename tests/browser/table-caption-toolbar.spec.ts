import { test, expect } from "@playwright/test";

// The table toolbar sits below the table's "Add caption" button (or its
// caption), never on top of it.
test("the table toolbar does not cover the caption or its add button", async ({ page }, info) => {
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
  await editor.locator("td", { hasText: "b" }).click();
  const tools = page.getByRole("toolbar", { name: "Tabelle", exact: true });
  await expect(tools).toBeVisible();
  const add = editor.locator(".block-caption-add").first();
  await expect(add).toBeVisible();
  const overlap = async () => {
    const a = (await add.boundingBox())!;
    const b = (await tools.boundingBox())!;
    return a.y < b.y + b.height && b.y < a.y + a.height && a.x < b.x + b.width && b.x < a.x + a.width;
  };
  await expect.poll(overlap).toBe(false);
  // With a caption, too.
  await add.click();
  await page.keyboard.type("Seite 31");
  await editor.locator("td", { hasText: "b" }).click();
  await expect(tools).toBeVisible();
  const caption = editor.locator(".block-caption-field").first();
  await expect.poll(async () => {
    const a = (await caption.boundingBox())!;
    const b = (await tools.boundingBox())!;
    return a.y < b.y + b.height && b.y < a.y + a.height;
  }).toBe(false);
});
