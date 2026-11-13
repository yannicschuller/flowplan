import { test, expect, type Page } from "@playwright/test";

// A new block between existing ones (#261): the "+" beside the handle of
// every kind of block (tables, images, formulas, columns) adds an empty
// paragraph below it (⌥: above) with the "/" menu; a click into the gap
// between two blocks without text – also where they touch – starts a
// paragraph there; ↓ from a selected image reaches the gap, typing or ↵
// there starts a paragraph; ↵ on a selected image adds one after it; the
// toolbar's "+" adds below the current block instead of turning it into
// another (an empty paragraph it fills); the block menu offers "Block
// darunter einfügen", also on touch screens, which have no "+".
const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
async function command(page: Page, data: Record<string, unknown>) {
  const response = await page.request.post("/api/command", { headers: { origin }, data });
  expect(response.ok(), await response.text()).toBe(true);
  return response.json();
}
// A page with the HTML; {IMG} is replaced by an uploaded picture.
async function fixture(page: Page, title: string, html: string) {
  await page.request.post("/api/auth/demo", { headers: { origin } });
  await command(page, { action: "profile.onboarded" });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const host = await command(page, { action: "page.create", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, kind: "document", title });
  if (html.includes("{IMG}")) {
    await page.goto("about:blank");
    const b64 = await page.evaluate(() => {
      const c = document.createElement("canvas");
      c.width = 480;
      c.height = 200;
      const ctx = c.getContext("2d")!;
      ctx.fillStyle = "#3b3fd8";
      ctx.fillRect(0, 0, 480, 200);
      return c.toDataURL("image/png").split(",")[1];
    });
    const upload = await page.request.post("/api/upload", { headers: { origin }, multipart: { pageId: host.id, file: { name: "bild.png", mimeType: "image/png", buffer: Buffer.from(b64, "base64") } } });
    expect(upload.ok(), await upload.text()).toBe(true);
    html = html.replaceAll("{IMG}", (await upload.json()).url);
  }
  const read = async () => (await page.request.get(`/api/pages/${host.id}`)).json();
  const { htmlState } = await import("../../lib/document-server");
  await command(page, { action: "document.sync", pageId: host.id, generation: (await read()).generation, update: Buffer.from(htmlState(html)).toString("base64") });
  return host;
}
// A page that starts with a table can come up with an empty paragraph above
// it (the first sync of a new page); the tests below want the table first.
const dropLeadingEmpty = (page: Page) =>
  page.evaluate(() => {
    const editor = (document.querySelector(".ProseMirror") as unknown as { editor: { state: { doc: { firstChild: { type: { name: string }; childCount: number } } }; view: { dispatch: (tr: unknown) => void; state: { tr: { delete: (a: number, b: number) => unknown } } } } }).editor;
    const first = editor.state.doc.firstChild;
    if (first.type.name === "paragraph" && first.childCount === 0) editor.view.dispatch(editor.view.state.tr.delete(0, 2));
  });
// The gap cursor: a line drawn by its ::after (the element has no size).
const gapCursorShown = (page: Page) =>
  page.evaluate(() => {
    const gap = document.querySelector(".ProseMirror .ProseMirror-gapcursor");
    return !!gap && getComputedStyle(gap).display !== "none" && getComputedStyle(gap, "::after").borderTopWidth !== "0px";
  });
const TABLE = "<table><tbody><tr><th><p>Kopf</p></th><th><p>Spalte</p></th></tr><tr><td><p>1</p></td><td><p>2</p></td></tr></tbody></table>";
// The top-level blocks, by kind (and text for paragraphs and headings).
const outline = (page: Page) =>
  page.getByLabel("Dokumentinhalt", { exact: true }).evaluate((editor) =>
    [...editor.children]
      .filter((el) => !el.classList.contains("ProseMirror-widget") && !el.classList.contains("ProseMirror-gapcursor"))
      .map((el) => {
        if (el.classList.contains("tableWrapper")) return "table";
        if (el.tagName === "DIV" && el.querySelector("img")) return "image";
        if (el.classList.contains("math-block")) return "math";
        if (el.classList.contains("editor-columns")) return "columns";
        return `${el.tagName.toLowerCase()}:${el.textContent}`;
      })
      // Empty paragraphs: the one at the end of every page, and one a new
      // page can come up with at its start.
      .filter((entry) => entry !== "p:"),
  );

test("“+” beside tables, images, formulas and columns; ↵ on a selected image (#261)", async ({ page }, info) => {
  test.setTimeout(120_000);
  test.skip(info.project.name !== "desktop", "Mouse only: touch screens have no “+” (see below).");
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const host = await fixture(
    page,
    `Dazwischen ${Date.now()}`,
    `<p>Start</p>${TABLE}<img src="{IMG}" alt="Bild"><div data-math="x^2"></div><div data-columns><div data-column><p>Links</p></div><div data-column><p>Rechts</p></div></div><p>Ende</p>`,
  );
  await page.goto(`/#page=${host.id}`);
  const editor = page.getByLabel("Dokumentinhalt", { exact: true });
  await expect(editor.getByText("Ende")).toBeVisible({ timeout: 20_000 });
  await expect(editor.locator("img")).toBeVisible();
  const slash = page.locator(".slash-menu");
  // "+" of a block, then a text instead of the "/".
  const add = async (hover: () => Promise<void>, name: RegExp, text: string, above = false) => {
    await hover();
    const plus = page.getByRole("button", { name });
    await expect(plus).toBeVisible();
    if (above) await page.keyboard.down("Alt");
    await plus.click();
    if (above) await page.keyboard.up("Alt");
    await expect(slash).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(slash).toHaveCount(0);
    await page.keyboard.press("Backspace");
    await page.keyboard.type(text);
  };
  const hoverAt = (locator: ReturnType<Page["locator"]>, dx = 40) => async () => {
    const box = (await locator.boundingBox())!;
    await page.mouse.move(box.x + dx, box.y + Math.min(box.height / 2, 20));
  };

  await add(hoverAt(editor.locator(".tableWrapper")), /^Block darunter einfügen: Tabelle/, "Unter der Tabelle");
  await add(hoverAt(editor.locator("img")), /^Block darunter einfügen: Bild/, "Unter dem Bild");
  await add(hoverAt(editor.locator(".math-block")), /^Block darunter einfügen: Formel/, "Über der Formel", true);
  // Columns: in the page margin left of them their own "+" – a block below
  // the whole layout, not inside a column.
  const columns = (await editor.locator(".editor-columns").boundingBox())!;
  await add(
    async () => page.mouse.move(columns.x - 100, columns.y + 14),
    /^Block darunter einfügen: Spalten/,
    "Unter den Spalten",
  );
  await expect.poll(() => outline(page)).toEqual([
    "p:Start",
    "table",
    "p:Unter der Tabelle",
    "image",
    "p:Unter dem Bild",
    "p:Über der Formel",
    "math",
    "columns",
    "p:Unter den Spalten",
    "p:Ende",
  ]);
  // Inside a column the block keeps its handle, right beside its text.
  await editor.getByText("Links").hover();
  await expect(page.getByRole("button", { name: "Blockaktionen: Absatz · Links", exact: true })).toHaveClass(/hovered/);

  // ↵ on a selected image: a paragraph after it, the caret in it.
  await editor.locator("img").click();
  await page.keyboard.press("Enter");
  await page.keyboard.type("Nach dem Bild");
  await expect.poll(() => outline(page)).toEqual([
    "p:Start",
    "table",
    "p:Unter der Tabelle",
    "image",
    "p:Nach dem Bild",
    "p:Unter dem Bild",
    "p:Über der Formel",
    "math",
    "columns",
    "p:Unter den Spalten",
    "p:Ende",
  ]);
  expect(errors).toEqual([]);
});

test("a click between a table and an image, ↓ to the gap and typing, ↵ at the gap (#261)", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "Mouse and keyboard; a tap works the same way.");
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const host = await fixture(page, `Lücke ${Date.now()}`, `${TABLE}<img src="{IMG}" alt="Bild"><div data-math="x^2"></div><p>Ende</p>`);
  await page.goto(`/#page=${host.id}`);
  const editor = page.getByLabel("Dokumentinhalt", { exact: true });
  await expect(editor.getByText("Ende")).toBeVisible({ timeout: 20_000 });
  await expect(editor.locator("img")).toBeVisible();
  await page.waitForTimeout(500);
  await dropLeadingEmpty(page);
  await expect.poll(() => outline(page)).toEqual(["table", "image", "math", "p:Ende"]);

  // Table and image touch: a click at their edge starts a paragraph.
  const table = (await editor.locator(".tableWrapper").boundingBox())!;
  await page.mouse.click(table.x + table.width / 2, table.y + table.height - 1);
  await page.keyboard.type("Zwischen Tabelle und Bild");
  await expect.poll(() => outline(page)).toEqual(["table", "p:Zwischen Tabelle und Bild", "image", "math", "p:Ende"]);

  // ↓ from the selected image: the gap before the formula; typing starts
  // a paragraph there.
  await editor.locator("img").click();
  await page.keyboard.press("ArrowDown");
  await expect.poll(() => gapCursorShown(page)).toBe(true);
  await page.keyboard.type("Getippt");
  await expect.poll(() => outline(page)).toEqual(["table", "p:Zwischen Tabelle und Bild", "image", "p:Getippt", "math", "p:Ende"]);

  // ↵ at the gap above the table (the first block): a paragraph there.
  await editor.getByText("Kopf").click();
  await page.keyboard.press("Home");
  // (A second ↑ at the very top stays there.)
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("ArrowUp");
  await expect.poll(() => gapCursorShown(page)).toBe(true);
  await page.keyboard.press("Enter");
  await page.keyboard.type("Ganz oben");
  await expect.poll(() => outline(page)).toEqual(["p:Ganz oben", "table", "p:Zwischen Tabelle und Bild", "image", "p:Getippt", "math", "p:Ende"]);
  // A click inside the table's text still puts the caret there.
  await editor.getByText("Spalte").click();
  await page.keyboard.type("!");
  await expect(editor.getByText("Spalte!")).toBeVisible();
  expect(errors).toEqual([]);
});

test("the toolbar's “+” adds a block below; an empty paragraph it fills (#261)", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "The fixed toolbar with a mouse.");
  const host = await fixture(page, `Leiste ${Date.now()}`, "<p>Erster Absatz</p><p>Zweiter Absatz</p>");
  await page.goto(`/#page=${host.id}`);
  const editor = page.getByLabel("Dokumentinhalt", { exact: true });
  await expect(editor.getByText("Zweiter Absatz")).toBeVisible({ timeout: 20_000 });
  const plus = page.getByRole("toolbar", { name: "Textformatierung" }).getByRole("button", { name: "Block hinzufügen", exact: true });
  const option = (name: RegExp) => page.locator(".slash-menu").getByRole("option", { name }).first();

  await editor.getByText("Erster Absatz").click();
  await plus.click();
  await option(/^Überschrift 1/).click();
  await page.keyboard.type("Neue Überschrift");
  // The paragraph stays a paragraph; the heading is below it.
  await expect.poll(() => outline(page)).toEqual(["p:Erster Absatz", "h1:Neue Überschrift", "p:Zweiter Absatz"]);

  // In an empty paragraph: that one becomes the block.
  await editor.getByText("Zweiter Absatz").click();
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  await plus.click();
  await option(/^Zitat/).click();
  await page.keyboard.type("Zitiert");
  await expect.poll(() => outline(page)).toEqual(["p:Erster Absatz", "h1:Neue Überschrift", "p:Zweiter Absatz", "blockquote:Zitiert"]);
});

test("touch: the block menu adds a block below an image (#261)", async ({ page }, info) => {
  test.skip(info.project.name !== "mobile", "Touch only: no “+” beside the handle there.");
  const host = await fixture(page, `Dazwischen touch ${Date.now()}`, `<p>Start</p><img src="{IMG}" alt="Bild">${TABLE}<p>Ende</p>`);
  await page.goto(`/#page=${host.id}`);
  const editor = page.getByLabel("Dokumentinhalt", { exact: true });
  await expect(editor.getByText("Ende")).toBeVisible({ timeout: 20_000 });
  await expect(editor.locator("img")).toBeVisible();
  await editor.locator("img").tap();
  await page.getByRole("button", { name: /^Blockaktionen: Bild/ }).tap();
  await page.getByRole("menuitem", { name: "Block darunter einfügen", exact: true }).tap();
  await expect(page.locator(".slash-menu")).toBeVisible();
  await expect.poll(() => outline(page)).toEqual(["p:Start", "image", "p:/", "table", "p:Ende"]);
});
