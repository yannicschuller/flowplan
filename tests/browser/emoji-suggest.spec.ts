import { test, expect, type Page } from "@playwright/test";

// Emoji suggestions after ":" (#388): ":rak" shows a row with 🚀 chosen,
// Enter inserts it; ←/→ move; Escape keeps the text; "12:30" and one letter
// open nothing; ":smile:" turns into 😄; the same in a text comment. On a
// phone the row scrolls sideways and a tap inserts.
const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
// Screenshots for the review, when asked for (EMOJI_SHOTS=<directory>).
const shots = process.env.EMOJI_SHOTS;

async function newDocument(page: Page, title: string) {
  await page.request.post("/api/auth/demo", { headers: { origin } });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const created = await page.request.post("/api/command", {
    headers: { origin },
    data: { action: "page.create", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, title: `${title} ${Date.now()}`, kind: "document" },
  });
  expect(created.ok(), await created.text()).toBe(true);
  await page.goto(`/#page=${(await created.json()).id}`);
  const editor = page.getByLabel("Dokumentinhalt", { exact: true });
  await editor.click();
  return editor;
}

test("“:rak” suggests 🚀, Enter inserts it; arrows move, Escape keeps the text, times and one letter open nothing", async ({ page }, info) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const editor = await newDocument(page, "Emoji");
  const row = page.getByRole("listbox", { name: "Emoji-Vorschläge" });
  const chosen = row.getByRole("option", { selected: true });

  await page.keyboard.type("Start :r");
  await page.waitForTimeout(300);
  await expect(row).toHaveCount(0);
  await page.keyboard.type("ak");
  await expect(row).toBeVisible({ timeout: 15000 });
  await expect(chosen).toHaveText("🚀");
  await expect(page.locator(".emoji-suggest-name")).toContainText("Rakete");
  expect(await row.getAttribute("aria-activedescendant")).toBe(await chosen.getAttribute("id"));
  if (shots) await page.screenshot({ path: `${shots}/emoji-suggest-${info.project.name}.png` });
  await page.keyboard.press("Enter");
  await expect(row).toHaveCount(0);
  await expect(editor.locator("p").first()).toHaveText("Start 🚀");

  // Typing narrows, ←/→ move along the row, Escape leaves ":smi" as text
  // and typing on does not open the row again.
  await page.keyboard.type(" :sm");
  await expect(row).toBeVisible();
  await page.keyboard.type("i");
  const options = row.getByRole("option");
  expect(await options.count()).toBeGreaterThan(2);
  const first = await options.nth(0).textContent();
  const second = await options.nth(1).textContent();
  await expect(chosen).toHaveText(first!);
  await page.keyboard.press("ArrowRight");
  await expect(chosen).toHaveText(second!);
  await page.keyboard.press("ArrowLeft");
  await expect(chosen).toHaveText(first!);
  await page.keyboard.press("ArrowLeft");
  await expect(chosen).toHaveText((await options.last().textContent())!);
  await page.keyboard.press("Escape");
  await expect(row).toHaveCount(0);
  await page.keyboard.type("l");
  await page.waitForTimeout(200);
  await expect(row).toHaveCount(0);
  await expect(editor.locator("p").first()).toHaveText("Start 🚀 :smil");

  // A time, one letter and a space after the colon open nothing.
  await page.keyboard.type(" um 12:30 und :x : ab");
  await page.waitForTimeout(200);
  await expect(row).toHaveCount(0);
  // A closing colon on a shortcode inserts the emoji right away.
  await page.keyboard.type(" :smile:");
  await expect(editor.locator("p").first()).toHaveText("Start 🚀 :smil um 12:30 und :x : ab 😄");
  await expect(row).toHaveCount(0);

  // The recently used 🚀 comes first for a query it matches.
  await page.keyboard.press("Enter");
  await page.keyboard.type(":ra");
  await expect(chosen).toHaveText("🚀");
  if (info.project.name === "mobile") {
    // The row scrolls sideways; a tap inserts.
    await page.keyboard.press("Backspace");
    await page.keyboard.press("Backspace");
    await page.keyboard.type("smi");
    await expect(options).toHaveCount(10);
    const scroll = await row.evaluate((el) => ({ width: el.scrollWidth, shown: el.clientWidth }));
    expect(scroll.width).toBeGreaterThan(scroll.shown);
    const box = await page.locator(".emoji-suggest").boundingBox();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(390);
    const third = (await options.nth(2).textContent())!;
    await options.nth(2).tap();
    await expect(row).toHaveCount(0);
    await expect(editor.locator("p").last()).toHaveText(third);
  } else {
    await page.keyboard.press("Tab");
    await expect(row).toHaveCount(0);
    await expect(editor.locator("p").last()).toHaveText("🚀");
  }
  expect(errors).toEqual([]);
});

test("in a text comment “:rak” and Enter insert 🚀", async ({ page }, info) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const editor = await newDocument(page, "Emoji comment");
  await page.keyboard.type("Alpha Bravo Charlie");
  await expect(editor).toContainText("Alpha Bravo Charlie");
  await editor.evaluate((el) => {
    const tiptap = (el as HTMLElement & { editor: { commands: { focus: () => void; setTextSelection: (r: { from: number; to: number }) => void } } }).editor;
    tiptap.commands.focus();
    tiptap.commands.setTextSelection({ from: 7, to: 12 });
  });
  const toggle = page.getByRole("button", { name: /^Textkommentare \(/ });
  if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
  await page.getByRole("button", { name: "Neuer Textkommentar", exact: true }).click();
  const field = page.getByLabel("Kommentar zur Textstelle", { exact: true });
  await expect(field).toBeFocused();
  await page.keyboard.type("Super :rak");
  const row = page.getByRole("listbox", { name: "Emoji-Vorschläge" });
  await expect(row).toBeVisible({ timeout: 15000 });
  await expect(row.getByRole("option", { selected: true })).toHaveText("🚀");
  if (shots) await page.screenshot({ path: `${shots}/emoji-suggest-comment-${info.project.name}.png` });
  await page.keyboard.press("Enter");
  await expect(row).toHaveCount(0);
  await expect(field).toHaveText("Super 🚀");
  await page.keyboard.type(" :tada:");
  await expect(field).toHaveText("Super 🚀 🎉");
  expect(errors).toEqual([]);
});

// Android's on-screen keyboards (#207): keydown "Unidentified", the text as
// text input – the word after the colon inside an IME composition. The row
// follows the text; a tap inserts, and the composition leaves nothing behind.
test("from an Android keyboard “:rak” shows the row, a tap inserts 🚀", async ({ page, context }, info) => {
  test.skip(info.project.name !== "mobile", "Android keyboards: the mobile project");
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const editor = await newDocument(page, "Emoji Android");
  const cdp = await context.newCDPSession(page);
  const key = (type: "rawKeyDown" | "keyUp") =>
    cdp.send("Input.dispatchKeyEvent", { type, key: "Unidentified", code: "", windowsVirtualKeyCode: 229, nativeVirtualKeyCode: 229 });
  for (const ch of "Los :") {
    await key("rawKeyDown");
    await cdp.send("Input.insertText", { text: ch });
    await key("keyUp");
  }
  for (const step of ["r", "ra", "rak"]) {
    await key("rawKeyDown");
    await cdp.send("Input.imeSetComposition", { text: step, selectionStart: step.length, selectionEnd: step.length });
    await key("keyUp");
    await page.waitForTimeout(30);
  }
  const row = page.getByRole("listbox", { name: "Emoji-Vorschläge" });
  await expect(row).toBeVisible({ timeout: 15000 });
  await expect(row.getByRole("option", { selected: true })).toHaveText("🚀");
  await row.getByRole("option", { selected: true }).tap();
  await expect(row).toHaveCount(0);
  await page.waitForTimeout(300);
  await expect(editor.locator("p").first()).toHaveText("Los 🚀");
  expect(errors).toEqual([]);
});
