import { test, expect } from "@playwright/test";

// "Copy image" in the toolbar puts the selected picture on the clipboard (a
// phone has no right-click menu); the app turns pinch-to-zoom off, the web
// keeps it.
async function imagePage(page: import("@playwright/test").Page) {
  const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
  await page.request.post("/api/auth/demo", { headers: { origin } });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const created = await page.request.post("/api/command", {
    headers: { origin },
    data: { action: "page.create", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, title: `Kopie ${Date.now()}`, kind: "document" },
  });
  const pageId = (await created.json()).id;
  await page.goto("/");
  const b64 = await page.evaluate(() => {
    const c = document.createElement("canvas");
    c.width = 400;
    c.height = 300;
    const ctx = c.getContext("2d")!;
    ctx.fillStyle = "#4dabf7";
    ctx.fillRect(0, 0, 400, 300);
    return c.toDataURL("image/png").split(",")[1];
  });
  const png = Buffer.from(b64, "base64");
  const upload = await page.request.post("/api/upload", { headers: { origin }, multipart: { pageId, file: { name: "foto.png", mimeType: "image/png", buffer: png } } });
  expect(upload.ok(), await upload.text()).toBe(true);
  return { pageId, src: (await upload.json()).url as string };
}

test("the toolbar copies the selected image as PNG", async ({ page }) => {
  test.setTimeout(150_000);
  await page.addInitScript(() => {
    (window as unknown as { __copied: string[] }).__copied = [];
    (window as unknown as { ClipboardItem: unknown }).ClipboardItem = class { constructor(public items: Record<string, Blob>) {} };
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { write: async (items: { items: Record<string, Blob> }[]) => { (window as unknown as { __copied: string[] }).__copied.push(...Object.keys(items[0].items)); }, writeText: async () => {} },
    });
  });
  const { pageId, src } = await imagePage(page);
  await page.goto(`/#page=${pageId}`);
  const editor = page.getByLabel("Dokumentinhalt", { exact: true });
  // The introduction a new account sees first.
  const skip = page.getByRole("button", { name: "Überspringen" });
  if (await skip.waitFor({ timeout: 30_000 }).then(() => true, () => false)) await skip.click();
  await editor.click();
  await page.evaluate((s) => {
    const el = document.querySelector(".ProseMirror") as HTMLElement & { editor: { chain: () => { focus: () => { setImage: (a: object) => { run: () => void } } } } };
    el.editor.chain().focus().setImage({ src: s, alt: "foto.png" }).run();
  }, src);
  const image = editor.locator("img").first();
  await expect(image).toBeVisible();
  await image.click();
  await page.getByRole("button", { name: "Bild kopieren" }).click();
  await expect(page.getByText("Bild kopiert")).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { __copied: string[] }).__copied)).toEqual(["image/png"]);
});

test("pinch-to-zoom is off in the app and stays on in the browser", async ({ page, browser }) => {
  await page.goto("/");
  await expect(page.locator('meta[name="viewport"]')).not.toHaveAttribute("content", /user-scalable=no/);
  const context = await browser.newContext({ userAgent: "Mozilla/5.0 FlowplanMobile/1.0" });
  const app = await context.newPage();
  await app.goto("/");
  await expect(app.locator('meta[name="viewport"]')).toHaveAttribute("content", /maximum-scale=1, user-scalable=no/);
  await expect(app.locator("html.native-app")).toHaveCount(1);
  await context.close();
});
