import { test, expect, devices } from "@playwright/test";

// On iPhone and iPad, Safari prints the page itself (not a frame) and only
// while the tap still counts: "Print / PDF" puts the lean copy into the page
// and prints right away, with only the copy in print.
test.use({ ...devices["iPhone 13"], locale: "de-DE" });

test("print on iPhone prints a lean copy in the page right away", async ({ page }) => {
  test.setTimeout(90_000);
  const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
  await page.request.post("/api/auth/demo", { headers: { origin } });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const title = `Druck iOS ${Date.now()}`;
  const created = await page.request.post("/api/command", {
    headers: { origin },
    data: { action: "page.create", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, title, kind: "document" },
  });
  const pageId = (await created.json()).id;
  type Printed = { at: number; copying: boolean; text: string }[];
  await page.addInitScript(() => {
    const w = window as unknown as { printed: Printed };
    w.printed = [];
    window.print = () => {
      w.printed.push({
        at: performance.now(),
        copying: document.documentElement.classList.contains("printing-copy"),
        text: document.querySelector(".print-copy")?.textContent ?? "",
      });
    };
  });
  await page.goto(`/#page=${pageId}`);
  const editor = page.getByLabel("Dokumentinhalt", { exact: true });
  await editor.click();
  await page.keyboard.type("Ein Absatz zum Drucken.");
  await page.getByRole("button", { name: "Seitenaktionen" }).click();
  const item = page.getByRole("menuitem", { name: "Drucken / PDF" });
  await item.waitFor();
  const tapped = await page.evaluate(() => performance.now());
  await item.click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { printed: Printed }).printed.length)).toBe(1);
  const [printed] = await page.evaluate(() => (window as unknown as { printed: Printed }).printed);
  // Printed while the tap still counts (Safari forwards it for about a second).
  expect(printed.at - tapped).toBeLessThan(1000);
  expect(printed.copying).toBe(true);
  expect(printed.text).toContain("Ein Absatz zum Drucken.");
  expect(printed.text).toContain(title);
  await expect(page.locator("iframe.print-frame")).toHaveCount(0);
  await expect(page.getByRole("menu")).toHaveCount(0);
  // On screen the copy is hidden; in print only the copy shows.
  await expect(page.locator(".print-copy")).toBeHidden();
  await page.emulateMedia({ media: "print" });
  await expect(page.locator(".print-copy .page-content")).toBeVisible();
  await expect(page.locator(".app-shell")).toBeHidden();
  await page.emulateMedia({ media: "screen" });
  // After printing, the copy is gone.
  await page.evaluate(() => window.dispatchEvent(new Event("afterprint")));
  await expect(page.locator(".print-copy")).toHaveCount(0);
  await expect(page.locator(".app-shell")).toBeVisible();
});

// Apps on the home screen cannot print at all: the print view (with own
// pictures as data) opens in the browser, which has no session there.
test("print in the home screen app hands a print view to the browser", async ({ page, browser }) => {
  test.setTimeout(90_000);
  const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
  await page.request.post("/api/auth/demo", { headers: { origin } });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const command = async (data: Record<string, unknown>) =>
    (await page.request.post("/api/command", { headers: { origin }, data })).json();
  const title = `Druck App ${Date.now()}`;
  const { id: pageId } = await command({ action: "page.create", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, title, kind: "document" });
  // A 2×1 picture, uploaded like any other.
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAADklEQVR4nGP4z8DwH4QBEfcD/ePF9e8AAAAASUVORK5CYII=", "base64");
  const upload = await page.request.post("/api/upload", { headers: { origin }, multipart: { pageId, file: { name: "bild.png", mimeType: "image/png", buffer: png } } });
  const { url: picture } = await upload.json();
  const { htmlState } = await import("../../lib/document-server");
  const { generation } = await (await page.request.get(`/api/pages/${pageId}`)).json();
  await command({
    action: "document.sync",
    pageId,
    generation,
    update: Buffer.from(htmlState(`<p>Ein Absatz für den Browser.</p><img src="${picture}" alt="Bild">`)).toString("base64"),
  });
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "standalone", { value: true });
    const w = window as unknown as { printed: number };
    w.printed = 0;
    window.print = () => {
      w.printed++;
    };
  });
  await page.goto(`/#page=${pageId}`);
  await expect(page.getByLabel("Dokumentinhalt", { exact: true })).toContainText("Ein Absatz für den Browser.");
  await page.getByRole("button", { name: "Seitenaktionen" }).click();
  await page.getByRole("menuitem", { name: "Drucken / PDF" }).click();
  const dialog = page.locator("dialog.print-handoff");
  const open = dialog.getByRole("link", { name: "Druckansicht öffnen" });
  await expect(open).toBeVisible();
  await page.screenshot({ path: "test-results/print/handoff.png" });
  await expect(dialog.getByRole("link", { name: "In Safari öffnen" })).toHaveCount(origin.startsWith("https:") ? 1 : 0);
  // The app does not try to print itself.
  expect(await page.evaluate(() => (window as unknown as { printed: number }).printed)).toBe(0);
  const href = (await open.getAttribute("href"))!;
  expect(href).toMatch(/\/api\/print\/[\w-]{32}$/);
  // The browser: no session.
  const safari = await browser.newContext({ ...devices["iPhone 13"], locale: "de-DE" });
  try {
    const view = await safari.newPage();
    await view.addInitScript(() => {
      const w = window as unknown as { printed: number };
      w.printed = 0;
      window.print = () => {
        w.printed++;
      };
    });
    const response = await view.goto(href);
    // Only the print button's script runs, allowed by its hash.
    expect(response!.headers()["content-security-policy"]).toContain("script-src 'sha256-");
    await expect(view.locator(".page-content")).toContainText("Ein Absatz für den Browser.");
    await expect(view.locator("body")).toContainText(title);
    const image = view.locator('.page-content img[alt="Bild"]');
    expect(await image.getAttribute("src")).toMatch(/^data:image\/png;base64,/);
    await expect.poll(() => image.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(2);
    await view.screenshot({ path: "test-results/print/view.png" });
    await view.getByRole("button", { name: "Drucken / PDF" }).click();
    expect(await view.evaluate(() => (window as unknown as { printed: number }).printed)).toBe(1);
    await view.emulateMedia({ media: "print" });
    await expect(view.locator(".print-view-bar")).toBeHidden();
    await view.screenshot({ path: "test-results/print/view-print.png" });
  } finally {
    await safari.close();
  }
  // Another address does not show anything.
  expect((await page.request.get("/api/print/abcdefghijklmnopqrstuvwxyz012345")).status()).toBe(404);
});
