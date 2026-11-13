import { test, expect, type Page } from "@playwright/test";

const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";

async function imagePage(page: Page, color: string) {
  await page.request.post("/api/auth/demo", { headers: { origin } });
  await page.request.post("/api/command", { headers: { origin }, data: { action: "profile.onboarded" } });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const created = await page.request.post("/api/command", {
    headers: { origin },
    data: { action: "page.create", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, title: `Bildwerkzeuge ${Date.now()}`, kind: "document" },
  });
  const pageId = (await created.json()).id;
  await page.goto("about:blank");
  const picture = async (fill: string) => {
    const b64 = await page.evaluate((fill) => {
      const c = document.createElement("canvas");
      c.width = 480;
      c.height = 300;
      const ctx = c.getContext("2d")!;
      ctx.fillStyle = fill;
      ctx.fillRect(0, 0, 480, 300);
      return c.toDataURL("image/png").split(",")[1];
    }, fill);
    return Buffer.from(b64, "base64");
  };
  const png = await picture(color);
  const upload = await page.request.post("/api/upload", { headers: { origin }, multipart: { pageId, file: { name: "foto.png", mimeType: "image/png", buffer: png } } });
  expect(upload.ok(), await upload.text()).toBe(true);
  const src = (await upload.json()).url as string;
  const { htmlState } = await import("../../lib/document-server");
  const generation = (await (await page.request.get(`/api/pages/${pageId}`)).json()).generation;
  const sync = await page.request.post("/api/command", {
    headers: { origin },
    data: { action: "document.sync", pageId, generation, update: Buffer.from(htmlState(`<p>Vorher.</p><img src="${src}" alt="foto.png"><p>Danach kommt Text.</p>`)).toString("base64") },
  });
  expect(sync.ok()).toBe(true);
  return { pageId, src, other: await picture("#e03131") };
}

// #240: a corner toolbar on images instead of the caption button below them.
test("images: a corner toolbar with caption, download, full screen and more", async ({ page }, info) => {
  test.setTimeout(150_000);
  const { pageId, other } = await imagePage(page, "#4dabf7");
  await page.goto(`/#page=${pageId}`);
  const editor = page.getByLabel("Dokumentinhalt", { exact: true });
  const image = editor.locator("img").first();
  await expect(image).toBeVisible({ timeout: 30_000 });
  const toolbar = page.getByRole("toolbar", { name: "Bild", exact: true });
  if (info.project.name === "mobile") await image.tap();
  else await image.hover();
  await expect(toolbar).toBeVisible();
  // In the picture's top right corner.
  const bar = (await toolbar.boundingBox())!,
    pic = (await image.boundingBox())!;
  expect(bar.x + bar.width).toBeLessThanOrEqual(pic.x + pic.width + 1);
  expect(bar.x + bar.width).toBeGreaterThan(pic.x + pic.width - 20);
  expect(bar.y).toBeGreaterThanOrEqual(pic.y);
  expect(bar.y).toBeLessThan(pic.y + 20);
  for (const name of ["Kommentieren", "Beschriftung", "Bild ersetzen", "Herunterladen", "Vollbild", "Weitere Bildaktionen"])
    await expect(toolbar.getByRole("button", { name }), name).toBeVisible();
  // No "Add caption" button below the image any more; the resize handles stay.
  await expect(editor.locator(".block-caption-add:visible")).toHaveCount(0);
  if (info.project.name !== "mobile") await expect(editor.locator("[data-resize-handle='right']").first()).toBeVisible();
  await page.screenshot({ path: `test-results/image-tools-${info.project.name}.png` });

  // Download: the picture's file.
  const download = page.waitForEvent("download");
  await toolbar.getByRole("button", { name: "Herunterladen" }).click();
  expect((await download).suggestedFilename()).toBe("foto.png");

  // Full screen: the picture alone, Escape closes.
  if (info.project.name === "mobile") await image.tap();
  else await image.hover();
  await toolbar.getByRole("button", { name: "Vollbild" }).click();
  const viewer = page.getByRole("dialog", { name: "foto.png" });
  await expect(viewer.locator("img")).toBeVisible();
  await page.screenshot({ path: `test-results/image-tools-viewer-${info.project.name}.png` });
  await page.keyboard.press("Escape");
  await expect(viewer).toHaveCount(0);

  // Caption from the toolbar.
  if (info.project.name === "mobile") await image.tap();
  else await image.hover();
  await toolbar.getByRole("button", { name: "Beschriftung" }).click();
  await page.keyboard.type("Ein blaues Bild");
  await expect(editor.locator(".block-caption-field").first()).toHaveValue("Ein blaues Bild");

  // "…": centred.
  if (info.project.name === "mobile") await image.tap();
  else await image.hover();
  await toolbar.getByRole("button", { name: "Weitere Bildaktionen" }).click();
  const more = page.getByRole("menu", { name: "Bild" }).or(page.locator(".block-menu-sheet"));
  for (const name of ["Links", "Mitte", "Rechts", "Bild markieren", "Bild kopieren", "Link zum Block kopieren", "Löschen"])
    await expect(more.getByRole("menuitem", { name, exact: true }).or(more.getByRole("menuitemradio", { name, exact: true })), name).toHaveCount(1);
  await more.getByRole("menuitemradio", { name: "Mitte", exact: true }).click();
  await expect(editor.locator("img[data-align='center']")).toHaveCount(1);
  const centred = (await image.boundingBox())!,
    text = (await editor.boundingBox())!;
  expect(Math.abs(centred.x + centred.width / 2 - (text.x + text.width / 2))).toBeLessThan(30);

  // Replace: a new picture in the same place; the caption stays.
  if (info.project.name === "mobile") await image.tap();
  else await image.hover();
  const chooser = page.waitForEvent("filechooser");
  await toolbar.getByRole("button", { name: "Bild ersetzen" }).click();
  await (await chooser).setFiles({ name: "rot.png", mimeType: "image/png", buffer: other });
  await expect(editor.locator("img[alt='rot.png']")).toHaveCount(1, { timeout: 15_000 });
  await expect(editor.locator("img[data-align='center']")).toHaveCount(1);
  await expect(editor.locator(".block-caption-field").first()).toHaveValue("Ein blaues Bild");
});
