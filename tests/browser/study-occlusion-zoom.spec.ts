import { test, expect, type CDPSession, type Page } from "@playwright/test";
import { diagramPng } from "../helpers/png";

// #343: on a phone two fingers zoom the picture of an image occlusion card
// (components/study/occlusion-zoom.ts) – not the page – without clashing
// with the study swipes: zoomed in, one finger pans instead of rating; a
// double tap shows the whole picture again; unzoomed, a swipe rates as
// before. Texts on the picture (Anki's text shapes) are shown, not asked.
// Touches through CDP (Input.dispatchTouchEvent), as a real screen sends
// them. STUDY_SCREENSHOTS=<dir> keeps pictures of the zoomed card.
const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
const shots = process.env.STUDY_SCREENSHOTS || "";

async function shot(page: Page, name: string, project: string) {
  if (!shots) return;
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.waitForTimeout(250);
    await page.screenshot({ path: `${shots}/${process.env.STUDY_SCREENSHOT_PREFIX || "fc6-"}${name}-${project === "mobile" ? 390 : 1440}-${scheme}.png` });
  }
  await page.emulateMedia({ colorScheme: "light" });
}
type Point = { x: number; y: number };
// One touch gesture: fingers from `from` to `to` in `steps`.
async function gesture(cdp: CDPSession, from: Point[], to: Point[], steps = 8) {
  const points = (k: number) => from.map((p, i) => ({ x: p.x + (to[i].x - p.x) * k, y: p.y + (to[i].y - p.y) * k, id: i, radiusX: 4, radiusY: 4, force: 1 }));
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: points(0) });
  for (let s = 1; s <= steps; s++) await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: points(s / steps) });
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
}
const tap = (cdp: CDPSession, p: Point) => gesture(cdp, [p], [p], 0);
const scaleOf = (transform: string) => Number(/scale\(([\d.]+)\)/.exec(transform)?.[1] || 1);

test("texts on an occlusion picture; on a phone two fingers zoom it, one finger pans it, swipes still rate", async ({ page }, info) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.request.post("/api/auth/demo", { headers: { origin } });
  const command = async (data: Record<string, unknown>) => {
    const response = await page.request.post("/api/command", { headers: { origin }, data });
    expect(response.ok(), await response.text()).toBe(true);
    return response.json();
  };
  await command({ action: "profile.onboarded" });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const pageId = (await command({ action: "page.create", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, title: `Zoomkarten ${Date.now()}`, kind: "database", databaseKind: "flashcards" })).id as string;
  const row = await command({ action: "row.create", pageId, cells: { title: "Welche Region ist markiert?", back: "", type: "Bildverdeckung" } });
  const upload = await page.request.post("/api/upload", { headers: { origin }, multipart: { pageId, file: { name: "atlas.png", mimeType: "image/png", buffer: diagramPng() } } });
  const { url } = await upload.json();
  const masks = {
    v: 1,
    mode: "hide-all",
    masks: [
      { id: "0c000000-0000-4000-8000-000000000001", shape: "rect", x: 0.39, y: 0.11, w: 0.24, h: 0.32, label: "Hochland" },
      { id: "0c000000-0000-4000-8000-000000000002", shape: "ellipse", x: 0.07, y: 0.17, w: 0.28, h: 0.44, label: "Nordregion" },
    ],
    texts: [{ id: "0d000000-0000-4000-8000-000000000001", x: 0.66, y: 0.62, text: "Meer", size: 0.08 }],
  };
  const attr = JSON.stringify(masks).replace(/&/g, "&amp;").replace(/"/g, "&quot;");
  const { htmlState } = await import("../../lib/document-server");
  const { generation } = await (await page.request.get(`/api/pages/${pageId}/rows/${row.id}`)).json();
  await command({ action: "row.document.sync", pageId, rowId: row.id, generation, update: Buffer.from(htmlState(`<img src="${url}" alt="Karte" data-occlusion="${attr}">`)).toString("base64") });

  await page.goto(`/#page=${pageId}`);
  await page.getByRole("button", { name: "Lernen starten" }).click();
  const focus = page.getByRole("dialog", { name: /^Lernen: / });
  const card = focus.locator(".occlusion-card");
  await expect(card.locator(".occlusion-mask.asked")).toBeVisible({ timeout: 30_000 });
  // The text is on the picture and told to screen readers, not a card.
  await expect(card.locator(".occlusion-texts text")).toHaveText("Meer");
  await expect(card.locator("figcaption")).toContainText("Text auf dem Bild: Meer.");
  await shot(page, "occlusion-texts", info.project.name);
  // The gestures need a touch screen.
  if (info.project.name !== "mobile") return;
  const zoom = card.locator(".occlusion-zoom");
  const frame = card.locator(".occlusion-frame");
  const transform = () => zoom.evaluate((el) => (el as HTMLElement).style.transform);
  const pageScale = () => page.evaluate(() => window.visualViewport?.scale ?? 1);
  const learning = focus.locator(".study-focus-count.learning b");
  const cdp = await page.context().newCDPSession(page);
  const box = (await frame.boundingBox())!;
  const mid = { x: box.x + box.width / 2, y: box.y + box.height / 2 };

  // Two fingers apart: the picture zooms, the page does not, nothing is revealed.
  await gesture(cdp, [{ x: mid.x - 20, y: mid.y }, { x: mid.x + 20, y: mid.y }], [{ x: mid.x - 70, y: mid.y }, { x: mid.x + 70, y: mid.y }]);
  await expect.poll(async () => scaleOf(await transform())).toBeGreaterThan(2);
  await expect(frame).toHaveClass(/is-zoomed/);
  expect(await pageScale()).toBe(1);
  await expect(card).not.toHaveClass(/revealed/);
  await shot(page, "zoomed", info.project.name);
  // A tap still reveals.
  await tap(cdp, mid);
  await expect(card).toHaveClass(/revealed/);
  // Zoomed in, one finger pans: the picture moves, the card is not rated.
  const before = await transform();
  await gesture(cdp, [{ x: mid.x + 60, y: mid.y }], [{ x: mid.x - 120, y: mid.y }], 10);
  await expect.poll(transform).not.toBe(before);
  await expect(focus.locator(".study-card")).not.toHaveClass(/swipe-/);
  await expect(learning).toHaveText("0");
  await expect(card).toHaveClass(/revealed/);
  // A double tap shows the whole picture again.
  await tap(cdp, mid);
  await page.waitForTimeout(60);
  await tap(cdp, mid);
  await expect.poll(transform).toBe("");
  await expect(frame).not.toHaveClass(/is-zoomed/);
  await expect(learning).toHaveText("0");
  // Unzoomed, a swipe to the right rates the card "Gut" as before.
  await gesture(cdp, [{ x: box.x + 40, y: mid.y }], [{ x: box.x + 40 + box.width * 0.6, y: mid.y }], 10);
  await expect(learning).toHaveText("1", { timeout: 15_000 });
  expect(await pageScale()).toBe(1);
  expect(errors).toEqual([]);
});
