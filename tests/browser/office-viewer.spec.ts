import { test, expect, type Page } from "@playwright/test";
import { docx, pptx } from "../helpers/office-fixtures";
import { diagramPng } from "../helpers/png";

// The Office preview (#562): a .pptx, a .docx and an old .ppt dropped into
// a document become cards; the viewer shows a presentation slide by slide
// (title, bullets with levels, a table, a picture, the folded notes, "2 / 3",
// buttons, arrow keys, the slide list on wide screens) and a text document
// as one page (headings, lists, a table, a picture), always with the note
// that it is a content preview and the download.

const PNG = diagramPng(320, 200);
async function deck() {
  return await pptx(
    [
      {
        title: "Quartalsbericht",
        body: ["Umsatz gestiegen", { text: "Vor allem im Norden", level: 1 }, { text: "Und im Süden", level: 1 }, "Neue Kunden"],
        notes: ["Mit den Zahlen anfangen.", "Danach die Karte zeigen."],
      },
      { title: "Zahlen", box: ["Die wichtigsten Werte:"], table: [["Region", "Umsatz"], ["Nord", "1.200"], ["Süd", "950"]], pictures: ["karte.png"] },
      { title: "Ausblick", body: ["Mehr Märkte", "Weniger Papier"] },
    ],
    { media: { "ppt/media/karte.png": PNG } },
  );
}
async function letter() {
  return await docx(
    [
      { heading: 1, text: "Protokoll der Sitzung" },
      { text: "Anwesend waren alle, die eingeladen waren." },
      { heading: 2, text: "Beschlüsse" },
      { number: "Das Budget wird freigegeben." },
      { number: "Die Planung beginnt im Januar." },
      { number: "Zuerst die Räume", level: 1 },
      { bullet: "Offene Fragen sammeln" },
      { table: [["Wer", "Was", "Bis"], ["Anna", "Angebot", "Freitag"], ["Ben", "Plan", "Montag"]] },
      { picture: "skizze.png" },
    ],
    { media: { "skizze.png": PNG } },
  );
}

// Files dropped onto the document, as from the desktop.
async function drop(page: Page, files: { name: string; type: string; data: Buffer }[]) {
  await page
    .locator(".page-content .ProseMirror")
    .first()
    .evaluate((el, list) => {
      const data = new DataTransfer();
      for (const f of list) data.items.add(new File([Uint8Array.from(atob(f.data), (c) => c.charCodeAt(0))], f.name, { type: f.type }));
      const box = el.getBoundingClientRect();
      const at = { clientX: box.left + 20, clientY: box.bottom - 10, bubbles: true, cancelable: true, dataTransfer: data };
      el.dispatchEvent(new DragEvent("dragover", at));
      el.dispatchEvent(new DragEvent("drop", at));
    }, files.map((f) => ({ ...f, data: f.data.toString("base64") })));
}
// Screenshots for a look at the viewer (OFFICE_SHOTS=<folder>), not compared.
async function shot(page: Page, name: string) {
  const folder = process.env.OFFICE_SHOTS;
  if (folder) await page.screenshot({ path: `${folder}/562-${name}.png` });
}

test("presentations and text documents dropped into a document: cards, the slide viewer, the document page", async ({ page }, info) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const phone = info.project.name === "mobile";
  const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
  await page.request.post("/api/auth/demo", { headers: { origin } });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const response = await page.request.post("/api/command", {
    headers: { origin },
    data: { action: "page.create", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, title: `Folien ${info.project.name} ${Date.now()}`, kind: "document" },
  });
  const p = await response.json();
  await page.goto(`/#page=${p.id}`);
  const text = page.locator(".page-content .ProseMirror").first();
  await expect(text).toBeVisible({ timeout: 20_000 });
  await text.click();
  await page.keyboard.type("Unterlagen:");
  await page.keyboard.press("Enter");
  const editor = page.getByLabel("Dokumentinhalt", { exact: true });
  await drop(page, [{ name: "bericht.pptx", type: "application/vnd.openxmlformats-officedocument.presentationml.presentation", data: await deck() }]);
  const slidesCard = editor.getByRole("button", { name: "Vorschau von „bericht.pptx“ öffnen" });
  await expect(slidesCard).toBeVisible({ timeout: 20_000 });
  await expect(slidesCard).toContainText("Präsentation · Vorschau öffnen");
  await drop(page, [{ name: "protokoll.docx", type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", data: await letter() }]);
  const docCard = editor.getByRole("button", { name: "Vorschau von „protokoll.docx“ öffnen" });
  await expect(docCard).toBeVisible({ timeout: 20_000 });
  await expect(docCard).toContainText("Textdokument · Vorschau öffnen");
  await drop(page, [{ name: "alt.ppt", type: "application/vnd.ms-powerpoint", data: Buffer.from("d0cf11e0a1b11ae1", "hex") }]);
  // The old format: only the download, which the card says.
  const old = editor.getByRole("link", { name: "„alt.ppt“ herunterladen" });
  await expect(old).toBeVisible({ timeout: 20_000 });
  await expect(old).toContainText("PowerPoint 97–2003 · nur Download");
  await expect(old).toHaveAttribute("download", "alt.ppt");

  // The presentation, one slide at a time.
  await slidesCard.click();
  const viewer = page.getByRole("dialog", { name: "bericht.pptx" });
  await expect(viewer).toBeVisible();
  const slide = viewer.locator("article.office-slide");
  await expect(slide.locator("h2")).toHaveText("Quartalsbericht", { timeout: 15_000 });
  await expect(viewer.getByText("Inhaltsvorschau – nicht das genaue Layout.", { exact: false })).toBeVisible();
  await expect(viewer.locator(".office-pager-count")).toHaveText("1 / 3");
  await expect(slide.locator(".office-item")).toHaveText(["•Umsatz gestiegen", "◦Vor allem im Norden", "◦Und im Süden", "•Neue Kunden"]);
  await expect(slide.locator(".office-level-1")).toHaveCount(2);
  await expect(viewer.getByRole("link", { name: "Herunterladen" })).toHaveAttribute("download", "bericht.pptx");
  // The notes, folded until asked for.
  const notes = viewer.locator("details.office-notes");
  await expect(notes.getByText("Mit den Zahlen anfangen.")).toBeHidden();
  await notes.locator("summary").click();
  await expect(notes.getByText("Mit den Zahlen anfangen.")).toBeVisible();
  // The slide list beside it on wide screens only.
  const outline = viewer.getByRole("navigation", { name: "Folien" });
  if (phone) await expect(outline).toBeHidden();
  else await expect(outline.getByRole("button")).toHaveText(["1Quartalsbericht", "2Zahlen", "3Ausblick"]);
  await shot(page, phone ? "phone-slide" : "desktop-light-slide");

  const previous = viewer.getByRole("button", { name: "Vorherige Folie" });
  const next = viewer.getByRole("button", { name: "Nächste Folie" });
  await expect(previous).toBeDisabled();
  await next.click();
  await expect(viewer.locator(".office-pager-count")).toHaveText("2 / 3");
  await expect(slide.locator("h2")).toHaveText("Zahlen");
  await expect(slide.locator(".office-paragraph")).toHaveText(["Die wichtigsten Werte:"]);
  await expect(slide.locator("table.office-table tr")).toHaveCount(3);
  await expect(slide.locator("table.office-table tr").nth(1).locator("td")).toHaveText(["Nord", "1.200"]);
  // The picture from the file, loaded through the picture route.
  const picture = slide.locator("img.office-image");
  await expect(picture).toHaveAttribute("src", /\/office\/image\?name=ppt%2Fmedia%2Fkarte\.png$/);
  await expect.poll(async () => await picture.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth)).toBe(320);
  await expect(viewer.locator("details.office-notes")).toHaveCount(0);
  await shot(page, phone ? "phone-slide-2" : "desktop-light-slide-2");
  if (!phone) {
    // Arrow keys, and the list.
    await page.keyboard.press("ArrowRight");
    await expect(viewer.locator(".office-pager-count")).toHaveText("3 / 3");
    await expect(next).toBeDisabled();
    await page.keyboard.press("ArrowLeft");
    await expect(viewer.locator(".office-pager-count")).toHaveText("2 / 3");
    await outline.getByRole("button", { name: /Quartalsbericht/ }).click();
    await expect(viewer.locator(".office-pager-count")).toHaveText("1 / 3");
    await page.emulateMedia({ colorScheme: "dark" });
    await page.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"));
    await shot(page, "desktop-dark-slide");
    await page.evaluate(() => document.documentElement.removeAttribute("data-theme"));
    await page.emulateMedia({ colorScheme: "light" });
  } else {
    await next.click();
    await expect(viewer.locator(".office-pager-count")).toHaveText("3 / 3");
    await previous.click();
    await previous.click();
    await expect(viewer.locator(".office-pager-count")).toHaveText("1 / 3");
  }
  await page.keyboard.press("Escape");
  await expect(viewer).toBeHidden();

  // The text document: one page.
  await docCard.click();
  const reader = page.getByRole("dialog", { name: "protokoll.docx" });
  const pageView = reader.locator("article.office-page");
  await expect(pageView.locator("h2")).toHaveText("Protokoll der Sitzung", { timeout: 15_000 });
  await expect(pageView.locator("h3")).toHaveText("Beschlüsse");
  await expect(pageView.locator(".office-item")).toHaveText(["1.Das Budget wird freigegeben.", "2.Die Planung beginnt im Januar.", "1.Zuerst die Räume", "•Offene Fragen sammeln"]);
  await expect(pageView.locator("table.office-table tr").first().locator("td")).toHaveText(["Wer", "Was", "Bis"]);
  await expect.poll(async () => await pageView.locator("img.office-image").evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth)).toBe(320);
  await expect(reader.locator(".office-pager")).toHaveCount(0);
  await shot(page, phone ? "phone-document" : "desktop-light-document");
  await reader.getByRole("button", { name: "Schließen" }).click();
  await expect(reader).toBeHidden();
  expect(errors).toEqual([]);
});
