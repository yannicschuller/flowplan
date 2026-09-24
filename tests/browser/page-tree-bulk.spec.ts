import { test, expect } from "@playwright/test";

test("sidebar selects several pages for moving, duplicating and trashing and drags pages by handle", async ({
  page,
}, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
  await page.request.post("/api/auth/demo", { headers: { origin } });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const command = async (data: Record<string, unknown>) => {
    const response = await page.request.post("/api/command", {
      headers: { origin },
      data,
    });
    expect(response.ok(), await response.text()).toBe(true);
    return response.json();
  };
  const tag = `${testInfo.project.name}${Date.now()}`;
  const create = async (title: string) =>
    (
      await command({
        action: "page.create",
        workspaceId: boot.workspace.id,
        spaceId: boot.spaces[0].id,
        title,
      })
    ).id as string;
  const target = await create(`Ziel ${tag}`),
    a = await create(`Alpha ${tag}`),
    b = await create(`Beta ${tag}`),
    c = await create(`Gamma ${tag}`);
  const pageRow = async (id: string) =>
    (await (await page.request.get(`/api/pages/${id}`)).json()).page;
  const mobile = testInfo.project.name === "mobile";
  await page.goto(`/#page=${target}`);
  await expect(page.locator(".tiptap")).toBeVisible();
  const openNav = async () => {
    if (mobile && !(await page.locator(".app-shell.nav-open").count()))
      await page.getByRole("button", { name: "Navigation öffnen" }).click();
  };
  await openNav();
  const nav = page.locator(".sidebar");
  const title = (name: string) =>
    nav.locator(".page-nav-title").filter({ hasText: name });
  if (mobile) {
    await nav.getByRole("button", { name: "Seiten auswählen" }).first().click();
    await nav.getByRole("checkbox", { name: `Alpha ${tag} auswählen` }).check();
    await nav.getByRole("checkbox", { name: `Beta ${tag} auswählen` }).check();
  } else {
    await title(`Alpha ${tag}`).click({ modifiers: ["ControlOrMeta"] });
    await title(`Beta ${tag}`).click({ modifiers: ["ControlOrMeta"] });
  }
  const bar = nav.getByRole("toolbar", { name: "Seitenauswahl" });
  await expect(bar).toContainText("2 ausgewählt");
  await page.screenshot({
    path: `test-results/page-tree-verification/${testInfo.project.name}-selection.png`,
  });
  await bar.getByRole("button", { name: "Verschieben" }).click();
  const dialog = page.getByRole("dialog", { name: "Seiten verschieben" });
  await dialog.getByLabel("Ziel").selectOption(`page:${target}`);
  await dialog
    .getByRole("button", { name: "Verschieben", exact: true })
    .click();
  await expect.poll(async () => (await pageRow(a)).parent_id).toBe(target);
  expect((await pageRow(b)).parent_id).toBe(target);
  await expect(bar).toHaveCount(0);

  // Range selection with Shift on desktop, checkboxes on touch.
  await openNav();
  if (mobile) {
    await nav.getByRole("button", { name: "Seiten auswählen" }).first().click();
    await nav.getByRole("checkbox", { name: `Alpha ${tag} auswählen` }).check();
    await nav.getByRole("checkbox", { name: `Beta ${tag} auswählen` }).check();
  } else {
    await title(`Alpha ${tag}`).click({ modifiers: ["ControlOrMeta"] });
    await title(`Beta ${tag}`).click({ modifiers: ["Shift"] });
    await expect(bar).toContainText("2 ausgewählt");
  }
  await bar.getByRole("button", { name: "Papierkorb" }).click();
  await page
    .getByRole("dialog", { name: "Seiten in den Papierkorb" })
    .getByRole("button", { name: "In den Papierkorb" })
    .click();
  // Trashed pages are no longer served.
  const gone = async (id: string) =>
    !(await page.request.get(`/api/pages/${id}`)).ok();
  await expect.poll(() => gone(a)).toBe(true);
  expect(await gone(b)).toBe(true);

  // Dragging with the handle (touch devices show it) moves a page.
  if (mobile) {
    await openNav();
    const handle = nav.getByRole("button", { name: `Gamma ${tag} ziehen` });
    const dest = nav.locator(`.page-nav[data-page-id="${target}"]`);
    await dest.scrollIntoViewIfNeeded();
    await handle.scrollIntoViewIfNeeded();
    // Wait until the sliding navigation has settled.
    await expect
      .poll(async () => (await dest.boundingBox())?.x)
      .toBeGreaterThanOrEqual(0);
    const from = await handle.boundingBox(),
      to = await dest.boundingBox();
    await page.mouse.move(
      from!.x + from!.width / 2,
      from!.y + from!.height / 2,
    );
    await page.mouse.down();
    await page.mouse.move(to!.x + to!.width / 2, to!.y + to!.height / 2, {
      steps: 8,
    });
    await expect(dest).toHaveClass(/drop-inside/);
    await page.mouse.up();
    await expect.poll(async () => (await pageRow(c)).parent_id).toBe(target);
  } else
    await expect(
      nav.getByRole("button", { name: `Gamma ${tag} ziehen` }),
    ).toBeHidden();
  expect(errors).toEqual([]);
  await command({ action: "page.delete", pageId: target });
  if (!mobile) await command({ action: "page.delete", pageId: c });
});
