import { test, expect, type Locator, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import * as Y from "yjs";
import { boardView } from "./whiteboard-ui";

// The dark whiteboard canvas (#399): in dark mode the canvas is dark by
// default – a black stroke shows light, a yellow note toned down with
// readable text, a white shape dark with a light outline – while the
// stored colours stay and exports are light. "Immer hell" (the board's
// quick toggle, the same account setting as Settings → Appearance) brings
// back the light board.
const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
// WB_DARK_SHOTS=<dir>: screenshots of the board in both settings.
const shots = process.env.WB_DARK_SHOTS;

async function setup(page: Page) {
  await page.request.post("/api/auth/demo", { headers: { origin } });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const command = async (data: Record<string, unknown>) => {
    const r = await page.request.post("/api/command", { headers: { origin }, data });
    expect(r.ok(), await r.text()).toBe(true);
    return r.json();
  };
  // The demo account is shared by the specs: start from the default.
  await command({ action: "profile.whiteboardCanvas", whiteboardCanvas: "theme" });
  const board = await command({ action: "page.create", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, title: `Dunkle Fläche ${Date.now()}`, kind: "whiteboard" });
  const data = await (await page.request.get(`/api/pages/${board.id}`)).json();
  const ydoc = new Y.Doc();
  Y.applyUpdate(ydoc, Buffer.from(data.whiteboard.state, "base64"));
  const before = Y.encodeStateVector(ydoc);
  const add = (props: Record<string, unknown>) => {
    const map = new Y.Map<unknown>();
    for (const [k, v] of Object.entries(props)) map.set(k, v);
    ydoc.getMap("items").set(randomUUID(), map);
  };
  add({ type: "frame", x: -40, y: -80, w: 760, h: 380, z: 0, text: "Planung" });
  add({ type: "pen", x: 0, y: 0, w: 200, h: 120, z: 1, points: [0, 0, 0.3, 0.8, 0.6, 0.2, 1, 1], stroke: "#000000", strokeWidth: 5 });
  add({ type: "sticky", x: 240, y: 0, w: 180, h: 180, z: 2, fill: "#fff6b6", text: "Gelbe Notiz" });
  add({ type: "shape", shape: "rectangle", x: 460, y: 0, w: 200, h: 120, z: 3, fill: "#ffffff", stroke: "#1f2937", text: "Form" });
  add({ type: "text", x: 0, y: 200, w: 260, h: 40, z: 4, text: "Freier Text", fontSize: 20, align: "left" });
  await command({
    action: "whiteboard.sync",
    pageId: board.id,
    generation: data.whiteboard.generation,
    update: Buffer.from(Y.encodeStateAsUpdate(ydoc, before)).toString("base64"),
  });
  return { board, command };
}

// Relative luminance and contrast (WCAG) of CSS colours, in the page.
async function colours(wb: Locator) {
  return await wb.evaluate((root) => {
    const parse = (c: string) => {
      const probe = document.createElement("canvas").getContext("2d")!;
      probe.fillStyle = "#010203";
      probe.fillStyle = c;
      const v = probe.fillStyle as string;
      if (v.startsWith("#")) return [1, 3, 5].map((i) => parseInt(v.slice(i, i + 2), 16));
      return (v.match(/[\d.]+/g) || []).slice(0, 3).map(Number);
    };
    const lum = (c: string) => {
      const [r, g, b] = parse(c).map((x) => {
        const s = x / 255;
        return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const contrast = (a: string, b: string) => {
      const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
      return (x + 0.05) / (y + 0.05);
    };
    const note = root.querySelector(".wb-sticky")!;
    const noteFill = note.querySelector("rect")!.getAttribute("fill")!;
    const noteText = getComputedStyle(note.querySelector(".wb-text")!).color;
    const shape = root.querySelector(".wb-shape path")!;
    const pen = root.querySelector(".wb-pen path")!;
    const text = getComputedStyle(root.querySelector(".wb-item.wb-text .wb-text")!).color;
    const background = getComputedStyle(root).backgroundColor;
    return {
      background: lum(background),
      pen: pen.getAttribute("stroke")!,
      penLum: lum(pen.getAttribute("stroke")!),
      noteFill,
      noteFillLum: lum(noteFill),
      noteContrast: contrast(noteText, noteFill),
      shapeFill: lum(shape.getAttribute("fill")!),
      shapeStroke: lum(shape.getAttribute("stroke")!),
      textContrast: contrast(text, background),
      dark: root.classList.contains("wb-dark-canvas"),
    };
  });
}

test("dark mode shows the board on a dark canvas; “Immer hell” brings back the light board; exports stay light", async ({ page }, info) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const { board, command } = await setup(page);
  try {
    if (shots && info.project.name === "desktop") await page.setViewportSize({ width: 1440, height: 900 });
    await page.emulateMedia({ colorScheme: "dark" });
    await page.goto(`/#page=${board.id}`);
    const wb = page.getByLabel("Whiteboard", { exact: true });
    await expect(wb.locator(".wb-sticky", { hasText: "Gelbe Notiz" })).toBeVisible();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await expect(wb).toHaveClass(/wb-dark-canvas/);

    // Dark canvas: the stored colours shown for it.
    const dark = await colours(wb);
    expect(dark.background).toBeLessThan(0.03);
    expect(dark.penLum, `black stroke shown as ${dark.pen}`).toBeGreaterThan(0.4);
    expect(dark.noteFillLum, "the yellow note is toned down").toBeLessThan(0.15);
    expect(dark.noteContrast, "the note's text reads (WCAG AA)").toBeGreaterThanOrEqual(4.5);
    expect(dark.shapeFill).toBeLessThan(0.1);
    expect(dark.shapeStroke).toBeGreaterThan(0.4);
    expect(dark.textContrast).toBeGreaterThanOrEqual(4.5);
    // The grid dots follow the theme.
    const dot = await wb.locator("#wb-grid .wb-grid-dot").evaluate((el) => getComputedStyle(el).fill);
    expect(dot).not.toBe("rgb(206, 212, 218)");
    if (shots) {
      await boardView(wb, "Alles anzeigen");
      await page.waitForTimeout(900);
      await page.screenshot({ path: join(shots, `${info.project.name}-dark.png`) });
    }

    // The stored colours are unchanged.
    const stored = await (await page.request.get(`/api/pages/${board.id}`)).json();
    const ydoc = new Y.Doc();
    Y.applyUpdate(ydoc, Buffer.from(stored.whiteboard.state, "base64"));
    const items = [...ydoc.getMap<Y.Map<unknown>>("items").values()].map((m) => m.toJSON());
    expect(items.find((i) => i.type === "pen")?.stroke).toBe("#000000");
    expect(items.find((i) => i.type === "sticky")?.fill).toBe("#fff6b6");

    // The export is light: the stored colours, on white.
    await boardView(wb, "Exportieren … (PNG, SVG, PDF)");
    const exporting = page.getByRole("dialog", { name: "Exportieren" });
    await exporting.getByRole("radio", { name: "SVG" }).click();
    const [download] = await Promise.all([page.waitForEvent("download"), exporting.getByRole("button", { name: "Exportieren" }).click()]);
    const svg = await readFile((await download.path())!, "utf8");
    expect(svg).toContain('stroke="#000000"');
    expect(svg).toContain('fill="#fff6b6"');
    expect(svg).toContain('fill="#ffffff"');
    expect(svg).not.toContain(dark.pen);
    expect(svg).not.toContain(dark.noteFill);
    // The board is dark again after the export.
    await expect(wb).toHaveClass(/wb-dark-canvas/);
    expect((await colours(wb)).penLum).toBeGreaterThan(0.4);

    // The quick toggle: "Dunkle Fläche" off keeps boards light – the account setting.
    await boardView(wb, "Dunkle Fläche");
    await expect(wb).not.toHaveClass(/wb-dark-canvas/);
    const light = await colours(wb);
    expect(light.background).toBeGreaterThan(0.9);
    expect(light.pen).toBe("#000000");
    expect(light.noteFill).toBe("#fff6b6");
    await expect.poll(async () => (await (await page.request.get("/api/bootstrap")).json()).whiteboardCanvas).toBe("light");
    if (shots) {
      await page.keyboard.press("Escape");
      await page.screenshot({ path: join(shots, `${info.project.name}-light.png`) });
    }

    // Kept after a reload, and the menu shows the switch off.
    await page.reload();
    await expect(wb.locator(".wb-sticky", { hasText: "Gelbe Notiz" })).toBeVisible();
    await expect(wb).not.toHaveClass(/wb-dark-canvas/);
    await wb.getByRole("button", { name: "Ansicht und Aktionen", exact: true }).click();
    const toggle = wb.getByRole("dialog", { name: "Ansicht und Aktionen" }).getByRole("button", { name: "Dunkle Fläche", exact: true });
    await expect(toggle).toHaveAttribute("aria-pressed", "false");
    await toggle.click();
    await expect(wb).toHaveClass(/wb-dark-canvas/);
    await expect(toggle).toHaveAttribute("aria-pressed", "true");
    await expect.poll(async () => (await (await page.request.get("/api/bootstrap")).json()).whiteboardCanvas).toBe("theme");

    // Light mode: the canvas is light whatever the setting, and the toggle is not offered.
    await page.emulateMedia({ colorScheme: "light" });
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
    await expect(wb).not.toHaveClass(/wb-dark-canvas/);
    expect(errors).toEqual([]);
  } finally {
    await command({ action: "profile.whiteboardCanvas", whiteboardCanvas: "theme" });
  }
});
