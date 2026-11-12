import { test, expect, type Page } from "@playwright/test";
import { DatabaseSync } from "node:sqlite";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { join } from "node:path";

// Issue #231 (wave 1): a record as a page of its own in the main area –
// by "Als Seite öffnen" and by the setting "Ganze Seite" – with its own
// address, back and forward, a real link for a new tab, as a favourite;
// the top bar shows the structural path, folded in the middle when long,
// without the titles of pages the person cannot read.

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
  const create = (title: string, parentId: string | null, kind = "document") =>
    command({ action: "page.create", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, title, kind, ...(parentId ? { parentId } : {}) });
  return { boot, command, create };
}
const crumbs = (page: Page) => page.locator(".topbar .breadcrumb-path");

test("a record opens as a page of its own, with its address, history and favourite", async ({ page }, info) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const mobile = info.project.name === "mobile";
  const { command, create } = await setup(page);
  const tag = `${info.project.name}${Date.now()}`;
  const client = await create(`Kunde ${tag}`, null);
  const overview = await create(`Übersicht ${tag}`, client.id);
  const db = await create(`Anforderungen ${tag}`, overview.id, "database");
  const row = await command({ action: "row.create", pageId: db.id, cells: { title: `U3a ${tag}` } });

  // The dialog over the database; "Als Seite öffnen" is a real link.
  await page.goto(`/#page=${db.id}&row=${row.id}`);
  const dialog = page.getByRole("dialog", { name: "Eintrag", exact: true });
  await expect(dialog).toBeVisible();
  // The record is in the path while its dialog is open (behind the dialog,
  // so not by its role).
  await expect(crumbs(page).locator("a.breadcrumb-link", { hasText: `U3a ${tag}` })).toHaveAttribute("href", `#page=${db.id}&row=${row.id}`);
  const asPage = dialog.getByRole("link", { name: "Als Seite öffnen", exact: true });
  await expect(asPage).toHaveAttribute("href", `#page=${db.id}&row=${row.id}&full=1`);
  await asPage.click();
  await expect(page).toHaveURL(new RegExp(`#page=${db.id}&row=${row.id}&full=1$`));
  const record = page.locator("main .record-page, .record-page").first();
  await expect(record).toBeVisible();
  await expect(dialog).toHaveCount(0);
  // No database behind it: neither its views nor its title.
  await expect(page.getByRole("group", { name: "Ansichten" })).toHaveCount(0);
  await expect(page.getByLabel("Seitentitel")).toHaveCount(0);
  await expect(record.locator(".row-title-input")).toHaveValue(`U3a ${tag}`);
  // Everything of the dialog: properties, document, comments.
  await expect(record.locator(".row-properties")).toBeVisible();
  await expect(record.locator(".ProseMirror")).toBeVisible();
  await expect(record.getByRole("heading", { name: "Kommentare" })).toBeVisible();
  // It fills the content area (no dialog width, no overlay).
  await expect(page.locator(".modal-overlay")).toHaveCount(0);

  // The path: workspace → pages → database → record, each a link.
  const path = crumbs(page);
  if (!mobile) {
    await expect(path.getByRole("link")).toHaveText([`Kunde ${tag}`, `Übersicht ${tag}`, `Anforderungen ${tag}`, `U3a ${tag}`]);
    await expect(path.getByRole("link", { name: `Kunde ${tag}` })).toHaveAttribute("href", `#page=${client.id}`);
    await expect(path.getByRole("link", { name: `U3a ${tag}` })).toHaveAttribute("aria-current", "page");
  } else {
    // Phones: "…" with the levels above, and the record.
    await expect(path.getByRole("link")).toHaveText([`U3a ${tag}`]);
    await path.getByRole("button", { name: "3 weitere Ebenen" }).click();
    await expect(page.getByRole("menuitem")).toHaveText([`Kunde ${tag}`, `Übersicht ${tag}`, `Anforderungen ${tag}`]);
    await page.keyboard.press("Escape");
  }
  await page.screenshot({ path: `test-results/record-full-page-${info.project.name}.png` });

  // Back: the dialog again; forward: the page again.
  await page.goBack();
  await expect(dialog).toBeVisible();
  await expect(record).toHaveCount(0);
  await page.goForward();
  await expect(page.locator(".record-page")).toBeVisible();
  await expect(dialog).toHaveCount(0);

  // Favourite: the sidebar lists it with a link to the page.
  await page.locator(".record-page").getByRole("button", { name: "Zu Favoriten" }).click();
  await expect(page.locator(".record-page").getByRole("button", { name: "Aus Favoriten entfernen" })).toBeVisible();
  if (mobile) await page.locator(".topbar").getByRole("button", { name: "Navigation öffnen" }).click();
  const favourite = page.locator(".sidebar").getByRole("link", { name: `Eintrag U3a ${tag}` });
  await expect(favourite).toHaveAttribute("href", `#page=${db.id}&row=${row.id}&full=1`);
  if (mobile) await page.keyboard.press("Escape");

  // The database segment leads back to the database.
  if (!mobile) {
    await path.getByRole("link", { name: `Anforderungen ${tag}` }).click();
  } else {
    await path.getByRole("button", { name: "3 weitere Ebenen" }).click();
    await page.getByRole("menuitem", { name: `Anforderungen ${tag}` }).click();
  }
  await expect(page).toHaveURL(new RegExp(`#page=${db.id}$`));
  await expect(page.getByRole("group", { name: "Ansichten" })).toBeVisible();
  await expect(page.locator(".record-page")).toHaveCount(0);

  // The favourite opens the page (a new tab would load the same address).
  if (mobile) await page.locator(".topbar").getByRole("button", { name: "Navigation öffnen" }).click();
  await favourite.click();
  await expect(page.locator(".record-page")).toBeVisible();
  const tab = await page.context().newPage();
  await tab.goto(`/#page=${db.id}&row=${row.id}&full=1`);
  await expect(tab.locator(".record-page .row-title-input")).toHaveValue(`U3a ${tag}`);
  await expect(tab.getByRole("dialog", { name: "Eintrag", exact: true })).toHaveCount(0);
  await tab.close();

  // The setting "Ganze Seite": a plain link opens the record as a page.
  const current = await (await page.request.get(`/api/pages/${db.id}`)).json();
  await command({ action: "database.recordLayout", pageId: db.id, layout: { ...current.database.recordLayout, open: "full" } });
  await page.goto("about:blank");
  await page.goto(`/#page=${db.id}`);
  await page.getByRole("button", { name: `Eintrag öffnen: U3a ${tag}` }).click();
  await expect(page.locator(".record-page")).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`#page=${db.id}&row=${row.id}&full=1$`));
  await page.goto("about:blank");
  await page.goto(`/#page=${db.id}&row=${row.id}`);
  await expect(page.locator(".record-page")).toBeVisible();
  await expect(dialog).toHaveCount(0);
  // The setting in the view's settings names the three ways.
  if (!mobile) {
    await page.goto(`/#page=${db.id}`);
    await page.getByTitle("Ansicht und Eigenschaften", { exact: true }).click();
    const settings = page.getByRole("dialog", { name: "Ansicht konfigurieren", exact: true });
    const select = settings.getByLabel("Einträge öffnen als", { exact: true });
    await expect(select.locator("option")).toHaveText(["Wie die Datenbank (Ganze Seite)", "Seitenleiste", "Mittig", "Ganze Seite"]);
    await settings.getByRole("button", { name: "Schließen", exact: true }).click();
  }
  await command({ action: "database.recordLayout", pageId: db.id, layout: { ...current.database.recordLayout, open: "center" } });
  expect(errors).toEqual([]);
});

test("a long path folds into …; guests see no titles of private pages above", async ({ page, browser }, info) => {
  test.setTimeout(120_000);
  test.skip(info.project.name !== "desktop", "The phone form is covered above.");
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const { boot, command, create } = await setup(page);
  const tag = `${Date.now()}`;
  let parent: string | null = null;
  const chain: { id: string; title: string }[] = [];
  for (const name of ["Privat", "Ebene 2", "Ebene 3", "Geteilt", "Ebene 5"]) {
    const created: { id: string } = await create(`${name} ${tag}`, parent);
    chain.push({ id: created.id, title: `${name} ${tag}` });
    parent = created.id;
  }
  const db = await create(`Liste ${tag}`, parent, "database");
  const row = await command({ action: "row.create", pageId: db.id, cells: { title: `Punkt ${tag}` } });

  await page.goto(`/#page=${db.id}&row=${row.id}&full=1`);
  const path = crumbs(page);
  await expect(path.getByRole("link")).toHaveText([`Privat ${tag}`, `Ebene 5 ${tag}`, `Liste ${tag}`, `Punkt ${tag}`]);
  const more = path.getByRole("button", { name: "3 weitere Ebenen" });
  await more.click();
  await expect(page.getByRole("menuitem")).toHaveText([`Ebene 2 ${tag}`, `Ebene 3 ${tag}`, `Geteilt ${tag}`]);
  await page.screenshot({ path: "test-results/record-full-page-collapsed.png" });
  await page.getByRole("menuitem", { name: `Ebene 3 ${tag}` }).click();
  await expect(page).toHaveURL(new RegExp(`#page=${chain[2].id}$`));
  await expect(page.getByLabel("Seitentitel")).toHaveValue(`Ebene 3 ${tag}`);
  await expect(path.getByRole("link")).toHaveText([`Privat ${tag}`, `Ebene 2 ${tag}`, `Ebene 3 ${tag}`]);

  // A guest with a share on "Geteilt" (and so its sub-pages).
  const store = new DatabaseSync(join(process.env.FLOWPLAN_DATA_DIR || join(process.cwd(), "data"), "flowplan.sqlite"));
  store.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
  const uid = randomUUID(),
    token = randomBytes(32).toString("hex");
  store.prepare("INSERT INTO users(id,subject,name,email,onboarded_at) VALUES(?,?,?,?,?)").run(uid, `guest-test:${uid}`, `Gast ${tag}`, `${uid}@example.test`, Date.now());
  store.prepare("INSERT INTO members VALUES(?,?,?)").run(boot.workspace.id, uid, "editor");
  store.prepare("INSERT INTO sessions(token,user_id,groups_json,expires) VALUES(?,?,?,?)").run(createHash("sha256").update(token).digest("hex"), uid, "[]", Date.now() + 300000);
  store.close();
  await command({ action: "grant.set", resourceId: chain[3].id, userId: uid, role: "editor" });
  await command({ action: "member.guest", workspaceId: boot.workspace.id, userId: uid, guest: true });
  const context = await browser.newContext({ viewport: page.viewportSize()! });
  try {
    await context.addCookies([{ name: "flowplan_session", value: token, url: origin, httpOnly: true, sameSite: "Lax" }]);
    const guest = await context.newPage();
    guest.on("pageerror", (e) => errors.push(e.message));
    await guest.goto(`${origin}/#page=${db.id}&row=${row.id}&full=1`);
    await expect(guest.locator(".record-page .row-title-input")).toHaveValue(`Punkt ${tag}`);
    const guestPath = crumbs(guest);
    await expect(guestPath.getByRole("link")).toHaveText([`Geteilt ${tag}`, `Ebene 5 ${tag}`, `Liste ${tag}`, `Punkt ${tag}`]);
    const topbar = guest.locator(".topbar");
    for (const hidden of ["Privat", "Ebene 2", "Ebene 3"]) await expect(topbar).not.toContainText(`${hidden} ${tag}`);
    await expect(guestPath.getByRole("button")).toHaveCount(0);
    expect(await guest.content()).not.toContain(chain[0].id);
  } finally {
    await context.close();
  }
  expect(errors).toEqual([]);
});
