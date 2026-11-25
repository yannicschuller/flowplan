import { test, expect, type Page } from "@playwright/test";

const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";

async function setup(page: Page) {
  await page.request.post("/api/auth/demo", { headers: { origin } });
  const command = async (data: Record<string, unknown>) => {
    const response = await page.request.post("/api/command", { headers: { origin }, data });
    expect(response.ok(), await response.text()).toBe(true);
    return response.json();
  };
  await command({ action: "profile.onboarded" });
  // Settings levels (#294): "Formatierungsleiste anpassen" is for experts.
  await command({ action: "profile.settingsLevel", level: "expert" });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const host = await command({ action: "page.create", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, title: `Leiste anpassen ${Date.now()}`, kind: "document" });
  const { htmlState } = await import("../../lib/document-server");
  const generation = (await (await page.request.get(`/api/pages/${host.id}`)).json()).generation;
  await command({ action: "document.sync", pageId: host.id, generation, update: Buffer.from(htmlState("<p>Ein Absatz für die Liste.</p>")).toString("base64") });
  return { command, host };
}
const layoutOf = async (page: Page) => (await (await page.request.get("/api/bootstrap")).json()).toolbarLayout as { order: string[]; hidden: string[] };
// The toolbar's direct children as names: "|" for a divider, else the
// button's accessible name (or a menu's class).
const toolbarNames = (page: Page) =>
  page.getByRole("toolbar", { name: "Textformatierung" }).evaluate((bar) =>
    [...bar.children].map((el) => (el.classList.contains("toolbar-separator") ? "|" : el.getAttribute("aria-label") || el.getAttribute("title") || el.className)),
  );

// #292: "Formatierungsleiste anpassen" – hide a button, move one with the
// keyboard and one by dragging, add a divider, group buttons (a preset and
// one by hand); the toolbar follows – a group is one button with a menu –,
// the layout is saved for the person, "Zurücksetzen" restores the default.
test("customizing the formatting toolbar: hide, reorder, group, reset", async ({ page }, info) => {
  test.setTimeout(120_000);
  const { command, host } = await setup(page);
  try {
    await page.goto(`/#settings/appearance`);
    await page.getByRole("button", { name: "Anpassen …" }).click();
    const list = page.getByRole("list", { name: "Schaltflächen der Formatierungsleiste" });
    await expect(list).toBeVisible({ timeout: 30_000 });
    const row = (name: string) => list.locator("li", { has: page.getByText(name, { exact: true }) });

    // Hide "Durchgestrichen".
    await row("Durchgestrichen").getByRole("checkbox").uncheck();
    await expect.poll(async () => (await layoutOf(page)).hidden, { timeout: 20_000 }).toEqual(["strike", "cloze", "bulletList", "orderedList", "indent", "outdent"]);

    // "Kursiv" up before "Fett", with the keyboard.
    const italicUp = list.getByRole("button", { name: "Kursiv nach oben" });
    await italicUp.focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("status").filter({ hasText: "„Kursiv“ steht jetzt an Position" })).toHaveCount(1);
    await expect.poll(async () => (await layoutOf(page)).order.slice(4, 6)).toEqual(["italic", "bold"]);

    // A divider after "Unterstrichen".
    await list.getByRole("button", { name: "Trennlinie nach Unterstrichen einfügen" }).click();
    await expect.poll(async () => {
      const { order } = await layoutOf(page);
      return order[order.indexOf("underline") + 1];
    }).toBe("|");

    // "Link" dragged onto "Vorschlagen": it goes before it.
    if (info.project.name !== "mobile") {
      // Both rows in view: a drag that scrolls the page is not a gesture.
      await row("Vorschlagen").scrollIntoViewIfNeeded();
      await row("Link").locator(".toolbar-layout-handle").dragTo(row("Vorschlagen"));
      await expect.poll(async () => {
        const { order } = await layoutOf(page);
        return order.indexOf("link") === order.indexOf("suggest") - 1;
      }).toBe(true);
    }
    // The preset group "Listen", and "Hochgestellt" grouped with the next
    // button ("Tiefgestellt"); "Kommentieren" cannot join "Farbe" (a menu).
    await page.getByRole("button", { name: "Gruppe „Listen“ anlegen" }).click();
    await expect.poll(async () => (await layoutOf(page)).order.find((e) => Array.isArray(e))).toEqual(["bulletList", "orderedList", "taskList"]);
    await expect(page.getByRole("button", { name: "Gruppe „Listen“ anlegen" })).toBeDisabled();
    await expect(list.getByRole("list", { name: "Gruppe Listen" }).getByRole("checkbox")).toHaveCount(3);
    await expect(list.getByRole("button", { name: "Kommentieren mit der nächsten Schaltfläche gruppieren" })).toBeDisabled();
    await list.getByRole("button", { name: "Hochgestellt mit der nächsten Schaltfläche gruppieren" }).click();
    await expect.poll(async () => JSON.stringify((await layoutOf(page)).order)).toContain('["superscript","subscript"]');
    await page.screenshot({ path: `test-results/toolbar-layout-settings-${info.project.name}.png`, fullPage: false });

    // The page's toolbar follows.
    await page.goto(`/#page=${host.id}`);
    const bar = page.getByRole("toolbar", { name: "Textformatierung" });
    await expect(bar).toBeVisible({ timeout: 30_000 });
    await expect(bar.getByTitle("Durchgestrichen", { exact: true })).toHaveCount(0);
    const names = await toolbarNames(page);
    const at = (name: string) => names.indexOf(name);
    expect(at("Kursiv")).toBeGreaterThanOrEqual(0);
    expect(at("Kursiv")).toBeLessThan(at("Fett"));
    expect(names[at("Unterstrichen") + 1]).toBe("|");
    if (info.project.name !== "mobile") expect(at("Link")).toBeLessThan(at("Vorschlagen"));
    expect(names[0]).not.toBe("|");
    expect(names.some((n, i) => n === "|" && names[i + 1] === "|")).toBe(false);
    await page.screenshot({ path: `test-results/toolbar-layout-page-${info.project.name}.png` });

    // The group is one button with a menu; chosen from the keyboard.
    const group = bar.getByRole("button", { name: "Listen" });
    await expect(group).toHaveAttribute("aria-haspopup", "menu");
    await expect(bar.getByTitle("Aufgabenliste", { exact: true })).toHaveCount(0);
    await expect(bar.getByRole("button", { name: "Hochgestellt, Tiefgestellt" })).toHaveCount(1);
    await page.getByLabel("Dokumentinhalt", { exact: true }).locator("p", { hasText: "Ein Absatz" }).click();
    await group.focus();
    await page.keyboard.press("Enter");
    const menu = page.getByRole("menu", { name: "Listen" });
    await expect(menu).toBeVisible();
    await expect(menu.getByRole("menuitemcheckbox")).toHaveText(["Aufzählung", "Nummerierte Liste", "Aufgabenliste"]);
    await menu.getByRole("menuitemcheckbox", { name: "Nummerierte Liste" }).click();
    await expect(page.getByLabel("Dokumentinhalt", { exact: true }).locator("ol li", { hasText: "Ein Absatz" })).toHaveCount(1);
    await expect(group).toHaveAttribute("aria-label", "Listen: Nummerierte Liste");

    // Reset: the default again, "Durchgestrichen" back.
    await page.goto(`/#settings/appearance`);
    await page.getByRole("button", { name: "Zurücksetzen" }).click();
    await expect.poll(async () => (await layoutOf(page)).hidden).toEqual(["bulletList", "orderedList", "indent", "outdent", "cloze"]);
    await expect.poll(async () => (await layoutOf(page)).order[0]).toBe("undo");
    await page.goto(`/#page=${host.id}`);
    await expect(bar.getByTitle("Durchgestrichen", { exact: true })).toHaveCount(1, { timeout: 30_000 });
  } finally {
    await command({ action: "profile.toolbarLayout", toolbarLayout: null });
  }
});

// Follow-ups to #292: the preview while customizing (a group's menu opens
// there), "Trennlinie einfügen" and removing a divider, blocks of the "/"
// menu as buttons that insert their block, and the status line with Reset.
test("customizing the toolbar: preview, dividers, blocks as buttons, customized status", async ({ page }, info) => {
  test.setTimeout(150_000);
  const { command, host } = await setup(page);
  try {
    await page.goto(`/#settings/appearance`);
    const setting = page.locator("#toolbar-layout");
    const status = setting.locator(".toolbar-layout-status");
    await expect(status).toHaveText("Standard", { timeout: 30_000 });
    await expect(setting.getByRole("button", { name: "Zurücksetzen" })).toBeDisabled();
    await setting.getByRole("button", { name: "Anpassen …" }).click();
    const preview = setting.getByRole("group", { name: "Vorschau der Formatierungsleiste" });
    await expect(preview).toBeVisible();
    await expect(preview.getByRole("button", { name: "Fett", exact: true })).toHaveCount(1);
    await expect(preview.getByRole("button", { name: "Aufzählung", exact: true })).toHaveCount(0);
    const list = setting.getByRole("list", { name: "Schaltflächen der Formatierungsleiste" });

    // A preset group shows in the preview as one button whose menu opens.
    await setting.getByRole("button", { name: "Gruppe „Listen“ anlegen" }).click();
    const group = preview.getByRole("button", { name: "Listen", exact: true });
    await expect(group).toHaveAttribute("aria-haspopup", "menu");
    await group.click();
    const menu = page.getByRole("menu", { name: "Listen" });
    await expect(menu.getByRole("menuitemcheckbox")).toHaveText(["Aufzählung", "Nummerierte Liste", "Aufgabenliste"]);
    await page.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);
    await expect(status).toHaveText("Angepasst");
    await expect(setting.getByRole("button", { name: "Zurücksetzen" })).toBeEnabled();

    // "Trennlinie einfügen" after "Fett", from the keyboard; it shows in the
    // preview and is removed again with its row's button.
    await expect(list.getByRole("button", { name: "Trennlinie nach Kursiv einfügen" })).toHaveAttribute("title", "Trennlinie danach");
    const addDivider = setting.getByRole("button", { name: "Trennlinie einfügen", exact: true });
    await addDivider.focus();
    await page.keyboard.press("Enter");
    const places = page.getByRole("menu", { name: "Trennlinie einfügen" });
    await expect(places.getByText("Trennlinie einfügen nach …")).toBeVisible();
    await places.getByRole("menuitem", { name: "Fett", exact: true }).click();
    const afterBold = async () => {
      const { order } = await layoutOf(page);
      return order[order.indexOf("bold") + 1];
    };
    await expect.poll(afterBold, { timeout: 20_000 }).toBe("|");
    const previewNames = () => preview.evaluate((bar) => [...bar.children].map((el) => (el.classList.contains("toolbar-separator") ? "|" : el.getAttribute("aria-label"))));
    await expect.poll(async () => (await previewNames())[(await previewNames()).indexOf("Fett") + 1]).toBe("|");
    const dividerRow = list.locator('li[data-entry="bold"] + li');
    await expect(dividerRow).toHaveClass(/divider/);
    await dividerRow.getByRole("button", { name: "Trennlinie entfernen" }).click();
    await expect.poll(afterBold, { timeout: 20_000 }).toBe("italic");

    // Blocks: "Tabelle" and "Callout" from the blocks list into the bar.
    const blocks = setting.getByRole("list", { name: "Blöcke, die nicht in der Leiste sind" });
    await blocks.getByRole("checkbox", { name: "Tabelle" }).click();
    await expect.poll(async () => (await layoutOf(page)).order.at(-1), { timeout: 20_000 }).toBe("block:table");
    await blocks.getByRole("checkbox", { name: "Callout" }).click();
    await expect.poll(async () => (await layoutOf(page)).order.at(-1), { timeout: 20_000 }).toBe("block:callout");
    await expect(blocks.getByRole("checkbox", { name: "Tabelle" })).toHaveCount(0);
    await expect(list.locator('li[data-entry="block:table"]').getByRole("checkbox")).toBeChecked();
    await expect(preview.getByRole("button", { name: "Tabelle", exact: true })).toHaveCount(1);
    await preview.scrollIntoViewIfNeeded();
    await page.screenshot({ path: `test-results/toolbar-layout-preview-${info.project.name}.png` });

    // In the page: "Tabelle" inserts a table, "Callout" opens its kinds.
    await page.goto(`/#page=${host.id}`);
    const bar = page.getByRole("toolbar", { name: "Textformatierung" });
    await expect(bar).toBeVisible({ timeout: 30_000 });
    const content = page.getByLabel("Dokumentinhalt", { exact: true });
    await content.locator("p", { hasText: "Ein Absatz" }).click();
    await bar.getByRole("button", { name: "Tabelle", exact: true }).click();
    await expect(content.locator("table")).toHaveCount(1);
    await expect(content.locator("p", { hasText: "Ein Absatz" })).toHaveCount(1);
    await content.locator("p", { hasText: "Ein Absatz" }).click();
    await bar.getByRole("button", { name: "Callout", exact: true }).click();
    const kinds = page.getByRole("listbox", { name: "Callout" });
    await expect(kinds.getByRole("option")).toHaveCount(5);
    await kinds.getByRole("option").first().click();
    await expect(content.locator("[data-callout]")).not.toHaveCount(0);

    // Reset: nothing customized any more, Reset disabled again.
    await page.goto(`/#settings/appearance`);
    await setting.getByRole("button", { name: "Zurücksetzen" }).click();
    await expect(status).toHaveText("Standard");
    await expect(setting.getByRole("button", { name: "Zurücksetzen" })).toBeDisabled();
    await expect.poll(async () => (await layoutOf(page)).order.some((e) => typeof e === "string" && e.startsWith("block:"))).toBe(false);
  } finally {
    await command({ action: "profile.toolbarLayout", toolbarLayout: null });
  }
});

// The instance's default toolbar (Administration → Instanz): it applies to
// everyone without their own; their Reset goes back to it.
test("admins set a default toolbar for everyone without their own", async ({ page, browser }, info) => {
  test.skip(!process.env.FLOWPLAN_DATA_DIR, "Needs the test server data directory.");
  test.skip(info.project.name !== "desktop", "Instance settings are global.");
  test.setTimeout(150_000);
  const { randomUUID, randomBytes, createHash } = await import("node:crypto");
  const { DatabaseSync } = await import("node:sqlite");
  const { join } = await import("node:path");
  const db = new DatabaseSync(join(process.env.FLOWPLAN_DATA_DIR!, "flowplan.sqlite"));
  db.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
  const uid = randomUUID(),
    token = randomBytes(32).toString("hex");
  db.prepare("INSERT INTO users(id,subject,name,email,onboarded_at) VALUES(?,?,?,?,?)").run(uid, `toolbar-admin:${uid}`, "Leisten Admin", `${uid}@example.test`, Date.now());
  db.prepare("INSERT INTO sessions(token,user_id,groups_json,expires) VALUES(?,?,?,?)").run(createHash("sha256").update(token).digest("hex"), uid, JSON.stringify(["flowplan-admins"]), Date.now() + 600000);
  db.close();
  const adminContext = await browser.newContext();
  await adminContext.addCookies([{ name: "flowplan_session", value: token, url: origin, httpOnly: true, sameSite: "Lax" }]);
  const admin = await adminContext.newPage();
  const { command, host } = await setup(page);
  try {
    await admin.goto(`${origin}/#settings/instance/general`);
    const setting = admin.locator("#toolbar-layout-default");
    await expect(setting.locator(".toolbar-layout-status")).toHaveText("Standard", { timeout: 30_000 });
    await setting.getByRole("button", { name: "Anpassen …" }).click();
    await setting.getByRole("list", { name: "Schaltflächen der Formatierungsleiste" }).locator('li[data-entry="strike"]').getByRole("checkbox").uncheck();
    await expect(setting.locator(".toolbar-layout-status")).toHaveText("Angepasst");
    await expect(setting.getByText("Gespeichert")).toBeVisible({ timeout: 20_000 });

    // The person without their own layout gets it.
    await expect.poll(async () => (await layoutOf(page)).hidden, { timeout: 20_000 }).toEqual(["strike", "cloze", "bulletList", "orderedList", "indent", "outdent"]);
    await page.goto(`/#settings/appearance`);
    const mine = page.locator("#toolbar-layout");
    await expect(mine.locator(".toolbar-layout-status")).toHaveText("Standard der Instanz", { timeout: 30_000 });
    await expect(mine.getByRole("button", { name: "Zurücksetzen" })).toBeDisabled();
    // Customized, then reset: back to the instance's default.
    await mine.getByRole("button", { name: "Anpassen …" }).click();
    await mine.getByRole("list", { name: "Schaltflächen der Formatierungsleiste" }).locator('li[data-entry="italic"]').getByRole("checkbox").uncheck();
    await expect(mine.locator(".toolbar-layout-status")).toHaveText("Angepasst");
    await expect.poll(async () => (await layoutOf(page)).hidden, { timeout: 20_000 }).toEqual(["italic", "strike", "cloze", "bulletList", "orderedList", "indent", "outdent"]);
    await mine.getByRole("button", { name: "Zurücksetzen" }).click();
    await expect(mine.locator(".toolbar-layout-status")).toHaveText("Standard der Instanz");
    await expect.poll(async () => (await layoutOf(page)).hidden, { timeout: 20_000 }).toEqual(["strike", "cloze", "bulletList", "orderedList", "indent", "outdent"]);
    await page.goto(`/#page=${host.id}`);
    const bar = page.getByRole("toolbar", { name: "Textformatierung" });
    await expect(bar).toBeVisible({ timeout: 30_000 });
    await expect(bar.getByTitle("Kursiv", { exact: true })).toHaveCount(1);
    await expect(bar.getByTitle("Durchgestrichen", { exact: true })).toHaveCount(0);

    // The admin's Reset: the built-in toolbar again, for everyone.
    await setting.getByRole("button", { name: "Zurücksetzen" }).click();
    await expect(setting.locator(".toolbar-layout-status")).toHaveText("Standard");
    await expect.poll(async () => (await layoutOf(page)).hidden, { timeout: 20_000 }).toEqual(["bulletList", "orderedList", "indent", "outdent", "cloze"]);
  } finally {
    await admin.request.post(`${origin}/api/command`, { headers: { origin }, data: { action: "admin.settings", settings: { toolbarLayoutDefault: null } } });
    await command({ action: "profile.toolbarLayout", toolbarLayout: null });
    await adminContext.close();
  }
});
