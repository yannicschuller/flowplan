import { test, expect, type Locator, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { dxfPlan, fakeDwg } from "../helpers/drawing-fixtures";

// The drawing viewer (#384): a DXF or DWG file in a document is a card
// that opens the viewer. The DXF plan (tests/helpers/drawing-fixtures.ts:
// a red 100 × 50 mm room, furniture, text, a hatch) is drawn, its layers
// go on and off, zoom and fit change the scale, and two clicks near the
// room's corners snap to them and measure 100 mm; the paper turns dark. A
// DWG file loads LibreDWG's WebAssembly from Flowplan's own origin – a
// file it cannot read says so and suggests exporting a DXF (a real DWG
// drawing with FLOWPLAN_DWG_SAMPLE).

// How many pixels of the canvas are strongly red (the room) and dark.
async function picture(canvas: Locator) {
  return canvas.evaluate((c: HTMLCanvasElement) => {
    const data = c.getContext("2d")!.getImageData(0, 0, c.width, c.height).data;
    let red = 0,
      dark = 0;
    for (let i = 0; i < data.length; i += 4) {
      // Thin lines are smoothed into lighter reds.
      if (data[i] > 150 && data[i] - data[i + 1] > 80 && data[i] - data[i + 2] > 80) red++;
      if (data[i] < 40 && data[i + 1] < 40 && data[i + 2] < 50) dark++;
    }
    return { red, dark: dark / (data.length / 4) };
  });
}
const scaleOf = async (canvas: Locator) => Number(await canvas.getAttribute("data-scale"));

async function press(page: Page, mobile: boolean, x: number, y: number) {
  if (mobile) await page.touchscreen.tap(x, y);
  else await page.mouse.click(x, y);
}

test("DXF and DWG drawings open the drawing viewer: layers, fit, measuring, paper, DWG reader", async ({ page }, info) => {
  test.setTimeout(120_000);
  const mobile = info.project.name === "mobile";
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
  await page.request.post("/api/auth/demo", { headers: { origin } });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const command = async (data: Record<string, unknown>) => {
    const response = await page.request.post("/api/command", { headers: { origin }, data });
    if (!response.ok()) throw new Error(await response.text());
    return response.json();
  };
  const p = await command({ action: "page.create", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, title: `2D ${info.project.name} ${Date.now()}`, kind: "document" });
  const upload = async (name: string, buffer: Buffer) => {
    const response = await page.request.post("/api/upload", {
      headers: { origin },
      // Browsers send no type (or a vendor one) for CAD files.
      multipart: { pageId: p.id, file: { name, mimeType: "application/octet-stream", buffer } },
    });
    expect(response.ok()).toBe(true);
    return (await response.json()) as { url: string; mime: string };
  };
  const dxf = await upload("Grundriss.dxf", Buffer.from(dxfPlan()));
  const dwg = await upload("Altbau.dwg", fakeDwg("AC1032"));
  expect(dxf.mime).toBe("model/vnd.dxf");
  expect(dwg.mime).toBe("model/vnd.dwg");
  const sample = process.env.FLOWPLAN_DWG_SAMPLE ? await upload("Muster.dwg", readFileSync(process.env.FLOWPLAN_DWG_SAMPLE)) : null;
  const data = await (await page.request.get(`/api/pages/${p.id}`)).json();
  const { htmlState } = await import("../../lib/document-server");
  const block = (url: string, name: string) => `<div data-model="${url}" data-title="${name}" class="model-block"><a href="${url}">${name}</a></div>`;
  await command({
    action: "document.sync",
    workspaceId: boot.workspace.id,
    pageId: p.id,
    generation: data.generation,
    update: Buffer.from(htmlState(`<p>Pläne:</p>${block(dxf.url, "Grundriss.dxf")}${block(dwg.url, "Altbau.dwg")}${sample ? block(sample.url, "Muster.dwg") : ""}`)).toString("base64"),
  });

  await page.goto(`/#page=${p.id}`);
  const editor = page.getByLabel("Dokumentinhalt", { exact: true });
  const card = editor.getByRole("button", { name: "Zeichnung „Grundriss.dxf“ öffnen" });
  await expect(card).toBeVisible({ timeout: 20_000 });
  await expect(card).toContainText("DXF · Im Zeichnungs-Viewer öffnen");
  await card.click();

  const viewer = page.getByRole("dialog", { name: "Grundriss.dxf" });
  await expect(viewer).toBeVisible();
  await expect(viewer.locator(".viewer2d-size")).toHaveText("100 × 50 mm", { timeout: 20_000 });
  await expect(viewer).toContainText("Einheit: mm");
  const canvas = viewer.locator("canvas.viewer2d-canvas");
  await expect(canvas).toHaveClass(/is-ready/);
  // The red room is drawn.
  await expect.poll(async () => (await picture(canvas)).red, { timeout: 10_000 }).toBeGreaterThan(200);
  const before = await picture(canvas);
  const fitted = await scaleOf(canvas);
  expect(fitted).toBeGreaterThan(0);

  // Layers: the off and frozen ones start hidden; the room's goes off and on.
  const layersButton = viewer.getByRole("button", { name: "Layer", exact: true });
  await layersButton.click();
  const layers = viewer.getByRole("region", { name: "Layer" });
  await expect(layers).toBeVisible();
  const walls = layers.getByRole("checkbox", { name: /^Wände/ });
  await expect(walls).toBeChecked();
  await expect(layers.getByRole("checkbox", { name: /^Aus/ })).not.toBeChecked();
  await expect(layers.getByRole("checkbox", { name: /^Gefroren/ })).not.toBeChecked();
  await walls.uncheck();
  await expect.poll(async () => (await picture(canvas)).red).toBeLessThan(before.red / 10);
  await walls.check();
  await expect.poll(async () => (await picture(canvas)).red).toBeGreaterThan(before.red / 2);
  await layers.getByRole("button", { name: "Layer schließen" }).click();
  await expect(layers).toHaveCount(0);

  // Zoom and fit.
  await viewer.getByRole("button", { name: "Vergrößern" }).click();
  await viewer.getByRole("button", { name: "Vergrößern" }).click();
  await expect.poll(() => scaleOf(canvas)).toBeGreaterThan(fitted * 1.5);
  await viewer.getByRole("button", { name: "Einpassen" }).click();
  await expect.poll(() => scaleOf(canvas)).toBeCloseTo(fitted, 6);

  // Measuring: clicks a few pixels off the room's lower corners snap to them.
  const measure = viewer.getByRole("button", { name: "Messen" });
  await measure.click();
  await expect(measure).toHaveAttribute("aria-pressed", "true");
  await expect(viewer.getByText("Klicke einen Punkt an – er rastet am nächsten Endpunkt ein.")).toBeVisible();
  const box = (await canvas.boundingBox())!;
  const cx = box.x + box.width / 2,
    cy = box.y + box.height / 2,
    s = await scaleOf(canvas);
  await press(page, mobile, cx - 50 * s + 4, cy + 25 * s - 3);
  await expect(viewer.getByText("Jetzt den zweiten Punkt anklicken.")).toBeVisible();
  await press(page, mobile, cx + 50 * s - 5, cy + 25 * s + 2);
  const distance = viewer.locator(".viewer3d-distance");
  await expect(distance).toHaveText("100 mm");
  await expect(viewer.getByRole("list", { name: "Messungen" })).toContainText("Messung 1:");
  if (!mobile) await expect(viewer.getByRole("list", { name: "Messungen" })).toContainText("Δx 100 mm · Δy 0 mm");
  await viewer.getByRole("button", { name: "Messungen löschen" }).click();
  await expect(distance).toHaveCount(0);
  await measure.click();

  // Dark paper: most of the canvas turns dark.
  expect((await picture(canvas)).dark).toBeLessThan(0.1);
  await viewer.getByRole("button", { name: "Dunkles Papier" }).click();
  await expect(viewer.locator(".viewer2d-stage")).toHaveAttribute("data-paper", "dark");
  await expect.poll(async () => (await picture(canvas)).dark).toBeGreaterThan(0.6);
  await page.keyboard.press("Escape");
  await expect(viewer).toHaveCount(0);

  // DWG: LibreDWG from Flowplan's own origin; this file is no real drawing.
  const wasm = page.waitForResponse((r) => r.url() === new URL("/libredwg/wasm/libredwg-web.wasm", origin).href);
  const reader = page.waitForResponse((r) => r.url() === new URL("/libredwg/dist/libredwg-web.js", origin).href);
  await editor.getByRole("button", { name: "Zeichnung „Altbau.dwg“ öffnen" }).click();
  const old = page.getByRole("dialog", { name: "Altbau.dwg" });
  await expect(old).toBeVisible();
  const [wasmAnswer, readerAnswer] = await Promise.all([wasm, reader]);
  expect(readerAnswer.status()).toBe(200);
  expect(readerAnswer.headers()["content-type"]).toContain("text/javascript");
  expect(wasmAnswer.status()).toBe(200);
  expect(wasmAnswer.headers()["content-type"]).toBe("application/wasm");
  await expect(old.getByRole("alert")).toContainText("Diese DWG-Datei (AutoCAD 2018) ließ sich nicht lesen.", { timeout: 60_000 });
  await expect(old.getByRole("alert")).toContainText("Exportiere die Zeichnung in deinem CAD-Programm als DXF");
  await expect(old.locator(".viewer3d-format")).toHaveText("DWG");
  await old.getByRole("button", { name: "Schließen" }).click();
  await expect(old).toHaveCount(0);

  if (sample) {
    await editor.getByRole("button", { name: "Zeichnung „Muster.dwg“ öffnen" }).click();
    const real = page.getByRole("dialog", { name: "Muster.dwg" });
    await expect(real.locator(".viewer2d-size")).toBeVisible({ timeout: 60_000 });
    await expect(real.getByRole("alert")).toHaveCount(0);
    await expect(real.locator(".viewer3d-format")).toHaveText(/^DWG /);
    await page.keyboard.press("Escape");
  }
  expect(errors).toEqual([]);
});
