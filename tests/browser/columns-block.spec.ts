import { test, expect, type Page } from "@playwright/test";
import { samplePdf } from "../helpers/pdf";

// The columns block: "/Spalten" inserts two columns, a PDF goes into each,
// the gap between them resizes them, and after a reload they are still side
// by side with their widths – stacked on a phone. Two PDFs one below the
// other become columns by dropping one at the other's edge.
const SHOTS = process.env.COLUMNS_SCREENSHOTS;

async function setup(page: Page, title: string) {
  const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
  await page.request.post("/api/auth/demo", { headers: { origin } });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const command = async (data: Record<string, unknown>) => {
    const response = await page.request.post("/api/command", { headers: { origin }, data });
    expect(response.ok(), await response.text()).toBe(true);
    return response.json();
  };
  const created = await command({ action: "page.create", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, title: `${title} ${Date.now()}`, kind: "document" });
  const upload = async (name: string, text: string) => {
    const response = await page.request.post("/api/upload", {
      headers: { origin },
      multipart: { pageId: created.id, file: { name, mimeType: "application/pdf", buffer: samplePdf([text]) } },
    });
    return (await response.json()).url as string;
  };
  const read = async () => (await page.request.get(`/api/pages/${created.id}`)).json();
  return { id: created.id as string, command, upload, read };
}
const box = async (page: Page, selector: string, index: number) => (await page.locator(selector).nth(index).boundingBox())!;

test("columns from the slash menu with a PDF in each: resized, kept after a reload, stacked on phones", async ({ page }, info) => {
  test.setTimeout(120_000);
  const desktop = info.project.name === "desktop";
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const { id, read } = await setup(page, "Spalten");
  await page.goto(`/#page=${id}`);
  const editor = page.getByLabel("Dokumentinhalt", { exact: true });
  await editor.click();
  // "/Spalten" offers two or three columns.
  await page.keyboard.type("/Spalten");
  await page.keyboard.press("Enter");
  await expect(page.locator(".slash-menu")).toContainText("3 Spalten");
  await page.keyboard.press("Enter");
  const columns = editor.locator(".editor-columns");
  await expect(columns.locator(".editor-column")).toHaveCount(2);
  // A PDF pasted into each column (the caret starts in the first).
  const paste = (name: string, text: string) =>
    page.evaluate(
      async ([name, bytes]) => {
        const data = new DataTransfer();
        data.items.add(new File([Uint8Array.from(atob(bytes), (c) => c.charCodeAt(0))], name, { type: "application/pdf" }));
        document.querySelector(".ProseMirror")!.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
      },
      [name, samplePdf([text]).toString("base64")] as const,
    );
  await page.keyboard.type("Angebot");
  await paste("Angebot.pdf", "Erstes Dokument");
  await expect(columns.locator(".editor-column").nth(0).locator(".pdf-block canvas")).toHaveCount(1, { timeout: 20_000 });
  await columns.locator(".editor-column").nth(1).locator("p").last().click();
  await page.keyboard.type("Rechnung");
  await paste("Rechnung.pdf", "Zweites Dokument");
  await expect(columns.locator(".editor-column").nth(1).locator(".pdf-block")).toHaveCount(1, { timeout: 20_000 });
  await expect(columns.locator(".editor-column").nth(0)).toContainText("Angebot");
  await expect(columns.locator(".editor-column").nth(1)).toContainText("Rechnung");
  const cards = ".editor-columns .pdf-block";
  for (const i of [0, 1]) await expect.poll(() => page.locator(cards).nth(i).locator("canvas").evaluate((c: HTMLCanvasElement) => c.width), { timeout: 15_000 }).toBeGreaterThan(100);
  // Every column keeps a line to write in below its PDF.
  for (const i of [0, 1]) await expect(columns.locator(".editor-column").nth(i).locator(":scope > p").last()).toBeVisible();
  const handle = columns.locator(".editor-columns-resize");
  if (desktop) {
    // Side by side, each preview within its column.
    const [a, b] = [await box(page, cards, 0), await box(page, cards, 1)];
    expect(Math.abs(a.y - b.y)).toBeLessThan(4);
    expect(b.x).toBeGreaterThan(a.x + a.width);
    // Dragging the gap to the left narrows the first column (in the
    // middle of the gap: the handles of the right column's blocks sit at
    // the top of their blocks there).
    await expect(handle).toHaveCount(1);
    const gap = (await handle.boundingBox())!;
    const before = await box(page, ".editor-columns .editor-column", 0);
    const y = gap.y + gap.height / 2;
    await page.mouse.move(gap.x + gap.width / 2, y);
    await page.mouse.down();
    await page.mouse.move(gap.x + gap.width / 2 - 90, y, { steps: 8 });
    await page.mouse.up();
    await expect.poll(async () => (await box(page, ".editor-columns .editor-column", 0)).width).toBeLessThan(before.width - 60);
    await expect.poll(async () => (await read()).html as string, { timeout: 15_000 }).toMatch(/data-width="3\d"[^]*data-width="6\d"/);
    // The other column has the room; no style attribute in the document.
    expect((await read()).html).not.toContain("style=");
  } else {
    // On a phone one below the other, without resize handles.
    const [a, b] = [await box(page, cards, 0), await box(page, cards, 1)];
    expect(b.y).toBeGreaterThan(a.y + a.height);
    await expect(handle).toBeHidden();
  }
  await expect.poll(async () => (await read()).html as string, { timeout: 15_000 }).toMatch(/data-columns[^]*Angebot\.pdf[^]*Rechnung\.pdf/);
  // After a reload: the same, still side by side (desktop) or stacked (phone).
  await page.reload();
  const again = page.getByLabel("Dokumentinhalt", { exact: true });
  await expect(again.locator(".editor-columns .pdf-block")).toHaveCount(2, { timeout: 20_000 });
  // Drawn as a whole page (portrait), within its column.
  for (const i of [0, 1])
    await expect
      .poll(() => page.locator(cards).nth(i).locator("canvas").evaluate((c: HTMLCanvasElement) => { const r = c.getBoundingClientRect(); return c.width > 100 && r.height > r.width; }), { timeout: 15_000 })
      .toBe(true);
  const [a, b] = [await box(page, ".editor-columns .editor-column", 0), await box(page, ".editor-columns .editor-column", 1)];
  if (desktop) {
    expect(Math.abs(a.y - b.y)).toBeLessThan(2);
    expect(a.width).toBeLessThan(b.width * 0.75);
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/columns-pdf-desktop.png` });
    // A double click on the gap gives equal widths again.
    await again.locator(".editor-columns-resize").dblclick();
    await expect.poll(async () => (await read()).html as string, { timeout: 15_000 }).not.toContain("data-width");
    const [c, d] = [await box(page, ".editor-columns .editor-column", 0), await box(page, ".editor-columns .editor-column", 1)];
    expect(Math.abs(c.width - d.width)).toBeLessThan(2);
    // The preview in a column opens the viewer.
    await again.getByRole("button", { name: "PDF „Angebot.pdf“ öffnen" }).click();
    const viewer = page.getByRole("dialog", { name: "Angebot.pdf" });
    await expect(viewer).toBeVisible();
    await viewer.getByRole("button", { name: "Schließen", exact: true }).click();
    await expect(viewer).toHaveCount(0);
  } else {
    expect(b.y).toBeGreaterThanOrEqual(a.y + a.height);
    expect(Math.abs(a.width - b.width)).toBeLessThan(2);
    await again.locator(".editor-columns .pdf-block").first().scrollIntoViewIfNeeded();
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/columns-pdf-phone.png` });
  }
  expect(errors).toEqual([]);
});

test("a PDF dropped at the edge of another PDF goes beside it", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "Mouse drag on wide layouts.");
  test.setTimeout(90_000);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const { id, command, upload, read } = await setup(page, "PDFs nebeneinander");
  const [first, second] = [await upload("Angebot.pdf", "Erstes Dokument"), await upload("Rechnung.pdf", "Zweites Dokument")];
  const { htmlState } = await import("../../lib/document-server");
  const pdf = (url: string, name: string) => `<div data-pdf="${url}" data-title="${name}" class="pdf-block"><a href="${url}">${name}</a></div>`;
  await command({
    action: "document.sync",
    pageId: id,
    generation: (await read()).generation,
    update: Buffer.from(htmlState(`<p>Unterlagen</p>${pdf(first, "Angebot.pdf")}${pdf(second, "Rechnung.pdf")}<p>Ende</p>`)).toString("base64"),
  });
  await page.goto(`/#page=${id}`);
  const editor = page.getByLabel("Dokumentinhalt", { exact: true });
  const cards = editor.locator(".pdf-block");
  await expect(cards).toHaveCount(2, { timeout: 20_000 });
  for (const i of [0, 1]) await expect.poll(() => cards.nth(i).locator("canvas").evaluate((c: HTMLCanvasElement) => c.width), { timeout: 15_000 }).toBeGreaterThan(100);
  // One below the other at first.
  const [a, b] = [(await cards.nth(0).boundingBox())!, (await cards.nth(1).boundingBox())!];
  expect(b.y).toBeGreaterThan(a.y + a.height - 1);
  await cards.nth(1).hover();
  const handle = page.getByRole("button", { name: "Blockaktionen: Medium · Rechnung.pdf", exact: true });
  await expect(handle).toBeVisible();
  const from = (await handle.boundingBox())!;
  // The first PDF's block is as wide as the text: its right edge.
  const target = (await editor.locator(".pdf-block").first().boundingBox())!;
  const right = (await editor.boundingBox())!;
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(Math.min(target.x + target.width, right.x + right.width) - 10, target.y + target.height / 2, { steps: 12 });
  await expect(page.locator(".document-block-drop")).toBeVisible();
  await page.mouse.up();
  await expect(editor.locator(".editor-columns .editor-column")).toHaveCount(2);
  await expect(editor.locator(".editor-columns .editor-column").nth(0)).toContainText("Angebot.pdf");
  await expect(editor.locator(".editor-columns .editor-column").nth(1)).toContainText("Rechnung.pdf");
  const [c, d] = [(await cards.nth(0).boundingBox())!, (await cards.nth(1).boundingBox())!];
  expect(Math.abs(c.y - d.y)).toBeLessThan(4);
  await expect.poll(async () => (await read()).html as string, { timeout: 15_000 }).toMatch(/data-columns[^]*Angebot\.pdf[^]*<\/div><div data-column[^]*Rechnung\.pdf/);
  expect(errors).toEqual([]);
  await command({ action: "page.delete", pageId: id });
});
