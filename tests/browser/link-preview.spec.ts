import { test, expect } from "@playwright/test";

test("the page preview closes when its link opens the page", async ({ page }, info) => {
  test.skip(info.project.name === "mobile", "Hover");
  const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
  await page.request.post("/api/auth/demo", { headers: { origin } });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const command = async (data: Record<string, unknown>) => {
    const response = await page.request.post("/api/command", { headers: { origin }, data });
    expect(response.ok(), await response.text()).toBe(true);
    return response.json();
  };
  const create = (title: string, kind: string) =>
    command({
      action: "page.create",
      workspaceId: boot.workspace.id,
      spaceId: boot.spaces[0].id,
      title,
      kind,
    });
  const board = await create(`Vorschau-Board ${Date.now()}`, "whiteboard");
  const doc = await create(`Vorschau-Dokument ${Date.now()}`, "document");
  const { htmlState } = await import("../../lib/document-server");
  const generation = (await (await page.request.get(`/api/pages/${doc.id}`)).json()).generation;
  await command({
    action: "document.sync",
    pageId: doc.id,
    generation,
    update: Buffer.from(
      htmlState(`<p>Board:</p><div data-whiteboard="${board.id}"></div>`),
    ).toString("base64"),
  });
  await page.goto(`/#page=${doc.id}`);
  const open = page.locator(".document-editor a", { hasText: "Öffnen" }).first();
  // A quick click, before the delayed preview appears: the preview must not
  // pop up on the next page afterwards.
  await open.hover();
  await open.click();
  await expect(page.locator(".whiteboard-page, .wb").first()).toBeVisible();
  await expect(page.locator(".link-preview")).toHaveCount(0);
  await page.waitForTimeout(1200);
  await expect(page.locator(".link-preview")).toHaveCount(0);
  // Hovering long enough still shows the preview on the next link.
  await page.goto(`/#page=${doc.id}`);
  await open.hover();
  await expect(page.locator(".link-preview")).toBeVisible();
  await command({ action: "page.delete", pageId: doc.id });
  await command({ action: "page.delete", pageId: board.id });
});
