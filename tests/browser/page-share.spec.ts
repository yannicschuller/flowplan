import { test, expect, type Page } from "@playwright/test";

// Sharing one page with an existing account that is not in the workspace:
// the person joins as a guest and sees only that page.
// Needs two accounts of the test instance: TEST_ADMIN_* (owner) and TEST_OTHER_*.
test("a page is shared with an existing account without the whole workspace", async ({ browser }, info) => {
  test.skip(info.project.name !== "desktop" || !process.env.TEST_OTHER_EMAIL, "Needs a second account; one run covers it.");
  const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
  const signIn = async (page: Page, email: string, password: string) => {
    await page.request.post("/api/auth/password", { headers: { origin }, data: { email, password } });
    await page.request.post("/api/command", { headers: { origin }, data: { action: "profile.onboarded" } });
  };
  const owner = await (await browser.newContext({ locale: "de-DE" })).newPage();
  await signIn(owner, process.env.TEST_ADMIN_EMAIL!, process.env.TEST_ADMIN_PASSWORD!);
  const boot = await (await owner.request.get("/api/bootstrap")).json();
  const title = `Steuer ${Date.now()}`;
  const created = await (
    await owner.request.post("/api/command", {
      headers: { origin },
      data: { action: "page.create", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, title, kind: "database", databaseKind: "documents" },
    })
  ).json();
  await owner.goto(`/#page=${created.id}`);
  await owner.getByRole("button", { name: "Teilen" }).first().click();
  const dialog = owner.getByRole("dialog", { name: "Seite teilen" });
  await dialog.getByLabel("E-Mail-Adresse der Person").fill(process.env.TEST_OTHER_EMAIL!);
  await dialog.getByRole("combobox", { name: "Rolle" }).selectOption("editor").catch(async () => {
    await dialog.getByRole("combobox", { name: "Rolle" }).click();
    await owner.getByRole("option", { name: "Bearbeiten" }).click();
  });
  await dialog.getByRole("button", { name: "Hinzufügen" }).click();
  await expect(dialog.locator(".page-people [role=status]")).toContainText("hat jetzt Zugriff");
  await expect(dialog.locator(".page-people .member-row")).toContainText("Gast");
  await owner.screenshot({ path: "test-results/page-share.png" });

  const guest = await (await browser.newContext({ locale: "de-DE" })).newPage();
  await signIn(guest, process.env.TEST_OTHER_EMAIL!, process.env.TEST_OTHER_PASSWORD!);
  const theirs = await (await guest.request.get(`/api/bootstrap?workspace=${boot.workspace.id}`)).json();
  expect(theirs.workspace.id).toBe(boot.workspace.id);
  // This page – and nothing else of the workspace (earlier runs may have shared more).
  const titles: string[] = theirs.pages.map((p: { title: string }) => p.title);
  expect(titles).toContain(title);
  expect(titles.every((t) => t.startsWith("Steuer "))).toBe(true);
  await guest.goto(`/#page=${created.id}`);
  await expect(guest.locator("main")).toContainText(title);
  await expect(guest.locator(".sidebar")).not.toContainText("Welcome to Flowplan");
});
