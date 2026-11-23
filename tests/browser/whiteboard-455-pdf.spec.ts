import { test, expect, type Locator, type Page } from "@playwright/test";
import { samplePdf } from "../helpers/pdf";
import { boardInsert } from "./whiteboard-ui";

// Issue #455: PDFs on the whiteboard – pages chosen on import (one element
// limited to them, or one per page), drawn sharp for the zoom, with the
// PDF's annotations and a switch to hide them – and comment pins with the
// comment content of page comments (formatting, page mentions, links), a
// colour per pin and a hover preview of the badge.

const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
async function setup(page: Page, title: string) {
  await page.request.post("/api/auth/demo", { headers: { origin } });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const command = async (data: Record<string, unknown>) => {
    const r = await page.request.post("/api/command", { headers: { origin }, data });
    expect(r.ok(), await r.text()).toBe(true);
    return r.json();
  };
  await command({ action: "profile.onboarded" });
  const board = await command({ action: "page.create", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, title, kind: "whiteboard" });
  return { boot, command, board };
}
const pdfBytes = samplePdf(["Seite eins", "Seite zwei", "Seite drei", "Seite vier", "Seite fünf"]);

// Red pixels on the PDF page's canvas (the annotation below is red).
const redPixels = (canvas: Locator) =>
  canvas.evaluate((el: HTMLCanvasElement) => {
    const ctx = el.getContext("2d");
    if (!ctx || !el.width) return -1;
    const data = ctx.getImageData(0, 0, el.width, el.height).data;
    let n = 0;
    for (let i = 0; i < data.length; i += 4) if (data[i] > 180 && data[i + 1] < 90 && data[i + 2] < 90) n++;
    return n;
  });

test("PDF pages are chosen on import and drawn sharp, with their annotations", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === "mobile", "Desktop-Zeigergesten");
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const { board } = await setup(page, `PDF ${Date.now()}`);
  await page.goto(`/#page=${board.id}`);
  const wb = page.getByLabel("Whiteboard", { exact: true });
  await expect(wb.locator(".wb-canvas")).toBeVisible();

  // Embed → upload: the pages are chosen first.
  await boardInsert(wb, "Einbetten");
  await page.getByLabel("PDF für das Whiteboard").setInputFiles({ name: "Handbuch.pdf", mimeType: "application/pdf", buffer: pdfBytes });
  const pick = page.getByRole("dialog", { name: "Seiten auswählen" });
  await expect(pick).toBeVisible();
  await expect(pick.getByText("5 von 5 Seiten ausgewählt.")).toBeVisible();
  await expect(pick.locator(".wb-pdf-pick-page canvas")).toHaveCount(5);
  // A typo is refused, ranges are taken.
  await pick.getByLabel("Seiten", { exact: true }).fill("2-9");
  await expect(pick.getByText("Bitte Seiten von 1 bis 5 angeben, z. B. 1-3, 7.")).toBeVisible();
  await expect(pick.getByRole("button", { name: /hinzufügen/ })).toBeDisabled();
  await pick.getByLabel("Seiten", { exact: true }).fill("2-3, 5");
  await expect(pick.getByText("3 von 5 Seiten ausgewählt.")).toBeVisible();
  await expect(pick.getByRole("checkbox", { name: "Seite 4" })).not.toBeChecked();
  // A thumbnail's box takes a page off again.
  await pick.getByRole("checkbox", { name: "Seite 5" }).uncheck();
  await expect(pick.getByLabel("Seiten", { exact: true })).toHaveValue("2-3");
  const uploaded = page.waitForResponse((r) => r.url().endsWith("/api/upload") && r.request().method() === "POST");
  await pick.getByRole("button", { name: "2 Seiten hinzufügen" }).click();
  const fileSrc = ((await (await uploaded).json()) as { url: string }).url;
  await expect(pick).toBeHidden();

  // One element with the page buttons within those pages.
  const pdf = wb.locator("g.wb-embed .wb-pdf");
  await expect(pdf).toHaveCount(1);
  const nav = pdf.locator(".wb-pdf-nav");
  await expect(nav).toContainText("2 · 1/2");
  await nav.getByRole("button", { name: "Nächste Seite" }).click();
  await expect(nav).toContainText("3 · 2/2");
  await expect(nav.getByRole("button", { name: "Nächste Seite" })).toBeDisabled();

  // Drawn for the zoom: zooming in draws the page with more pixels.
  const canvas = pdf.locator("canvas.wb-pdf-page");
  await expect(canvas).toHaveAttribute("data-drawn", /\d+/);
  const before = Number(await canvas.getAttribute("data-drawn"));
  for (let i = 0; i < 4; i++) await wb.getByRole("button", { name: "Vergrößern", exact: true }).click();
  await expect.poll(async () => Number(await canvas.getAttribute("data-drawn")), { timeout: 10_000 }).toBeGreaterThan(before * 1.9);
  await wb.getByRole("button", { name: "Zoom zurücksetzen" }).click();

  // Annotations made in the viewer (saved here through the API) show on
  // the board's page, and can be hidden on this element.
  const saved = await page.request.post(`${fileSrc}/ink`, {
    headers: { origin },
    data: {
      base: 0,
      doc: {
        format: "flowplan-ink",
        version: 1,
        unit: "pt",
        pages: { "3": [{ id: "red", type: "pen", color: "#e03131", width: 30, points: [100, 300, 0.5, 300, 300, 0.5, 500, 300, 0.5] }] },
      },
    },
  });
  expect(saved.ok(), await saved.text()).toBe(true);
  await page.reload();
  await expect(canvas).toHaveAttribute("data-drawn", /\d+/);
  const hide = pdf.getByRole("button", { name: "Anmerkungen ausblenden" });
  await expect(hide).toHaveAttribute("aria-pressed", "true");
  await expect.poll(() => redPixels(canvas), { timeout: 10_000 }).toBeGreaterThan(100);
  // (The page's title may cover the element after the reload: the board's
  // own handler takes the press.)
  await hide.dispatchEvent("pointerdown", { button: 0, isPrimary: true, pointerType: "mouse" });
  await expect(pdf.getByRole("button", { name: "Anmerkungen einblenden" })).toHaveAttribute("aria-pressed", "false");
  await expect.poll(() => redPixels(canvas), { timeout: 10_000 }).toBe(0);
  expect(errors).toEqual([]);
});

test("a dropped PDF can go onto the board as one element per page", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === "mobile", "Desktop-Zeigergesten");
  const { board } = await setup(page, `PDF-Seiten ${Date.now()}`);
  await page.goto(`/#page=${board.id}`);
  const wb = page.getByLabel("Whiteboard", { exact: true });
  const canvas = wb.locator(".wb-canvas");
  await expect(canvas).toBeVisible();
  const box = (await canvas.boundingBox())!;
  const transfer = await page.evaluateHandle((bytes) => {
    const dt = new DataTransfer();
    dt.items.add(new File([new Uint8Array(bytes)], "Folien.pdf", { type: "application/pdf" }));
    return dt;
  }, [...pdfBytes]);
  await canvas.dispatchEvent("drop", { dataTransfer: transfer, clientX: box.x + box.width / 2, clientY: box.y + box.height / 2 });
  const pick = page.getByRole("dialog", { name: "Seiten auswählen" });
  await expect(pick).toBeVisible();
  await pick.getByLabel("Seiten", { exact: true }).fill("1, 4");
  await pick.getByRole("radio", { name: "Jede Seite als eigenes Element" }).check();
  await pick.getByRole("button", { name: "2 Seiten hinzufügen" }).click();
  await expect(wb.locator("g.wb-embed .wb-pdf")).toHaveCount(2);
  // A single page each: no page buttons.
  await expect(wb.locator(".wb-pdf-nav")).toHaveCount(0);
  await expect(wb.locator("canvas.wb-pdf-page").first()).toHaveAttribute("aria-label", "Seite 1 von Folien.pdf");
  await expect(wb.locator("canvas.wb-pdf-page").nth(1)).toHaveAttribute("aria-label", "Seite 4 von Folien.pdf");
});

test("comment pins have formatted comments, page mentions, links, a colour and a hover preview", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === "mobile", "Desktop-Zeigergesten");
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const { boot, command, board } = await setup(page, `Kommentare ${Date.now()}`);
  const title = `Roadmap ${Date.now()}`;
  const target = await command({ action: "page.create", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, title });
  await page.goto(`/#page=${board.id}`);
  const wb = page.getByLabel("Whiteboard", { exact: true });
  const canvas = wb.locator(".wb-canvas");
  await expect(canvas).toBeVisible();
  await wb.getByRole("button", { name: "Kommentar", exact: true }).click();
  const box = (await canvas.boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  const comment = wb.getByRole("dialog", { name: "Kommentar" });
  const field = comment.getByRole("textbox", { name: "Kommentar schreiben" });
  await expect(field).toBeFocused();
  await page.keyboard.type("Bitte ");
  await page.keyboard.press("ControlOrMeta+b");
  await page.keyboard.type("dringend");
  await page.keyboard.press("ControlOrMeta+b");
  await page.keyboard.type(" lesen: @Roadmap");
  const option = comment.getByRole("option", { name: new RegExp(title) });
  await expect(option).toBeVisible({ timeout: 15_000 });
  await option.click();
  await page.keyboard.type("und https://example.org ");
  // A file, by the paperclip's file field.
  await comment.locator('input[type="file"]').setInputFiles({ name: "notizen.txt", mimeType: "text/plain", buffer: Buffer.from("Hallo") });
  await expect(comment.locator(".comment-files").getByText("notizen.txt")).toBeVisible({ timeout: 15_000 });
  await comment.getByRole("button", { name: "Senden" }).click();
  const message = comment.locator(".wb-comment-message").first();
  await expect(message.locator("strong", { hasText: "dringend" })).toBeVisible();
  await expect(message.locator("a.comment-page-mention")).toHaveText(new RegExp(title));
  await expect(message.getByRole("link", { name: /notizen\.txt/ })).toHaveAttribute("href", /^\/api\/files\//);
  await expect(message.locator("a.comment-page-mention")).toHaveAttribute("href", new RegExp(target.id));
  await expect(message.locator('a[href="https://example.org"]')).toBeVisible();

  // The stored board has the page by id only, the plain text "@…".
  await expect
    .poll(async () => page.evaluate(async (id) => (await (await fetch(`/api/pages/${id}`)).json()).html as string, board.id), { timeout: 15_000 })
    .toContain("Bitte dringend lesen: @…");

  // A colour for the pin.
  await comment.getByRole("button", { name: "Farbe des Kommentars: Orange" }).click();
  await comment.getByRole("radio", { name: "Blau" }).click();
  await expect(wb.locator("g.wb-comment path").first()).toHaveAttribute("fill", "#1c7ed6");
  await comment.getByRole("button", { name: "Kommentar schließen" }).click();
  await expect(comment).toBeHidden();

  // Hovering the badge shows the first comment; a click opens the thread.
  await wb.locator("g.wb-comment").hover();
  const preview = page.locator(".wb-comment-preview");
  await expect(preview).toBeVisible();
  await expect(preview).toContainText(`Bitte dringend lesen: @${title} und https://example.org`);
  await expect(preview).toContainText("Keine Antworten");
  await preview.click();
  await expect(comment).toBeVisible();
  expect(errors).toEqual([]);
});

test("comment pins: authors edit and delete their own messages", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === "mobile", "Desktop-Zeigergesten");
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const { board } = await setup(page, `Kommentare bearbeiten ${Date.now()}`);
  await page.goto(`/#page=${board.id}`);
  const wb = page.getByLabel("Whiteboard", { exact: true });
  const canvas = wb.locator(".wb-canvas");
  await expect(canvas).toBeVisible();
  await wb.getByRole("button", { name: "Kommentar", exact: true }).click();
  const box = (await canvas.boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  const comment = wb.getByRole("dialog", { name: "Kommentar" });
  await expect(comment.getByRole("textbox", { name: "Kommentar schreiben" })).toBeFocused();
  await page.keyboard.type("Erste Fassung");
  await comment.locator('input[type="file"]').setInputFiles({ name: "anhang.txt", mimeType: "text/plain", buffer: Buffer.from("Hallo") });
  await expect(comment.locator(".comment-files").getByText("anhang.txt")).toBeVisible({ timeout: 15_000 });
  await comment.getByRole("button", { name: "Senden" }).click();
  const first = comment.locator(".wb-comment-message").first();
  await expect(first).toContainText("Erste Fassung");
  await comment.getByRole("textbox", { name: "Antworten" }).click();
  await page.keyboard.type("Eine Antwort");
  await comment.getByRole("button", { name: "Senden" }).click();
  const messages = comment.locator(".wb-comment-message");
  await expect(messages).toHaveCount(2);

  // Edit in place with the composer: "· bearbeitet".
  await first.hover();
  await first.getByRole("button", { name: "Kommentar bearbeiten" }).click();
  const edit = first.getByRole("textbox", { name: "Kommentartext bearbeiten" });
  await expect(edit).toBeFocused();
  await expect(edit).toContainText("Erste Fassung");
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.type("Zweite Fassung");
  await first.getByRole("button", { name: "Änderung speichern" }).click();
  await expect(first).toContainText("Zweite Fassung");
  await expect(first).toContainText("bearbeitet");
  await expect(first.getByRole("textbox")).toHaveCount(0);
  // Cancelling keeps the text.
  await first.hover();
  await first.getByRole("button", { name: "Kommentar bearbeiten" }).click();
  await page.keyboard.type(" verworfen");
  await first.getByRole("button", { name: "Bearbeitung abbrechen" }).click();
  await expect(first).not.toContainText("verworfen");

  // Deleting the first message (with a reply): asked first, a placeholder
  // stays, its attachment goes to the file trash.
  const trash = page.waitForRequest((r) => r.url().endsWith(`/api/whiteboards/${board.id}/comments`) && (r.postData() || "").includes('"trash"'), { timeout: 20_000 });
  await first.hover();
  await first.getByRole("button", { name: "Kommentar löschen" }).click();
  const confirm = page.getByRole("dialog", { name: "Kommentar löschen" });
  await expect(confirm).toContainText("Papierkorb");
  await confirm.getByRole("button", { name: "Kommentar endgültig löschen" }).click();
  await expect(first).toContainText("Kommentar gelöscht");
  await expect(first.getByRole("button", { name: "Kommentar bearbeiten" })).toHaveCount(0);
  await expect(messages.nth(1)).toContainText("Eine Antwort");
  await trash;
  await comment.getByRole("button", { name: "Kommentar schließen" }).click();
  await wb.locator("g.wb-comment").hover();
  await expect(page.locator(".wb-comment-preview")).toContainText("Kommentar gelöscht");
  await expect(page.locator(".wb-comment-preview")).toContainText("1 Antwort");
  await page.locator(".wb-comment-preview").click();

  // Deleting the last message left removes the pin.
  const reply = messages.nth(1);
  await reply.hover();
  await reply.getByRole("button", { name: "Kommentar löschen" }).click();
  await confirm.getByRole("button", { name: "Kommentar endgültig löschen" }).click();
  await expect(comment).toHaveCount(0);
  await expect(wb.locator("g.wb-comment")).toHaveCount(0);
  expect(errors).toEqual([]);
});
