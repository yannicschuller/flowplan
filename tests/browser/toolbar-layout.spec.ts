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
    await expect.poll(async () => (await layoutOf(page)).hidden, { timeout: 20_000 }).toEqual(["strike", "bulletList", "orderedList"]);

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
    await expect.poll(async () => (await layoutOf(page)).hidden).toEqual(["bulletList", "orderedList"]);
    await expect.poll(async () => (await layoutOf(page)).order[0]).toBe("undo");
    await page.goto(`/#page=${host.id}`);
    await expect(bar.getByTitle("Durchgestrichen", { exact: true })).toHaveCount(1, { timeout: 30_000 });
  } finally {
    await command({ action: "profile.toolbarLayout", toolbarLayout: null });
  }
});
