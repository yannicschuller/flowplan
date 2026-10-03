import { test, expect } from "@playwright/test";
import { samplePdf } from "../helpers/pdf";

// A PDF in a document shows its first page; a click opens the viewer with
// all pages, zoom and download.
test("PDF preview in a document and the viewer", async ({ page }, info) => {
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
  const p = await command({ action: "page.create", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, title: `PDF ${info.project.name} ${Date.now()}`, kind: "document" });
  const uploaded = await page.request.post("/api/upload", {
    headers: { origin },
    multipart: {
      pageId: p.id,
      file: { name: "Angebot.pdf", mimeType: "application/pdf", buffer: samplePdf(["Seite eins", "Seite zwei"]) },
    },
  });
  const { url } = await uploaded.json();
  const data = await (await page.request.get(`/api/pages/${p.id}`)).json();
  const { htmlState } = await import("../../lib/document-server");
  await command({
    action: "document.sync",
    workspaceId: boot.workspace.id,
    pageId: p.id,
    generation: data.generation,
    update: Buffer.from(
      htmlState(`<p>Unser Angebot:</p><div data-pdf="${url}" data-title="Angebot.pdf" class="pdf-block"><a href="${url}">Angebot.pdf</a></div>`),
    ).toString("base64"),
  });
  await page.goto(`/#page=${p.id}`);
  const editor = page.getByLabel("Dokumentinhalt", { exact: true });
  const card = editor.getByRole("button", { name: "PDF „Angebot.pdf“ öffnen" });
  await expect(card).toBeVisible({ timeout: 20_000 });
  // The first page is drawn as the preview.
  await expect.poll(() => card.locator("canvas").evaluate((c: HTMLCanvasElement) => c.width), { timeout: 15_000 }).toBeGreaterThan(100);
  await card.click();
  const viewer = page.getByRole("dialog", { name: "Angebot.pdf" });
  await expect(viewer).toBeVisible();
  if (info.project.name === "desktop") await expect(viewer).toContainText("Seite 1 von 2");
  await expect(viewer.locator("canvas.pdf-page")).toHaveCount(2);
  await expect.poll(() => viewer.locator("canvas.pdf-page").first().evaluate((c: HTMLCanvasElement) => c.width), { timeout: 15_000 }).toBeGreaterThan(300);
  await expect(viewer.getByRole("link", { name: "Herunterladen" })).toHaveAttribute("href", url);
  await viewer.getByRole("button", { name: "Vergrößern" }).click();
  if (info.project.name === "desktop") await expect(viewer).toContainText("125 %");
  await page.keyboard.press("Escape");
  await expect(viewer).toHaveCount(0);
  expect(errors).toEqual([]);
});
