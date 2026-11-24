import { test, expect, type Browser, type Page } from "@playwright/test";

// #526: shared and published pages follow the publisher's appearance. With
// "Seitensymbol: Neben dem Titel" the published page shows its visitors the
// icon next to the title as well; the share dialog changes it for the
// publication only. A test server may sign every test in as the same
// person, so the test puts the default back.
const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
async function command(page: Page, data: Record<string, unknown>) {
  const r = await page.request.post("/api/command", { headers: { origin }, data });
  expect(r.ok(), await r.text()).toBe(true);
  return r.json();
}
// Where the icon sits against the title, for a visitor without a session.
async function placement(browser: Browser, url: string) {
  const context = await browser.newContext();
  try {
    const visitor = await context.newPage();
    await visitor.goto(url);
    const title = visitor.getByRole("heading", { level: 1, name: "Neben dem Titel?" });
    await expect(title).toBeVisible();
    const icon = await visitor.locator("main .page-emoji").first().boundingBox();
    const heading = await title.boundingBox();
    expect(icon && heading).toBeTruthy();
    if (icon!.x + icon!.width <= heading!.x + 1 && icon!.y < heading!.y + heading!.height && icon!.y + icon!.height > heading!.y) return "inline";
    if (icon!.y + icon!.height <= heading!.y + 1) return "above";
    return `unclear ${JSON.stringify({ icon, heading })}`;
  } finally {
    await context.close();
  }
}

test.afterEach(async ({ page }) => {
  await page.request.post("/api/command", { headers: { origin }, data: { action: "profile.pageIcon", pageIcon: "above" } });
});

test("a published page shows the icon where the publisher sees it; the dialog changes the publication", async ({ page, browser }, info) => {
  test.skip(info.project.name !== "desktop", "One run covers the dialog.");
  test.setTimeout(120_000);
  await page.request.post("/api/auth/demo", { headers: { origin } });
  await command(page, { action: "profile.onboarded" });
  await command(page, { action: "profile.pageIcon", pageIcon: "inline" });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const created = await command(page, { action: "page.create", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, title: "Neben dem Titel?", kind: "document" });
  await command(page, { action: "page.update", pageId: created.id, patch: { icon: "🚀" } });

  // Published from the share dialog: preset from the setting.
  await page.goto(`/#page=${created.id}`);
  await expect(page.getByLabel("Dokumentinhalt", { exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(page.locator(".document-header.icon-inline")).toBeVisible();
  await page.getByRole("button", { name: "Teilen" }).first().click();
  const dialog = page.getByRole("dialog", { name: "Seite teilen" });
  await dialog.getByRole("tab", { name: /Web/ }).click();
  await dialog.getByRole("switch", { name: "Im Web veröffentlichen" }).click();
  const url = await dialog.getByLabel("Öffentlicher Link").inputValue();
  expect(url).toContain("/share/");
  const icon = dialog.getByRole("radiogroup", { name: "Seitensymbol" });
  await expect(icon.getByRole("radio", { name: "Neben dem Titel" })).toBeChecked();

  // A visitor in a fresh browser: next to the title, like in the editor.
  expect(await placement(browser, url)).toBe("inline");

  // Changed for the publication: above for visitors, the editor unchanged.
  await icon.getByText("Über dem Titel").click();
  await expect(icon.getByRole("radio", { name: "Über dem Titel" })).toBeChecked();
  await expect.poll(() => placement(browser, url)).toBe("above");
  expect((await (await page.request.get("/api/bootstrap")).json()).pageIcon).toBe("inline");
  await expect(page.locator(".document-header.icon-inline")).toBeVisible();

  await command(page, { action: "page.publish", pageId: created.id, enabled: false });
  await command(page, { action: "page.delete", pageId: created.id });
});
