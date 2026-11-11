import { test, expect, type Page } from "@playwright/test";

// Issue #75: in a scrolled record (centred dialog or bottom sheet, side
// panel, full page) the "/" menu, the text menu and the table of contents
// sit next to the text, as on a page – the dialog is no containing block
// for its fixed children.
test("menus and outline stay at the text in a scrolled record", async ({ page }, info) => {
  test.setTimeout(180_000);
  const phone = info.project.name === "mobile";
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
  await page.request.post("/api/auth/demo", { headers: { origin } });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const command = async (data: Record<string, unknown>) => {
    const response = await page.request.post("/api/command", { headers: { origin }, data });
    expect(response.ok(), await response.text()).toBe(true);
    return response.json();
  };
  let html = "<h1>Anfang</h1>";
  for (let i = 0; i < 36; i++) {
    if (i % 9 === 0) html += `<h2>Abschnitt ${i / 9 + 1}</h2>`;
    html += `<p>Absatz ${i} mit etwas Text, damit der Eintrag lang wird. Wort${i} steht hier.</p>`;
  }
  const db = await command({
    action: "page.create",
    workspaceId: boot.workspace.id,
    spaceId: boot.spaces[0].id,
    title: `Lange Einträge ${info.project.name} ${Date.now()}`,
    kind: "database",
  });
  const row = await command({ action: "row.create", pageId: db.id, cells: { title: "Langer Eintrag" } });
  // A touch selection on a phone shows the text menu only with "Immer" (#200).
  if (phone) await command({ action: "profile.textMenu", textMenu: "always" });

  for (const mode of ["center", "side", "full"]) {
    const current = await (await page.request.get(`/api/pages/${db.id}`)).json();
    await command({
      action: "database.update",
      pageId: db.id,
      version: current.database.version,
      fields: [{ id: "title", name: "Name", type: "text" }],
      views: [{ id: "table", name: "Tabelle", type: "table", filters: [], sorts: [], recordOpen: mode }],
    });
    await page.goto("about:blank");
    await page.goto(`/#page=${db.id}&row=${row.id}`);
    // A new account's welcome tour.
    const welcome = page.getByRole("dialog", { name: "Willkommen bei Flowplan" });
    if (await welcome.isVisible()) {
      await page.keyboard.press("Escape");
      await expect(welcome).toBeHidden();
    }
    const dialog = page.locator(".modal.record-dialog");
    const editor = dialog.locator(".ProseMirror");
    await expect(editor).toBeVisible();
    if (mode === "center") {
      await editor.evaluate((el, html) => {
        (el as HTMLElement & { editor: TiptapLike }).editor.chain().focus().insertContent(html).run();
      }, html);
    }
    await expect.poll(() => editor.locator("p").count(), { timeout: 15_000 }).toBeGreaterThanOrEqual(36);
    await expect(dialog).toHaveClass(mode === "side" ? /modal-side/ : mode === "full" ? /modal-full/ : /record-dialog/);
    // Nothing between the text and the window captures fixed elements.
    await page.waitForTimeout(400); // the opening animation
    expect(await captors(page)).toEqual([]);

    // Scrolled well down, with the caret at the end of a paragraph in the
    // middle of the window.
    await dialog.evaluate((el) => (el.scrollTop = 1000));
    const index = await page.evaluate(() => {
      const ps = [...document.querySelectorAll(".modal.record-dialog .ProseMirror p")];
      const mid = innerHeight * 0.45;
      let best = 0;
      ps.forEach((p, i) => {
        if (Math.abs(p.getBoundingClientRect().top - mid) < Math.abs(ps[best].getBoundingClientRect().top - mid)) best = i;
      });
      return best;
    });
    const paragraph = editor.locator("p").nth(index);
    await paragraph.evaluate((p) => {
      const editor = (p.closest(".ProseMirror") as HTMLElement & { editor: TiptapLike }).editor;
      const end = editor.view.posAtDOM(p, p.childNodes.length);
      editor.chain().focus(undefined, { scrollIntoView: false }).setTextSelection(end).run();
    });

    // Tiptap focuses a frame later; Enter must not reach the close button.
    await expect(editor).toBeFocused();
    // "/" on a new line opens the block menu right below (or above) the
    // caret.
    await page.keyboard.press("Enter");
    await page.keyboard.type("/");
    const slash = page.locator(".slash-menu");
    await expect(slash).toBeVisible();
    const caret = await page.evaluate(() => {
      const r = document.getSelection()!.getRangeAt(0).getClientRects()[0];
      return { left: r.left, top: r.top, bottom: r.bottom };
    });
    const menu = (await slash.boundingBox())!;
    const gap = menu.y >= caret.top ? menu.y - caret.bottom : caret.top - (menu.y + menu.height);
    expect(Math.abs(gap - 6), `"/" menu ${mode}: ${JSON.stringify({ caret, menu })}`).toBeLessThan(4);
    const width = page.viewportSize()!.width;
    // At the "/" itself (the caret is just after it), kept in the window.
    expect(Math.abs(menu.x - Math.max(8, Math.min(caret.left, width - 328)))).toBeLessThan(12);
    await page.keyboard.press("Backspace");
    await expect(slash).toHaveCount(0);
    await page.keyboard.press("Backspace");

    // A selected word gets the text menu right above it.
    const word = await paragraph.evaluate((p) => {
      const text = p.firstChild!;
      const at = text.textContent!.indexOf("Wort");
      const range = document.createRange();
      range.setStart(text, at);
      range.setEnd(text, at + 4);
      const r = range.getBoundingClientRect();
      return { at, x: r.left + r.width / 2, y: r.top + r.height / 2, top: r.top, bottom: r.bottom };
    });
    if (phone)
      await paragraph.evaluate((p, at) => {
        const range = document.createRange();
        range.setStart(p.firstChild!, at);
        range.setEnd(p.firstChild!, at + 4);
        document.getSelection()!.removeAllRanges();
        document.getSelection()!.addRange(range);
      }, word.at);
    else await page.mouse.dblclick(word.x, word.y);
    const textMenu = page.locator(".text-menu.selection");
    await expect(textMenu).toBeVisible();
    await page.waitForTimeout(200); // the opening animation
    const bar = (await textMenu.boundingBox())!;
    expect(bar.y, `text menu ${mode}`).toBeGreaterThanOrEqual(0);
    const barGap = bar.y + bar.height <= word.top + 1 ? word.top - (bar.y + bar.height) : bar.y - word.bottom;
    expect(barGap, `text menu ${mode}: ${JSON.stringify({ word, bar })}`).toBeGreaterThanOrEqual(-1);
    expect(barGap).toBeLessThan(20);
    await page.keyboard.press("ArrowRight");

    // The table of contents is in the window and on top.
    const toggle = dialog.locator(".outline-toggle");
    if ((await toggle.getAttribute("aria-pressed")) !== "true") await toggle.click();
    const outline = page.getByRole("navigation", { name: "Inhaltsverzeichnis" });
    await expect(outline).toBeVisible();
    await expect(outline).toBeInViewport({ ratio: 1 });
    const box = (await outline.boundingBox())!;
    const hit = await page.evaluate(
      ([x, y]) => !!document.elementFromPoint(x, y)?.closest(".document-outline"),
      [box.x + box.width / 2, box.y + 12],
    );
    expect(hit, `outline ${mode} on top`).toBe(true);
    if (!phone) {
      // Beside the dialog's text: inside the dialog's box.
      const frame = (await dialog.boundingBox())!;
      expect(box.x + box.width).toBeLessThanOrEqual(frame.x + frame.width);
      expect(box.y).toBeGreaterThanOrEqual(frame.y);
    }
    await outline.getByRole("button", { name: "Abschnitt 1", exact: true }).click();
    await expect(editor.locator("h2", { hasText: "Abschnitt 1" })).toBeInViewport();
    if (await outline.isVisible()) await page.getByRole("button", { name: "Inhaltsverzeichnis schließen" }).click();
    await expect(outline).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
  }
  expect(errors).toEqual([]);
  await command({ action: "page.delete", pageId: db.id });
});

// The editor instance on its element (Tiptap sets it), as far as used here.
type Chain = {
  focus: (at?: unknown, options?: { scrollIntoView: boolean }) => Chain;
  insertContent: (html: string) => Chain;
  setTextSelection: (pos: number) => Chain;
  run: () => boolean;
};
type TiptapLike = { chain: () => Chain; view: { posAtDOM: (node: Node, offset: number) => number } };

// Ancestors of the record's text that would be the containing block of a
// position: fixed child (transform, translate, scale, filter, containment …).
function captors(page: Page) {
  return page.evaluate(() => {
    const found: string[] = [];
    for (let el = document.querySelector(".modal.record-dialog .ProseMirror")?.parentElement; el; el = el.parentElement) {
      const s = getComputedStyle(el);
      const why = [
        s.transform !== "none" && `transform ${s.transform}`,
        s.translate !== "none" && `translate ${s.translate}`,
        s.scale !== "none" && `scale ${s.scale}`,
        s.rotate !== "none" && `rotate ${s.rotate}`,
        s.filter !== "none" && "filter",
        s.backdropFilter !== "none" && "backdrop-filter",
        s.perspective !== "none" && "perspective",
        /transform|translate|scale|rotate|filter|perspective/.test(s.willChange) && `will-change ${s.willChange}`,
        /layout|paint|strict|content/.test(s.contain) && `contain ${s.contain}`,
        s.containerType !== "normal" && `container-type ${s.containerType}`,
      ].filter(Boolean);
      if (why.length) found.push(`${el.className}: ${why.join(", ")}`);
    }
    return found;
  });
}
