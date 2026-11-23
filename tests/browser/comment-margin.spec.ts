import { test, expect, type Page, type Locator } from "@playwright/test";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

// Text comments in the margin (#387): on wide screens open text comments
// stand as cards beside their passage; a click on the highlight or the card
// opens the thread in place; a new comment's form opens there too; resolved
// threads leave the margin; the table of contents gives way. Narrow
// screens and the setting "below the document" keep the panel, where a
// click on a highlight brings the thread into view.
const LOAD = 30_000;
const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
const shots = "/tmp/claude-0/-home-user/f16eb679-8174-54bb-ad77-fd87de0398b3/scratchpad";
const filler = Array.from({ length: 14 }, (_, i) => `<p>Filler paragraph ${i + 1} with enough words to take a line of its own in the document.</p>`).join("");
const HTML =
  "<h2>Introduction</h2><p>Alpha Bravo Charlie Delta</p>" +
  filler +
  "<h2>Details</h2><p>Echo Foxtrot Golf Hotel</p>" +
  filler +
  "<h2>End</h2><p>India Juliett Kilo</p>";

async function fixture(page: Page) {
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
  const area = await command({ action: "space.create", workspaceId: boot.workspace.id, name: `Margin ${randomUUID()}`, private: false });
  const doc = await command({ action: "page.create", workspaceId: boot.workspace.id, spaceId: area.id, title: "Margin review" });
  const database = await command({ action: "page.create", workspaceId: boot.workspace.id, spaceId: area.id, title: "Margin records", kind: "database" });
  const row = await command({ action: "row.create", pageId: database.id, cells: { title: "Margin entry" } });
  await page.request.get(`/api/pages/${database.id}/rows/${row.id}`);
  // Imported here, not at the top: see playwright.config.ts.
  const { htmlState } = await import("../../lib/document-server");
  const db = new DatabaseSync(join(process.env.FLOWPLAN_DATA_DIR, "flowplan.sqlite"));
  db.exec("PRAGMA busy_timeout=5000;");
  const state = htmlState(HTML);
  db.prepare("UPDATE documents SET state=?,html=? WHERE page_id=?").run(state, HTML, doc.id);
  db.prepare("UPDATE row_documents SET state=?,html=? WHERE row_id=?").run(state, HTML, row.id);
  db.close();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  return { boot, doc, database, row, command, errors };
}

async function open(page: Page, hash: string) {
  await page.goto("about:blank");
  await page.goto(`${origin}/${hash}`);
  await expect(page.locator(".tiptap.document-editor")).toContainText("Alpha Bravo", { timeout: LOAD });
}

// Selects `word` in the document (the first time it occurs).
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
  await expect(page.locator(".tiptap.document-editor")).toBeFocused();
}

// A new comment with ⌘⌥M / Ctrl+Alt+M: the form opens in the margin.
async function comment(page: Page, word: string, text: string) {
  await selectWord(page, word);
  await page.keyboard.press("ControlOrMeta+Alt+m");
  const form = page.locator(".comment-margin .inline-comment-new");
  await expect(form).toBeVisible();
  const input = form.getByRole("textbox", { name: "Kommentar zur Textstelle" });
  await expect(input).toBeFocused();
  await input.fill(text);
  await form.getByRole("button", { name: "Kommentar senden", exact: true }).click();
  await expect(page.locator(".comment-margin-card.active .inline-comment-message")).toContainText(text, { timeout: LOAD });
}

const mark = (page: Page, word: string) => page.locator(".tiptap .inline-comment-mark", { hasText: word }).first();
const card = (page: Page, text: string) => page.locator(".comment-margin-card", { hasText: text });
const top = async (locator: Locator) => (await locator.boundingBox())!.y;

test.describe("text comments in the margin (#387)", () => {
  test.beforeEach(({}, info) => test.skip(info.project.name !== "desktop", "Wide screens: the desktop project."));

  test("wide: cards beside passages, open in place, composer in the margin, resolve, outline gives way", async ({ page }) => {
    const f = await fixture(page);
    await page.addInitScript(() => {
      try {
        localStorage.setItem("flowplan.outline", "1");
      } catch {}
    });
    await open(page, `#page=${f.doc.id}`);
    // No comments yet: the table of contents beside the text, no margin.
    await expect(page.locator(".document-outline:not(.outline-popover)")).toBeVisible();
    await expect(page.locator(".comment-margin")).toHaveCount(0);

    await comment(page, "Bravo", "First note on Bravo");
    // The margin takes the room: the table of contents gives way to its button.
    await expect(page.locator(".document-outline")).toHaveCount(0);
    await expect(page.locator(".outline-toggle[aria-expanded='false']")).toBeVisible();
    await expect(page.locator(".inline-comment-panel")).toHaveCount(0);
    await comment(page, "Foxtrot", "Second note on Foxtrot");
    await comment(page, "Charlie", "Third note on Charlie, the same line as Bravo");
    // A click in the text closes the open card.
    await page.locator(".tiptap p", { hasText: "Filler paragraph 3" }).first().click();
    await expect(page.locator(".comment-margin-card.active")).toHaveCount(0);
    await expect(page.locator(".comment-margin-card")).toHaveCount(3);

    // Each card beside its passage, right of the text.
    const text = (await page.locator(".tiptap.document-editor").boundingBox())!;
    for (const c of await page.locator(".comment-margin-card").all()) expect((await c.boundingBox())!.x).toBeGreaterThan(text.x + text.width);
    expect(Math.abs((await top(card(page, "First note"))) - (await top(mark(page, "Bravo"))))).toBeLessThan(6);
    expect(Math.abs((await top(card(page, "Second note"))) - (await top(mark(page, "Foxtrot"))))).toBeLessThan(6);
    // Bravo and Charlie share a line: Charlie's card stacks below Bravo's.
    const first = (await card(page, "First note").boundingBox())!;
    expect(await top(card(page, "Third note"))).toBeGreaterThanOrEqual(first.y + first.height + 4);
    await expect(card(page, "First note").locator(".comment-margin-text")).toHaveText("First note on Bravo");
    await expect(card(page, "First note").locator(".comment-margin-author")).toContainText(f.boot.user.name);

    // A click on a highlight opens its card in place – no jump to the end.
    const before = await page.evaluate(() => document.querySelector(".tiptap")!.getBoundingClientRect().top);
    await mark(page, "Foxtrot").click();
    const active = page.locator(".comment-margin-card.active");
    await expect(active).toContainText("Second note on Foxtrot");
    await expect(active.getByRole("textbox", { name: "Antwort", exact: true })).toBeVisible();
    await expect(page.locator(".tiptap .inline-comment-active")).toHaveText("Foxtrot");
    expect(Math.abs((await top(active)) - (await top(mark(page, "Foxtrot"))))).toBeLessThan(6);
    expect(Math.abs((await page.evaluate(() => document.querySelector(".tiptap")!.getBoundingClientRect().top)) - before)).toBeLessThan(40);
    await expect(page.locator(".inline-comment-panel")).toHaveCount(0);
    // Reply in the card; collapsed it shows the number of replies.
    await active.getByRole("textbox", { name: "Antwort", exact: true }).click();
    await page.keyboard.type("A reply in the margin");
    await active.getByRole("button", { name: "Antwort senden", exact: true }).click();
    await expect(active.locator(".inline-comment-message")).toHaveCount(2);
    await page.screenshot({ path: `${shots}/margin-wide-light.png` });
    await page.emulateMedia({ colorScheme: "dark" });
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await page.screenshot({ path: `${shots}/margin-wide-dark.png` });
    await page.emulateMedia({ colorScheme: "light" });
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
    await active.getByRole("textbox", { name: "Antwort", exact: true }).click();
    await page.keyboard.press("Escape");
    await expect(page.locator(".comment-margin-card.active")).toHaveCount(0);
    await expect(card(page, "Second note")).toContainText("1 Antwort");
    // The card itself opens it as well.
    await card(page, "First note").getByRole("button").click();
    await expect(page.locator(".comment-margin-card.active")).toContainText("First note on Bravo");
    await expect(page.locator(".tiptap .inline-comment-active")).toHaveText("Bravo");
    // The open card stands at its passage; Charlie's card moves out of its way.
    await expect(page.locator(".comment-margin-card.active .inline-comment-message")).toHaveCount(1);
    await expect
      .poll(async () => {
        const opened = (await page.locator(".comment-margin-card.active").boundingBox())!;
        return (await top(card(page, "Third note"))) - (opened.y + opened.height);
      })
      .toBeGreaterThanOrEqual(4);
    await expect.poll(async () => Math.abs((await top(page.locator(".comment-margin-card.active"))) - (await top(mark(page, "Bravo"))))).toBeLessThan(6);
    // Resolved: the card leaves the margin, the highlight goes.
    await page.locator(".comment-margin-card.active").getByRole("button", { name: "Thread erledigen", exact: true }).click();
    await expect(page.locator(".comment-margin-card")).toHaveCount(2);
    await expect(card(page, "First note")).toHaveCount(0);
    await expect(mark(page, "Bravo")).toHaveCount(0);
    // The panel below the document stays the overview, with its filter.
    await page.getByRole("button", { name: /^Textkommentare \(/ }).click();
    await page.locator(".inline-comment-panel select").selectOption("resolved");
    await expect(page.locator(".inline-thread-link")).toHaveCount(1);
    await page.locator(".inline-comment-panel select").selectOption("open");
    await expect(page.locator(".inline-thread-link")).toHaveCount(2);
    expect(f.errors).toEqual([]);
  });

  test("narrow: a popover at the passage (#450); with the setting off: the panel, and a clicked highlight brings its thread into view", async ({ page }) => {
    const f = await fixture(page);
    await open(page, `#page=${f.doc.id}`);
    await comment(page, "Bravo", "Note for the narrow view");
    await page.screenshot({ path: `${shots}/margin-composer.png` });
    // Narrow (the window too small for the margin): the thread opens as a
    // popover at its passage, not in the panel below the document.
    await page.setViewportSize({ width: 1000, height: 900 });
    await expect(page.locator(".comment-margin")).toHaveCount(0);
    await page.reload();
    await expect(page.locator(".tiptap.document-editor")).toContainText("Alpha Bravo", { timeout: LOAD });
    await expect(mark(page, "Bravo")).toBeVisible({ timeout: LOAD });
    await expect(page.locator(".comment-margin")).toHaveCount(0);
    await mark(page, "Bravo").click();
    const popover = page.locator(".comment-popover");
    await expect(popover.locator(".inline-comment-message")).toContainText("Note for the narrow view");
    await expect(page.locator(".inline-comment-panel")).toHaveCount(0);
    const near = (await mark(page, "Bravo").boundingBox())!;
    expect(Math.abs((await popover.boundingBox())!.y - near.y)).toBeLessThan(near.height + 40);
    const panel = page.locator(".inline-comment-panel");
    await page.screenshot({ path: `${shots}/margin-narrow-light.png` });
    await page.emulateMedia({ colorScheme: "dark" });
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await page.screenshot({ path: `${shots}/margin-narrow-dark.png` });
    await page.emulateMedia({ colorScheme: "light" });
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");

    // Wide again, the setting "below the document": the panel as well.
    await f.command({ action: "profile.commentMargin", commentMargin: false });
    await page.setViewportSize({ width: 1440, height: 1000 });
    await open(page, `#page=${f.doc.id}`);
    await expect(mark(page, "Bravo")).toBeVisible({ timeout: LOAD });
    await expect(page.locator(".comment-margin")).toHaveCount(0);
    await mark(page, "Bravo").click();
    await expect(panel.locator(".inline-comment-message")).toContainText("Note for the narrow view");
    await expect.poll(async () => (await panel.boundingBox())!.y).toBeLessThan(1000 - 100);
    // In the settings: Appearance › "Textkommentare".
    await page.goto(`${origin}/#settings/appearance`);
    const group = page.getByRole("radiogroup", { name: "Textkommentare" });
    await expect(group).toBeVisible({ timeout: LOAD });
    await expect(group.getByLabel("Unter dem Dokument")).toBeChecked();
    await group.getByText("Am Rand").click();
    await expect.poll(async () => (await (await page.request.get("/api/bootstrap")).json()).commentMargin).toBe(true);
    expect(f.errors).toEqual([]);
  });

  test("a record as a page has the margin too", async ({ page }) => {
    const f = await fixture(page);
    await open(page, `#page=${f.database.id}&row=${f.row.id}&full=1`);
    await expect(page.locator(".record-page")).toBeVisible();
    await comment(page, "Juliett", "A note on the record");
    await page.locator(".tiptap p", { hasText: "Filler paragraph 2" }).first().click();
    const c = card(page, "A note on the record");
    await expect(c).toBeVisible();
    expect(Math.abs((await top(c)) - (await top(mark(page, "Juliett"))))).toBeLessThan(6);
    const text = (await page.locator(".tiptap.document-editor").boundingBox())!;
    expect((await c.boundingBox())!.x).toBeGreaterThan(text.x + text.width);
    await mark(page, "Juliett").click();
    await expect(page.locator(".comment-margin-card.active")).toContainText("A note on the record");
    await page.screenshot({ path: `${shots}/margin-record.png` });
    expect(f.errors).toEqual([]);
  });
});
