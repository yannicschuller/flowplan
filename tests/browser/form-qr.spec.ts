import { test, expect } from "@playwright/test";

// The QR code of a form's link (#415): next to "Formularlink kopieren", a
// dialog with the code on a white tile, downloads as SVG and PNG (at least
// 1024 pixels) and a print button.
test("the form's QR code opens in a dialog with SVG and PNG downloads", async ({ page }, info) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
  await page.request.post("/api/auth/demo", { headers: { origin } });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const command = async (data: Record<string, unknown>) => {
    const response = await page.request.post("/api/command", { headers: { origin }, data });
    expect(response.ok(), await response.text()).toBe(true);
    return response.json();
  };
  await command({ action: "profile.onboarded" });
  const title = `Einkaufsliste ${info.project.name} ${Date.now()}`;
  const db = await command({ action: "page.create", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, title, kind: "database" });
  await command({ action: "form.update", pageId: db.id, enabled: true, internal: false, anonymous: true });
  const token = (await (await page.request.get(`/api/pages/${db.id}`)).json()).form.token as string;

  await page.goto(`/#page=${db.id}`);
  const views = page.getByRole("group", { name: "Ansichten" });
  const tab = views.getByRole("button", { name: "Formular", exact: true });
  if (await tab.isVisible()) await tab.click();
  else {
    await views.getByRole("button", { name: /^Weitere Ansichten/ }).click();
    await page.getByRole("menuitem", { name: "Formular", exact: true }).click();
  }
  await expect(page.getByRole("button", { name: "Formularlink kopieren" })).toBeVisible();
  await page.getByRole("button", { name: "QR-Code", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "QR-Code des Formulars" });
  await expect(dialog).toBeVisible();

  // The code: dark on a white tile with a quiet zone, the title and the link.
  const code = dialog.getByRole("img", { name: "QR-Code mit dem Formularlink" });
  await expect(code).toBeVisible();
  expect(await code.evaluate((el) => el.tagName.toLowerCase())).toBe("svg");
  await expect(code.locator("rect")).toHaveAttribute("fill", "#fff");
  await expect(code.locator("path")).toHaveAttribute("fill", "#000");
  expect(await code.getAttribute("viewBox")).toMatch(/^-4 -4 (\d+) \1$/);
  await expect(dialog.getByRole("heading", { name: title })).toBeVisible();
  await expect(dialog.getByText(`/forms/${token}`)).toBeVisible();

  // The downloads: blob addresses with their types and file names.
  const svgLink = dialog.getByRole("link", { name: "SVG herunterladen" });
  const pngLink = dialog.getByRole("link", { name: "PNG herunterladen" });
  await expect(svgLink).toHaveAttribute("type", "image/svg+xml");
  await expect(svgLink).toHaveAttribute("href", /^blob:/);
  await expect(svgLink).toHaveAttribute("download", /^Einkaufsliste-.*-qr\.svg$/);
  await expect(pngLink).toHaveAttribute("type", "image/png");
  await expect(pngLink).toHaveAttribute("href", /^blob:/);
  await expect(pngLink).toHaveAttribute("download", /^Einkaufsliste-.*-qr\.png$/);
  const svgFile = await svgLink.evaluate(async (a: HTMLAnchorElement) => {
    const blob = await (await fetch(a.href)).blob();
    return { type: blob.type, text: await blob.text() };
  });
  expect(svgFile.type).toBe("image/svg+xml");
  expect(svgFile.text).toMatch(/^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
  const png = await pngLink.evaluate(async (a: HTMLAnchorElement) => {
    const blob = await (await fetch(a.href)).blob();
    const bitmap = await createImageBitmap(blob);
    return { type: blob.type, width: bitmap.width, height: bitmap.height };
  });
  expect(png.type).toBe("image/png");
  expect(png.width).toBeGreaterThanOrEqual(1024);
  expect(png.height).toBe(png.width);

  // A real download keeps the file name.
  const [download] = await Promise.all([page.waitForEvent("download"), svgLink.click()]);
  expect(download.suggestedFilename()).toMatch(/-qr\.svg$/);

  await expect(dialog.getByRole("button", { name: "Drucken", exact: true })).toBeEnabled();
  // No style attributes in the dialog's code (strict CSP).
  expect(await dialog.locator(".form-qr-sheet [style]").count()).toBe(0);
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  expect(errors).toEqual([]);
});
