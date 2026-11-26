import { test, expect, type Page, type Route } from "@playwright/test";
import { randomBytes } from "node:crypto";

// Upload progress in documents (#561): a file dropped or pasted into a
// document shows a placeholder where it will go – its name, a progress bar
// with percent and size, a cancel button – that is only a decoration, never
// part of the document. The finished file lands at the placeholder even if
// the caret moved on; a cancelled upload leaves nothing and reports no error.

async function openDocument(page: Page, title: string) {
  const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
  await page.request.post("/api/auth/demo", { headers: { origin } });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const response = await page.request.post("/api/command", {
    headers: { origin },
    data: { action: "page.create", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, title, kind: "document" },
  });
  const created = await response.json();
  await page.goto(`/#page=${created.id}`);
  const text = page.locator(".page-content .ProseMirror").first();
  await expect(text).toBeVisible({ timeout: 20_000 });
  return { id: created.id as string, text };
}

// Files dropped onto the end of the document, as from the desktop.
async function drop(page: Page, files: { name: string; type: string; data: Buffer }[]) {
  await page
    .locator(".page-content .ProseMirror")
    .first()
    .evaluate((el, list) => {
      const data = new DataTransfer();
      for (const f of list) data.items.add(new File([Uint8Array.from(atob(f.data), (c) => c.charCodeAt(0))], f.name, { type: f.type }));
      const box = el.getBoundingClientRect();
      const at = { clientX: box.left + 20, clientY: box.bottom - 10, bubbles: true, cancelable: true, dataTransfer: data };
      el.dispatchEvent(new DragEvent("dragover", at));
      el.dispatchEvent(new DragEvent("drop", at));
    }, files.map((f) => ({ ...f, data: f.data.toString("base64") })));
}

// Holds every upload until released: the placeholder stays in view.
async function holdUploads(page: Page) {
  const waiting: Route[] = [];
  let release: () => void = () => {};
  const released = new Promise<void>((resolve) => (release = resolve));
  await page.route("**/api/upload", async (route) => {
    waiting.push(route);
    await released;
    await route.continue().catch(() => {});
  });
  return { waiting, release };
}

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGP4z8DwnyHhPwMDAwMDAwAtAAX/2Hl5uAAAAABJRU5ErkJggg==", "base64");

test("a dropped file: placeholder with progress where it goes, the file there when done", async ({ page }, info) => {
  test.setTimeout(90_000);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const { text } = await openDocument(page, `Hochladen ${info.project.name} ${Date.now()}`);
  await text.click();
  await page.keyboard.type("Vorher");
  await page.keyboard.press("Enter");
  await page.keyboard.type("Hier:");
  await page.keyboard.press("Enter");
  // A slow line: 3 MB at 384 KB/s, so the bar is seen moving.
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Network.enable");
  await cdp.send("Network.emulateNetworkConditions", { offline: false, latency: 20, downloadThroughput: -1, uploadThroughput: 384 * 1024 });
  await drop(page, [{ name: "messwerte.bin", type: "application/octet-stream", data: randomBytes(3 * 1024 * 1024) }]);

  const placeholder = text.locator(".upload-placeholder");
  await expect(placeholder).toHaveCount(1);
  await expect(placeholder).toContainText("messwerte.bin");
  const bar = placeholder.getByRole("progressbar", { name: "Hochladen von „messwerte.bin“" });
  await expect(bar).toHaveAttribute("aria-valuenow", /^\d+$/);
  await expect(placeholder.locator(".upload-placeholder-status")).toHaveText(/^\d+\s%\s·\s[\d,]+\s(B|KB|MB)\svon\s3\sMB$/);
  await expect(placeholder.getByRole("button", { name: "Hochladen von „messwerte.bin“ abbrechen" })).toBeVisible();
  // The bar fills up while the file goes out.
  await expect.poll(async () => Number(await bar.getAttribute("aria-valuenow")), { timeout: 15_000 }).toBeGreaterThan(0);
  const now = Number(await bar.getAttribute("aria-valuenow"));
  expect(now).toBeLessThan(100);
  await expect(placeholder.locator(".upload-placeholder-status")).toHaveText(/^\d+\s%\s·\s[\d,]+\s(KB|MB)\svon\s3\sMB$/);
  // Not part of the document: the editor's content has no trace of it.
  const html = () => page.evaluate(() => (document.querySelector(".page-content .ProseMirror") as HTMLElement & { editor?: { getHTML(): string } }).editor?.getHTML() ?? "");
  expect(await html()).not.toContain("messwerte");
  expect(await html()).not.toContain("upload-placeholder");

  // Meanwhile the caret goes up to the first line and writes there.
  await text.getByText("Vorher").click();
  await page.keyboard.press("Home");
  await page.keyboard.type("Neu: ");
  const link = text.getByRole("link", { name: "messwerte.bin" });
  await expect(link).toBeVisible({ timeout: 30_000 });
  await expect(placeholder).toHaveCount(0);
  // The file where it was dropped, the typing where the caret was.
  const order = await text.locator(":scope > p").allTextContents();
  expect(order[0]).toBe("Neu: Vorher");
  expect(order.indexOf("Hier:")).toBeGreaterThan(-1);
  expect(order.indexOf("messwerte.bin")).toBe(order.indexOf("Hier:") + 1);
  await expect(page.getByRole("status").filter({ hasText: "„messwerte.bin“ hochgeladen" })).toHaveCount(1);
  await cdp.send("Network.emulateNetworkConditions", { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  expect(errors).toEqual([]);
});

test("a pasted image: cancel removes the placeholder without an error, the next one arrives", async ({ page }, info) => {
  test.setTimeout(90_000);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const { text } = await openDocument(page, `Abbrechen ${info.project.name} ${Date.now()}`);
  await text.click();
  await page.keyboard.type("Bild:");
  await page.keyboard.press("Enter");
  const uploads = await holdUploads(page);
  const paste = (name: string) =>
    page.evaluate(
      ({ data, name }) => {
        const file = new File([Uint8Array.from(atob(data), (c) => c.charCodeAt(0))], name, { type: "image/png" });
        const transfer = new DataTransfer();
        transfer.items.add(file);
        document.querySelector(".page-content .ProseMirror")!.dispatchEvent(new ClipboardEvent("paste", { clipboardData: transfer, bubbles: true, cancelable: true }));
      },
      { data: PNG.toString("base64"), name },
    );
  await paste("skizze.png");
  const placeholder = text.locator(".upload-placeholder");
  await expect(placeholder).toHaveCount(1);
  await expect(placeholder.getByRole("progressbar", { name: "Hochladen von „skizze.png“" })).toBeVisible();
  await expect.poll(() => uploads.waiting.length).toBe(1);

  // Pictures of the placeholder for the review (UPLOAD_SHOTS=<folder>).
  if (process.env.UPLOAD_SHOTS)
    for (const scheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      await page.evaluate(() => {
        const el = document.querySelector(".upload-placeholder") as HTMLElement;
        el.style.setProperty("--upload-share", "0.37");
        el.querySelector(".upload-placeholder-status")!.textContent = "37 % · 17,8 MB von 48 MB";
      });
      await page.waitForTimeout(400);
      const box = (await text.boundingBox())!;
      await page.screenshot({
        path: `${process.env.UPLOAD_SHOTS}/561-${info.project.name}-${scheme}.png`,
        clip: { x: Math.max(0, box.x - 16), y: Math.max(0, box.y - 16), width: Math.min(box.width + 32, 820), height: 140 },
      });
    }
  await page.emulateMedia({ colorScheme: "light" });

  await placeholder.getByRole("button", { name: "Hochladen von „skizze.png“ abbrechen" }).click();
  await expect(placeholder).toHaveCount(0);
  uploads.release();
  await page.unroute("**/api/upload");
  // Nothing inserted, nothing reported.
  await page.waitForTimeout(500);
  await expect(text.locator("img")).toHaveCount(0);
  await expect(page.locator(".error-alert")).toHaveCount(0);
  await expect(page.getByRole("alert").filter({ hasText: /\S/ })).toHaveCount(0);

  // The next one goes through as usual.
  await paste("foto.png");
  await expect(text.locator('img[src^="/api/files/"]')).toHaveCount(1, { timeout: 20_000 });
  await expect(text.locator('img[alt="foto.png"]')).toHaveCount(1);
  await expect(placeholder).toHaveCount(0);
  expect(errors).toEqual([]);
});
