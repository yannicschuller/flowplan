import { test, expect } from "@playwright/test";

test("typing and cursors reach a second window within a fraction of a second", async ({
  browser,
}, info) => {
  test.skip(info.project.name !== "desktop", "One run is enough for timing.");
  const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
  const open = async () => {
    const context = await browser.newContext({ baseURL: origin });
    const page = await context.newPage();
    await page.request.post("/api/auth/demo", { headers: { origin } });
    return { context, page };
  };
  const a = await open(),
    b = await open();
  const boot = await (await a.page.request.get("/api/bootstrap")).json();
  const created = await a.page.request.post("/api/command", {
    headers: { origin },
    data: {
      action: "page.create",
      workspaceId: boot.workspace.id,
      spaceId: boot.spaces[0].id,
      kind: "document",
      title: `Live ${Date.now()}`,
    },
  });
  const { id } = await created.json();
  await a.page.goto(`/#page=${id}`);
  await b.page.goto(`/#page=${id}`);
  const editorA = a.page.getByLabel("Dokumentinhalt", { exact: true });
  const editorB = b.page.getByLabel("Dokumentinhalt", { exact: true });
  await expect(editorA).toBeVisible();
  await expect(editorB).toBeVisible();
  // Both windows open their live channel.
  await a.page.waitForTimeout(1500);

  await editorA.click();
  const timings: number[] = [];
  for (const word of ["Erstens", "Zweitens", "Drittens"]) {
    await a.page.keyboard.type(` ${word}`);
    const start = Date.now();
    await expect(editorB).toContainText(word, { timeout: 5000 });
    timings.push(Date.now() - start);
  }
  // Before: up to about 3.6 s (save every 1.8 s, poll every 1.8 s). The
  // development server has the odd slow response, so the typical value is
  // held tight and the worst one well below the old delay.
  const sorted = [...timings].sort((x, y) => x - y);
  expect(sorted[1], `Latenzen ${timings.join(", ")} ms`).toBeLessThan(700);
  expect(sorted[2], `Latenzen ${timings.join(", ")} ms`).toBeLessThan(2000);

  // The cursor of window A appears in B without waiting for a poll.
  await editorB.click();
  await a.page.keyboard.press("ArrowLeft");
  await expect(b.page.locator(".collaborator-cursor").first()).toBeAttached({ timeout: 3000 });
  await a.context.close();
  await b.context.close();
});
