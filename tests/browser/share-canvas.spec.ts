import { test, expect, type CDPSession, type Page } from "@playwright/test";

// Guests editing whiteboards and notebooks through an edit link (#280,
// lib/share-canvas.ts, components/shared-canvas.tsx): a fresh browser
// without an account edits live with a member; uploads stay closed.
test.use({ hasTouch: true });
const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
type Point = { x: number; y: number };

async function setup(page: Page, kind: "whiteboard" | "notebook") {
  await page.request.post("/api/auth/demo", { headers: { origin } });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const command = async (data: Record<string, unknown>) => {
    const response = await page.request.post("/api/command", { headers: { origin }, data });
    if (!response.ok()) throw new Error(await response.text());
    return response.json();
  };
  await command({ action: "profile.onboarded" });
  const id = (await command({ action: "page.create", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, title: `Geteilt ${Date.now()}`, kind })).id as string;
  const token = (await command({ action: "share.create", pageId: id, role: "editor", name: "Kunde" })).token as string;
  return { id, token, command };
}
async function pen(cdp: CDPSession, points: Point[]) {
  const base = { pointerType: "pen" as const, button: "left" as const, buttons: 1 };
  await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: points[0].x, y: points[0].y, clickCount: 1, force: 0.4, ...base });
  for (const p of points.slice(1)) await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: p.x, y: p.y, force: 0.5, ...base });
  const last = points[points.length - 1];
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: last.x, y: last.y, clickCount: 1, ...base });
}
const line = (from: Point, to: Point, steps = 14) =>
  Array.from({ length: steps + 1 }, (_, i) => ({ x: from.x + ((to.x - from.x) * i) / steps, y: from.y + ((to.y - from.y) * i) / steps + Math.sin(i) * 5 }));

test("a guest edits a shared whiteboard live with a member, without uploads", async ({ page, browser }, info) => {
  test.skip(info.project.name === "mobile", "Desktop pointer gestures");
  const { id, token } = await setup(page, "whiteboard");
  await page.goto(`/#page=${id}`);
  const memberBoard = page.getByLabel("Whiteboard", { exact: true });
  await expect(memberBoard.locator(".wb-canvas")).toBeVisible();

  // The guest: a fresh browser, no account.
  const context = await browser.newContext({ viewport: page.viewportSize(), locale: "de-DE" });
  const guest = await context.newPage();
  const errors: string[] = [];
  guest.on("pageerror", (e) => errors.push(e.message));
  await guest.goto(`${origin}/share/${token}`);
  await guest.getByRole("button", { name: "Whiteboard bearbeiten" }).click();
  const wb = guest.getByLabel("Whiteboard", { exact: true });
  const canvas = wb.locator(".wb-canvas");
  // The editor's code loads on demand (slow on a cold dev server).
  await expect(canvas).toBeVisible({ timeout: 60_000 });

  // No upload, image search, page links, templates or AI in the panel.
  await wb.getByRole("button", { name: "Einfügen und mehr", exact: true }).click();
  const panel = wb.locator(".wb-plus");
  await expect(panel.getByRole("button", { name: "Emoji", exact: true })).toBeVisible();
  for (const name of ["Bild", "Bilder und Symbole suchen", "Seite verknüpfen", "Importieren …", "Vorlagen", "Einbetten"])
    await expect(panel.getByRole("button", { name, exact: true })).toHaveCount(0);
  await guest.keyboard.press("Escape");
  await expect(wb.getByRole("button", { name: "Moderation", exact: true })).toHaveCount(0);

  // A sticky note by double click; the member sees it live.
  const box = (await canvas.boundingBox())!;
  await canvas.dblclick({ position: { x: box.width / 2, y: box.height / 2 } });
  await guest.keyboard.type("Vom Gast");
  await guest.keyboard.press("Escape");
  await expect(wb.locator(".wb-sticky")).toContainText("Vom Gast");
  const seen = memberBoard.locator(".wb-sticky", { hasText: "Vom Gast" });
  await expect(seen).toBeVisible({ timeout: 10_000 });

  // Moved by the guest: it moves for the member too.
  const before = (await seen.boundingBox())!;
  await guest.keyboard.press("Escape");
  const note = (await wb.locator(".wb-sticky").boundingBox())!;
  await guest.mouse.move(note.x + 20, note.y + 20);
  await guest.mouse.down();
  await guest.mouse.move(note.x + 20 + 180, note.y + 20 + 90, { steps: 8 });
  await guest.mouse.up();
  await expect.poll(async () => Math.round((await seen.boundingBox())!.x - before.x), { timeout: 10_000 }).toBeGreaterThan(100);

  // The guest's pointer shows the link's guest name to the member.
  await guest.mouse.move(box.x + 100, box.y + 100);
  await guest.mouse.move(box.x + 160, box.y + 130, { steps: 4 });
  await expect(page.locator(".wb-cursor", { hasText: "Gast · Kunde" })).toBeVisible({ timeout: 5000 });

  // Dropping a file: not uploaded, said so.
  await canvas.dispatchEvent("drop", {
    dataTransfer: await guest.evaluateHandle(() => {
      const data = new DataTransfer();
      data.items.add(new File([new Uint8Array([137, 80, 78, 71])], "bild.png", { type: "image/png" }));
      return data;
    }),
  });
  await expect(guest.locator(".shared-canvas [role=alert]")).toContainText("Hochladen ist für Gäste nicht möglich.");

  // The upload endpoints refuse the guest.
  const upload = await guest.request.post(`${origin}/api/share/${token}/files`, {
    headers: { origin },
    multipart: { pageId: id, file: { name: "a.png", mimeType: "image/png", buffer: Buffer.from("89504e470d0a1a0a", "hex") } },
  });
  expect(upload.status()).toBe(403);
  expect((await guest.request.post(`${origin}/api/upload`, { headers: { origin }, multipart: { pageId: id, file: { name: "a.png", mimeType: "image/png", buffer: Buffer.from("89504e470d0a1a0a", "hex") } } })).status()).toBe(401);
  expect((await guest.request.post(`${origin}/api/whiteboards/import`, { headers: { origin }, multipart: { pageId: id, file: { name: "a.excalidraw", mimeType: "application/json", buffer: Buffer.from("{}") } } })).status()).toBe(401);
  expect(errors).toEqual([]);
  await context.close();
});

test("a guest writes on a shared notebook and the owner sees the stroke", async ({ page, browser }, info) => {
  test.skip(info.project.name !== "desktop", "Pen input runs on the desktop project.");
  const { id, token } = await setup(page, "notebook");
  await page.goto(`/#page=${id}`);
  await expect(page.locator(".notebook-sheet")).toHaveCount(1, { timeout: 30_000 });
  const strokes = (p: Page) => p.locator(".notebook-sheet").first().locator(".ink-strokes > g[clip-path] > path:not(.ink-draft):not(.ink-lasso)");

  const context = await browser.newContext({ viewport: page.viewportSize(), locale: "de-DE", hasTouch: true });
  const guest = await context.newPage();
  await guest.goto(`${origin}/share/${token}`);
  await guest.getByRole("button", { name: "Notizbuch bearbeiten" }).click();
  await expect(guest.locator(".notebook-sheet")).toHaveCount(1, { timeout: 60_000 });
  // Writing tools, but no picture insert, paper or PDF export.
  await expect(guest.getByRole("toolbar", { name: "Schreibwerkzeuge" })).toBeVisible();
  const controls = guest.getByRole("toolbar", { name: "Notizbuch" });
  await expect(controls.getByRole("button", { name: "Papier ändern" })).toHaveCount(0);
  await expect(controls.getByRole("button", { name: "Präsentieren" })).toHaveCount(0);

  const cdp = await context.newCDPSession(guest);
  const sheet = (await guest.locator(".notebook-sheet").first().boundingBox())!;
  await pen(cdp, line({ x: sheet.x + 90, y: sheet.y + 140 }, { x: sheet.x + 380, y: sheet.y + 180 }));
  await expect(strokes(guest)).toHaveCount(1);
  await expect(controls.getByRole("status")).toHaveText("Gespeichert", { timeout: 10_000 });

  // The owner's open notebook follows (every few seconds).
  await expect(strokes(page)).toHaveCount(1, { timeout: 20_000 });
  const data = await (await page.request.get(`/api/pages/${id}`)).json();
  expect(Object.values(data.notebook.sheets[0].ink.pages)[0]).toHaveLength(1);

  // A sheet added by the guest is there for the owner after reloading.
  await guest.locator(".notebook-add-end").click();
  await expect(guest.locator(".notebook-sheet")).toHaveCount(2);
  await page.reload();
  await expect(page.locator(".notebook-sheet")).toHaveCount(2, { timeout: 30_000 });
  await context.close();
});

test("on a phone the shared whiteboard opens in the editor, without upload entries", async ({ page }, info) => {
  test.skip(info.project.name !== "mobile", "Phone layout");
  const { token } = await setup(page, "whiteboard");
  await page.context().clearCookies();
  await page.goto(`/share/${token}`);
  await page.getByRole("button", { name: "Whiteboard bearbeiten" }).click();
  const wb = page.getByLabel("Whiteboard", { exact: true });
  await expect(wb.locator(".wb-canvas")).toBeVisible({ timeout: 60_000 });
  const box = (await wb.boundingBox())!;
  expect(box.width).toBeGreaterThan((page.viewportSize()?.width || 0) - 2);
  await wb.getByRole("button", { name: "Weitere Werkzeuge", exact: true }).click();
  const sheet = wb.locator(".wb-sheet");
  await expect(sheet.getByRole("button", { name: "Emoji", exact: true })).toBeVisible();
  await expect(sheet.getByRole("button", { name: "Bild", exact: true })).toHaveCount(0);
  await expect(sheet.getByRole("button", { name: "Vorlagen", exact: true })).toHaveCount(0);
});
