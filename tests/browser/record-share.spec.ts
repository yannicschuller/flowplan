import { test, expect, type Page } from "@playwright/test";

// Issue #231 (wave 2): the record's own Share menu – a link with password,
// opened by an anonymous visitor who sees only that record (no database,
// no other records, no way into the database), publishing the record and
// revoking both.

const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
const shots = process.env.RECORD_SHARE_SHOTS;
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

test("share a record by link with a password, publish it and revoke both", async ({ page, browser }, info) => {
  test.setTimeout(150_000);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const { boot, command } = await setup(page);
  const tag = `${info.project.name}${Date.now()}`;
  const db = await command({ action: "page.create", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, title: `Anforderungen ${tag}`, kind: "database" });
  const first = await (await page.request.get(`/api/pages/${db.id}`)).json();
  await command({
    action: "database.update",
    pageId: db.id,
    version: first.database.version,
    fields: [
      { id: "title", name: "Name", type: "text" },
      { id: "status", name: "Status", type: "select", options: ["Offen", "Erledigt"] },
      { id: "due", name: "Fällig", type: "date" },
      { id: "budget", name: "Budget intern", type: "text", access: { read: "editors" } },
      { id: "link", name: "Verknüpft", type: "relation", relationPage: db.id },
    ],
    views: first.database.views,
  });
  const sibling = await command({ action: "row.create", pageId: db.id, cells: { title: `Geheime Anforderung ${tag}` } });
  const record = await command({
    action: "row.create",
    pageId: db.id,
    cells: { title: `U3a Schnittstelle ${tag}`, status: "Offen", due: "2026-12-01", budget: "50 000 €", link: [sibling.id] },
  });

  // The record's Share menu, on its page.
  await page.goto(`/#page=${db.id}&row=${record.id}&full=1`);
  const recordPage = page.locator(".record-page");
  await expect(recordPage).toBeVisible();
  await recordPage.locator(".row-document .ProseMirror").click();
  await page.keyboard.type("Spezifikation für den Kunden.");
  // Saved once the record's document holds it.
  await expect
    .poll(async () => JSON.stringify(await (await page.request.get(`/api/pages/${db.id}/rows/${record.id}`)).json()), { timeout: 30_000 })
    .toContain("Spezifikation für den Kunden.");
  await recordPage.getByRole("button", { name: "Eintrag teilen" }).click();
  const dialog = page.getByRole("dialog", { name: "Eintrag teilen" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText("Geteilt wird nur dieser Eintrag")).toBeVisible();
  await dialog.getByRole("button", { name: "Neuer Link" }).click();
  await dialog.getByLabel("Linkname").fill("Kunde");
  await dialog.getByLabel("Linkberechtigung").selectOption("commenter");
  await dialog.getByLabel("Passwort für den neuen Link").fill("geheim-123");
  await dialog.getByRole("button", { name: "Link erstellen" }).click();
  await expect(dialog.locator(".sh-link").filter({ hasText: "Kunde" })).toBeVisible();
  if (shots) await page.screenshot({ path: `${shots}/share-menu-links-${info.project.name}.png` });
  await dialog.getByRole("tab", { name: /Eigenschaften/ }).click();
  await expect(dialog.getByText("Was Besucher sehen")).toBeVisible();
  if (shots) await page.screenshot({ path: `${shots}/share-menu-properties-${info.project.name}.png` });

  await dialog.getByRole("button", { name: "Fertig" }).click();
  await expect(dialog).toHaveCount(0);
  const shares = await command({ action: "record.shares", pageId: db.id, rowId: record.id });
  const token = shares.links[0].token as string;

  // An anonymous visitor: the password first, then only this record.
  const visitor = await browser.newContext({ locale: "de-DE", viewport: page.viewportSize() || undefined, colorScheme: info.project.name === "mobile" ? "dark" : "light" });
  const guest = await visitor.newPage();
  guest.on("pageerror", (e) => errors.push(e.message));
  await guest.goto(`/share/${token}`);
  await expect(guest.getByRole("heading", { name: "Passwort erforderlich" })).toBeVisible();
  await guest.getByLabel("Passwort").fill("geheim-123");
  await guest.getByRole("button", { name: "Öffnen" }).click();
  await expect(guest.getByRole("heading", { name: `U3a Schnittstelle ${tag}`, level: 1 })).toBeVisible({ timeout: 45_000 });
  // The path starts at the record: no database, no workspace.
  await expect(guest.locator(".public-breadcrumb")).toHaveText(`U3a Schnittstelle ${tag}`);
  await expect(guest.getByText(`Anforderungen ${tag}`)).toHaveCount(0);
  await expect(guest.getByText(`Geheime Anforderung ${tag}`)).toHaveCount(0);
  await expect(guest.locator(`a[href*="${sibling.id}"]`)).toHaveCount(0);
  await expect(guest.locator("table.data-table, .public-views")).toHaveCount(0);
  await expect(guest.getByText("Spezifikation für den Kunden.")).toBeVisible();
  // Shown: status and due date; the read-restricted budget and the
  // relation (another record's title) are not.
  await expect(guest.locator(".public-properties")).toContainText("Offen");
  await expect(guest.getByText("50 000 €")).toHaveCount(0);
  await expect(guest.getByText("Verknüpft")).toHaveCount(0);
  // Commenting works (after hydration the button is enabled).
  const publishComment = guest.getByRole("button", { name: "Kommentar veröffentlichen" });
  await expect(async () => {
    await guest.getByLabel("Dein Name").fill("Kundin");
    await guest.getByLabel("Kommentar").fill("Passt so.");
    await expect(publishComment).toBeEnabled({ timeout: 1000 });
  }).toPass({ timeout: 60_000 });
  await publishComment.click();
  await expect(guest.getByText("Passt so.")).toBeVisible();
  if (shots) await guest.screenshot({ path: `${shots}/visitor-${info.project.name}.png`, fullPage: true });
  // The database and the sibling are out of reach through this link.
  expect((await guest.goto(`/share/${token}/${db.id}`))?.status()).toBe(404);
  expect((await guest.goto(`/share/${token}?row=${sibling.id}`))?.status()).toBe(404);
  const api = (path: string) => guest.request.get(path, { headers: { "Accept-Language": "de-DE" } });
  expect((await api(`/api/share/${token}?pageId=${db.id}`)).status()).toBe(404);
  expect((await api(`/api/share/${token}?pageId=${db.id}&rowId=${sibling.id}`)).status()).toBe(404);
  expect((await api(`/api/share/${token}?pageId=${db.id}&rowId=${record.id}`)).status()).toBe(200);
  // No member API either.
  expect((await api(`/api/bootstrap`)).status()).toBe(401);

  // Publish the record; the visitor sees it without a password.
  await page.locator(".record-page").getByRole("button", { name: "Eintrag teilen" }).click();
  await dialog.getByRole("tab", { name: /Web/ }).click();
  await dialog.getByRole("switch", { name: "Im Web veröffentlichen" }).click();
  const publicLink = dialog.getByLabel("Öffentlicher Link");
  await expect(publicLink).toHaveValue(/\/share\//);
  if (shots) await page.screenshot({ path: `${shots}/share-menu-web-${info.project.name}.png` });
  const publicUrl = await publicLink.inputValue();
  const reader = await visitor.newPage();
  await reader.goto(publicUrl);
  await expect(reader.getByRole("heading", { name: `U3a Schnittstelle ${tag}`, level: 1 })).toBeVisible({ timeout: 30_000 });
  await expect(reader.getByText("Veröffentlichter Eintrag")).toBeVisible();
  // Guest comments stay with the links; a publication only reads.
  await expect(reader.getByText("Passt so.")).toHaveCount(0);
  await expect(reader.getByRole("button", { name: "Kommentar veröffentlichen" })).toHaveCount(0);
  const robots = await reader.locator('meta[name="robots"]').getAttribute("content");
  expect(robots).toContain("noindex");
  if (shots) await reader.screenshot({ path: `${shots}/visitor-published-${info.project.name}.png`, fullPage: true });

  // Unpublish and revoke: both addresses end.
  await dialog.getByRole("switch", { name: "Im Web veröffentlichen" }).click();
  await expect(dialog.getByLabel("Öffentlicher Link")).toHaveCount(0);
  await dialog.getByRole("tab", { name: /Links/ }).click();
  await dialog.getByRole("button", { name: "Mehr zu Kunde" }).click();
  await page.getByRole("menuitem", { name: "Widerrufen" }).click();
  await expect(dialog.locator(".sh-link")).toHaveCount(0);
  expect((await reader.goto(publicUrl))?.status()).toBe(404);
  expect((await guest.goto(`/share/${token}`))?.status()).toBe(404);
  await visitor.close();
  expect(errors).toEqual([]);
});
