import { test, expect } from "@playwright/test";

test("hovering page links shows a permission-checked preview card", async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name === "mobile",
    "Hover previews need a pointer.",
  );
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
  const tag = Date.now();
  const target = await command({
    action: "page.import",
    workspaceId: boot.workspace.id,
    spaceId: boot.spaces[0].id,
    title: `Zielseite ${tag}`,
    format: "markdown",
    content: "Hier steht die Einleitung der Zielseite.",
  });
  const source = await command({
    action: "page.import",
    workspaceId: boot.workspace.id,
    spaceId: boot.spaces[0].id,
    title: `Quelle ${tag}`,
    format: "html",
    content: `<p>Siehe <a href="/#page=${target.id}">die Zielseite</a>.</p>`,
  });
  const preview = await (
    await page.request.get(`/api/pages/${target.id}/preview`)
  ).json();
  expect(preview.excerpt).toContain("Einleitung");
  await page.goto(`/#page=${source.id}`);
  const link = page.locator(".tiptap a", { hasText: "die Zielseite" });
  await expect(link).toBeVisible();
  await link.hover();
  const card = page.getByRole("tooltip");
  await expect(card).toContainText(`Zielseite ${tag}`);
  await expect(card).toContainText("Einleitung der Zielseite");
  await page.screenshot({
    path: `test-results/link-preview-verification/desktop-card.png`,
  });
  await page.mouse.move(5, 5);
  await expect(card).toHaveCount(0);
  // Pages the viewer cannot read do not reveal anything.
  const hidden = await page.request.get(
    `/api/pages/00000000-0000-4000-8000-000000000000/preview`,
  );
  expect(hidden.ok()).toBe(false);
  expect(errors).toEqual([]);
  for (const p of [source, target])
    await command({ action: "page.delete", pageId: p.id });
});
