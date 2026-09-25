import { test, expect } from "@playwright/test";

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==",
  "base64",
);

test("the media overview shows, filters and opens workspace files", async ({
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
  const tag = `${testInfo.project.name}${Date.now()}`;
  const p = await command({
    action: "page.create",
    workspaceId: boot.workspace.id,
    spaceId: boot.spaces[0].id,
    title: `Medienablage ${tag}`,
  });
  for (const [name, mimeType, buffer] of [
    [`foto-${tag}.png`, "image/png", png],
    [`bericht-${tag}.pdf`, "application/pdf", Buffer.from("%PDF-1.4\n%%EOF")],
  ] as const) {
    const upload = await page.request.post("/api/upload", {
      headers: { origin },
      multipart: { pageId: p.id, file: { name, mimeType, buffer } },
    });
    expect(upload.ok(), await upload.text()).toBe(true);
  }
  await page.goto("/#media");
  const library = page.locator(".media-library");
  await expect(library.getByRole("heading", { name: "Medien" })).toBeVisible();
  await library.getByLabel("Dateien suchen").fill(tag);
  const grid = library.getByRole("list", { name: "Dateien" });
  await expect(grid.locator(".media-item")).toHaveCount(2);
  await expect(grid.locator(".media-thumb img")).toHaveCount(1);
  expect(
    await grid
      .locator(".media-thumb img")
      .evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth),
  ).toBe(1);
  await library.getByRole("radio", { name: "PDF" }).click();
  await expect(grid.locator(".media-item")).toHaveCount(1);
  await expect(grid).toContainText(`bericht-${tag}.pdf`);
  await page.screenshot({
    path: `test-results/media-library-verification/${testInfo.project.name}.png`,
  });
  await grid.getByRole("button", { name: `Medienablage ${tag}` }).click();
  await expect(page).toHaveURL(new RegExp(`page=${p.id}`));
  await expect(page.locator(".tiptap")).toBeVisible();
  expect(errors).toEqual([]);
  await command({ action: "page.delete", pageId: p.id });
});
