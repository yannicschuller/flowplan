import { test, expect, type Locator, type Page } from "@playwright/test";
import { stepBox, stlCube } from "../helpers/model-fixtures";

// The 3D viewer (#384): a 3D file in a document is a card that opens the
// viewer – an STL cube (three.js) and a STEP box (OpenCascade's
// WebAssembly from Flowplan's own origin). The canvas draws the model, the
// standard views change it, and two clicks on the surface measure a
// distance.

// How much of the canvas the model covers (opaque pixels, the background
// is transparent), and a coarse fingerprint of the picture.
async function picture(canvas: Locator) {
  return canvas.evaluate((c: HTMLCanvasElement) => {
    const copy = document.createElement("canvas");
    copy.width = 48;
    copy.height = 48;
    const context = copy.getContext("2d")!;
    context.drawImage(c, 0, 0, 48, 48);
    const data = context.getImageData(0, 0, 48, 48).data;
    let covered = 0,
      print = "";
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3] > 200) covered++;
      if (i % 64 === 0) print += data[i + 3] > 200 ? (data[i] > 128 ? "L" : "D") : ".";
    }
    return { covered: covered / (48 * 48), print };
  });
}

async function press(page: Page, mobile: boolean, x: number, y: number) {
  if (mobile) await page.touchscreen.tap(x, y);
  else await page.mouse.click(x, y);
}

test("3D files in a document open the 3D viewer: views, measuring, STEP", async ({ page }, info) => {
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
  const p = await command({ action: "page.create", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, title: `3D ${info.project.name} ${Date.now()}`, kind: "document" });
  const upload = async (name: string, buffer: Buffer) => {
    const response = await page.request.post("/api/upload", {
      headers: { origin },
      // Browsers send no type (or a vendor one) for 3D files.
      multipart: { pageId: p.id, file: { name, mimeType: "application/octet-stream", buffer } },
    });
    expect(response.ok()).toBe(true);
    return (await response.json()) as { url: string; mime: string };
  };
  const stl = await upload("Würfel.stl", stlCube(20));
  const step = await upload("Gehäuse.step", Buffer.from(stepBox(30, 20, 10)));
  expect(stl.mime).toBe("model/stl");
  expect(step.mime).toBe("model/step");
  const data = await (await page.request.get(`/api/pages/${p.id}`)).json();
  const { htmlState } = await import("../../lib/document-server");
  const block = (url: string, name: string) => `<div data-model="${url}" data-title="${name}" class="model-block"><a href="${url}">${name}</a></div>`;
  await command({
    action: "document.sync",
    workspaceId: boot.workspace.id,
    pageId: p.id,
    generation: data.generation,
    update: Buffer.from(htmlState(`<p>Bauteile:</p>${block(stl.url, "Würfel.stl")}${block(step.url, "Gehäuse.step")}`)).toString("base64"),
  });

  await page.goto(`/#page=${p.id}`);
  const editor = page.getByLabel("Dokumentinhalt", { exact: true });
  const card = editor.getByRole("button", { name: "3D-Modell „Würfel.stl“ öffnen" });
  await expect(card).toBeVisible({ timeout: 20_000 });
  await expect(card).toContainText("Im 3D-Viewer öffnen");
  await card.click();

  const viewer = page.getByRole("dialog", { name: "Würfel.stl" });
  await expect(viewer).toBeVisible();
  await expect(viewer.locator(".viewer3d-size")).toHaveText("20 × 20 × 20 mm", { timeout: 20_000 });
  await expect(viewer).toContainText("12 Dreiecke");
  await expect(viewer).toContainText("STL speichert keine Einheit");
  const canvas = viewer.locator("canvas.viewer3d-canvas");
  await expect(canvas).toHaveAttribute("data-view", "iso");
  // The model is drawn: a good part of the canvas, not all of it.
  await expect.poll(async () => (await picture(canvas)).covered, { timeout: 10_000 }).toBeGreaterThan(0.05);
  const iso = await picture(canvas);
  expect(iso.covered).toBeLessThan(0.9);

  // Standard views: each one changes the picture.
  const top = viewer.getByRole("button", { name: "Draufsicht (Blick entlang Z)" });
  await top.click();
  await expect(canvas).toHaveAttribute("data-view", "top");
  await expect(top).toHaveAttribute("aria-pressed", "true");
  await expect.poll(async () => (await picture(canvas)).print).not.toBe(iso.print);
  const topPicture = await picture(canvas);
  await viewer.getByRole("button", { name: "Seitenansicht von rechts (Blick entlang X)" }).click();
  await expect(canvas).toHaveAttribute("data-view", "right");
  await viewer.getByRole("button", { name: "Vergrößern" }).click();
  await expect.poll(async () => (await picture(canvas)).covered).toBeGreaterThan(topPicture.covered);
  await viewer.getByRole("button", { name: "Startansicht" }).click();
  await expect(canvas).toHaveAttribute("data-view", "iso");
  // Back to the fitted isometric picture (the stage may have changed its
  // size slightly on a phone since, so not pixel for pixel).
  await expect.poll(async () => Math.abs((await picture(canvas)).covered - iso.covered)).toBeLessThan(0.03);

  // Measuring on the front face (y = −10): two points across it.
  await viewer.getByRole("button", { name: "Vorderansicht (Blick entlang Y)" }).click();
  await expect(canvas).toHaveAttribute("data-view", "front");
  const measure = viewer.getByRole("button", { name: "Messen" });
  await measure.click();
  await expect(measure).toHaveAttribute("aria-pressed", "true");
  await expect(viewer.getByText("Klicke einen Punkt auf der Oberfläche an.")).toBeVisible();
  const box = (await canvas.boundingBox())!;
  const cx = box.x + box.width / 2,
    cy = box.y + box.height / 2,
    d = Math.min(box.width, box.height) * 0.12;
  await press(page, mobile, cx - d, cy);
  await expect(viewer.getByText("Jetzt den zweiten Punkt anklicken.")).toBeVisible();
  await press(page, mobile, cx + d, cy);
  const distance = viewer.locator(".viewer3d-distance");
  await expect(distance).toHaveCount(1);
  await expect(viewer.getByRole("list", { name: "Messungen" })).toContainText("Messung 1:");
  const value = Number((await distance.textContent())!.replace(" mm", "").replace(",", "."));
  // Points at ±d on a 20 mm face seen whole: between a quarter and the full width.
  expect(value).toBeGreaterThan(5);
  expect(value).toBeLessThan(20);
  // Clicking past the model sets no point.
  await press(page, mobile, box.x + 6, box.y + 6);
  await expect(viewer.getByText("Klicke einen Punkt auf der Oberfläche an.")).toBeVisible();
  await viewer.getByRole("button", { name: "Messungen löschen" }).click();
  await expect(distance).toHaveCount(0);
  await viewer.getByRole("button", { name: "Drahtgitter" }).click();
  await expect(viewer.getByRole("button", { name: "Drahtgitter" })).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("Escape");
  await expect(viewer).toHaveCount(0);

  // STEP: OpenCascade triangulates the box in a worker.
  const wasm = page.waitForResponse((r) => r.url().endsWith("/occt/occt-import-js.wasm"));
  await editor.getByRole("button", { name: "3D-Modell „Gehäuse.step“ öffnen" }).click();
  const cad = page.getByRole("dialog", { name: "Gehäuse.step" });
  await expect(cad).toBeVisible();
  const answer = await wasm;
  expect(answer.status()).toBe(200);
  expect(answer.headers()["content-type"]).toBe("application/wasm");
  await expect(cad.locator(".viewer3d-size")).toHaveText("30 × 20 × 10 mm", { timeout: 60_000 });
  await expect(cad).not.toContainText("speichert keine Einheit");
  const cadCanvas = cad.locator("canvas.viewer3d-canvas");
  await expect.poll(async () => (await picture(cadCanvas)).covered, { timeout: 10_000 }).toBeGreaterThan(0.05);
  await cad.getByRole("button", { name: "Schließen" }).click();
  await expect(cad).toHaveCount(0);
  expect(errors).toEqual([]);
});
