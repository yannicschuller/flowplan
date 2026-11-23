import { test, expect, type Locator, type Page } from "@playwright/test";

// Issue #449: the record layout's "Position der Unterseiten" – "Über dem
// Inhalt" puts a record's sub-pages above its document, directly below the
// properties, in the dialog, the side panel and on the record's page, and
// on the shared record. With no sub-pages only "Unterseite hinzufügen" is
// left there. "Unter dem Inhalt" (the default) keeps them below.

const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
async function setup(page: Page) {
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
// Whether `first` comes before `second` in the page, and above it.
async function above(first: Locator, second: Locator) {
  const handle = await second.elementHandle();
  const before = await first.evaluate(
    (a, b) => !!(a.compareDocumentPosition(b as Node) & Node.DOCUMENT_POSITION_FOLLOWING),
    handle,
  );
  const [a, b] = [await first.boundingBox(), await second.boundingBox()];
  return before && !!a && !!b && a.y + a.height <= b.y + 1;
}

test("sub-pages above the record's document: dialog, side panel, page, empty list, shared record", async ({ page, browser }, info) => {
  test.setTimeout(180_000);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const { boot, command } = await setup(page);
  const tag = `${info.project.name}${Date.now()}`;
  const db = await command({ action: "page.create", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, title: `Projekte ${tag}`, kind: "database", databaseKind: "empty" });
  const record = await command({ action: "row.create", pageId: db.id, cells: { title: `Relaunch ${tag}` } });
  const plain = await command({ action: "row.create", pageId: db.id, cells: { title: `Ohne Unterseiten ${tag}` } });
  // A long document, so above and below are far apart.
  const { htmlState } = await import("../../lib/document-server");
  const current = await (await page.request.get(`/api/pages/${db.id}/rows/${record.id}`)).json();
  const html = Array.from({ length: 40 }, (_, i) => `<p>Absatz ${i + 1} der Projektbeschreibung.</p>`).join("");
  await command({ action: "row.document.sync", pageId: db.id, rowId: record.id, generation: current.generation, update: Buffer.from(htmlState(html)).toString("base64") });
  await command({ action: "page.create", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, parentId: db.id, parentRowId: record.id, kind: "document", title: `Besprechung ${tag}` });
  const read = async () => await (await page.request.get(`/api/pages/${db.id}`)).json();

  // The default: below the document, on the record's page.
  await page.goto(`/#page=${db.id}&row=${record.id}&full=1`);
  const recordPage = page.locator(".record-page");
  await expect(recordPage.locator(".row-document")).toContainText("Absatz 40");
  await expect(recordPage.locator(".record-subpages .record-subpage")).toHaveCount(1);
  expect(await above(recordPage.locator(".row-document"), recordPage.locator(".record-subpages"))).toBe(true);

  // Changed in the record's layout, in its dialog.
  await page.goto(`/#page=${db.id}&row=${record.id}`);
  const entry = page.getByRole("dialog", { name: "Eintrag", exact: true });
  await expect(entry.locator(".row-document")).toContainText("Absatz 40");
  await entry.getByRole("button", { name: "Layout anpassen" }).click();
  const layout = entry.getByRole("group", { name: "Layout der Einträge" });
  const place = layout.getByLabel("Position der Unterseiten");
  await expect(place).toHaveValue("bottom");
  await place.selectOption("top");
  await expect.poll(async () => (await read()).database.recordLayout.subpages).toBe("top");
  const subPages = entry.locator(".record-subpages");
  await expect(subPages.locator(".record-subpage")).toHaveText([new RegExp(`Besprechung ${tag}`)]);
  await expect(subPages.getByRole("heading", { name: "Unterseiten" })).toBeVisible();
  expect(await above(subPages, entry.locator(".row-document"))).toBe(true);
  // Directly below the properties.
  expect(await above(entry.locator(".row-properties"), subPages)).toBe(true);

  // The side panel.
  await layout.getByLabel("Einträge öffnen als").selectOption("side");
  await expect(entry).toHaveClass(/modal-side/);
  await expect(subPages.locator(".record-subpage")).toHaveCount(1);
  expect(await above(subPages, entry.locator(".row-document"))).toBe(true);

  // The record's page.
  await page.goto(`/#page=${db.id}&row=${record.id}&full=1`);
  await expect(recordPage.locator(".record-subpages .record-subpage")).toHaveCount(1);
  expect(await above(recordPage.locator(".record-subpages"), recordPage.locator(".row-document"))).toBe(true);

  // A record without sub-pages: only the action, no heading, no list.
  await page.goto(`/#page=${db.id}&row=${plain.id}&full=1`);
  const empty = recordPage.locator(".record-subpages");
  await expect(empty.getByRole("button", { name: "Unterseite hinzufügen" })).toBeVisible();
  await expect(empty.getByRole("heading")).toHaveCount(0);
  await expect(empty.locator(".record-subpage")).toHaveCount(0);
  await expect(recordPage.getByRole("heading", { name: "Unterseiten", exact: true })).toHaveCount(0);
  expect(await above(empty, recordPage.locator(".row-document"))).toBe(true);
  const emptyBox = (await empty.boundingBox())!;
  expect(emptyBox.height).toBeLessThan(60);

  // The shared record (with its sub-pages) follows the layout.
  await command({ action: "record.share.create", pageId: db.id, rowId: record.id, name: "Kunde", role: "viewer", includeChildren: true });
  const shares = await command({ action: "record.shares", pageId: db.id, rowId: record.id });
  const token = shares.links[0].token as string;
  const visitor = await browser.newContext({ locale: "de-DE", viewport: page.viewportSize()! });
  const guest = await visitor.newPage();
  await guest.goto(`/share/${token}`);
  const children = guest.locator(".public-children");
  await expect(children.getByRole("link", { name: new RegExp(`Besprechung ${tag}`) })).toBeVisible();
  const document = guest.locator(".document-editor", { hasText: "Absatz 40" });
  expect(await above(children, document)).toBe(true);

  // Back to "Unter dem Inhalt": below again, everywhere.
  const now = (await read()).database.recordLayout;
  await command({ action: "database.recordLayout", pageId: db.id, layout: { ...now, subpages: "bottom" } });
  await guest.reload();
  await expect(children.getByRole("link", { name: new RegExp(`Besprechung ${tag}`) })).toBeVisible();
  expect(await above(document, children)).toBe(true);
  await page.goto(`/#page=${db.id}&row=${record.id}&full=1`);
  await page.reload();
  await expect(recordPage.locator(".record-subpages .record-subpage")).toHaveCount(1);
  expect(await above(recordPage.locator(".row-document"), recordPage.locator(".record-subpages"))).toBe(true);
  // Without sub-pages below the document: heading and action, as before.
  await page.goto(`/#page=${db.id}&row=${plain.id}&full=1`);
  await expect(recordPage.locator(".record-subpages").getByRole("heading", { name: "Unterseiten" })).toBeVisible();
  await visitor.close();
  expect(errors).toEqual([]);
});
