import { test, expect, type Page } from "@playwright/test";

// Issue #231 (wave 3): sub-pages under a record – created from the record's
// page, shown in the record, in the sidebar under the record and in the
// breadcrumb; a loose page moved below the record with "Verschieben"; the
// record deleted (its sub-page goes to the trash) and restored; the record
// shared with "Unterseiten einbeziehen" so a visitor opens the sub-page.

const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
const shots = process.env.RECORD_PAGES_SHOTS;
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
async function shot(page: Page, name: string, project: string) {
  if (!shots) return;
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.waitForTimeout(250);
    await page.screenshot({ path: `${shots}/${name}-${project}-${scheme}.png` });
  }
  await page.emulateMedia({ colorScheme: "light" });
}

test("sub-pages under a record: create, show, move, delete with the record, restore, share", async ({ page, browser }, info) => {
  test.setTimeout(180_000);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const desktop = info.project.name === "desktop";
  const { boot, command } = await setup(page);
  const tag = `${info.project.name}${Date.now()}`;
  const db = await command({ action: "page.create", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, title: `Anforderungen ${tag}`, kind: "database", databaseKind: "empty" });
  const record = await command({ action: "row.create", pageId: db.id, cells: { title: `U3a Schnittstelle ${tag}` } });
  await command({ action: "row.create", pageId: db.id, cells: { title: `Andere Anforderung ${tag}` } });

  // From the record's page: "Unterseite hinzufügen" creates a page below it.
  await page.goto(`/#page=${db.id}&row=${record.id}&full=1`);
  const recordPage = page.locator(".record-page");
  await expect(recordPage).toBeVisible();
  const subPages = recordPage.locator(".record-subpages");
  await expect(subPages.getByRole("heading", { name: "Unterseiten" })).toBeVisible();
  await subPages.getByRole("button", { name: "Unterseite hinzufügen" }).click();
  await expect.poll(() => new URL(page.url()).hash, { timeout: 30_000 }).not.toContain("row=");
  const created = new URL(page.url()).hash.match(/page=([0-9a-f-]{36})/)![1];
  const title = page.locator(".page-title");
  await expect(title).toHaveValue("Ohne Titel", { timeout: 30_000 });
  await title.fill(`Gesprächsnotizen ${tag}`);
  await title.press("Tab");
  await expect
    .poll(async () => (await (await page.request.get(`/api/pages/${created}`)).json()).page.title, { timeout: 30_000 })
    .toBe(`Gesprächsnotizen ${tag}`);
  const stored = (await (await page.request.get(`/api/pages/${created}`)).json()).page;
  expect([stored.parent_id, stored.parent_row_id]).toEqual([db.id, record.id]);

  // The breadcrumb: … / database / record / sub-page, each a link.
  const path = page.locator(".breadcrumb-path");
  if (desktop) {
    await expect(path.getByRole("link", { name: `Anforderungen ${tag}` })).toBeVisible();
    await expect(path.getByRole("link", { name: `U3a Schnittstelle ${tag}` })).toHaveAttribute("href", `#page=${db.id}&row=${record.id}&full=1`);
  }
  await expect(path.locator(".breadcrumb-current")).toContainText(`Gesprächsnotizen ${tag}`);

  // The sidebar: the record below its database, the page below the record.
  if (desktop) {
    const item = page.locator(`[data-record-tree="record:${db.id}:${record.id}"]`);
    await expect(item).toBeVisible();
    await expect(item).toContainText(`U3a Schnittstelle ${tag}`);
    await expect(page.locator(`.page-nav[data-page-id="${created}"]`)).toBeVisible();
    // Records without sub-pages stay in the database.
    await expect(page.locator(".record-tree-item", { hasText: `Andere Anforderung ${tag}` })).toHaveCount(0);
    await shot(page, "sub-page-breadcrumb-sidebar", info.project.name);
  } else await shot(page, "sub-page-breadcrumb", info.project.name);

  // A loose page (a stand-in's child) moved below the record with "Verschieben".
  const loose = await command({ action: "page.create", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, title: `Flussdiagramme ${tag}` });
  await page.goto(`/#page=${loose.id}`);
  await page.getByRole("button", { name: "Seitenaktionen" }).click();
  await page.getByRole("menuitem", { name: "Verschieben", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Seite verschieben" });
  await dialog.getByLabel("Übergeordnete Seite").selectOption({ label: `Anforderungen ${tag}` });
  await dialog.getByLabel("Unter Eintrag").selectOption({ label: `U3a Schnittstelle ${tag}` });
  await dialog.getByRole("button", { name: "Verschieben", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect
    .poll(async () => (await (await page.request.get(`/api/pages/${loose.id}`)).json()).page.parent_row_id)
    .toBe(record.id);

  // The record lists both sub-pages (its page and its dialog).
  await page.goto(`/#page=${db.id}&row=${record.id}&full=1`);
  await expect(subPages.locator(".record-subpage")).toHaveText([new RegExp(`Gesprächsnotizen ${tag}`), new RegExp(`Flussdiagramme ${tag}`)]);
  // In the sidebar only the record is the active entry; its database is
  // an ancestor, like the parent of an open sub-page.
  if (desktop) {
    const item = page.locator(`[data-record-tree="record:${db.id}:${record.id}"]`);
    await expect(item).toHaveAttribute("aria-selected", "true");
    await expect(item).toHaveClass(/\bselected\b/);
    const database = page.locator(`.page-nav[data-page-id="${db.id}"]`);
    await expect(database).toHaveAttribute("aria-selected", "false");
    await expect(database).not.toHaveClass(/\bselected\b/);
    await expect(database).toHaveAttribute("aria-expanded", "true");
    await expect(page.locator('.sidebar [aria-selected="true"].page-nav')).toHaveCount(1);
  }
  // The "moved" notice with its Undo goes first (not in the pictures).
  const toast = page.locator(".toast");
  if (await toast.count()) await toast.getByRole("button", { name: "Meldung schließen" }).click().catch(() => {});
  await expect(toast).toHaveCount(0, { timeout: 15_000 });
  await subPages.scrollIntoViewIfNeeded();
  await shot(page, "record-page-sub-pages", info.project.name);
  await page.goto(`/#page=${db.id}&row=${record.id}`);
  const modal = page.locator(".modal .row-detail");
  await expect(modal.locator(".record-subpages .record-subpage")).toHaveCount(2);
  await modal.locator(".record-subpages").scrollIntoViewIfNeeded();
  await shot(page, "record-dialog-sub-pages", info.project.name);

  // Deleting the record takes its sub-pages to the trash; restoring brings them back.
  await command({ action: "row.delete", pageId: db.id, rowId: record.id });
  let pages = (await (await page.request.get("/api/bootstrap")).json()).pages as { id: string; deleted_at: string | null }[];
  expect(pages.find((p) => p.id === created)?.deleted_at).toBeTruthy();
  expect(pages.find((p) => p.id === loose.id)?.deleted_at).toBeTruthy();
  await page.goto("/#trash");
  await expect(page.getByText(`U3a Schnittstelle ${tag}`).first()).toBeVisible();
  await command({ action: "row.trash.restore", trashId: record.id });
  pages = (await (await page.request.get("/api/bootstrap")).json()).pages;
  expect(pages.find((p) => p.id === created)?.deleted_at).toBeNull();
  expect(pages.find((p) => p.id === loose.id)?.deleted_at).toBeNull();

  // Shared with "Unterseiten einbeziehen": the visitor opens the sub-page,
  // and nothing of the database.
  await page.goto(`/#page=${db.id}&row=${record.id}&full=1`);
  await recordPage.getByRole("button", { name: "Eintrag teilen" }).click();
  const share = page.getByRole("dialog", { name: "Eintrag teilen" });
  await share.getByRole("button", { name: "Neuer Link" }).click();
  await share.getByLabel("Linkname").fill("Kunde");
  await share.getByRole("switch", { name: "Unterseiten einbeziehen" }).click();
  await share.getByRole("button", { name: "Link erstellen" }).click();
  await expect(share.locator(".sh-link").filter({ hasText: "Kunde" })).toContainText("mit Unterseiten");
  const shares = await command({ action: "record.shares", pageId: db.id, rowId: record.id });
  const token = shares.links[0].token as string;
  const visitor = await browser.newContext({ locale: "de-DE", viewport: page.viewportSize()! });
  const guest = await visitor.newPage();
  await guest.goto(`/share/${token}`);
  const children = guest.locator(".public-children");
  await expect(children.getByRole("link", { name: new RegExp(`Gesprächsnotizen ${tag}`) })).toBeVisible();
  await children.getByRole("link", { name: new RegExp(`Gesprächsnotizen ${tag}`) }).click();
  await expect(guest.getByRole("heading", { level: 1, name: `Gesprächsnotizen ${tag}` })).toBeVisible();
  await expect(guest.locator(".public-breadcrumb")).toContainText(`U3a Schnittstelle ${tag}`);
  await expect(guest.locator("body")).not.toContainText(`Anforderungen ${tag}`);
  expect((await guest.request.get(`/share/${token}/${db.id}`)).status()).toBe(404);
  await visitor.close();
  expect(errors).toEqual([]);
});
