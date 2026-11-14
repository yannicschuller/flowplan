import { test, expect, type Page } from "@playwright/test";
import { toggleReadingMode } from "./page-top-bar";

// Editor UI quirks (#278): text style and alignment as menus in the
// toolbar, the suggest mode's label on its own surface, task boxes in
// reading mode (not changeable, no animation, a focus ring), and on shared
// pages the "/" menu behind "+", one handle per callout and the icon
// toolbar of the app.
const origin = () => process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
async function fixture(page: Page, title: string, html: string) {
  await page.request.post("/api/auth/demo", { headers: { origin: origin() } });
  const command = async (data: Record<string, unknown>) => {
    const response = await page.request.post("/api/command", { headers: { origin: origin() }, data });
    expect(response.ok(), await response.text()).toBe(true);
    return response.json();
  };
  await command({ action: "profile.onboarded" });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const host = await command({ action: "page.create", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, kind: "document", title });
  const read = async () => (await page.request.get(`/api/pages/${host.id}`)).json();
  const { htmlState } = await import("../../lib/document-server");
  await command({ action: "document.sync", pageId: host.id, generation: (await read()).generation, update: Buffer.from(htmlState(html)).toString("base64") });
  return { host, command, read };
}
const overlaps = (a: { x: number; y: number; width: number; height: number }, b: { x: number; y: number; width: number; height: number }) =>
  a.x < b.x + b.width - 0.5 && b.x < a.x + a.width - 0.5 && a.y < b.y + b.height - 0.5 && b.y < a.y + a.height - 0.5;

test("text style and alignment are menus in the toolbar", async ({ page }, info) => {
  test.setTimeout(150_000);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const f = await fixture(page, `Menüs ${info.project.name} ${Date.now()}`, "<p>Erster Absatz</p><p>Zweiter Absatz</p>");
  await page.goto(`/#page=${f.host.id}`);
  const editor = page.getByLabel("Dokumentinhalt", { exact: true });
  await expect(editor.getByText("Zweiter Absatz")).toBeVisible({ timeout: 20_000 });
  await editor.getByText("Erster Absatz").click();
  const toolbar = page.getByRole("toolbar", { name: "Textformatierung" });

  // Alignment: the button shows the current one; "Rechtsbündig" aligns right.
  const align = toolbar.getByRole("button", { name: "Ausrichtung: Linksbündig", exact: true });
  await expect(align).toHaveAttribute("aria-haspopup", "menu");
  await align.click();
  const alignMenu = page.getByRole("menu", { name: "Ausrichtung" });
  await expect(alignMenu.getByRole("menuitemradio")).toHaveText([/Linksbündig/, /Zentriert/, /Rechtsbündig/, /Blocksatz/]);
  await expect(alignMenu.getByRole("menuitemradio", { name: /Linksbündig/ })).toHaveAttribute("aria-checked", "true");
  if (info.project.name === "desktop") await expect(alignMenu.getByRole("menuitemradio", { name: /Zentriert/ })).toContainText("Shift");
  await page.screenshot({ path: "test-results/toolbar-align-menu.png" });
  await alignMenu.getByRole("menuitemradio", { name: /Rechtsbündig/ }).click();
  await expect(editor.locator("p").first()).toHaveCSS("text-align", "right");
  await expect(toolbar.getByRole("button", { name: "Ausrichtung: Rechtsbündig", exact: true })).toBeVisible();

  // Text style: "Text", then "Überschrift 3" makes a level 3 heading.
  const style = toolbar.getByRole("button", { name: "Textstil: Text", exact: true });
  await expect(style).toHaveText(/Text/);
  await style.click();
  const styleMenu = page.getByRole("menu", { name: "Textstil" });
  await expect(styleMenu.getByRole("menuitemradio")).toHaveText([/^Text/, /Überschrift 1/, /Überschrift 2/, /Überschrift 3/, /Überschrift 4/]);
  await page.screenshot({ path: "test-results/toolbar-heading-menu.png" });
  await styleMenu.getByRole("menuitemradio", { name: /Überschrift 3/ }).click();
  await expect(editor.locator("h3")).toHaveText("Erster Absatz");
  await expect(toolbar.getByRole("button", { name: "H3 – Textstil: Überschrift 3", exact: true })).toHaveText(/H3/);

  if (info.project.name === "desktop") {
    // By keyboard: Enter opens, arrows move, Escape closes.
    await editor.getByText("Zweiter Absatz").click();
    const second = toolbar.getByRole("button", { name: "Textstil: Text", exact: true });
    await second.focus();
    await page.keyboard.press("Enter");
    await expect(styleMenu.getByRole("menuitemradio").first()).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await expect(styleMenu.getByRole("menuitemradio", { name: /Überschrift 1/ })).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(styleMenu).toHaveCount(0);
    await second.focus();
    await page.keyboard.press("Enter");
    await expect(styleMenu.getByRole("menuitemradio").first()).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await expect(styleMenu.getByRole("menuitemradio", { name: /Überschrift 1/ })).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await expect(styleMenu.getByRole("menuitemradio", { name: /Überschrift 2/ })).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(editor.locator("h2")).toHaveText("Zweiter Absatz");
  }
  expect(errors).toEqual([]);
  await f.command({ action: "page.delete", pageId: f.host.id });
});

test("the suggest mode's label has a surface of its own and covers no button", async ({ page }, info) => {
  test.setTimeout(150_000);
  const f = await fixture(page, `Vorschlagen ${info.project.name} ${Date.now()}`, "<p>Ein Satz</p>");
  await page.goto(`/#page=${f.host.id}`);
  const editor = page.getByLabel("Dokumentinhalt", { exact: true });
  await expect(editor.getByText("Ein Satz")).toBeVisible({ timeout: 20_000 });
  await editor.getByText("Ein Satz").click();
  const toolbar = page.getByRole("toolbar", { name: "Textformatierung" });
  const suggest = toolbar.getByRole("button", { name: "Vorschlagen", exact: true });
  await suggest.click();
  await expect(suggest).toHaveAttribute("aria-pressed", "true");
  await expect(suggest).toContainText("Vorschlagen");
  const own = (await suggest.boundingBox())!;
  const label = (await suggest.locator("span").boundingBox())!;
  // The label lies inside its button …
  expect(label.x).toBeGreaterThanOrEqual(own.x);
  expect(label.x + label.width).toBeLessThanOrEqual(own.x + own.width + 0.5);
  // … which has a background and covers none of the others.
  expect(await suggest.evaluate((el) => getComputedStyle(el).backgroundColor)).not.toBe("rgba(0, 0, 0, 0)");
  const others = await toolbar.locator("button:visible").evaluateAll((buttons) =>
    buttons.filter((b) => !b.classList.contains("suggest-toggle")).map((b) => {
      const r = b.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height, name: b.getAttribute("aria-label") || b.getAttribute("title") };
    }),
  );
  for (const other of others) expect(overlaps(own, other), `covers ${other.name}`).toBe(false);
  await page.screenshot({ path: "test-results/suggest-mode-label.png" });
  await suggest.click();
  await expect(suggest).toHaveAttribute("aria-pressed", "false");
  await f.command({ action: "page.delete", pageId: f.host.id });
});

test("task boxes in reading mode cannot be ticked and show a focus ring", async ({ page }, info) => {
  test.setTimeout(150_000);
  const f = await fixture(page, `Lesen ${info.project.name} ${Date.now()}`, '<p>Vorher</p><ul data-type="taskList"><li data-type="taskItem" data-checked="false"><p>Angebot schreiben</p></li></ul>');
  await page.goto(`/#page=${f.host.id}`);
  const editor = page.getByLabel("Dokumentinhalt", { exact: true });
  await expect(editor.locator("li p")).toHaveText("Angebot schreiben", { timeout: 20_000 });
  await toggleReadingMode(page, "Lesemodus");
  await expect(page.getByLabel("Dokumentinhalt", { exact: true })).toHaveAttribute("contenteditable", "false");
  const box = editor.getByRole("checkbox");
  await box.hover().catch(() => {});
  await expect(box).toHaveAttribute("title", "Im Lesemodus nicht änderbar");
  await expect(box).toHaveAttribute("aria-disabled", "true");
  await expect(box).toHaveCSS("cursor", "default");
  // A click (or a tap) changes nothing and draws no strike-through.
  let drawn = false;
  await page.exposeFunction("strikeDrawn", () => (drawn = true));
  await page.evaluate(() => {
    new MutationObserver((records) => {
      if (records.some((r) => [...r.addedNodes].some((n) => (n as Element).classList?.contains("strike-draw")))) (window as unknown as { strikeDrawn: () => void }).strikeDrawn();
    }).observe(document.body, { childList: true });
  });
  // (aria-disabled: Playwright would wait for it to become enabled.)
  if (info.project.name === "mobile") await box.tap({ force: true });
  else await box.click({ force: true });
  await expect(box).not.toBeChecked();
  await page.waitForTimeout(400);
  await expect(box).not.toBeChecked();
  expect(drawn).toBe(false);
  await expect(editor.locator("li[data-checked='true']")).toHaveCount(0);
  expect((await f.read()).html).not.toContain('data-checked="true"');

  if (info.project.name === "desktop") {
    // Reached by keyboard: a visible ring; Space does not tick it either.
    await editor.getByText("Vorher").click();
    let focused = false;
    for (let i = 0; i < 40 && !focused; i++) {
      await page.keyboard.press("Tab");
      focused = await box.evaluate((el) => el === document.activeElement);
    }
    expect(focused).toBe(true);
    await expect(box).toHaveCSS("outline-style", "solid");
    expect(parseFloat(await box.evaluate((el) => getComputedStyle(el).outlineWidth))).toBeGreaterThanOrEqual(2);
    await page.screenshot({ path: "test-results/read-mode-task-focus.png" });
    await page.keyboard.press("Space");
    await expect(box).not.toBeChecked();

    // Editing again: the box ticks as before.
    await toggleReadingMode(page, "Bearbeiten");
    await expect(editor).toHaveAttribute("contenteditable", "true");
    await box.click();
    await expect(box).toBeChecked();
    await expect(box).not.toHaveAttribute("aria-disabled", "true");
  }
  await f.command({ action: "page.delete", pageId: f.host.id });
});

test("a callout has one handle, in the app and on a shared page", async ({ page, browser }, info) => {
  test.setTimeout(150_000);
  test.skip(info.project.name !== "desktop", "Hover handles: mouse only.");
  const f = await fixture(page, `Hinweis ${Date.now()}`, '<p>Oben</p><aside data-callout="note"><p>Im Hinweis</p></aside><blockquote><p>Im Zitat</p></blockquote><p>Unten</p>');
  const visibleHandles = (p: Page) =>
    p.locator(".document-block-handle").evaluateAll((handles) => handles.filter((h) => Number(getComputedStyle(h).opacity) > 0.5).map((h) => h.getAttribute("aria-label")));
  await page.goto(`/#page=${f.host.id}`);
  const editor = page.getByLabel("Dokumentinhalt", { exact: true });
  await expect(editor.getByText("Im Hinweis")).toBeVisible({ timeout: 20_000 });
  await editor.getByText("Im Hinweis").hover();
  await expect.poll(() => visibleHandles(page)).toEqual(["Blockaktionen: Hinweis · Im Hinweis"]);
  await editor.getByText("Im Zitat").hover();
  await expect.poll(() => visibleHandles(page)).toEqual(["Blockaktionen: Zitat · Im Zitat"]);
  await expect(page.getByRole("button", { name: "Blockaktionen: Absatz · Im Hinweis", exact: true })).toHaveCount(0);

  const link = await f.command({ action: "share.create", pageId: f.host.id, role: "editor", name: "Quirks" });
  const visitor = await browser.newContext({ viewport: page.viewportSize()!, locale: "de-DE" });
  try {
    const guest = await visitor.newPage();
    await guest.goto(`${origin()}/share/${link.token}`);
    await guest.getByRole("button", { name: "Inhalt bearbeiten", exact: true }).click();
    const shared = guest.getByLabel("Geteilten Inhalt bearbeiten");
    await expect(shared).toContainText("Unten", { timeout: 20_000 });
    await shared.getByText("Im Hinweis").hover();
    await expect.poll(() => visibleHandles(guest)).toEqual(["Blockaktionen: Hinweis · Im Hinweis"]);
    await guest.screenshot({ path: "test-results/share-callout-handle.png" });
  } finally {
    await visitor.close();
  }
  await f.command({ action: "page.delete", pageId: f.host.id });
});

test("the shared page's editor: icon toolbar and the “/” menu behind “+”", async ({ page, browser }, info) => {
  test.setTimeout(150_000);
  const errors: string[] = [];
  const f = await fixture(page, `Geteilt ${info.project.name} ${Date.now()}`, "<p>Oben</p><p>Unten</p>");
  const link = await f.command({ action: "share.create", pageId: f.host.id, role: "editor", name: "Quirks" });
  const visitor = await browser.newContext({ viewport: page.viewportSize()!, isMobile: info.project.name === "mobile", hasTouch: info.project.name === "mobile", locale: "de-DE" });
  try {
    const guest = await visitor.newPage();
    guest.on("pageerror", (e) => errors.push(e.message));
    await guest.goto(`${origin()}/share/${link.token}`);
    await guest.getByRole("button", { name: "Inhalt bearbeiten", exact: true }).click();
    const shared = guest.getByLabel("Geteilten Inhalt bearbeiten");
    await expect(shared).toContainText("Unten", { timeout: 20_000 });

    // Icon buttons with names, in groups, inside the box.
    const toolbar = guest.getByRole("toolbar", { name: "Textformatierung" });
    for (const name of ["Fett", "Kursiv", "Unterstrichen", "Durchgestrichen", "Aufzählung", "Aufgabenliste", "Inline-Formel", "Mermaid-Diagramm", "Datei einfügen", "Block hinzufügen"]) {
      const button = toolbar.getByRole("button", { name, exact: true });
      await expect(button).toBeVisible();
      await expect(button.locator("svg")).toHaveCount(1);
      expect((await button.textContent())?.trim()).toBe("");
    }
    await expect(toolbar.getByRole("button", { name: /Textstil/ })).toBeVisible();
    await expect(toolbar.getByRole("button", { name: /^Ausrichtung/ })).toBeVisible();
    await expect(toolbar.locator(".toolbar-separator")).not.toHaveCount(0);
    const box = (await guest.locator(".shared-rich-editor").boundingBox())!;
    const bar = (await toolbar.boundingBox())!;
    expect(bar.x + bar.width).toBeLessThanOrEqual(box.x + box.width + 0.5);
    await guest.screenshot({ path: `test-results/share-toolbar-${info.project.name}.png` });

    // Bold through the toolbar.
    await shared.getByText("Oben").click();
    await guest.keyboard.press("End");
    await guest.keyboard.press("Shift+Home");
    await toolbar.getByRole("button", { name: "Fett", exact: true }).click();
    await expect(shared.locator("strong")).toHaveText("Oben");

    if (info.project.name === "desktop") {
      // The handle's "+" adds a block with the "/" menu open.
      await shared.getByText("Unten").hover();
      await guest.getByRole("button", { name: /^Block darunter einfügen: .*Unten/ }).click();
      const menu = guest.locator(".slash-menu");
      await expect(menu).toBeVisible();
      await guest.keyboard.type("h2");
      await expect(menu.locator('button[data-active="true"]')).toContainText("Überschrift 2");
      await guest.keyboard.press("Enter");
      await expect(menu).toHaveCount(0);
      await guest.keyboard.type("Neu");
      await expect(shared.locator("h2")).toHaveText("Neu");
      await expect(shared).not.toContainText("/");
      // Typing "/" opens it as well; Escape closes it and keeps the "/".
      await guest.keyboard.press("Enter");
      await guest.keyboard.type("/");
      await expect(menu).toBeVisible();
      await guest.keyboard.press("Escape");
      await expect(menu).toHaveCount(0);
    }
    // The toolbar's "+" opens the menu with a search field.
    await shared.getByText("Unten").click();
    await toolbar.getByRole("button", { name: "Block hinzufügen", exact: true }).click();
    const search = guest.getByRole("combobox", { name: "Block suchen" });
    await expect(search).toBeVisible();
    await search.fill("aufgabe");
    await guest.keyboard.press("Enter");
    await expect(shared.locator('ul[data-type="taskList"]')).toHaveCount(1);
    expect(errors).toEqual([]);
  } finally {
    await visitor.close();
  }
  await f.command({ action: "page.delete", pageId: f.host.id });
});
