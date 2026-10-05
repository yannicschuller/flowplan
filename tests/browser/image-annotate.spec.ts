import { test, expect } from "@playwright/test";

// Marking up a photo in a document: draw, save as a new image, open again
// with the markings, remove them and get the original back.
test("mark up an image with the pen and remove the markings again", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "Drawing with the mouse is desktop-only here.");
  test.setTimeout(150_000);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
  await page.request.post("/api/auth/demo", { headers: { origin } });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const created = await page.request.post("/api/command", {
    headers: { origin },
    data: { action: "page.create", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, title: `Foto ${Date.now()}`, kind: "document" },
  });
  const pageId = (await created.json()).id;
  await page.goto(`/#page=${pageId}`);
  const editor = page.getByLabel("Dokumentinhalt", { exact: true });
  await editor.click();

  // A photo in the document (a generated PNG, uploaded like any image).
  const png = await page.evaluate(() => {
    const c = document.createElement("canvas");
    c.width = 400;
    c.height = 300;
    const ctx = c.getContext("2d")!;
    ctx.fillStyle = "#4dabf7";
    ctx.fillRect(0, 0, 400, 300);
    return c.toDataURL("image/png").split(",")[1];
  });
  const upload = await page.request.post("/api/upload", {
    headers: { origin },
    multipart: { pageId, file: { name: "foto.png", mimeType: "image/png", buffer: Buffer.from(png, "base64") } },
  });
  expect(upload.ok(), await upload.text()).toBe(true);
  const original = (await upload.json()).url as string;
  await page.evaluate((src) => {
    const el = document.querySelector(".ProseMirror") as HTMLElement & { editor: { chain: () => { focus: () => { setImage: (a: object) => { run: () => void } } } } };
    el.editor.chain().focus().setImage({ src, alt: "foto.png" }).run();
  }, original);
  const image = editor.locator("img").first();
  await expect(image).toBeVisible();

  // Double-click opens the editor; drawing a line and saving makes a new image.
  await image.dblclick();
  const dialog = page.getByRole("dialog", { name: "Bild markieren" });
  const canvas = dialog.getByLabel("Bild zum Markieren");
  await expect(canvas).toBeVisible();
  const box = (await canvas.boundingBox())!;
  await page.mouse.move(box.x + 40, box.y + 40);
  await page.mouse.down();
  await page.mouse.move(box.x + 200, box.y + 120, { steps: 10 });
  await page.mouse.up();
  await dialog.getByRole("radio", { name: "Pfeil" }).click();
  await page.mouse.move(box.x + 60, box.y + 200);
  await page.mouse.down();
  await page.mouse.move(box.x + 160, box.y + 160, { steps: 5 });
  await page.mouse.up();
  await dialog.getByRole("button", { name: "Speichern" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(image).not.toHaveAttribute("src", original);
  await expect(image).toHaveAttribute("data-original", original);
  const marked = JSON.parse((await image.getAttribute("data-annotations"))!);
  expect(marked.map((s: { type: string }) => s.type)).toEqual(["pen", "arrow"]);
  // The page keeps original and markings.
  await expect
    .poll(async () => (await (await page.request.get(`/api/pages/${pageId}`)).json()).html, { timeout: 15_000 })
    .toContain(`data-original="${original}"`);

  // Opened again, the markings are there and can be removed.
  await image.dblclick();
  await expect(dialog.getByRole("button", { name: "Rückgängig" })).toBeEnabled();
  await dialog.getByRole("button", { name: "Alle Markierungen entfernen" }).click();
  await dialog.getByRole("button", { name: "Speichern" }).click();
  await expect(image).toHaveAttribute("src", original);
  await expect(image).not.toHaveAttribute("data-original", /.+/);
  expect(errors).toEqual([]);
});
