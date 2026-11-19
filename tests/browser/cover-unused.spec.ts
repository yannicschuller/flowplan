import { test, expect } from "@playwright/test";

// #396: a replaced cover stays among the page's images; the cover dialog
// marks it "Nicht verwendet" and moves it to the trash (the media library's
// file.delete), from where it comes back.
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==",
  "base64",
);

test("a replaced cover shows as unused in the cover dialog and is removed into the trash (#396)", async ({ page }, testInfo) => {
  test.setTimeout(90_000);
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
  const tag = `${testInfo.project.name}${Date.now()}`;
  const p = await command({
    action: "page.create",
    workspaceId: boot.workspace.id,
    spaceId: boot.spaces[0].id,
    title: `Cover wechseln ${tag}`,
  });
  const [a, b] = [`cover-a-${tag}.png`, `cover-b-${tag}.png`];
  const urls: Record<string, string> = {};
  for (const name of [a, b]) {
    const upload = await page.request.post("/api/upload", {
      headers: { origin },
      multipart: { pageId: p.id, purpose: "cover", file: { name, mimeType: "image/png", buffer: png } },
    });
    expect(upload.ok(), await upload.text()).toBe(true);
    urls[name] = (await upload.json()).url;
  }
  const read = async () => (await page.request.get(`/api/pages/${p.id}`)).json();
  // Cover A first.
  await command({ action: "page.update", pageId: p.id, patch: { cover: urls[a] } });

  await page.goto(`/#page=${p.id}`);
  const dialog = page.getByRole("dialog", { name: "Cover auswählen", exact: true });
  const images = dialog.getByRole("list", { name: "Vorhandene Bilder", exact: true });
  const item = (name: string) => images.locator(".cover-image", { hasText: name });
  await page.getByRole("button", { name: "Cover ändern", exact: true }).click();
  // A is the cover: chosen and used; B is not used yet.
  await expect(images.getByRole("button", { name: a, exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(item(b).getByText("Nicht verwendet")).toBeVisible();
  await expect(item(a).getByText("Nicht verwendet")).toHaveCount(0);
  await expect(item(a).getByRole("button", { name: `„${a}“ entfernen` })).toHaveCount(0);
  // Replaced by B (keyboard: Enter on B, then save).
  await images.getByRole("button", { name: b, exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(images.getByRole("button", { name: b, exact: true })).toHaveAttribute("aria-pressed", "true");
  await dialog.getByRole("button", { name: "Speichern", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect.poll(async () => (await read()).page.cover).toBe(urls[b]);

  // Opened again: A is unused now and can be removed, B (the cover) not.
  await page.getByRole("button", { name: "Cover ändern", exact: true }).click();
  await expect(item(a).getByText("Nicht verwendet")).toBeVisible();
  await expect(images.getByRole("button", { name: a, exact: true })).toHaveAccessibleDescription("Nicht verwendet");
  await expect(item(b).getByText("Nicht verwendet")).toHaveCount(0);
  await expect(item(b).getByRole("button", { name: `„${b}“ entfernen` })).toHaveCount(0);
  // For the review: the dialog in both themes (the app follows the system's).
  await item(a).scrollIntoViewIfNeeded();
  for (const scheme of ["dark", "light"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.screenshot({ path: `test-results/cover-unused/${testInfo.project.name}-${scheme}.png`, animations: "disabled" });
  }
  await item(a).getByRole("button", { name: `„${a}“ entfernen` }).click();
  const confirm = page.getByRole("dialog", { name: "Bild entfernen", exact: true });
  await expect(confirm).toContainText(a);
  await expect(confirm).toContainText("Papierkorb");
  await page.screenshot({ path: `test-results/cover-unused/${testInfo.project.name}-confirm.png` });
  // Cancel keeps it.
  await confirm.getByRole("button", { name: "Abbrechen", exact: true }).click();
  await expect(confirm).toHaveCount(0);
  await expect(item(a)).toHaveCount(1);
  await item(a).getByRole("button", { name: `„${a}“ entfernen` }).click();
  await confirm.getByRole("button", { name: "In den Papierkorb", exact: true }).click();
  await expect(confirm).toHaveCount(0);
  await expect(dialog.getByRole("status")).toContainText("ist jetzt im Papierkorb");
  await expect(item(a)).toHaveCount(0);
  await expect(images).toBeFocused();
  await expect(images.getByRole("button", { name: b, exact: true })).toHaveAttribute("aria-pressed", "true");
  expect((await page.request.get(urls[a])).status()).toBe(404);
  expect((await page.request.get(urls[b])).status()).toBe(200);
  // The used cover cannot be removed this way, not even straight away.
  const refused = await page.request.post("/api/command", {
    headers: { origin },
    data: { action: "file.delete", fileIds: [urls[b].split("/").at(-1)], unusedOnly: true },
  });
  expect(refused.status()).toBe(409);
  await dialog.getByRole("button", { name: "Abbrechen", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect((await read()).page.cover).toBe(urls[b]);
  await expect(page.getByAltText("Seiten-Cover")).toBeVisible();

  // In the trash, and restorable from there.
  await page.goto("/#trash");
  const row = page.locator(".trash-view .file-trash .trash-row", { hasText: a });
  await expect(row).toBeVisible();
  await row.getByRole("button", { name: "Wiederherstellen" }).click();
  await expect(row).toHaveCount(0);
  expect((await page.request.get(urls[a])).status()).toBe(200);
  expect(errors).toEqual([]);
  await command({ action: "page.delete", pageId: p.id });
});
