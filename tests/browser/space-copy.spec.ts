import { test, expect, type Page } from "@playwright/test";
async function navigation(page: Page, mobile: boolean) {
  if (
    mobile &&
    !(await page.locator(".app-shell").getAttribute("class"))?.includes(
      "nav-open",
    )
  )
    await page
      .getByRole("button", { name: "Navigation öffnen", exact: true })
      .click();
}
async function setup(page: Page) {
  const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
  await page.request.post("/api/auth/demo", { headers: { origin } });
  const bootstrap = async () =>
    (await page.request.get("/api/bootstrap")).json();
  const boot = await bootstrap();
  const command = async (data: Record<string, unknown>) => {
    const r = await page.request.post("/api/command", {
      headers: { origin },
      data,
    });
    expect(r.ok(), await r.text()).toBe(true);
    return r.json();
  };
  const cleanup = async (ids: string[]) => {
    for (const sid of ids) {
      let b = await bootstrap(),
        s = b.managedSpaces.find((s: any) => s.id === sid);
      if (s)
        await command({
          action: "space.delete",
          spaceId: sid,
          version: s.version,
          confirmName: s.name,
        });
      b = await bootstrap();
      s = b.trashedSpaces.find((s: any) => s.id === sid);
      if (s)
        await command({
          action: "space.purge",
          spaceId: sid,
          version: s.version,
          confirmName: s.name,
        });
    }
  };
  return { origin, bootstrap, boot, command, cleanup };
}
test("create and edit searchable space icons, persist color, and duplicate saved content across roots", async ({
  page,
}, info) => {
  const f = await setup(page),
    mobile = info.project.name === "mobile",
    name = `Space copy ${info.project.name} ${Date.now()}`,
    ids: string[] = [];
  let release = () => {};
  try {
    await page.goto("/");
    await navigation(page, mobile);
    await page
      .getByRole("button", { name: "Bereich hinzufügen", exact: true })
      .click();
    let dialog = page.getByRole("dialog", {
      name: "Bereich hinzufügen",
      exact: true,
    });
    await dialog.getByLabel("Name", { exact: true }).fill(name);
    await dialog
      .getByRole("button", { name: "Symbol auswählen", exact: true })
      .click();
    await dialog
      .getByRole("searchbox", { name: "Emoji suchen", exact: true })
      .fill("Rakete");
    await dialog.locator("form").evaluate((form) => {
      form.addEventListener(
        "submit",
        () => form.setAttribute("data-search-submitted", "true"),
        { once: true },
      );
    });
    await dialog
      .getByRole("searchbox", { name: "Emoji suchen", exact: true })
      .press("Enter");
    await expect(dialog.locator("form")).not.toHaveAttribute(
      "data-search-submitted",
      "true",
    );
    await dialog.getByRole("button", { name: /Rakete 🚀/i }).click();
    await dialog.getByLabel("Hintergrundfarbe").selectOption("purple");
    await dialog.getByLabel("Privater Bereich", { exact: true }).check();
    await expect(dialog).toHaveCSS("opacity", "1");
    await expect(page.locator(".modal-overlay")).toHaveCSS("opacity", "1");
    await page.screenshot({
      path: `test-results/${info.project.name}-space-appearance.png`,
      fullPage: true,
      animations: "disabled",
    });
    await dialog
      .getByRole("button", { name: "Bereich erstellen", exact: true })
      .click();
    await expect(dialog).toHaveCount(0);
    const area = (await f.bootstrap()).spaces.find((s: any) => s.name === name);
    ids.push(area.id);
    expect(area.icon).toBe("🚀");
    expect(area.icon_color).toBe("purple");
    const root = await f.command({
      action: "page.create",
      workspaceId: f.boot.workspace.id,
      spaceId: area.id,
      title: "Copy root",
    });
    const other = await f.command({
      action: "page.create",
      workspaceId: f.boot.workspace.id,
      spaceId: area.id,
      title: "Other root",
    });
    await f.command({
      action: "page.create",
      workspaceId: f.boot.workspace.id,
      spaceId: area.id,
      parentId: root.id,
      title: "Copy child",
    });
    await page.goto(`/#page=${root.id}`);
    await expect(
      page.getByLabel("Dokumentinhalt", { exact: true }),
    ).toBeVisible();
    await navigation(page, mobile);
    const areaRow = page.locator(".nav-section").filter({
      has: page.getByRole("button", {
        name: `Bereich ${name} verwalten`,
        exact: true,
      }),
    });
    await expect(areaRow.locator(".space-icon")).toContainText("🚀");
    await expect(areaRow.locator(".space-icon")).toHaveClass(
      /space-color-purple/,
    );
    await expect(areaRow.locator(".space-name")).toHaveAttribute("title", name);
    const labelBox = await areaRow.locator(".space-name").boundingBox();
    const menuBox = await areaRow
      .getByRole("button", { name: `Bereich ${name} verwalten`, exact: true })
      .boundingBox();
    expect(labelBox!.x + labelBox!.width).toBeLessThanOrEqual(menuBox!.x + 1);
    await page
      .getByRole("button", { name: `Bereich ${name} verwalten`, exact: true })
      .click();
    dialog = page.getByRole("dialog", {
      name: "Bereich verwalten",
      exact: true,
    });
    await dialog.getByLabel("Hintergrundfarbe").selectOption("green");
    await dialog
      .getByRole("button", { name: "Symbol auswählen", exact: true })
      .click();
    await dialog
      .getByRole("searchbox", { name: "Emoji suchen", exact: true })
      .fill("Katze");
    await dialog.getByRole("button", { name: /^Katze 🐈️?$/i }).click();
    await dialog
      .getByRole("button", { name: "Speichern", exact: true })
      .click();
    await expect(dialog).toHaveCount(0);
    await page.reload();
    await expect(
      page.getByLabel("Dokumentinhalt", { exact: true }),
    ).toBeVisible();
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route("**/api/command", async (route) => {
      const data = route.request().postDataJSON();
      if (
        data.action === "document.sync" &&
        data.html?.includes("Pending copy content")
      )
        await gate;
      await route.continue();
    });
    const pending = page.waitForRequest(
      (req) =>
        req.url().endsWith("/api/command") &&
        req.postDataJSON()?.html?.includes("Pending copy content"),
    );
    await page.getByLabel("Dokumentinhalt", { exact: true }).click();
    await page.keyboard.insertText("Pending copy content");
    await pending;
    expect(
      (await (await page.request.get(`/api/pages/${root.id}`)).json()).html,
    ).not.toContain("Pending copy content");
    await navigation(page, mobile);
    await page
      .getByRole("button", { name: `Bereich ${name} verwalten`, exact: true })
      .click();
    dialog = page.getByRole("dialog", {
      name: "Bereich verwalten",
      exact: true,
    });
    await expect(dialog.locator(".space-icon")).toContainText("🐈");
    await expect(dialog.getByLabel("Hintergrundfarbe")).toHaveValue("green");
    await dialog
      .getByRole("button", { name: "Bereich duplizieren", exact: true })
      .click();
    dialog = page.getByRole("dialog", {
      name: "Bereich duplizieren",
      exact: true,
    });
    await expect(dialog.getByLabel("Sichtbarkeit")).toHaveValue("private");
    await dialog.getByLabel("Name", { exact: true }).fill(`${name} result`);
    await expect(dialog).toHaveCSS("opacity", "1");
    await page.screenshot({
      path: `test-results/${info.project.name}-space-copy.png`,
      fullPage: true,
      animations: "disabled",
    });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      ),
    ).toBe(false);
    await dialog
      .getByRole("button", { name: "Kopie erstellen", exact: true })
      .click();
    await expect(dialog).toHaveCount(0);
    release();
    await page.unrouteAll({ behavior: "wait" });
    const next = await f.bootstrap(),
      copied = next.spaces.find((s: any) => s.name === `${name} result`);
    ids.push(copied.id);
    expect(copied.icon.replaceAll("\uFE0F", "")).toBe("🐈");
    expect(copied.icon_color).toBe("green");
    expect(copied.visibility).toBe("private");
    const pages = next.pages.filter((p: any) => p.space_id === copied.id);
    expect(pages).toHaveLength(3);
    const copyRoot = pages.find((p: any) => p.title === "Copy root");
    expect(pages.find((p: any) => p.title === "Copy child").parent_id).toBe(
      copyRoot.id,
    );
    expect(pages.find((p: any) => p.title === "Other root").id).not.toBe(
      other.id,
    );
    expect(
      (await (await page.request.get(`/api/pages/${copyRoot.id}`)).json()).html,
    ).toContain("Pending copy content");
    await page.goto(`/#page=${copyRoot.id}`);
    await expect(
      page.getByLabel("Dokumentinhalt", { exact: true }),
    ).toContainText("Pending copy content");
  } finally {
    test.setTimeout(90_000);
    release();
    await page.unrouteAll({ behavior: "wait" }).catch(() => {});
    await f.cleanup(ids);
  }
});

test("space copy conflicts retain the chosen name and visibility; cancel creates no copy", async ({
  page,
}, info) => {
  const f = await setup(page),
    mobile = info.project.name === "mobile",
    name = `Space conflict ${info.project.name} ${Date.now()}`;
  const area = await f.command({
    action: "space.create",
    workspaceId: f.boot.workspace.id,
    name,
    private: true,
  });
  try {
    await page.goto("/");
    await navigation(page, mobile);
    await page
      .getByRole("button", { name: `Bereich ${name} verwalten`, exact: true })
      .click();
    await page
      .getByRole("dialog", { name: "Bereich verwalten", exact: true })
      .getByRole("button", { name: "Bereich duplizieren", exact: true })
      .click();
    const dialog = page.getByRole("dialog", {
      name: "Bereich duplizieren",
      exact: true,
    });
    await dialog.getByLabel("Name", { exact: true }).fill(`${name} chosen`);
    await dialog.getByLabel("Sichtbarkeit").selectOption("team");
    await f.command({
      action: "space.update",
      spaceId: area.id,
      version: 1,
      name: `${name} changed`,
      private: true,
      icon: "🌳",
      iconColor: "green",
    });
    await dialog
      .getByRole("button", { name: "Kopie erstellen", exact: true })
      .click();
    await expect(dialog.getByRole("alert")).toContainText(
      "inzwischen geändert",
    );
    await expect(dialog.getByLabel("Name", { exact: true })).toHaveValue(
      `${name} chosen`,
    );
    await expect(dialog.getByLabel("Sichtbarkeit")).toHaveValue("team");
    await dialog
      .getByRole("button", { name: "Abbrechen", exact: true })
      .click();
    await expect(dialog).toHaveCount(0);
    expect(
      (await f.bootstrap()).spaces.some(
        (s: any) => s.name === `${name} chosen`,
      ),
    ).toBe(false);
  } finally {
    await f.cleanup([area.id]);
  }
});
