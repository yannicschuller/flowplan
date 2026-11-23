import { readFileSync } from "node:fs";
import { test, expect, type Page } from "@playwright/test";

// QR codes for every page and record and QR label sheets of a database
// (#448): the page's ⋯ menu and a record's menu open the form's QR dialog
// (components/form-qr.tsx) with their own address; "QR-Etiketten drucken"
// prints the view's or the selected records as labels
// (components/qr-labels.tsx). Nothing is really printed: the print frame's
// print() counts instead, and the test reads the copy inside it.
const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";

async function signIn(page: Page) {
  await page.request.post("/api/auth/demo", { headers: { origin } });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const command = async (data: Record<string, unknown>) => {
    const response = await page.request.post("/api/command", { headers: { origin }, data });
    expect(response.ok(), await response.text()).toBe(true);
    return response.json();
  };
  await command({ action: "profile.onboarded" });
  return { boot, command };
}
// Every print frame prints into a counter instead of the printer.
async function stubPrint(page: Page) {
  await page.evaluate(() => {
    const w = window as unknown as { __printed: number };
    w.__printed = 0;
    new MutationObserver(() => {
      const frame = document.querySelector<HTMLIFrameElement>("iframe.print-frame");
      if (frame?.contentWindow && !(frame as unknown as { stubbed?: boolean }).stubbed) {
        (frame as unknown as { stubbed?: boolean }).stubbed = true;
        frame.contentWindow.print = () => void w.__printed++;
      }
    }).observe(document.body, { childList: true });
    window.print = () => void w.__printed++;
  });
}
const printed = (page: Page) => page.evaluate(() => (window as unknown as { __printed: number }).__printed);
async function dismissWelcome(page: Page) {
  const welcome = page.getByRole("dialog", { name: "Willkommen bei Flowplan" });
  if (await welcome.isVisible()) {
    await page.keyboard.press("Escape");
    await expect(welcome).toBeHidden();
  }
}

test("a page's QR code: from the ⋯ menu, its own address, SVG download and a print sheet", async ({ page }, info) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const { boot, command } = await signIn(page);
  const title = `Kiste 0001 ${info.project.name} ${Date.now()}`;
  const doc = await command({ action: "page.create", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, title, kind: "document" });
  await page.goto(`/#page=${doc.id}`);
  await expect(page.getByLabel("Dokumentinhalt", { exact: true })).toBeVisible();
  await dismissWelcome(page);
  await stubPrint(page);

  await page.getByRole("button", { name: "Seitenaktionen" }).click();
  await page.getByRole("menuitem", { name: "QR-Code", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "QR-Code der Seite" });
  await expect(dialog).toBeVisible();
  const code = dialog.getByRole("img", { name: "QR-Code mit dem Link zur Seite" });
  await expect(code.locator("rect")).toHaveAttribute("fill", "#fff");
  await expect(code.locator("path")).toHaveAttribute("fill", "#000");
  await expect(dialog.getByRole("heading", { name: title })).toBeVisible();
  // The address "Copy link" gives.
  const link = await dialog.locator(".form-qr-link").textContent();
  expect(link).toBe(`${new URL(page.url()).origin}/#page=${doc.id}`);
  await expect(dialog.getByText("für alle, die angemeldet sind und sie sehen dürfen")).toBeVisible();

  const svgLink = dialog.getByRole("link", { name: "SVG herunterladen" });
  await expect(svgLink).toHaveAttribute("download", /^Kiste-0001-.*-qr\.svg$/);
  const [download] = await Promise.all([page.waitForEvent("download"), svgLink.click()]);
  expect(readFileSync((await download.path())!, "utf8")).toMatch(/^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
  await expect(dialog.getByRole("link", { name: "PNG herunterladen" })).toHaveAttribute("href", /^blob:/);

  // The print sheet: title, code and link in the print frame.
  await dialog.getByRole("button", { name: "Drucken", exact: true }).click();
  await expect.poll(() => printed(page)).toBe(1);
  const sheet = page.frameLocator("iframe.print-frame").locator(".form-qr-sheet");
  await expect(sheet.locator(".form-qr-title")).toHaveText(title);
  await expect(sheet.locator("svg.form-qr-code path")).toHaveCount(1);
  await expect(sheet.locator(".form-qr-link")).toHaveText(link!);
  expect(await dialog.locator(".form-qr-sheet [style]").count()).toBe(0);
  // The print frame holds the focus after printing: closed by its button.
  await dialog.getByRole("button", { name: "Schließen", exact: true }).click();
  await expect(dialog).toBeHidden();
  expect(errors).toEqual([]);
});

test("a record's QR code: from the record's menu, the record's own address", async ({ page }, info) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const { boot, command } = await signIn(page);
  const db = await command({ action: "page.create", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, title: `Lager ${info.project.name} ${Date.now()}`, kind: "database" });
  const row = await command({ action: "row.create", pageId: db.id, cells: { title: "Kiste 0042" } });
  await page.goto(`/#page=${db.id}&row=${row.id}`);
  await dismissWelcome(page);
  const record = page.getByRole("dialog").filter({ has: page.getByRole("button", { name: "Weitere Aktionen" }) });
  await record.getByRole("button", { name: "Weitere Aktionen" }).click();
  await page.getByRole("menuitem", { name: "QR-Code", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "QR-Code des Eintrags" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("img", { name: "QR-Code mit dem Link zum Eintrag" })).toBeVisible();
  await expect(dialog.getByRole("heading", { name: "Kiste 0042" })).toBeVisible();
  expect(await dialog.locator(".form-qr-link").textContent()).toBe(`${new URL(page.url()).origin}/#page=${db.id}&row=${row.id}`);
  await expect(dialog.getByRole("link", { name: "SVG herunterladen" })).toHaveAttribute("download", "Kiste-0042-qr.svg");
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  expect(errors).toEqual([]);
});

test("QR labels of a database: preset, skipped places, properties, preview and the print copy", async ({ page }, info) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const { boot, command } = await signIn(page);
  const db = await command({ action: "page.create", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, title: `Inventar ${info.project.name} ${Date.now()}`, kind: "database" });
  for (let i = 1; i <= 5; i++) await command({ action: "row.create", pageId: db.id, cells: { title: `Kiste 000${i}`, status: i % 2 ? "Erledigt" : "In Arbeit" } });
  await page.goto(`/#page=${db.id}`);
  await dismissWelcome(page);
  await expect(page.getByText("Kiste 0005")).toBeVisible();
  await stubPrint(page);

  await page.getByRole("button", { name: "Exportieren", exact: true }).click();
  await page.getByRole("menuitem", { name: "QR-Etiketten drucken …" }).click();
  const dialog = page.getByRole("dialog", { name: "QR-Etiketten drucken" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText("Für die 5 Einträge der Ansicht")).toBeVisible();
  const preview = dialog.locator(".qr-labels-preview");
  const labels = preview.locator(".qrl-label:not(.qrl-empty)");
  await expect(labels).toHaveCount(5);
  // A4 3 × 8 by default: 24 places.
  await expect(preview.locator(".qrl-empty")).toHaveCount(24);
  await expect(dialog.getByRole("status")).toContainText("5 Etiketten auf 1 Bogen");
  await expect(labels.first().locator(".qrl-title")).toHaveText("Kiste 0001");
  await expect(labels.first().locator("svg.qrl-code path")).toHaveCount(1);

  // Avery L7163 (14 places), the first 12 used already: two sheets.
  await dialog.getByRole("combobox", { name: "Etikettenbogen" }).selectOption("a4-2x7");
  await expect(preview.locator(".qrl-empty")).toHaveCount(14);
  await dialog.getByRole("spinbutton", { name: /Erste Plätze/ }).fill("12");
  await expect(labels).toHaveCount(2);
  await expect(preview.locator(".qrl-skipped")).toHaveCount(12);
  await expect(dialog.getByRole("status")).toContainText("5 Etiketten auf 2 Bögen");

  // A property under the title, with its name.
  await dialog.getByRole("combobox", { name: "Eigenschaft 1" }).selectOption({ label: "Status" });
  await expect(labels.first().locator(".qrl-detail")).toHaveText("Erledigt");
  await dialog.getByRole("checkbox", { name: "Mit dem Namen der Eigenschaft" }).check();
  await expect(labels.nth(1).locator(".qrl-detail")).toHaveText("Status: In Arbeit");

  // A custom size that does not fit: said so, nothing to print.
  await dialog.getByRole("combobox", { name: "Etikettenbogen" }).selectOption("custom");
  await dialog.getByRole("spinbutton", { name: "Spalten" }).fill("5");
  await expect(dialog.getByText("Die Etiketten passen nicht in die Breite des Papiers.")).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Drucken", exact: true })).toBeDisabled();
  await dialog.getByRole("spinbutton", { name: "Spalten" }).fill("3");
  await expect(dialog.getByRole("button", { name: "Drucken", exact: true })).toBeEnabled();
  await dialog.getByRole("combobox", { name: "Etikettenbogen" }).selectOption("a4-2x7");

  // The print copy: every sheet at its size, the paper without margins.
  await dialog.getByRole("button", { name: "Drucken", exact: true }).click();
  await expect.poll(() => printed(page)).toBe(1);
  const frame = page.frameLocator("iframe.print-frame");
  await expect(frame.locator(".qrl-page")).toHaveCount(2);
  await expect(frame.locator(".qrl-label")).toHaveCount(5);
  await expect(frame.locator(".qrl-empty")).toHaveCount(0);
  await expect(frame.locator(".qrl-page").first().locator(".qrl-label")).toHaveCount(2);
  expect(await frame.locator(".qrl-root style").textContent()).toContain("@page{size:210mm 297mm;margin:0}");
  expect(await frame.locator(".qrl-root [style]").count()).toBe(0);
  const size = await frame.locator(".qrl-label").first().evaluate((el) => [el.getBoundingClientRect().width, el.getBoundingClientRect().height]);
  // 99.1 × 38.1 mm at 96 dpi.
  expect(Math.abs(size[0] - (99.1 * 96) / 25.4)).toBeLessThan(1);
  expect(Math.abs(size[1] - (38.1 * 96) / 25.4)).toBeLessThan(1);

  // The choice stays for this database.
  await dialog.getByRole("button", { name: "Schließen", exact: true }).click();
  await expect(dialog).toBeHidden();
  await page.getByRole("button", { name: "Exportieren", exact: true }).click();
  await page.getByRole("menuitem", { name: "QR-Etiketten drucken …" }).click();
  await expect(dialog.getByRole("combobox", { name: "Etikettenbogen" })).toHaveValue("a4-2x7");
  await page.keyboard.press("Escape");
  expect(errors).toEqual([]);
});

test("QR labels for the selected records from the selection bar", async ({ page }, info) => {
  test.skip(info.project.name === "mobile", "The selection bar of the table is tested on the desktop.");
  const { boot, command } = await signIn(page);
  const db = await command({ action: "page.create", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, title: `Regal ${Date.now()}`, kind: "database" });
  for (const title of ["Kiste A", "Kiste B", "Kiste C"]) await command({ action: "row.create", pageId: db.id, cells: { title } });
  await page.goto(`/#page=${db.id}`);
  await dismissWelcome(page);
  await page.getByRole("checkbox", { name: "Kiste C auswählen" }).check();
  await page.getByRole("checkbox", { name: "Kiste A auswählen" }).check();
  const bar = page.getByRole("toolbar", { name: "Ausgewählte Einträge" });
  await bar.getByRole("button", { name: "QR-Etiketten drucken" }).click();
  const dialog = page.getByRole("dialog", { name: "QR-Etiketten drucken" });
  await expect(dialog.getByText("Für die 2 ausgewählten Einträge.")).toBeVisible();
  // In the view's order, not the order of selecting.
  await expect(dialog.locator(".qr-labels-preview .qrl-title")).toHaveText(["Kiste A", "Kiste C"]);
  await expect(dialog.getByRole("status")).toContainText("2 Etiketten auf 1 Bogen");
});
