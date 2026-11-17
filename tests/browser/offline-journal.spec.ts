import { test, expect, type Page, type TestInfo } from "@playwright/test";

// Issue #333: offline, "Heute" and the "+" next to a journal in the sidebar
// did nothing (asking the server for today's page failed and the journal's
// own "Heute" stayed disabled), and new pages or records gave no answer.
// Now today's entry opens offline – the stored page, or an entry kept on
// this device that creates the day with its text once the connection is
// back –, a new record waits in the offline queue, and what needs the
// server (a new page) says so in a calm note.
const origin = () => process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
const localDay = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
const dayTitle = (date: string) =>
  new Intl.DateTimeFormat("de-DE", { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }).format(
    new Date(`${date}T00:00:00Z`),
  );
const mobile = (info: TestInfo) => info.project.name === "mobile";
async function openNavigation(page: Page, info: TestInfo) {
  if (mobile(info)) await page.locator(".topbar").getByRole("button", { name: "Navigation öffnen" }).click();
}

test("offline: today's journal entry opens and is created later, records wait, new pages say why not (#333)", async ({ page, context }, info) => {
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
  const journalTitle = `Sandbox Journal ${stamp}`;
  const journalId = (
    await command({ action: "page.create", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, title: journalTitle, kind: "journal" })
  ).id as string;
  await command({ action: "journal.settings", pageId: journalId, template: "<h3>Vorlage</h3><p></p>" });
  const database = (
    await command({ action: "page.create", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, title: `Offline-Liste ${stamp}`, kind: "database" })
  ).id as string;
  const today = localDay();
  const days = async () =>
    ((await (await page.request.get("/api/bootstrap")).json()).pages as { id: string; parent_id: string; journal_date?: string; deleted_at?: string }[]).filter(
      (p) => p.parent_id === journalId && p.journal_date === today && !p.deleted_at,
    );

  // A document opened once online: the editor's code is in this tab (with
  // offline use on, the offline copy holds the whole app).
  const note = (await command({ action: "page.create", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, title: `Notiz ${stamp}` })).id as string;
  await page.goto(`/#page=${note}`);
  await expect(page.locator(".page-content .ProseMirror").first()).toBeVisible({ timeout: 30_000 });
  // The database was opened once online: this tab keeps a copy of it.
  await page.evaluate((id) => (location.hash = `page=${id}`), database);
  const newRow = page.getByRole("button", { name: "Neue Zeile" });
  await expect(newRow).toBeVisible({ timeout: 30_000 });
  const offlineIcon = page.locator(".topbar .offline-status-button");

  await context.setOffline(true);
  await expect(offlineIcon).toBeVisible();

  // A new record offline: shown at once, waiting for the connection.
  await newRow.click();
  const entryDialog = page.getByRole("dialog", { name: "Eintrag", exact: true });
  if (await entryDialog.isVisible()) await entryDialog.getByRole("button", { name: "Schließen", exact: true }).click();
  await expect(page.locator(".title-cell")).toHaveCount(1);
  await expect(page.locator(".offline-pending")).toContainText("1 Offline-Änderung");

  // A new page needs the server: a calm note, no dialog, no error.
  await openNavigation(page, info);
  await page.getByTitle(`Seite in ${boot.spaces[0].name} hinzufügen`).first().click();
  await expect(page.locator(".toast-info")).toContainText("Geht nur mit Verbindung – du bist gerade offline.");
  await expect(page.getByRole("dialog", { name: "Neue Seite" })).toHaveCount(0);
  await expect(page.locator(".toast-error")).toHaveCount(0);
  if (mobile(info) && (await page.locator(".topbar").getByRole("button", { name: "Navigation schließen" }).isVisible().catch(() => false)))
    await page.keyboard.press("Escape");

  // The journal's "+" opens today's entry, kept on this device.
  if (!(await page.locator(`[data-page-id="${journalId}"]`).isVisible())) await openNavigation(page, info);
  const journalRow = page.locator(`[data-page-id="${journalId}"]`);
  await journalRow.getByRole("button", { name: `Unterseite in ${journalTitle} hinzufügen` }).click();
  await expect(page.locator("textarea.page-title")).toHaveValue(dayTitle(today));
  await expect(page.locator(".journal-draft-note")).toContainText("Offline-Entwurf");
  await expect(page.locator(".journal-draft-hint")).toContainText("Du bist offline");
  const editor = page.locator(".page-content .ProseMirror").first();
  await editor.click();
  await page.keyboard.type("Offline im Journal geschrieben.");
  await expect(editor).toContainText("Offline im Journal geschrieben.");
  // Away and back through "Heute" in the sidebar: the same entry, its text kept.
  await page.evaluate((id) => (location.hash = `page=${id}`), database);
  await expect(newRow).toBeVisible();
  await openNavigation(page, info);
  if ((await journalRow.getAttribute("aria-expanded")) === "false") await journalRow.locator(".tree-toggle").click();
  await page.locator(`#tree-group-${journalId}`).getByRole("treeitem", { name: "Heute" }).click();
  await expect(page.locator(".journal-draft-note")).toContainText("Offline-Entwurf");
  await expect(editor).toContainText("Offline im Journal geschrieben.");
  await editor.click();
  await page.keyboard.press("End");
  await page.keyboard.type(" Noch mehr.");
  await expect(editor).toContainText("Offline im Journal geschrieben. Noch mehr.");
  // The journal page itself: its "Heute" is no dead button offline.
  expect(await days()).toEqual([]);
  await expect(page.locator(".toast-error")).toHaveCount(0);

  await context.setOffline(false);
  await expect(offlineIcon).toHaveCount(0, { timeout: 15_000 });
  // The day exists on the server, with its template and the text.
  await expect.poll(async () => (await days()).length, { timeout: 20_000 }).toBe(1);
  const [day] = await days();
  await expect
    .poll(async () => String((await (await page.request.get(`/api/pages/${day.id}`)).json()).html || ""), { timeout: 20_000 })
    .toMatch(/Vorlage[\s\S]*Offline im Journal geschrieben\. Noch mehr\./);
  // The open entry gave way to the stored day.
  await expect(page.locator(".journal-draft-note")).toHaveCount(0, { timeout: 15_000 });
  await expect(page).toHaveURL(new RegExp(`#page=${day.id}`));
  await expect(editor).toContainText("Offline im Journal geschrieben. Noch mehr.");
  // The record reached the server too.
  await expect
    .poll(async () => ((await (await page.request.get(`/api/pages/${database}`)).json()).rows as unknown[]).length, { timeout: 20_000 })
    .toBe(1);
  // Nothing left waiting on the device.
  expect(await page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith("flowplan:journal-offline:")))).toEqual([]);
  expect(errors).toEqual([]);
});

test("offline: the journal page's own 'Heute' opens the entry kept on this device (#333)", async ({ page, context }, info) => {
  test.setTimeout(120_000);
  await page.request.post("/api/auth/demo", { headers: { origin: origin() } });
  const command = async (data: Record<string, unknown>) => {
    const response = await page.request.post("/api/command", { headers: { origin: origin() }, data });
    expect(response.ok(), await response.text()).toBe(true);
    return response.json();
  };
  await command({ action: "profile.onboarded" });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const journalId = (
    await command({ action: "page.create", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, title: `Journal ${info.project.name} ${Date.now()}`, kind: "journal" })
  ).id as string;
  // A journal whose day is made on the first write: today stays a draft.
  await command({ action: "journal.settings", pageId: journalId, options: { create: "write" } });
  const note = (await command({ action: "page.create", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, title: `Notiz ${Date.now()}` })).id as string;
  await page.goto(`/#page=${note}`);
  await expect(page.locator(".page-content .ProseMirror").first()).toBeVisible({ timeout: 30_000 });
  await page.evaluate((id) => (location.hash = `page=${id}`), journalId);
  const card = page.locator("button.journal-today");
  await expect(card).toBeEnabled({ timeout: 30_000 });
  await expect(card).toContainText("Schreiben");
  // The connection goes while the journal is open: today's draft lives on
  // the server and cannot be loaded now – the card opens the entry kept
  // on this device instead of failing.
  await context.setOffline(true);
  await expect(page.locator(".topbar .offline-status-button")).toBeVisible();
  await card.click();
  await expect(page.locator(".journal-draft-note")).toContainText("Offline-Entwurf");
  await expect(page.locator(".toast-error")).toHaveCount(0);
  const editor = page.locator(".page-content .ProseMirror").first();
  await editor.click();
  await page.keyboard.type("Vom Journal aus.");
  await context.setOffline(false);
  // Created under today's draft, with the text.
  await expect(page.locator(".journal-draft-note")).toHaveCount(0, { timeout: 20_000 });
  await expect(editor).toContainText("Vom Journal aus.");
  void info;
});
