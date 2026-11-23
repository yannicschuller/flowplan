import { test, expect, type Page, type Browser } from "@playwright/test";
import { DatabaseSync } from "node:sqlite";
import { randomUUID, randomBytes, createHash } from "node:crypto";
import { join } from "node:path";

// Comments beside their passage everywhere (#450): without room for the
// margin, a clicked highlight or a new comment opens as a popover at the
// passage (a bottom sheet on phones); comments on media sit beside their
// block; every thread has a colour its author picks and a count after the
// passage; the comments panel on the right takes replies; hovering a
// highlight previews its thread.
const LOAD = 30_000;
const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
const shots = process.env.TEST_SHOTS || "test-results/comment-popover";
const filler = Array.from({ length: 6 }, (_, i) => `<p>Filler paragraph ${i + 1} with enough words to take a line of its own.</p>`).join("");
const HTML = (img: string) =>
  "<h2>Introduction</h2><p>Alpha Bravo Charlie Delta</p>" +
  filler +
  `<p>Echo Foxtrot Golf Hotel</p><img src="${img}" alt="Picture">` +
  filler +
  "<p>India Juliett Kilo</p>";

async function fixture(page: Page, browser: Browser) {
  if (!process.env.FLOWPLAN_DATA_DIR?.startsWith("/tmp/flowplan-inline-e2e."))
    throw new Error("Use isolated inline-comment data.");
  await page.request.post("/api/auth/demo", { headers: { origin } });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const command = async (data: Record<string, unknown>) => {
    const r = await page.request.post("/api/command", { headers: { origin }, data });
    expect(r.ok(), await r.text()).toBe(true);
    return r.json();
  };
  await command({ action: "profile.commentMargin", commentMargin: true });
  const area = await command({ action: "space.create", workspaceId: boot.workspace.id, name: `Popover ${randomUUID()}`, private: false });
  const doc = await command({ action: "page.create", workspaceId: boot.workspace.id, spaceId: area.id, title: "Popover review" });
  await page.goto("about:blank");
  const b64 = await page.evaluate(() => {
    const c = document.createElement("canvas");
    c.width = 360;
    c.height = 160;
    const ctx = c.getContext("2d")!;
    ctx.fillStyle = "#3b3fd8";
    ctx.fillRect(0, 0, 360, 160);
    return c.toDataURL("image/png").split(",")[1];
  });
  const upload = await page.request.post("/api/upload", { headers: { origin }, multipart: { pageId: doc.id, file: { name: "bild.png", mimeType: "image/png", buffer: Buffer.from(b64, "base64") } } });
  expect(upload.ok(), await upload.text()).toBe(true);
  const html = HTML((await upload.json()).url);
  // Imported here, not at the top: see playwright.config.ts.
  const { htmlState } = await import("../../lib/document-server");
  const db = new DatabaseSync(join(process.env.FLOWPLAN_DATA_DIR, "flowplan.sqlite"));
  db.exec("PRAGMA busy_timeout=5000;");
  db.prepare("UPDATE documents SET state=?,html=? WHERE page_id=?").run(htmlState(html), html, doc.id);
  // A second person: a reader of the workspace with a session of their own.
  const uid = randomUUID(),
    token = randomBytes(32).toString("hex");
  db.prepare("INSERT INTO users(id,subject,name,email,onboarded_at) VALUES(?,?,?,?,?)").run(uid, uid, "Second Reader", `${uid}@test.invalid`, Date.now());
  db.prepare("INSERT INTO members VALUES(?,?,?)").run(boot.workspace.id, uid, "viewer");
  db.prepare("INSERT INTO sessions(token,user_id,groups_json,expires) VALUES(?,?,?,?)").run(createHash("sha256").update(token).digest("hex"), uid, "[]", Date.now() + 3600000);
  db.close();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const second = async () => {
    const context = await browser.newContext({ viewport: page.viewportSize(), isMobile: test.info().project.name === "mobile", hasTouch: test.info().project.name === "mobile" });
    await context.addCookies([{ name: "flowplan_session", value: token, url: origin }]);
    const other = await context.newPage();
    other.on("pageerror", (e) => errors.push(e.message));
    return other;
  };
  return { boot, doc, command, errors, second };
}

async function open(page: Page, hash: string) {
  await page.goto("about:blank");
  await page.goto(`${origin}/${hash}`);
  if (test.info().project.name === "mobile") {
    const shade = page.locator(".nav-shade");
    if (await shade.isVisible()) await shade.click({ position: { x: 300, y: 600 } });
  }
  await expect(page.locator(".tiptap.document-editor")).toContainText("Alpha Bravo", { timeout: LOAD });
}

async function selectWord(page: Page, word: string) {
  await page.locator(".tiptap.document-editor").evaluate((el, word) => {
    const editor = (el as HTMLElement & { editor: any }).editor;
    let at = -1;
    editor.state.doc.descendants((node: any, pos: number) => {
      if (at >= 0 || !node.isText) return;
      const i = node.text.indexOf(word);
      if (i >= 0) at = pos + i;
    });
    editor.commands.focus();
    editor.commands.setTextSelection({ from: at, to: at + word.length });
  }, word);
}
async function selectImage(page: Page) {
  await page.locator(".tiptap.document-editor").evaluate((el) => {
    const editor = (el as HTMLElement & { editor: any }).editor;
    let at = -1;
    editor.state.doc.descendants((node: any, pos: number) => {
      if (at < 0 && /image/i.test(node.type.name)) at = pos;
    });
    editor.commands.focus();
    editor.commands.setNodeSelection(at);
  });
}

const mark = (page: Page, word: string) => page.locator(".tiptap .inline-comment-mark", { hasText: word }).first();
const popover = (page: Page) => page.locator(".comment-popover");
const afterContent = (page: Page, word: string) =>
  page.locator(".tiptap .inline-comment-count").first().evaluate((el) => getComputedStyle(el, "::after").content);

// A new comment with ⌘⌥M: its form opens at the passage (popover or margin).
async function comment(page: Page, word: string, text: string, where: string) {
  const form = page.locator(`${where} .inline-comment-new`);
  // Right after opening, the document may still be connecting ("Das
  // Dokument wird noch geladen."): again until the form is there.
  await expect(async () => {
    await selectWord(page, word);
    await page.keyboard.press("ControlOrMeta+Alt+m");
    await expect(form).toBeVisible({ timeout: 2000 });
  }).toPass({ timeout: LOAD });
  const input = form.getByRole("textbox", { name: "Kommentar zur Textstelle" });
  await expect(input).toBeFocused();
  await input.fill(text);
  return form;
}

test.describe("comments beside their passage (#450)", () => {
  test.describe.configure({ timeout: 150_000 });
  test("narrow window: popover beside the passage, colour, count, reply, Escape; a second person sees the colour", async ({ page, browser }, info) => {
    test.skip(info.project.name !== "desktop", "A narrow desktop window; phones have their own test.");
    const f = await fixture(page, browser);
    await page.setViewportSize({ width: 1000, height: 860 });
    await open(page, `#page=${f.doc.id}`);
    await expect(page.locator(".comment-margin")).toHaveCount(0);

    // A new comment: the form at the passage, not in the panel.
    const form = await comment(page, "Bravo", "Popover note on Bravo", ".comment-popover");
    await expect(page.locator(".inline-comment-panel")).toHaveCount(0);
    // The author picks green for the highlight before sending.
    await form.getByRole("button", { name: /^Farbe der Markierung/ }).click();
    await form.getByRole("radio", { name: "Grün" }).click();
    await expect(mark(page, "Bravo")).toHaveAttribute("data-comment-color", "green");
    await form.getByRole("button", { name: "Kommentar senden", exact: true }).click();
    // The thread goes on in the popover.
    await expect(popover(page).locator(".inline-comment-message")).toContainText("Popover note on Bravo", { timeout: LOAD });
    const box = (await popover(page).boundingBox())!,
      passage = (await mark(page, "Bravo").boundingBox())!;
    // Beside or below the passage, within the window, close to it.
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(1000);
    expect(box.y).toBeGreaterThanOrEqual(passage.y - 4);
    expect(box.y).toBeLessThan(passage.y + passage.height + 40);
    // The count: 1 comment, drawn after the passage by CSS.
    await expect(page.locator(".tiptap .inline-comment-count")).toHaveAttribute("data-comment-count", "1");
    expect(await afterContent(page, "Bravo")).toBe('"1"');
    expect(await page.locator(".tiptap").evaluate((el) => (el as HTMLElement).innerText.includes("Bravo1"))).toBe(false);

    // A reply in the popover; the count follows.
    const reply = popover(page).getByRole("textbox", { name: "Antwort", exact: true });
    await reply.click();
    await page.keyboard.type("A reply in the popover");
    await popover(page).getByRole("button", { name: "Antwort senden", exact: true }).click();
    await expect(popover(page).locator(".inline-comment-message")).toHaveCount(2);
    await expect(page.locator(".tiptap .inline-comment-count")).toHaveAttribute("data-comment-count", "2");
    await page.screenshot({ path: `${shots}/popover-narrow-light.png` });
    await page.emulateMedia({ colorScheme: "dark" });
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await page.screenshot({ path: `${shots}/popover-narrow-dark.png` });
    await page.emulateMedia({ colorScheme: "light" });
    // Escape closes it; a click on the highlight opens it again.
    await reply.click();
    await page.keyboard.press("Escape");
    await expect(popover(page)).toHaveCount(0);
    await mark(page, "Bravo").click();
    await expect(popover(page).locator(".inline-comment-message")).toHaveCount(2);
    await expect(page.locator(".inline-comment-panel")).toHaveCount(0);

    // A second person sees it green; the author changes it to blue …
    const other = await f.second();
    await open(other, `#page=${f.doc.id}`);
    await expect(mark(other, "Bravo")).toHaveAttribute("data-comment-color", "green", { timeout: LOAD });
    await popover(page).getByRole("button", { name: /^Farbe der Markierung/ }).click();
    await popover(page).getByRole("radio", { name: "Blau" }).click();
    await expect(mark(page, "Bravo")).toHaveAttribute("data-comment-color", "blue");
    // … and the other window follows without a reload.
    await expect(mark(other, "Bravo")).toHaveAttribute("data-comment-color", "blue", { timeout: 15_000 });
    // The reader may not recolour the author's thread: no colour choice.
    await mark(other, "Bravo").click();
    await expect(popover(other).locator(".inline-comment-message")).toHaveCount(2);
    await expect(popover(other).getByRole("button", { name: /^Farbe der Markierung/ })).toHaveCount(0);
    // A click into the text closes the popover.
    await page.locator(".tiptap h2", { hasText: "Introduction" }).click();
    await expect(popover(page)).toHaveCount(0);
    // The panel below the document stays the overview.
    await page.getByRole("button", { name: /^Textkommentare \(/ }).click();
    await expect(page.locator(".inline-thread-link")).toHaveCount(1);
    expect(f.errors).toEqual([]);
  });

  test("comments on media sit beside their block: margin on wide screens, popover in a narrow window", async ({ page, browser }, info) => {
    test.skip(info.project.name !== "desktop", "Window sizes of the desktop.");
    const f = await fixture(page, browser);
    await open(page, `#page=${f.doc.id}`);
    const image = page.locator(".tiptap img:not(.ProseMirror-separator)").first();
    await expect(image).toBeVisible({ timeout: LOAD });
    await selectImage(page);
    await page.keyboard.press("ControlOrMeta+Alt+m");
    const form = page.locator(".comment-margin .inline-comment-new");
    await expect(form).toBeVisible();
    await form.getByRole("textbox", { name: "Kommentar zur Textstelle" }).fill("About the picture");
    await form.getByRole("button", { name: "Kommentar senden", exact: true }).click();
    const card = page.locator(".comment-margin-card", { hasText: "About the picture" });
    await expect(card).toBeVisible({ timeout: LOAD });
    await expect(page.locator(".tiptap img.inline-comment-mark")).toBeVisible();
    // Beside the picture, at its height (once the card has its place).
    await expect
      .poll(async () => {
        const img = await image.boundingBox(),
          c = await card.boundingBox();
        return !!img && !!c && c.x > img.x + img.width - 1 && Math.abs(c.y - img.y) < 12;
      })
      .toBe(true);
    // The count at the block's corner.
    await expect(page.locator(".tiptap [data-resize-wrapper][data-comment-count='1']")).toBeVisible();
    await page.screenshot({ path: `${shots}/media-margin.png` });

    await page.setViewportSize({ width: 1000, height: 860 });
    await expect(page.locator(".comment-margin")).toHaveCount(0);
    await page.locator(".tiptap img.inline-comment-mark").click();
    await expect(popover(page)).toContainText("About the picture");
    const p = (await popover(page).boundingBox())!,
      now = (await image.boundingBox())!;
    // At the picture: beside it or right below it, not at the document's end.
    expect(p.y).toBeGreaterThanOrEqual(now.y - 4);
    expect(p.y).toBeLessThan(now.y + now.height + 40);
    await expect(page.locator(".inline-comment-panel")).toHaveCount(0);
    await page.screenshot({ path: `${shots}/media-popover.png` });
    expect(f.errors).toEqual([]);
  });

  test("hover preview: author, first comment, replies; click opens the thread; Escape closes", async ({ page, browser }, info) => {
    test.skip(info.project.name !== "desktop", "Hovering with a mouse: desktop.");
    const f = await fixture(page, browser);
    await open(page, `#page=${f.doc.id}`);
    const form = await comment(page, "Foxtrot", "A rather long first comment about Foxtrot that the preview shows at its beginning only, because a preview is meant to be small and quick to read.", ".comment-margin");
    await form.getByRole("button", { name: "Kommentar senden", exact: true }).click();
    const active = page.locator(".comment-margin-card.active");
    await active.getByRole("textbox", { name: "Antwort", exact: true }).click();
    await page.keyboard.type("First reply");
    await active.getByRole("button", { name: "Antwort senden", exact: true }).click();
    await expect(active.locator(".inline-comment-message")).toHaveCount(2);
    await page.locator(".tiptap p", { hasText: "Filler paragraph 1" }).first().click();
    await expect(active).toHaveCount(0);

    await mark(page, "Foxtrot").hover();
    const preview = page.locator(".comment-preview");
    await expect(preview).toBeVisible();
    await expect(preview).toContainText(f.boot.user.name);
    await expect(preview).toContainText("A rather long first comment");
    await expect(preview).toContainText("1 Antwort");
    await expect(preview.locator(".comment-preview-text")).toContainText("…");
    await expect(preview).not.toContainText("quick to read");
    await page.screenshot({ path: `${shots}/preview-light.png` });
    await page.emulateMedia({ colorScheme: "dark" });
    await page.screenshot({ path: `${shots}/preview-dark.png` });
    await page.emulateMedia({ colorScheme: "light" });
    // Moving on to the preview keeps it; Escape closes it.
    await preview.hover();
    await expect(preview).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(preview).toHaveCount(0);
    // Leaving closes it; coming back and clicking the preview opens the thread.
    await mark(page, "Foxtrot").hover();
    await expect(preview).toBeVisible();
    await page.mouse.move(5, 5);
    await expect(preview).toHaveCount(0);
    await mark(page, "Foxtrot").hover();
    await preview.click();
    await expect(page.locator(".comment-margin-card.active")).toContainText("First reply");
    await expect(preview).toHaveCount(0);
    expect(f.errors).toEqual([]);
  });

  test("reply to a text comment in the comments panel on the right", async ({ page, browser }, info) => {
    test.skip(info.project.name !== "desktop", "The side panel: desktop.");
    const f = await fixture(page, browser);
    await open(page, `#page=${f.doc.id}`);
    const form = await comment(page, "Juliett", "Note on Juliett", ".comment-margin");
    await form.getByRole("button", { name: "Kommentar senden", exact: true }).click();
    await expect(page.locator(".comment-margin-card.active")).toContainText("Note on Juliett", { timeout: LOAD });
    await page.getByTitle("Kommentare", { exact: true }).click();
    const panel = page.locator(".comments-panel");
    const text = panel.getByRole("group", { name: "Textkommentar zu „Juliett“" });
    await expect(text).toContainText("Note on Juliett");
    const field = text.getByRole("textbox", { name: "Antwort", exact: true });
    await field.click();
    await page.keyboard.type("Replied from the side panel");
    await text.getByRole("button", { name: "Antwort senden", exact: true }).click();
    await expect(text).toContainText("1 Antwort");
    await text.getByRole("button", { name: "1 Antwort zeigen" }).click();
    await expect(text.getByRole("list", { name: "Antworten" })).toContainText("Replied from the side panel");
    // The thread at the passage has it as well, and the count after it.
    await expect(page.locator(".tiptap .inline-comment-count")).toHaveAttribute("data-comment-count", "2", { timeout: 15_000 });
    await page.screenshot({ path: `${shots}/hub-reply.png` });
    expect(f.errors).toEqual([]);
  });

  test("phone: a highlight opens its thread as a bottom sheet, the passage stays in sight", async ({ page, browser }, info) => {
    test.skip(info.project.name !== "mobile", "Phones.");
    const f = await fixture(page, browser);
    await open(page, `#page=${f.doc.id}`);
    await selectWord(page, "India");
    await page.locator(".tiptap.document-editor").evaluate((el) => el.dispatchEvent(new CustomEvent("comment-create")));
    const form = page.locator(".comment-popover .inline-comment-new");
    await expect(form).toBeVisible();
    await expect(page.locator(".comment-popover")).toHaveClass(/comment-popover-sheet/);
    await form.getByRole("textbox", { name: "Kommentar zur Textstelle" }).fill("From the phone");
    await form.getByRole("button", { name: "Kommentar senden", exact: true }).click();
    const sheet = popover(page);
    await expect(sheet.locator(".inline-comment-message")).toContainText("From the phone", { timeout: LOAD });
    await page.keyboard.press("Escape");
    await expect(sheet).toHaveCount(0);
    await page.evaluate(() => window.scrollTo(0, 0));
    await mark(page, "India").tap();
    await expect(sheet).toBeVisible();
    await expect(sheet.locator(".inline-comment-message")).toContainText("From the phone");
    const viewport = page.viewportSize()!;
    // At the bottom edge, full width (once it has slid up).
    await expect.poll(async () => {
      const b = (await sheet.boundingBox())!;
      return Math.abs(b.y + b.height - viewport.height) < 4 && b.width > viewport.width - 4;
    }).toBe(true);
    const s = (await sheet.boundingBox())!;
    // The passage visible above the sheet.
    await expect.poll(async () => {
      const m = (await mark(page, "India").boundingBox())!;
      return m.y >= 0 && m.y + m.height <= s.y;
    }).toBe(true);
    await page.screenshot({ path: `${shots}/sheet-phone.png` });
    await sheet.getByRole("button", { name: "Kommentar schließen" }).click();
    await expect(sheet).toHaveCount(0);
    expect(f.errors).toEqual([]);
  });
});
