import { test, expect, type CDPSession, type Page } from "@playwright/test";

// Zooming while marking up an image (#404, components/image-annotator.tsx,
// lib/image-markup-view.ts): the "Markieren" button in the image bar opens
// it; two fingers pinch to zoom around their centre, the pen writes where
// it touches the zoomed image and the markings are saved in image pixels
// (the same as drawn unzoomed); with pen-only drawing a finger pans and
// never draws, without it one finger draws and two zoom; "Einpassen" goes
// back, ⌘/Ctrl + wheel and the keys zoom on the desktop. Pen and touch come
// from the browser itself (DevTools protocol), as on a tablet.
test.use({ hasTouch: true });

const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
const shots = process.env.MARKUP_SCREENSHOTS || "";
type Point = { x: number; y: number };
// The worksheet: 1600 × 1200 pixels.
const W = 1600,
  H = 1200;

async function pen(cdp: CDPSession, points: Point[]) {
  const base = { pointerType: "pen" as const, button: "left" as const, buttons: 1 };
  await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: points[0].x, y: points[0].y, clickCount: 1, force: 0.5, ...base });
  for (const p of points.slice(1)) await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: p.x, y: p.y, force: 0.5, ...base });
  const last = points[points.length - 1];
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: last.x, y: last.y, clickCount: 1, ...base });
}
const line = (from: Point, to: Point, steps = 8) =>
  Array.from({ length: steps + 1 }, (_, i) => ({ x: from.x + ((to.x - from.x) * i) / steps, y: from.y + ((to.y - from.y) * i) / steps }));
async function finger(cdp: CDPSession, from: Point, to: Point) {
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: from.x, y: from.y }] });
  for (let i = 1; i <= 8; i++)
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: from.x + ((to.x - from.x) * i) / 8, y: from.y + ((to.y - from.y) * i) / 8 }] });
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
}
async function pinch(cdp: CDPSession, centre: Point, from: number, to: number, steps = 10) {
  const at = (d: number) => [
    { x: centre.x - d / 2, y: centre.y, id: 1 },
    { x: centre.x + d / 2, y: centre.y, id: 2 },
  ];
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [at(from)[0]] });
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: at(from) });
  for (let i = 1; i <= steps; i++) await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: at(from + ((to - from) * i) / steps) });
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
}

// A page with a worksheet image (lines every 100 px).
async function worksheetPage(page: Page) {
  await page.request.post("/api/auth/demo", { headers: { origin } });
  await page.request.post("/api/command", { headers: { origin }, data: { action: "profile.onboarded" } });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const created = await page.request.post("/api/command", {
    headers: { origin },
    data: { action: "page.create", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, title: `Arbeitsblatt ${Date.now()}`, kind: "document" },
  });
  const pageId = (await created.json()).id;
  await page.goto("about:blank");
  const b64 = await page.evaluate(
    ([w, h]) => {
      const c = document.createElement("canvas");
      c.width = w;
      c.height = h;
      const ctx = c.getContext("2d")!;
      ctx.fillStyle = "#fffdf6";
      ctx.fillRect(0, 0, w, h);
      ctx.fillStyle = "#1d1a14";
      ctx.font = "bold 64px sans-serif";
      ctx.fillText("Arbeitsblatt 3", 120, 140);
      ctx.strokeStyle = "#9aa7b8";
      ctx.lineWidth = 3;
      for (let y = 260; y < h - 60; y += 100) {
        ctx.beginPath();
        ctx.moveTo(120, y);
        ctx.lineTo(w - 120, y);
        ctx.stroke();
      }
      return c.toDataURL("image/png").split(",")[1];
    },
    [W, H],
  );
  const upload = await page.request.post("/api/upload", {
    headers: { origin },
    multipart: { pageId, file: { name: "arbeitsblatt.png", mimeType: "image/png", buffer: Buffer.from(b64, "base64") } },
  });
  expect(upload.ok(), await upload.text()).toBe(true);
  const src = (await upload.json()).url as string;
  const { htmlState } = await import("../../lib/document-server");
  const generation = (await (await page.request.get(`/api/pages/${pageId}`)).json()).generation;
  const sync = await page.request.post("/api/command", {
    headers: { origin },
    data: { action: "document.sync", pageId, generation, update: Buffer.from(htmlState(`<p>Aufgabe 1</p><img src="${src}" alt="arbeitsblatt.png"><p>Ende.</p>`)).toString("base64") },
  });
  expect(sync.ok()).toBe(true);
  return { pageId, src };
}

// The image bar, by pointing at the image (a tap on touch screens).
async function showBar(page: Page, mobile: boolean) {
  const image = page.getByLabel("Dokumentinhalt", { exact: true }).locator("img").first();
  await expect(image).toBeVisible({ timeout: 30_000 });
  const bar = page.getByRole("toolbar", { name: "Bild", exact: true });
  if (mobile) {
    if (!(await bar.isVisible())) {
      await page.waitForTimeout(600);
      await image.tap();
    }
  } else await image.hover();
  await expect(bar).toBeVisible();
  return { image, bar };
}

test("pinch to zoom while marking up an image: the pen lands on the right spot, Fit goes back", async ({ page }, info) => {
  test.setTimeout(150_000);
  const mobile = info.project.name === "mobile";
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const { pageId, src } = await worksheetPage(page);
  await page.goto(`/#page=${pageId}`);
  const { image, bar } = await showBar(page, mobile);
  // The visible way in: "Markieren" in the bar (spelled out where it fits).
  const markup = bar.getByRole("button", { name: "Bild markieren" });
  await expect(markup).toBeVisible();
  if (!mobile) await expect(markup).toHaveText("Markieren");
  const barBox = (await bar.boundingBox())!,
    picture = (await image.boundingBox())!;
  expect(barBox.x).toBeGreaterThanOrEqual(picture.x - 1);
  expect(barBox.x + barBox.width).toBeLessThanOrEqual(picture.x + picture.width + 1);
  await markup.click();

  const dialog = page.getByRole("dialog", { name: "Bild markieren" });
  const canvas = dialog.getByLabel("Bild zum Markieren");
  await expect(canvas).toBeVisible();
  const zoom = dialog.locator(".annotator-zoom-value");
  const fitButton = dialog.getByRole("button", { name: "Einpassen" });
  await expect(zoom).toHaveText("100 %");
  await expect(fitButton).toBeDisabled();
  // A colour swatch under the pointer (or the hovering pen) keeps its colour – it did turn grey.
  const green = dialog.getByRole("radio", { name: "Farbe #2f9e44" });
  await green.hover();
  await expect(green).toHaveCSS("background-color", "rgb(47, 158, 68)");
  await dialog.getByRole("radio", { name: "Farbe #e03131" }).hover();
  await expect(dialog.getByRole("radio", { name: "Farbe #e03131" })).toHaveCSS("background-color", "rgb(224, 49, 49)");
  const box = (await canvas.boundingBox())!;
  const fit = box.width / W;
  const cdp = await page.context().newCDPSession(page);
  // The screen point of an image point, unzoomed.
  const screen = (p: Point) => ({ x: box.x + p.x * fit, y: box.y + p.y * fit });

  // 1. Unzoomed: a stroke along the second line of the worksheet.
  const a = { x: 400, y: 360 },
    b = { x: 1000, y: 360 };
  await pen(cdp, line(screen(a), screen(b)));
  // The pen was used: from now on fingers zoom and pan.
  await page.waitForTimeout(700);

  // 2. Two fingers pinch to 2×, around the middle of the canvas.
  const centre = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  await pinch(cdp, centre, 100, 200);
  await expect(zoom).toHaveText(/^(19[7-9]|20[0-3]) %$/); // a pinch lands within a few per cent
  await expect(fitButton).toBeEnabled();
  // The canvas keeps its size and place (only what it shows is zoomed), and
  // the tools stay where they were.
  expect(await canvas.boundingBox()).toEqual(box);
  if (shots) await page.screenshot({ path: `${shots}/markup-zoomed-${info.project.name}.png` });

  // 3. Zoomed: the same stroke once more, below the first one. The point
  // under the pinch centre stayed there: image point = (screen − centre) / (2 × fit) + centre's image point.
  const c = { x: (centre.x - box.x) / fit, y: (centre.y - box.y) / fit };
  const zoomed = (p: Point) => ({ x: centre.x + (p.x - c.x) * 2 * fit, y: centre.y + (p.y - c.y) * 2 * fit });
  const a2 = { x: 650, y: 560 },
    b2 = { x: 950, y: 560 };
  await pen(cdp, line(zoomed(a2), zoomed(b2)));
  await page.waitForTimeout(700);

  // 4. Pen-only: one finger pans the zoomed image and draws nothing.
  await finger(cdp, { x: centre.x + 40, y: centre.y }, { x: centre.x - 40, y: centre.y - 30 });
  await expect(zoom).toHaveText(/^(19[7-9]|20[0-3]) %$/); // a pinch lands within a few per cent

  // 5. "Einpassen" shows the whole image again.
  await fitButton.click();
  await expect(zoom).toHaveText("100 %");
  await expect(fitButton).toBeDisabled();

  if (!mobile) {
    // ⌘/Ctrl + wheel (a trackpad pinch) zooms around the pointer, the keys too.
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: centre.x, y: centre.y, deltaX: 0, deltaY: -40, modifiers: 2 });
    await expect.poll(async () => parseInt((await zoom.textContent()) || "0")).toBeGreaterThan(140);
    await page.keyboard.press("0");
    await expect(zoom).toHaveText("100 %");
    await page.keyboard.type("+");
    await expect(zoom).toHaveText("150 %");
    // A plain wheel pans the zoomed image (the zoom stays).
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: centre.x, y: centre.y, deltaX: 0, deltaY: 80 });
    await expect(zoom).toHaveText("150 %");
    await page.keyboard.press("-");
    await expect(zoom).toHaveText("100 %");
  }

  // 6. Saved: two strokes, in image pixels, where they were drawn.
  await dialog.getByRole("button", { name: "Speichern" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(image).toHaveAttribute("data-original", src);
  const shapes = JSON.parse((await image.getAttribute("data-annotations"))!) as { type: string; points: [number, number][] }[];
  expect(shapes.map((s) => s.type)).toEqual(["pen", "pen"]);
  // Within a pixel of the screen, in image pixels: 1 / fit unzoomed, half that zoomed.
  const close = (got: [number, number], want: Point, tolerance: number) => {
    expect(Math.abs(got[0] - want.x), `x ${got[0]} ≈ ${want.x}`).toBeLessThan(tolerance);
    expect(Math.abs(got[1] - want.y), `y ${got[1]} ≈ ${want.y}`).toBeLessThan(tolerance);
  };
  const [first, second] = shapes;
  close(first.points[0], a, 1.5 / fit);
  close(first.points[first.points.length - 1], b, 1.5 / fit);
  close(second.points[0], a2, 1 / fit);
  close(second.points[second.points.length - 1], b2, 1 / fit);
  // The zoomed stroke is as straight and as long as drawn – not scaled.
  const length = (s: (typeof shapes)[number]) => s.points[s.points.length - 1][0] - s.points[0][0];
  expect(Math.abs(length(second) - (b2.x - a2.x))).toBeLessThan(1 / fit);

  // 7. Without pen-only drawing: one finger draws, two fingers zoom and draw nothing.
  await page.evaluate(() => localStorage.setItem("flowplan-pen-only", "0"));
  await page.waitForTimeout(700);
  await (await showBar(page, mobile)).bar.getByRole("button", { name: "Bild markieren" }).click();
  await expect(canvas).toBeVisible();
  await expect(zoom).toHaveText("100 %");
  const again = (await canvas.boundingBox())!;
  const mid = { x: again.x + again.width / 2, y: again.y + again.height / 2 };
  await pinch(cdp, mid, 80, 120);
  await expect(zoom).toHaveText(/^(14[7-9]|15[0-3]) %$/); // a pinch lands within a few per cent
  await finger(cdp, { x: mid.x - 30, y: mid.y + 20 }, { x: mid.x + 30, y: mid.y + 20 });
  await expect(zoom).toHaveText(/^(14[7-9]|15[0-3]) %$/); // a pinch lands within a few per cent
  await dialog.getByRole("button", { name: "Speichern" }).click();
  await expect(dialog).toHaveCount(0);
  await expect
    .poll(async () => JSON.parse((await image.getAttribute("data-annotations")) || "[]").map((s: { type: string }) => s.type))
    .toEqual(["pen", "pen", "pen"]);
  expect(errors).toEqual([]);
});

test("screenshots: the markup editor zoomed in and the image bar", async ({ page }, info) => {
  test.skip(!shots || info.project.name !== "desktop", "Only when screenshots are asked for.");
  test.setTimeout(300_000);
  const { pageId } = await worksheetPage(page);
  for (const [name, viewport, touch] of [
    ["ipad", { width: 1024, height: 1366 }, true],
    ["desktop", { width: 1440, height: 900 }, false],
    ["phone", { width: 390, height: 844 }, true],
  ] as const) {
    for (const scheme of ["light", "dark"] as const) {
      await page.setViewportSize(viewport);
      await page.emulateMedia({ colorScheme: scheme });
      await page.goto(`/#page=${pageId}`);
      const { image, bar } = await showBar(page, touch);
      await page.waitForTimeout(300);
      await page.screenshot({ path: `${shots}/image-bar-${name}-${scheme}.png` });
      await image.scrollIntoViewIfNeeded();
      const barBox = (await bar.boundingBox())!;
      await page.screenshot({
        path: `${shots}/image-bar-${name}-${scheme}-detail.png`,
        clip: { x: Math.max(0, barBox.x - 40), y: Math.max(0, barBox.y - 20), width: Math.min(viewport.width - Math.max(0, barBox.x - 40), barBox.width + 80), height: barBox.height + 60 },
      });
      if (name === "phone") continue;
      await bar.getByRole("button", { name: "Bild markieren" }).click();
      const dialog = page.getByRole("dialog", { name: "Bild markieren" });
      const canvas = dialog.getByLabel("Bild zum Markieren");
      await expect(canvas).toBeVisible();
      const box = (await canvas.boundingBox())!;
      const cdp = await page.context().newCDPSession(page);
      const centre = { x: box.x + box.width * 0.35, y: box.y + box.height * 0.3 };
      if (touch) {
        await pen(cdp, line({ x: box.x + 10, y: box.y + 5 }, { x: box.x + 11, y: box.y + 5 }, 1));
        await page.waitForTimeout(700);
        await pinch(cdp, centre, 100, 300);
      } else for (let i = 0; i < 6; i++) await cdp.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: centre.x, y: centre.y, deltaX: 0, deltaY: -30, modifiers: 2 });
      // Handwriting on the zoomed worksheet.
      const word = (x: number, y: number) =>
        Array.from({ length: 25 }, (_, i) => ({ x: x + i * 6, y: y + Math.sin(i * 1.3) * 10 - (i % 5 === 0 ? 8 : 0) }));
      await pen(cdp, word(box.x + box.width * 0.2, centre.y + 30));
      await pen(cdp, word(box.x + box.width * 0.2 + 180, centre.y + 30));
      await page.waitForTimeout(300);
      await page.screenshot({ path: `${shots}/markup-zoomed-${name}-${scheme}.png` });
      await dialog.getByRole("button", { name: "Abbrechen" }).click();
      await expect(dialog).toHaveCount(0);
    }
  }
});
