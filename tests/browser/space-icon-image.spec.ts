import { test, expect, type Page } from "@playwright/test";
import { deflateSync } from "node:zlib";

// An uploaded image as the space symbol (#251): chosen in "Bereich
// hinzufügen", shown in the sidebar, removed again in "Bereich verwalten".

// A small PNG (a diagonal gradient) without image libraries.
function png(size = 96) {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf: Buffer) => {
    let c = 0xffffffff;
    for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4), sum = Buffer.alloc(4), body = Buffer.concat([Buffer.from(type), data]);
    len.writeUInt32BE(data.length);
    sum.writeUInt32BE(crc(body));
    return Buffer.concat([len, body, sum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // RGB
  const raw = Buffer.alloc((size * 3 + 1) * size);
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const at = y * (size * 3 + 1) + 1 + x * 3;
      raw[at] = 230;
      raw[at + 1] = Math.round((x / size) * 200);
      raw[at + 2] = Math.round((y / size) * 255);
    }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

async function navigation(page: Page, mobile: boolean) {
  if (!(await page.locator(".app-shell").getAttribute("class"))?.includes("nav-open") && mobile)
    await page.locator(".topbar").getByRole("button", { name: "Navigation öffnen", exact: true }).click();
}

test("upload an image as space symbol, see it in the sidebar, remove it again", async ({ page }, info) => {
  const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
  await page.request.post("/api/auth/demo", { headers: { origin } });
  const bootstrap = async () => (await page.request.get("/api/bootstrap")).json();
  const command = async (data: Record<string, unknown>) => {
    const r = await page.request.post("/api/command", { headers: { origin }, data });
    expect(r.ok(), await r.text()).toBe(true);
    return r.json();
  };
  const mobile = info.project.name === "mobile",
    name = `Image space ${info.project.name} ${Date.now()}`;
  await command({ action: "profile.onboarded" });
  let sid = "";
  try {
    await page.goto("/");
    await navigation(page, mobile);
    await page.getByRole("button", { name: "Bereich hinzufügen", exact: true }).click();
    let dialog = page.getByRole("dialog", { name: "Bereich hinzufügen", exact: true });
    await dialog.getByLabel("Name", { exact: true }).fill(name);
    await expect(dialog.getByRole("button", { name: "Bild hochladen", exact: true })).toBeVisible();
    await dialog.getByLabel("Bild für den Bereich", { exact: true }).setInputFiles({ name: "space.png", mimeType: "image/png", buffer: png() });
    // The preview in the button shows the image; the colour has no say.
    await expect(dialog.locator(".space-icon.has-image img")).toHaveAttribute("src", /^data:image\/(webp|png);base64,/);
    await expect(dialog.getByLabel("Hintergrundfarbe")).toHaveCount(0);
    await dialog.screenshot({ path: `test-results/${info.project.name}-space-icon-dialog.png`, animations: "disabled" });
    await dialog.getByRole("button", { name: "Bereich erstellen", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    const created = (await bootstrap()).spaces.find((s: any) => s.name === name);
    sid = created.id;
    expect(created.icon).toMatch(/^data:image\/(webp|png);base64,/);

    await navigation(page, mobile);
    const row = page.locator(".nav-section").filter({
      has: page.getByRole("button", { name: `Bereich ${name} verwalten`, exact: true }),
    });
    const image = row.locator(".space-toggle .space-icon.has-image img");
    await expect(image).toHaveAttribute("src", created.icon);
    await expect.poll(() => image.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth)).toBe(128);
    const box = await row.locator(".space-toggle .space-icon").boundingBox();
    expect(Math.round(box!.width)).toBe(27);
    expect(Math.round(box!.height)).toBe(27);
    await row.scrollIntoViewIfNeeded();
    await page.screenshot({ path: `test-results/${info.project.name}-space-icon-image.png`, animations: "disabled" });

    // "Entfernen" goes back to the default folder symbol.
    await page.getByRole("button", { name: `Bereich ${name} verwalten`, exact: true }).click();
    await page.getByRole("menuitem", { name: "Bereich bearbeiten …", exact: true }).click();
    dialog = page.getByRole("dialog", { name: "Bereich verwalten", exact: true });
    await dialog.getByRole("button", { name: "Entfernen", exact: true }).click();
    await expect(dialog.locator(".space-icon.has-image")).toHaveCount(0);
    await expect(dialog.getByLabel("Hintergrundfarbe")).toBeVisible();
    await dialog.getByRole("button", { name: "Speichern", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    expect((await bootstrap()).spaces.find((s: any) => s.id === sid).icon).toBe("folder");
    await navigation(page, mobile);
    await expect(row.locator(".space-toggle .space-icon.has-image")).toHaveCount(0);
  } finally {
    if (sid) {
      let s = (await bootstrap()).managedSpaces.find((x: any) => x.id === sid);
      if (s) await command({ action: "space.delete", spaceId: sid, version: s.version, confirmName: s.name });
      s = (await bootstrap()).trashedSpaces.find((x: any) => x.id === sid);
      if (s) await command({ action: "space.purge", spaceId: sid, version: s.version, confirmName: s.name });
    }
  }
});
