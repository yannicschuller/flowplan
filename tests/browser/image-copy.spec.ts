import { test, expect } from "@playwright/test";

// Images keep the browser's own context menu (copy, save) and can be
// copied and pasted like text.
test("images can be right-clicked and copied", async ({ page, context }, info) => {
  test.skip(info.project.name !== "desktop", "Right-click and keyboard copy are desktop actions.");
  test.setTimeout(120_000);
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
  await page.request.post("/api/auth/demo", { headers: { origin } });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const created = await page.request.post("/api/command", {
    headers: { origin },
    data: { action: "page.create", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, title: `Bild ${Date.now()}`, kind: "document" },
  });
  const pageId = (await created.json()).id;
  await page.goto(`/#page=${pageId}`);
  const editor = page.getByLabel("Dokumentinhalt", { exact: true });
  await editor.click();
  const png = await page.evaluate(() => {
    const c = document.createElement("canvas");
    c.width = 200;
    c.height = 120;
    c.getContext("2d")!.fillRect(0, 0, 200, 120);
    return c.toDataURL("image/png").split(",")[1];
  });
  const upload = await page.request.post("/api/upload", {
    headers: { origin },
    multipart: { pageId, file: { name: "bild.png", mimeType: "image/png", buffer: Buffer.from(png, "base64") } },
  });
  const src = (await upload.json()).url as string;
  await page.evaluate((src) => {
    const el = document.querySelector(".ProseMirror") as HTMLElement & { editor: { chain: () => { focus: () => { setImage: (a: object) => { run: () => void } } } } };
    el.editor.chain().focus().setImage({ src, alt: "bild.png" }).run();
  }, src);
  const image = editor.locator("img").first();
  await expect(image).toBeVisible();

  // Right-click: the browser's menu, not the text menu (the event is not cancelled).
  const cancelled = await image.evaluate((img) => {
    const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 10, clientY: 10 });
    img.dispatchEvent(event);
    return event.defaultPrevented;
  });
  expect(cancelled).toBe(false);
  await expect(page.locator(".text-menu")).toHaveCount(0);

  // Select the image, copy, paste below: two images.
  await image.click();
  const mod = process.platform === "darwin" ? "Meta" : "Control";
  await page.keyboard.press(`${mod}+c`);
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("Enter");
  await page.keyboard.press(`${mod}+v`);
  await expect(editor.locator("img")).toHaveCount(2);
  expect(errors).toEqual([]);
});
