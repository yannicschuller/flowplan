import { test, expect, type Page } from "@playwright/test";

// Issue #370 (report in the iPhone app): offline, a new record of a database
// took its properties, but its content stayed "Loading …" with "This record
// is not available offline": the record's document was asked of the server.
// A record made offline now opens with an empty document of its own, kept on
// the device; what is written in it waits in the offline queue behind the
// record's creation and reaches the server once the connection is back.
test.use({ actionTimeout: 20_000 });
const origin = () => process.env.TEST_BASE_URL || "http://127.0.0.1:3000";

async function setUp(page: Page, title: string) {
  await page.request.post("/api/auth/demo", { headers: { origin: origin() } });
  const command = async (data: Record<string, unknown>) => {
    const response = await page.request.post("/api/command", { headers: { origin: origin() }, data });
    expect(response.ok(), await response.text()).toBe(true);
    return response.json();
  };
  await command({ action: "profile.onboarded" });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const db = await command({ action: "page.create", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, title, kind: "database" });
  await command({ action: "row.create", pageId: db.id, cells: { title: "Vorhanden" } });
  // The database and a record opened once online: the views' code is in this tab.
  await page.goto(`/#page=${db.id}`);
  await page.getByText("Vorhanden", { exact: true }).click();
  const entry = page.getByRole("dialog", { name: "Eintrag", exact: true });
  await expect(entry.locator(".row-document .ProseMirror")).toBeVisible({ timeout: 30_000 });
  await entry.getByRole("button", { name: "Schließen", exact: true }).click();
  await expect(entry).toHaveCount(0);
  return { db, entry };
}
// Offline: a new record with a title and a line in its content.
async function newRecord(page: Page, entry: ReturnType<Page["getByRole"]>, name: string, text: string) {
  await page.getByRole("button", { name: "Neu", exact: true }).first().click();
  const title = entry.getByRole("textbox", { name: "Titel des Eintrags" });
  await expect(title).toBeFocused({ timeout: 15_000 });
  await page.keyboard.type(name);
  // The content: an editor, not "not available offline".
  const content = entry.locator(".row-document .ProseMirror");
  await expect(content).toBeVisible({ timeout: 15_000 });
  await expect(entry.locator(".row-document-offline")).toHaveCount(0);
  await content.click();
  await page.keyboard.type(text);
  await expect(content).toContainText(text);
  // Versions are the server's: once the record is there.
  await expect(entry.getByRole("button", { name: "Datensatz-Versionen" })).toBeDisabled();
  return content;
}
const rowOf = async (page: Page, dbId: string, name: string) => {
  const data = await (await page.request.get(`/api/pages/${dbId}`)).json();
  return (data.rows as { id: string; cells: Record<string, unknown> }[]).find((r) => r.cells.title === name);
};

test("offline: a new record opens with an empty document; its text and title reach the server once online (#370)", async ({ page, context }, info) => {
  test.setTimeout(180_000);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const { db, entry } = await setUp(page, `Offline-Einträge ${info.project.name} ${Date.now()}`);

  await context.setOffline(true);
  await expect(page.locator(".topbar .offline-status-button")).toBeVisible();
  const content = await newRecord(page, entry, "Offline-Eintrag", "Unterwegs geschrieben.");
  await expect(entry.locator(".row-document-heading [role=status]")).toHaveText("Offline gespeichert");
  // Closed and opened again: the text comes from the device.
  await entry.getByRole("button", { name: "Schließen", exact: true }).click();
  await expect(entry).toHaveCount(0);
  await page.getByText("Offline-Eintrag", { exact: true }).click();
  await expect(content).toContainText("Unterwegs geschrieben.", { timeout: 15_000 });
  await entry.getByRole("button", { name: "Schließen", exact: true }).click();
  await expect(page.locator(".offline-pending")).toBeVisible();

  await context.setOffline(false);
  await expect(page.locator(".offline-pending")).toHaveCount(0, { timeout: 30_000 });
  await expect.poll(async () => (await rowOf(page, db.id, "Offline-Eintrag"))?.id, { timeout: 15_000 }).toBeTruthy();
  const row = (await rowOf(page, db.id, "Offline-Eintrag"))!;
  const document = async () => (await (await page.request.get(`/api/pages/${db.id}/rows/${row.id}`)).json()) as { html: string; generation: string };
  await expect.poll(async () => (await document()).html, { timeout: 15_000 }).toMatch(/^<p[^>]*>Unterwegs geschrieben\.<\/p>$/);
  // The document the device began: the editor goes on with it.
  expect((await document()).generation).toBe(row.id);
  await page.getByText("Offline-Eintrag", { exact: true }).click();
  await expect(content).toContainText("Unterwegs geschrieben.");
  await expect(entry.getByRole("button", { name: "Datensatz-Versionen" })).toBeEnabled();
  // The reopened editor merges the device's copy and the server's first
  // (typing into that moment can drop a keystroke on the phone emulation).
  await page.waitForTimeout(1500);
  await content.click();
  await expect(content).toBeFocused();
  await page.keyboard.press("End");
  await page.keyboard.type(" Wieder online.");
  await expect.poll(async () => (await document()).html, { timeout: 15_000 }).toMatch(/^<p[^>]*>Unterwegs geschrieben\. Wieder online\.<\/p>$/);
  expect(errors).toEqual([]);
});

test("offline with a full device: a new record's document works in this window and says it is not kept (#370)", async ({ page, context }, info) => {
  test.setTimeout(180_000);
  test.skip(info.project.name !== "desktop", "One run covers the shared code path.");
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  // The device refuses to store anything: no new IndexedDB store for a
  // document, and no entry in the offline copy (Cache Storage).
  await page.addInitScript(() => {
    const open = IDBFactory.prototype.open;
    IDBFactory.prototype.open = function (this: IDBFactory, name: string, version?: number) {
      if (!String(name).startsWith("flowplan:")) return open.call(this, name, version);
      const request = {} as IDBOpenDBRequest & { onerror: ((event: unknown) => void) | null };
      setTimeout(() => request.onerror?.({ target: { error: new DOMException("The device is full.", "QuotaExceededError") } }), 0);
      return request;
    };
    Cache.prototype.put = () => Promise.reject(new DOMException("The device is full.", "QuotaExceededError"));
  });
  const { db, entry } = await setUp(page, `Offline voll ${Date.now()}`);

  await context.setOffline(true);
  await expect(page.locator(".topbar .offline-status-button")).toBeVisible();
  await newRecord(page, entry, "Ohne Platz", "Nur im Fenster.");
  await expect(entry.locator(".row-document-heading [role=status]")).toHaveText("Nur in diesem Fenster – auf dem Gerät ist kein Platz");

  // Back online with the record still open: its editor sends the text.
  // The open record stays open while it is sent (its editor is the only
  // copy of the text).
  await entry.locator(".row-document").evaluate((el) => el.setAttribute("data-kept-open", ""));
  await context.setOffline(false);
  await expect.poll(async () => (await rowOf(page, db.id, "Ohne Platz"))?.id, { timeout: 30_000 }).toBeTruthy();
  const row = (await rowOf(page, db.id, "Ohne Platz"))!;
  await expect
    .poll(async () => ((await (await page.request.get(`/api/pages/${db.id}/rows/${row.id}`)).json()) as { html: string }).html, { timeout: 20_000 })
    .toMatch(/^<p[^>]*>Nur im Fenster\.<\/p>$/);
  await expect(entry.locator(".row-document-heading [role=status]")).toHaveText("Gespeichert", { timeout: 15_000 });
  await expect(entry.locator(".row-document[data-kept-open]")).toHaveCount(1);
  // Only the refused stores' own complaints (y-indexeddb leaves them unhandled).
  expect(errors.filter((e) => !/QuotaExceeded|device is full/.test(e))).toEqual([]);
});
