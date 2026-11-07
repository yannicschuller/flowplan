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

test("files are deleted into the trash, unused ones marked, and restored (#164)", async ({
  page,
}, testInfo) => {
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
  const tag = `${testInfo.project.name}${Date.now()}`;
  const p = await command({
    action: "page.create",
    workspaceId: boot.workspace.id,
    spaceId: boot.spaces[0].id,
    title: `Aufräumen ${tag}`,
  });
  const urls: string[] = [];
  for (const name of [`cover-${tag}.png`, `weg-${tag}.png`, `alt-${tag}.png`]) {
    const upload = await page.request.post("/api/upload", {
      headers: { origin },
      multipart: { pageId: p.id, file: { name, mimeType: "image/png", buffer: png } },
    });
    expect(upload.ok(), await upload.text()).toBe(true);
    urls.push((await upload.json()).url);
  }
  // Only the first image is used (as the page's cover).
  await command({ action: "page.update", pageId: p.id, patch: { cover: urls[0] } });
  await command({ action: "profile.onboarded" });
  await page.goto("/#media");
  const library = page.locator(".media-library");
  await library.getByLabel("Dateien suchen").fill(tag);
  const grid = library.getByRole("list", { name: "Dateien" });
  await expect(grid.locator(".media-item")).toHaveCount(3);
  await expect(grid.locator(".media-item .media-unused")).toHaveCount(2);
  await grid.getByRole("checkbox", { name: `weg-${tag}.png auswählen` }).check();
  const selection = library.getByRole("toolbar", { name: "Dateiauswahl" });
  await expect(selection).toContainText("1 ausgewählt");
  await page.screenshot({ path: `test-results/media-library-verification/delete-${testInfo.project.name}.png` });
  await selection.getByRole("button", { name: "In den Papierkorb" }).click();
  await expect(library.getByRole("status")).toContainText("1 Datei in den Papierkorb verschoben.");
  await expect(grid).not.toContainText(`weg-${tag}.png`);
  expect((await page.request.get(urls[1])).status()).toBe(404);
  await library.getByRole("radio", { name: /Nicht verwendet/ }).click();
  await expect(grid.locator(".media-item")).toHaveCount(1);
  await library.getByRole("button", { name: "Alle unbenutzten löschen" }).click();
  const dialog = page.getByRole("dialog", { name: "Alle unbenutzten löschen" });
  await expect(dialog).toContainText("Versionsverlauf");
  await page.screenshot({ path: `test-results/media-library-verification/unused-${testInfo.project.name}.png` });
  await dialog.getByRole("button", { name: "Abbrechen" }).click();
  await library.getByRole("button", { name: "Papierkorb öffnen" }).click();
  const row = page.locator(".trash-view .file-trash .trash-row", { hasText: `weg-${tag}.png` });
  await expect(row).toBeVisible();
  await page.screenshot({ path: `test-results/media-library-verification/trash-${testInfo.project.name}.png` });
  await row.getByRole("button", { name: "Wiederherstellen" }).click();
  await expect(row).toHaveCount(0);
  expect((await page.request.get(urls[1])).status()).toBe(200);
  expect(errors).toEqual([]);
  await command({ action: "page.delete", pageId: p.id });
});
