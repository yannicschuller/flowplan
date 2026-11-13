import { test, expect } from "@playwright/test";

// #275: several pages selected in the sidebar are locked and unlocked at
// once; a page the person may only read is skipped and counted.
test("sidebar locks and unlocks a selection of pages and skips read-only pages", async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
  await page.request.post("/api/auth/demo", { headers: { origin } });
  await page.request.post("/api/command", { headers: { origin }, data: { action: "profile.onboarded" } });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const command = async (data: Record<string, unknown>) => {
    const response = await page.request.post("/api/command", { headers: { origin }, data });
    expect(response.ok(), await response.text()).toBe(true);
    return response.json();
  };
  const tag = `${testInfo.project.name}${Date.now()}`;
  const create = async (title: string) =>
    (await command({ action: "page.create", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, title })).id as string;
  const a = await create(`Alpha ${tag}`),
    b = await create(`Beta ${tag}`),
    c = await create(`Gamma ${tag}`),
    d = await create(`Delta ${tag}`);
  // Delta: only readable for the person (a direct grant below their role).
  await command({ action: "grant.set", resourceId: d, userId: boot.user.id, role: "viewer" });
  const locked = async (id: string) => (await (await page.request.get(`/api/pages/${id}`)).json()).page.locked;
  const mobile = testInfo.project.name === "mobile";
  await page.goto(`/#page=${a}`);
  await expect(page.locator(".tiptap")).toBeVisible();
  const openNav = async () => {
    if (mobile && !(await page.locator(".app-shell.nav-open").count()))
      await page.locator(".topbar").getByRole("button", { name: "Navigation öffnen" }).click();
  };
  const nav = page.locator(".sidebar");
  const title = (name: string) => nav.locator(".page-nav-title").filter({ hasText: name });
  const select = async (names: string[]) => {
    await openNav();
    if (mobile) {
      if (!(await nav.getByRole("checkbox").count()))
        await nav.getByRole("button", { name: "Seiten auswählen" }).first().click();
      for (const name of names) await nav.getByRole("checkbox", { name: `${name} auswählen` }).check();
    } else {
      await title(names[0]).click({ modifiers: ["Shift"] });
      for (const name of names.slice(1)) await title(name).click({ modifiers: ["ControlOrMeta"] });
    }
  };
  const bar = nav.getByRole("toolbar", { name: "Seitenauswahl" });
  const more = async () => {
    await bar.getByRole("button", { name: "Weitere Aktionen für die Auswahl" }).click();
    return page.getByRole("menu", { name: "Weitere Aktionen für die Auswahl" });
  };
  const toast = page.locator(".toast-live[role=status]");

  await select([`Alpha ${tag}`, `Beta ${tag}`, `Gamma ${tag}`]);
  await expect(bar).toContainText("3 ausgewählt");
  await (await more()).getByRole("menuitem", { name: "Seiten sperren" }).click();
  await expect(toast).toContainText("3 Seiten gesperrt.");
  for (const id of [a, b, c]) await expect.poll(() => locked(id)).toBe(1);
  // The selection stays; every selected page shows the lock.
  await expect(bar).toContainText("3 ausgewählt");
  for (const id of [a, b, c])
    await expect(nav.locator(`.page-nav[data-page-id="${id}"] .page-nav-title svg`)).toHaveCount(2);

  // Unlocking: from the context menu of a selected page on desktop.
  if (mobile) await (await more()).getByRole("menuitem", { name: "Seiten entsperren" }).click();
  else {
    await title(`Beta ${tag}`).click({ button: "right" });
    await page.getByRole("menu", { name: "Aktionen für 3 Seiten" }).getByRole("menuitem", { name: "Seiten entsperren" }).click();
  }
  await expect(toast).toContainText("3 Seiten entsperrt.");
  for (const id of [a, b, c]) await expect.poll(() => locked(id)).toBe(0);
  await bar.getByRole("button", { name: "Fertig" }).click();
  await expect(bar).toHaveCount(0);

  // A read-only page in the selection is skipped and counted.
  await select([`Alpha ${tag}`, `Delta ${tag}`]);
  await expect(bar).toContainText("2 ausgewählt");
  await (await more()).getByRole("menuitem", { name: "Seiten sperren" }).click();
  await expect(toast).toContainText("1 Seite gesperrt. 1 Seite ohne Bearbeitungsrechte übersprungen.");
  expect(await locked(a)).toBe(1);
  expect(await locked(d)).toBe(0);
  await page.screenshot({ path: `test-results/page-tree-verification/${testInfo.project.name}-bulk-lock.png` });
  expect(errors).toEqual([]);
});
