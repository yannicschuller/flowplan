import { test, expect, type Page, type Route } from "@playwright/test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Blurred placeholders of uploaded images (components/image-placeholder.ts,
// lib/image-placeholders.ts): while an image loads, its box already has the
// final size and shows the blurred picture; the image then fades in over
// it and nothing below moves. The image requests are held back here to
// look at the state before.

const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
const landscape = readFileSync(join(process.cwd(), "tests/fixtures/images/landscape.jpg"));
// Screenshots for reviews (not part of the test): SCREENSHOT_DIR=…
const shots = process.env.SCREENSHOT_DIR;

async function setup(page: Page) {
  await page.request.post("/api/auth/demo", { headers: { origin } });
  await page.request.post("/api/command", { headers: { origin }, data: { action: "profile.onboarded" } });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const command = async (data: Record<string, unknown>) => {
    const response = await page.request.post("/api/command", { headers: { origin }, data });
    expect(response.ok(), await response.text()).toBe(true);
    return response.json();
  };
  const upload = async (pageId: string) => {
    const response = await page.request.post("/api/upload", {
      headers: { origin },
      multipart: { pageId, file: { name: "landschaft.jpg", mimeType: "image/jpeg", buffer: landscape } },
    });
    expect(response.ok(), await response.text()).toBe(true);
    return (await response.json()) as { id: string; url: string; placeholder?: { w: number; h: number; hash?: string } };
  };
  return { boot, command, upload };
}

// Holds back the file's requests until release() (the image stays loading).
async function holdImage(page: Page, url: string) {
  const held: Route[] = [];
  let open = false;
  await page.route(`**${url}`, (route) => (open ? route.continue() : void held.push(route)));
  return async () => {
    open = true;
    for (const route of held.splice(0)) await route.continue();
  };
}

async function dismissWelcome(page: Page) {
  const welcome = page.getByRole("dialog", { name: /Willkommen bei Flowplan/ });
  if (await welcome.isVisible().catch(() => false)) await page.keyboard.press("Escape");
}

test("a document image holds its size with the blurred placeholder, then fades in", async ({ page }, info) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const { boot, command } = await setup(page);
  const doc = await command({ action: "page.create", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, title: `Bilder ${info.project.name}` });
  await page.goto(`/#page=${doc.id}`);
  await dismissWelcome(page);
  // Inserted like from the file picker of the editor.
  const editor = page.getByLabel("Dokumentinhalt", { exact: true });
  await editor.click();
  await page.keyboard.type("Vor dem Bild");
  await page.keyboard.press("Enter");
  await page.keyboard.type("Nach dem Bild");
  await editor.getByText("Vor dem Bild").click();
  await page.keyboard.press("End");
  const uploaded = page.waitForResponse((r) => r.url().endsWith("/api/upload"));
  await page.locator(".editor-wrapper input[type=file]").first().setInputFiles({ name: "Landschaft", mimeType: "image/jpeg", buffer: landscape });
  const file = (await (await uploaded).json()) as { id: string; url: string; placeholder?: { w: number; h: number; hash?: string } };
  // The upload answers with size and hash.
  expect(file.placeholder?.w).toBe(900);
  expect(file.placeholder?.h).toBe(600);
  expect(file.placeholder?.hash).toMatch(/^[A-Za-z0-9+/]+=*$/);
  await expect(editor.locator('img[alt="Landschaft"]')).toBeVisible();
  // The image between the two paragraphs, saved.
  await expect
    .poll(async () => (await (await page.request.get(`/api/pages/${doc.id}`)).json()).html)
    .toMatch(/Vor dem Bild.*<img[^>]*Landschaft.*Nach dem Bild/s);
  // Only files one may see are answered.
  const answer = await (await page.request.get(`/api/files/placeholders?ids=${file.id},00000000-0000-4000-8000-000000000000`)).json();
  expect(Object.keys(answer.placeholders)).toEqual([file.id]);

  // Opened again without the browser's cache, the image held back.
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Network.setCacheDisabled", { cacheDisabled: true });
  const release = await holdImage(page, file.url);
  await page.reload();
  const image = editor.locator('img[alt="Landschaft"]');
  await expect(image).toHaveClass(/fp-fade/);
  await expect(image).not.toHaveClass(/is-loaded/);
  // The frame shows the blurred picture; the image has its final shape.
  const frameBackground = () =>
    image.evaluate((img) => getComputedStyle(img.closest("[data-resize-wrapper], .fp-image-frame") as HTMLElement).backgroundImage);
  await expect.poll(frameBackground).toMatch(/^url\("data:image\/png;base64,/);
  const before = (await image.boundingBox())!;
  expect(before.width).toBeGreaterThan(100);
  expect(Math.abs(before.width / before.height - 1.5)).toBeLessThan(0.02);
  const after = editor.getByText("Nach dem Bild");
  const belowBefore = (await after.boundingBox())!.y;
  if (shots) {
    await page.screenshot({ path: `${shots}/placeholder-${info.project.name}-light.png` });
    await page.emulateMedia({ colorScheme: "dark" });
    await page.screenshot({ path: `${shots}/placeholder-${info.project.name}-dark.png` });
    await page.emulateMedia({ colorScheme: "light" });
  }

  await release();
  await expect(image).toHaveClass(/is-loaded/);
  await expect.poll(() => image.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(900);
  // Nothing moved, and once faded in the placeholder is gone (transparent
  // images would show it otherwise).
  const loaded = (await image.boundingBox())!;
  expect(Math.round(loaded.height)).toBe(Math.round(before.height));
  expect(Math.round((await after.boundingBox())!.y)).toBe(Math.round(belowBefore));
  await expect.poll(frameBackground).toBe("none");
  expect(await image.evaluate((img) => getComputedStyle(img).opacity)).toBe("1");
  if (shots) {
    await page.screenshot({ path: `${shots}/loaded-${info.project.name}-light.png` });
    await page.emulateMedia({ colorScheme: "dark" });
    await page.screenshot({ path: `${shots}/loaded-${info.project.name}-dark.png` });
    await page.emulateMedia({ colorScheme: "light" });
  }
  // Reading mode keeps the image as it is.
  await page.getByRole("button", { name: "Lesemodus", exact: true }).click();
  const framed = editor.locator('img[alt="Landschaft"]');
  await expect(framed).toBeVisible();
  await expect.poll(() => framed.evaluate((img) => getComputedStyle(img).opacity)).toBe("1");
  // Read-only documents (here: a locked page) frame the image themselves.
  await command({ action: "page.update", pageId: doc.id, patch: { locked: true } });
  await page.unroute(`**${file.url}`);
  const releaseAgain = await holdImage(page, file.url);
  await page.reload();
  const readOnly = page.locator('.fp-image-frame > img[alt="Landschaft"]');
  await expect(readOnly).toHaveClass(/fp-fade/);
  await expect.poll(() => readOnly.evaluate((img) => getComputedStyle(img.parentElement!).backgroundImage)).toMatch(/^url\("data:image\/png;base64,/);
  const held = (await readOnly.boundingBox())!;
  expect(Math.abs(held.width / held.height - 1.5)).toBeLessThan(0.02);
  await releaseAgain();
  await expect(readOnly).toHaveClass(/is-loaded/);
  expect(Math.round((await readOnly.boundingBox())!.height)).toBe(Math.round(held.height));
  expect(errors).toEqual([]);
});

test("covers and gallery cards show the placeholder until their image is there", async ({ page }, info) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const { boot, command, upload } = await setup(page);
  const db = await command({ action: "page.create", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, title: `Galerie ${info.project.name}`, kind: "database" });
  const file = await upload(db.id);
  const read = async () => (await page.request.get(`/api/pages/${db.id}`)).json();
  await command({
    action: "database.update",
    pageId: db.id,
    version: (await read()).database.version,
    fields: [
      { id: "title", name: "Name", type: "text" },
      { id: "pic", name: "Bild", type: "files" },
    ],
    views: [{ id: "gallery", name: "Galerie", type: "gallery", filters: [], sorts: [], gallery: { cover: "field", fieldId: "pic", fit: "cover", size: "medium" } }],
  });
  await command({ action: "row.create", pageId: db.id, cells: { title: "Berge", pic: [file.url] } });
  await command({ action: "page.update", pageId: db.id, patch: { cover: file.url } });

  const release = await holdImage(page, file.url);
  await page.goto(`/#page=${db.id}`);
  await dismissWelcome(page);
  const cover = page.locator(".page-cover");
  const card = page.locator(".record-card .gallery-cover");
  for (const box of [cover, card]) {
    await expect(box.locator("img")).toHaveClass(/fp-fade/);
    await expect.poll(() => box.evaluate((el) => getComputedStyle(el).backgroundImage)).toMatch(/^url\("data:image\/png;base64,/);
  }
  await release();
  for (const box of [cover, card]) {
    await expect(box.locator("img")).toHaveClass(/is-loaded/);
    await expect.poll(() => box.evaluate((el) => getComputedStyle(el).backgroundImage)).toBe("none");
  }
  expect(errors).toEqual([]);
});
