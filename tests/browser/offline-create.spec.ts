import { test, expect, type Page, type TestInfo } from "@playwright/test";

// Issue #370: offline, new documents, databases (with records), whiteboards,
// notebooks, pages from a built-in template and pictures are made on the
// device, appear in the sidebar at once marked "not yet synced", and are
// created on the server in order once the connection is back.
// A click that cannot happen fails with its reason, not the test's timeout.
test.use({ actionTimeout: 20_000 });
const origin = () => process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
const mobile = (info: TestInfo) => info.project.name === "mobile";
// A 2 × 2 PNG.
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGP8z8DAwMDAxMDAwMDAAAANHQEDK+mmyAAAAABJRU5ErkJggg==";

// Phones: the sidebar is a drawer (its own button closes it).
const drawerOpen = async (page: Page) => (await page.locator(".app-shell.nav-open").count()) > 0;
async function openNavigation(page: Page, info: TestInfo) {
  if (mobile(info) && !(await drawerOpen(page))) await page.locator(".topbar").getByRole("button", { name: "Navigation öffnen" }).click();
}
async function closeNavigation(page: Page, info: TestInfo) {
  if (mobile(info) && (await drawerOpen(page))) {
    // "× Navigation" in the bottom bar (the sidebar has no close button of
    // its own beside it, #617).
    await page.getByRole("navigation", { name: "Schnellnavigation" }).getByRole("button", { name: "Navigation schließen" }).click();
    await expect(page.locator(".app-shell.nav-open")).toHaveCount(0);
  }
}

test("offline: pages, a database with records, a board, a notebook, a template page and a picture are made on the device and synced later (#370)", async ({ page, context }, info) => {
  test.setTimeout(240_000);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.request.post("/api/auth/demo", { headers: { origin: origin() } });
  const command = async (data: Record<string, unknown>) => {
    const response = await page.request.post("/api/command", { headers: { origin: origin() }, data });
    expect(response.ok(), await response.text()).toBe(true);
    return response.json();
  };
  await command({ action: "profile.onboarded" });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const space = boot.spaces[0];
  const stamp = `${info.project.name} ${Date.now()}`;
  // Each kind of view opened once online: its code is in this tab (with
  // offline use on, the offline copy holds the whole app).
  const warm: Record<string, string> = {};
  for (const kind of ["document", "database", "whiteboard", "notebook"])
    warm[kind] = (await command({ action: "page.create", workspaceId: boot.workspace.id, spaceId: space.id, title: `Vorab ${kind} ${stamp}`, kind })).id;
  await page.goto(`/#page=${warm.document}`);
  await expect(page.locator(".page-content .ProseMirror").first()).toBeVisible({ timeout: 30_000 });
  await page.evaluate((id) => (location.hash = `page=${id}`), warm.database);
  await expect(page.getByRole("button", { name: "Neue Zeile" })).toBeVisible({ timeout: 30_000 });
  await page.evaluate((id) => (location.hash = `page=${id}`), warm.whiteboard);
  await expect(page.locator(".whiteboard").first()).toBeVisible({ timeout: 30_000 });
  await page.evaluate((id) => (location.hash = `page=${id}`), warm.notebook);
  await expect(page.locator(".notebook-bar").first()).toBeVisible({ timeout: 30_000 });

  const offlineIcon = page.locator(".topbar .offline-status-button");
  await context.setOffline(true);
  await expect(offlineIcon).toBeVisible();

  // A picture into a page the server has: shown from the device, the
  // document waits for its upload.
  const pastePicture = (name: string) =>
    page
      .locator(".page-content .ProseMirror")
      .first()
      .evaluate(
        (el, [png, file]) => {
          const bytes = Uint8Array.from(atob(png), (c) => c.charCodeAt(0));
          const data = new DataTransfer();
          data.items.add(new File([bytes], file, { type: "image/png" }));
          el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
        },
        [PNG, name],
      );
  await page.evaluate((id) => (location.hash = `page=${id}`), warm.document);
  const existing = page.locator(".page-content .ProseMirror").first();
  await expect(existing).toBeVisible();
  await existing.click();
  await page.keyboard.type("Bild von unterwegs:");
  await pastePicture("bestehend.png");
  await expect(existing.locator("img")).toHaveAttribute("src", /^blob:/, { timeout: 15_000 });

  const dialog = page.getByRole("dialog", { name: "Neue Seite" });
  // Opens "Neue Seite" from the sidebar's "+" of the space, names the page
  // and picks its kind; returns the new page's id (from the address).
  const create = async (title: string, kind: string | null) => {
    await openNavigation(page, info);
    await page.getByTitle(`Seite in ${space.name} hinzufügen`).first().click();
    await expect(dialog).toBeVisible();
    await dialog.getByRole("textbox", { name: "Name" }).fill(title);
    if (kind) await dialog.getByRole("radio", { name: kind }).click();
    await dialog.getByRole("textbox", { name: "Name" }).press("Enter");
    await expect(dialog).toHaveCount(0);
    await expect(page.locator("textarea.page-title")).toHaveValue(title);
    await expect(page.locator(".topbar-note")).toContainText("Noch nicht synchronisiert");
    const id = new URL(page.url()).hash.match(/page=([0-9a-f-]{36})/)![1];
    await closeNavigation(page, info);
    return id;
  };

  // A document with text and a picture.
  const docTitle = `Offline-Dokument ${stamp}`;
  const doc = await create(docTitle, null);
  const editor = page.locator(".page-content .ProseMirror").first();
  await editor.click();
  await page.keyboard.type("Offline geschrieben.");
  await pastePicture("offline-bild.png");
  // The picture shows its copy on this device.
  await expect(editor.locator("img")).toHaveAttribute("src", /^blob:/, { timeout: 15_000 });
  await expect(page.locator(".toast-error")).toHaveCount(0);

  // A database with two records.
  const dbTitle = `Offline-Datenbank ${stamp}`;
  const db = await create(dbTitle, "Datenbank");
  const newRow = page.getByRole("button", { name: "Neue Zeile" });
  for (let i = 0; i < 2; i++) {
    await newRow.click();
    const entry = page.getByRole("dialog", { name: "Eintrag", exact: true });
    if (await entry.isVisible().catch(() => false)) await entry.getByRole("button", { name: "Schließen", exact: true }).click();
  }
  await expect(page.locator(".title-cell")).toHaveCount(2);

  // A whiteboard and a notebook.
  const boardTitle = `Offline-Whiteboard ${stamp}`;
  const board = await create(boardTitle, "Whiteboard");
  await expect(page.locator(".whiteboard").first()).toBeVisible();
  // A note on it (N, then a click places it; desktop).
  if (!mobile(info)) {
    const wb = page.getByLabel("Whiteboard", { exact: true });
    await wb.focus();
    await page.keyboard.press("n");
    const box = (await wb.locator(".wb-canvas").boundingBox())!;
    await wb.locator(".wb-canvas").click({ position: { x: box.width / 2, y: box.height / 2 } });
    await page.keyboard.type("Offline notiert");
    await page.keyboard.press("Escape");
    await expect(wb.locator(".wb-sticky")).toContainText("Offline notiert");
  }
  const notebookTitle = `Offline-Notizbuch ${stamp}`;
  const notebook = await create(notebookTitle, "Notizbuch");
  await expect(page.locator(".notebook-bar").first()).toBeVisible();
  // A stroke on its first sheet (with the mouse: desktop).
  const strokes = page.locator(".notebook-sheet").first().locator(".ink-strokes > g[clip-path] > path:not(.ink-draft):not(.ink-lasso)");
  if (!mobile(info)) {
    const sheetBox = (await page.locator(".notebook-sheet").first().boundingBox())!;
    await page.mouse.move(sheetBox.x + 100, sheetBox.y + 150);
    await page.mouse.down();
    await page.mouse.move(sheetBox.x + 300, sheetBox.y + 160, { steps: 8 });
    await page.mouse.up();
    await expect(strokes).toHaveCount(1);
  }

  // A page from a built-in template: the gallery opens offline too.
  await openNavigation(page, info);
  await page.getByTitle(`Seite in ${space.name} hinzufügen`).first().click();
  await dialog.getByRole("radio", { name: "Aus Vorlage" }).click();
  const gallery = page.getByRole("dialog", { name: "Vorlagen" });
  await expect(gallery).toBeVisible();
  await expect(gallery).toContainText("Gespeicherte Vorlagen und der Marketplace gehen nur mit Verbindung");
  await gallery.getByRole("button", { name: /Meeting-Notizen/ }).click();
  const templateTitle = `Offline-Vorlage ${stamp}`;
  await dialog.getByRole("textbox", { name: "Name" }).fill(templateTitle);
  await dialog.getByRole("textbox", { name: "Name" }).press("Enter");
  await expect(page.locator("textarea.page-title")).toHaveValue(templateTitle);
  await expect(editor).toContainText("Besprechung");
  const fromTemplate = new URL(page.url()).hash.match(/page=([0-9a-f-]{36})/)![1];
  await closeNavigation(page, info);

  // Every new page is in the sidebar, marked "not yet synced".
  await openNavigation(page, info);
  for (const id of [doc, db, board, notebook, fromTemplate]) {
    const row = page.locator(`.page-nav[data-page-id="${id}"]`);
    await expect(row).toBeVisible();
    await expect(row.locator(".offline-mark-pending")).toHaveText("Noch nicht synchronisiert");
  }
  await page.locator(`.page-nav[data-page-id="${fromTemplate}"]`).scrollIntoViewIfNeeded();
  await page.screenshot({ path: `test-results/dr370-offline-marks-${info.project.name}.png` });
  await closeNavigation(page, info);
  await page.locator("aside.sidebar").evaluate((el) => Promise.all(el.getAnimations({ subtree: true }).map((a) => a.finished)));
  await page.screenshot({ path: `test-results/dr370-offline-page-${info.project.name}.png` });
  // A journal still needs the connection: the calm note.
  await openNavigation(page, info);
  await page.getByTitle(`Seite in ${space.name} hinzufügen`).first().click();
  await dialog.getByRole("radio", { name: "Journal" }).click();
  await dialog.getByRole("textbox", { name: "Name" }).press("Enter");
  await expect(dialog).toContainText("Geht nur mit Verbindung – du bist gerade offline.");
  await dialog.getByRole("button", { name: "Abbrechen" }).click();
  await expect(dialog).toHaveCount(0);
  await closeNavigation(page, info);
  // Nothing reached the server yet (the test's own requests are not offline).
  const serverPages = async () => ((await (await page.request.get("/api/bootstrap")).json()).pages as { id: string; title: string; kind: string }[]);
  expect((await serverPages()).some((p) => [doc, db, board, notebook, fromTemplate].includes(p.id))).toBe(false);

  // The connection is back while the page the server had is open: its
  // document waits for the picture's upload, then goes out; the new pages
  // are created in order, the new document's text sent from the device.
  await page.evaluate((id) => (location.hash = `page=${id}`), warm.document);
  await expect(editor).toContainText("Bild von unterwegs:");
  await context.setOffline(false);
  await expect(offlineIcon).toHaveCount(0, { timeout: 15_000 });
  await expect
    .poll(async () => (await serverPages()).filter((p) => [doc, db, board, notebook, fromTemplate].includes(p.id)).length, { timeout: 30_000 })
    .toBe(5);
  const byId = new Map((await serverPages()).map((p) => [p.id, p]));
  expect(byId.get(doc)?.title).toBe(docTitle);
  expect(byId.get(db)?.kind).toBe("database");
  expect(byId.get(board)?.kind).toBe("whiteboard");
  expect(byId.get(notebook)?.kind).toBe("notebook");
  // The document's text and its picture, uploaded under the id it was given.
  await expect
    .poll(async () => String((await (await page.request.get(`/api/pages/${doc}`)).json()).html || ""), { timeout: 30_000 })
    .toMatch(/Offline geschrieben\.[\s\S]*<img[^>]+src="\/api\/files\/[0-9a-f-]{36}"/);
  const src = (String((await (await page.request.get(`/api/pages/${doc}`)).json()).html).match(/\/api\/files\/[0-9a-f-]{36}/) || [""])[0];
  expect((await page.request.get(src)).status()).toBe(200);
  // The page the server had: its text and picture arrived too, the file first.
  await expect
    .poll(async () => String((await (await page.request.get(`/api/pages/${warm.document}`)).json()).html || ""), { timeout: 30_000 })
    .toMatch(/Bild von unterwegs:[\s\S]*<img[^>]+src="\/api\/files\/[0-9a-f-]{36}"/);
  const existingSrc = (String((await (await page.request.get(`/api/pages/${warm.document}`)).json()).html).match(/\/api\/files\/[0-9a-f-]{36}/) || [""])[0];
  expect((await page.request.get(existingSrc)).status()).toBe(200);
  // The board's note and the notebook's stroke, kept on the device until now.
  if (!mobile(info)) {
    await expect
      .poll(async () => Buffer.from(String((await (await page.request.get(`/api/pages/${board}`)).json()).whiteboard?.state || ""), "base64").toString("utf8"), { timeout: 30_000 })
      .toContain("Offline notiert");
    const sheetId = (await (await page.request.get(`/api/pages/${notebook}`)).json()).notebook.sheets[0].id as string;
    await expect
      .poll(async () => ((await (await page.request.get(`/api/pages/${notebook}/ink?surface=${encodeURIComponent(sheetId)}`)).json()).doc?.pages?.[sheetId]?.length ?? 0), { timeout: 30_000 })
      .toBe(1);
  }
  // The database with its two records, the template page with its text.
  await expect
    .poll(async () => ((await (await page.request.get(`/api/pages/${db}`)).json()).rows as unknown[]).length, { timeout: 30_000 })
    .toBe(2);
  expect(String((await (await page.request.get(`/api/pages/${fromTemplate}`)).json()).html)).toContain("Besprechung");
  // The marks are gone; nothing waits on the device.
  await openNavigation(page, info);
  await expect(page.locator(".offline-mark")).toHaveCount(0, { timeout: 15_000 });
  await closeNavigation(page, info);
  expect(await page.evaluate(() => JSON.parse(Object.entries(localStorage).find(([k]) => k.startsWith("flowplan-offline-queue:") && !k.includes(":conflicts") && !k.includes(":failed"))?.[1] || "[]").length)).toBe(0);

  // A reload shows everything from the server.
  await page.reload();
  await expect(editor).toContainText("Bild von unterwegs:", { timeout: 30_000 });
  await page.evaluate((id) => (location.hash = `page=${id}`), doc);
  await expect(editor).toContainText("Offline geschrieben.", { timeout: 30_000 });
  await expect(editor.locator("img")).toHaveAttribute("src", /^\/api\/files\//);
  await page.evaluate((id) => (location.hash = `page=${id}`), db);
  await expect(page.locator(".title-cell")).toHaveCount(2, { timeout: 30_000 });
  await openNavigation(page, info);
  for (const id of [doc, db, board, notebook, fromTemplate]) await expect(page.locator(`.page-nav[data-page-id="${id}"]`)).toBeVisible();
  expect(errors).toEqual([]);
});

test("offline: a page the server refuses keeps its content and its sub-pages until tried again (#370)", async ({ page, context }, info) => {
  test.setTimeout(180_000);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.request.post("/api/auth/demo", { headers: { origin: origin() } });
  const command = async (data: Record<string, unknown>) => {
    const response = await page.request.post("/api/command", { headers: { origin: origin() }, data });
    expect(response.ok(), await response.text()).toBe(true);
    return response.json();
  };
  await command({ action: "profile.onboarded" });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const stamp = `${info.project.name} ${Date.now()}`;
  const parent = (await command({ action: "page.create", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, title: `Elternseite ${stamp}` })).id as string;
  await page.goto(`/#page=${parent}`);
  const editor = page.locator(".page-content .ProseMirror").first();
  await expect(editor).toBeVisible({ timeout: 30_000 });
  await context.setOffline(true);
  await expect(page.locator(".topbar .offline-status-button")).toBeVisible();

  // A sub-page below the stored page, and one below that.
  const dialog = page.getByRole("dialog", { name: "Neue Seite" });
  const subPage = async (title: string) => {
    await page.getByRole("button", { name: "Unterseite hinzufügen" }).click();
    await dialog.getByRole("textbox", { name: "Name" }).fill(title);
    await dialog.getByRole("textbox", { name: "Name" }).press("Enter");
    await expect(page.locator("textarea.page-title")).toHaveValue(title);
    return new URL(page.url()).hash.match(/page=([0-9a-f-]{36})/)![1];
  };
  const child = await subPage(`Unterseite ${stamp}`);
  await editor.click();
  await page.keyboard.type("Bleibt auf dem Gerät.");
  const grandchild = await subPage(`Enkelseite ${stamp}`);

  // Meanwhile the parent goes to the trash on another device.
  await command({ action: "page.delete", pageId: parent });
  await page.evaluate((id) => (location.hash = `page=${id}`), child);
  await expect(editor).toContainText("Bleibt auf dem Gerät.");
  await context.setOffline(false);
  // Refused: the page and its sub-page are kept with the reason.
  const notice = page.locator(".offline-page-note.failed");
  await expect(notice).toContainText("Diese Seite konnte nicht synchronisiert werden", { timeout: 30_000 });
  await expect(page.locator(".topbar-note")).toContainText("Nicht synchronisiert");
  await expect(editor).toContainText("Bleibt auf dem Gerät.");
  await page.screenshot({ path: `test-results/dr370-offline-failed-${info.project.name}.png` });
  const serverIds = async () => ((await (await page.request.get("/api/bootstrap")).json()).pages as { id: string }[]).map((p) => p.id);
  expect((await serverIds()).filter((id) => id === child || id === grandchild)).toEqual([]);
  await page.evaluate((id) => (location.hash = `page=${id}`), grandchild);
  await expect(notice).toBeVisible();
  // The parent is back: "Try again" creates both, in order, with the text.
  await command({ action: "page.restore", pageId: parent });
  await page.evaluate((id) => (location.hash = `page=${id}`), child);
  await notice.getByRole("button", { name: "Erneut versuchen" }).click();
  await expect.poll(async () => (await serverIds()).filter((id) => id === child || id === grandchild).length, { timeout: 30_000 }).toBe(2);
  await expect
    .poll(async () => String((await (await page.request.get(`/api/pages/${child}`)).json()).html || ""), { timeout: 30_000 })
    .toContain("Bleibt auf dem Gerät.");
  await expect(notice).toHaveCount(0, { timeout: 15_000 });
  await expect(page.locator(".offline-mark")).toHaveCount(0);
  expect(errors).toEqual([]);
});
