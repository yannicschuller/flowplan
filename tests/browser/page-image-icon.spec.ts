import { test, expect } from "@playwright/test";

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==",
  "base64",
);

test("pages accept an uploaded image as icon, show it in navigation and switch back to emoji", async ({
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
    title: `Bildsymbol ${testInfo.project.name} ${Date.now()}`,
  });
  const read = async () =>
    (await page.request.get(`/api/pages/${p.id}`)).json();
  await page.goto(`/#page=${p.id}`);
  await expect(page.locator(".tiptap")).toBeVisible();
  await page
    .getByRole("button", { name: "Seiten-Icon ändern", exact: true })
    .click();
  const dialog = page.getByRole("dialog", { name: "Seiten-Icon", exact: true });
  await dialog.getByRole("tab", { name: "Bild", exact: true }).click();
  await dialog.locator('input[type="file"]').setInputFiles({
    name: "logo.png",
    mimeType: "image/png",
    buffer: png,
  });
  await expect(dialog).toHaveCount(0);
  await expect
    .poll(async () => (await read()).page.icon)
    .toMatch(/^\/api\/files\/[0-9a-f-]{36}$/);
  const icon = (await read()).page.icon;
  await expect(
    page.locator(`img.page-image-icon[src="${icon}"]`).first(),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.locator(`img.page-image-icon[src="${icon}"]`).first(),
  ).toBeVisible();
  await page.screenshot({
    path: `test-results/page-icon-verification/${testInfo.project.name}-image-icon.png`,
  });
  // Existing images of the page can be selected again.
  await page
    .getByRole("button", { name: "Seiten-Icon ändern", exact: true })
    .click();
  await dialog.getByRole("tab", { name: "Bild", exact: true }).click();
  await expect(
    dialog.getByRole("option", { name: "logo.png als Seitensymbol" }),
  ).toHaveAttribute("aria-selected", "true");
  await dialog.getByRole("tab", { name: "Emoji", exact: true }).click();
  await dialog
    .getByRole("searchbox", { name: "Emoji suchen", exact: true })
    .fill("Rakete");
  await dialog.getByRole("button", { name: "Rakete 🚀", exact: true }).click();
  await expect.poll(async () => (await read()).page.icon).toBe("🚀");
  expect(errors).toEqual([]);
  await command({ action: "page.delete", pageId: p.id });
});
