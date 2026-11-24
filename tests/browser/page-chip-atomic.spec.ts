import { test, expect, type Page } from "@playwright/test";
import { DatabaseSync } from "node:sqlite";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { join } from "node:path";

// #466: a page link with its icon (the "/Seite" sub-page link, "@" pages)
// is one piece of the text – the steps of the issue: /page, rename the
// sub-page, arrows and Shift+arrows across the link, drag it to another
// paragraph, Backspace; hover preview and click still work. A pinned tab
// keeps its page: a click on a link and /page open a new tab beside it.
// Phones (no tabs) stay as before.
const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";

async function user(page: Page) {
  const db = new DatabaseSync(join(process.env.FLOWPLAN_DATA_DIR!, "flowplan.sqlite"));
  db.exec("PRAGMA busy_timeout=5000;");
  const uid = randomUUID(),
    token = randomBytes(32).toString("hex");
  db.prepare("INSERT INTO users(id,subject,name,email,onboarded_at) VALUES(?,?,?,?,?)").run(uid, `page-chip:${uid}`, "Charlie Chip", `${uid}@example.test`, Date.now());
  db.prepare("INSERT INTO sessions(token,user_id,groups_json,expires) VALUES(?,?,?,?)").run(createHash("sha256").update(token).digest("hex"), uid, "[]", Date.now() + 3_600_000);
  db.close();
  await page.context().addCookies([{ name: "flowplan_session", value: token, url: origin, httpOnly: true, sameSite: "Lax" }]);
  const command = async (data: Record<string, unknown>) => {
    const response = await page.request.post("/api/command", { headers: { origin }, data });
    expect(response.ok(), await response.text()).toBe(true);
    return response.json();
  };
  await command({ action: "workspace.create", name: "Chips" });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const create = async (title: string) =>
    (await command({ action: "page.create", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, title, kind: "document" })).id as string;
  return { host: await create("Gastgeber"), other: await create("Seite B") };
}
const hashPage = (page: Page) => new URL(page.url()).hash.match(/page=([0-9a-f-]{36})/)?.[1] ?? null;
const editorOf = (page: Page) => page.locator(".split-primary").getByLabel("Dokumentinhalt", { exact: true });
const mainTitle = (page: Page) => page.locator(".split-primary textarea.page-title");
const pageOf = async (page: Page, id: string) => (await (await page.request.get(`/api/pages/${id}`)).json()).page;

// "/seite" at the caret: the sub-page opens; its title becomes `title`.
async function subPage(page: Page, title: string) {
  const before = hashPage(page);
  await page.keyboard.type("/seite");
  await expect(page.locator(".slash-menu").getByRole("option", { selected: true })).toContainText("Neue Unterseite anlegen");
  await page.keyboard.press("Enter");
  await expect.poll(() => hashPage(page), { timeout: 30_000 }).not.toBe(before);
  const id = hashPage(page)!;
  const field = page.locator("textarea.page-title").first();
  await expect(field).toHaveValue("Ohne Titel", { timeout: 30_000 });
  await expect(field).toBeFocused();
  if (title) {
    await page.keyboard.type(title);
    await field.press("Tab");
    await expect.poll(async () => (await pageOf(page, id)).title, { timeout: 30_000 }).toBe(title);
  }
  return id;
}
// Where the DOM selection is, seen from the chip.
const selectionAround = (page: Page) =>
  page.evaluate(() => {
    const chip = document.querySelector(".split-primary a[data-page-link]")!;
    const s = getSelection()!;
    // The selected part of the text: the whole chip in it, its ends outside.
    const selected = s.rangeCount ? s.getRangeAt(0).cloneContents() : null;
    return { text: selected?.querySelector("a[data-page-link]")?.textContent ?? "", inChip: chip.contains(s.anchorNode) || chip.contains(s.focusNode), collapsed: s.isCollapsed };
  });

test("a sub-page link is one piece: arrows, Shift+arrows, drag, Backspace, hover, click", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "Keyboard and mouse; phones are tested below.");
  test.skip(!process.env.FLOWPLAN_DATA_DIR, "Needs the test server data directory.");
  test.setTimeout(180_000);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const { host } = await user(page);
  await page.goto(`/#page=${host}`);
  await expect(mainTitle(page)).toHaveValue("Gastgeber", { timeout: 30_000 });
  const editor = editorOf(page);

  // 1–3: /page, rename the sub-page, back to the page.
  await editor.click();
  await page.keyboard.type("Ziel");
  await page.keyboard.press("Enter");
  await page.keyboard.type("Vorher ");
  const sub = await subPage(page, "Kapitel 1");
  await page.goBack();
  await expect(mainTitle(page)).toHaveValue("Gastgeber", { timeout: 30_000 });
  const chip = editor.locator(`a[data-page-link][href="/#page=${sub}"]`);
  await expect(chip).toHaveText("Kapitel 1", { timeout: 30_000 });
  await expect(chip).toHaveAttribute("contenteditable", "false");
  await expect(chip).toHaveAttribute("draggable", "true");
  const second = editor.locator("p").nth(1);
  await second.click();
  await page.keyboard.press("End");
  await page.keyboard.type(" danach");
  await expect(second).toHaveText("Vorher Kapitel 1 danach");

  // 4: arrows pass the link in one press each way; typing lands beside it.
  for (const _ of " danach") await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.type("X");
  await expect(second).toHaveText("Vorher XKapitel 1 danach");
  await expect(chip).toHaveText("Kapitel 1");
  await page.keyboard.press("Backspace");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.type("Y");
  await expect(second).toHaveText("Vorher Kapitel 1Y danach");
  await page.keyboard.press("Backspace");
  // Shift+arrows select the whole link, never a part of its title.
  await page.keyboard.press("Shift+ArrowLeft");
  let around = await selectionAround(page);
  expect(around.text).toBe("Kapitel 1");
  expect(around.inChip).toBe(false);
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("Shift+ArrowRight");
  around = await selectionAround(page);
  expect(around.text).toBe("Kapitel 1");
  expect(around.inChip).toBe(false);
  // Typing over the selection replaces the link as a whole (after the
  // undo manager's grouping time, so that undo takes back only this).
  await page.waitForTimeout(1000);
  await page.keyboard.type("Z");
  await expect(second).toHaveText("Vorher Z danach");
  await expect(chip).toHaveCount(0);
  await page.keyboard.press("ControlOrMeta+z");
  await expect(chip).toHaveCount(1);
  await expect(second).toHaveText("Vorher Kapitel 1 danach");

  // 5: dragging moves the whole link to the end of the first paragraph.
  const first = editor.locator("p").nth(0);
  const target = await first.evaluate((p) => {
    const range = document.createRange();
    range.selectNodeContents(p.firstChild!);
    const r = range.getBoundingClientRect();
    return { x: r.right + 2, y: r.top + r.height / 2 };
  });
  const box = (await chip.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 10, box.y + box.height / 2, { steps: 3 });
  await page.mouse.move(target.x, target.y, { steps: 12 });
  await page.mouse.up();
  await expect(first.locator("a[data-page-link]")).toHaveText("Kapitel 1");
  await expect(second.locator("a[data-page-link]")).toHaveCount(0);
  await expect(chip).toHaveCount(1);
  await expect(first).toHaveText("ZielKapitel 1");
  expect((await second.textContent())!.replace(/\s+/g, " ").trim()).toBe("Vorher danach");

  // Hover: the preview of the sub-page; a click opens it.
  await chip.hover();
  await expect(page.locator(".link-preview")).toContainText("Kapitel 1", { timeout: 15_000 });
  await chip.click();
  await expect.poll(() => hashPage(page), { timeout: 30_000 }).toBe(sub);
  await page.goBack();
  await expect(mainTitle(page)).toHaveValue("Gastgeber", { timeout: 30_000 });

  // Stored as the link it always was, marked as a chip.
  await expect
    .poll(async () => (await (await page.request.get(`/api/pages/${host}`)).json()).html as string, { timeout: 30_000 })
    .toMatch(new RegExp(`href="/#page=${sub}" data-page-link`));
  // Backspace right after the link deletes it whole; "Ziel" stays.
  await expect(chip).toHaveCount(1, { timeout: 30_000 });
  await first.click();
  await page.keyboard.press("End");
  await page.keyboard.press("Backspace");
  await expect(chip).toHaveCount(0);
  await expect(first).toHaveText("Ziel");
  expect(errors).toEqual([]);
});

test("pinned tab: a click on a page link and /page open a new tab beside it", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "Tabs are for tablets and computers.");
  test.skip(!process.env.FLOWPLAN_DATA_DIR, "Needs the test server data directory.");
  test.setTimeout(180_000);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const { host, other } = await user(page);
  await page.goto(`/#page=${host}`);
  await expect(mainTitle(page)).toHaveValue("Gastgeber", { timeout: 30_000 });
  const editor = editorOf(page);
  await editor.click();
  const sub = await subPage(page, "Kapitel 1");
  await page.goBack();
  await expect(mainTitle(page)).toHaveValue("Gastgeber", { timeout: 30_000 });
  const chip = editor.locator(`a[data-page-link][href="/#page=${sub}"]`);
  await expect(chip).toHaveText("Kapitel 1", { timeout: 30_000 });

  // Two tabs, the host pinned.
  const bar = page.locator('.frame-tabs[data-tab-frame="0"]');
  const tabs = bar.getByRole("tab");
  const titles = tabs.locator(".frame-tab-title");
  await page.locator(`.page-nav[data-page-id="${other}"] .page-nav-title`).first().click({ modifiers: ["ControlOrMeta"] });
  await expect(titles).toHaveText(["Gastgeber", "Seite B"]);
  await tabs.nth(0).click();
  await expect(mainTitle(page)).toHaveValue("Gastgeber");
  await tabs.nth(0).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Anheften" }).click();
  await expect(tabs.nth(0)).toHaveClass(/pinned/);

  // A plain click on the link: a new tab right after the pinned one.
  await chip.click();
  await expect(titles).toHaveText(["Gastgeber", "Kapitel 1", "Seite B"], { timeout: 30_000 });
  await expect(tabs.nth(1)).toHaveAttribute("aria-selected", "true");
  expect(hashPage(page)).toBe(sub);
  await tabs.nth(0).click();
  await expect(mainTitle(page)).toHaveValue("Gastgeber", { timeout: 30_000 });

  // /page in the pinned tab: the new sub-page opens in a new tab.
  await editor.click();
  await page.keyboard.press("ControlOrMeta+End");
  const second = await subPage(page, "");
  await expect(titles).toHaveText(["Gastgeber", "Ohne Titel", "Kapitel 1", "Seite B"], { timeout: 30_000 });
  await expect(tabs.nth(1)).toHaveAttribute("aria-selected", "true");
  expect(hashPage(page)).toBe(second);
  await tabs.nth(0).click();
  await expect(mainTitle(page)).toHaveValue("Gastgeber", { timeout: 30_000 });
  await expect(editor.locator(`a[data-page-link][href="/#page=${second}"]`)).toHaveCount(1, { timeout: 30_000 });

  // The page tree from the pinned tab: a new tab as well.
  await page.locator(`.page-nav[data-page-id="${other}"] .page-nav-title`).first().click();
  await expect(tabs).toHaveCount(5);
  await expect(tabs.nth(0)).toHaveClass(/pinned/);
  await expect(mainTitle(page)).toHaveValue("Seite B", { timeout: 30_000 });
  await tabs.nth(0).click();
  await expect(mainTitle(page)).toHaveValue("Gastgeber", { timeout: 30_000 });
  expect(errors).toEqual([]);
});

test("phone: /page and a click on the link go to the page as before, no tabs", async ({ page }, info) => {
  test.skip(info.project.name !== "mobile", "Phones only.");
  test.skip(!process.env.FLOWPLAN_DATA_DIR, "Needs the test server data directory.");
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const { host } = await user(page);
  await page.goto(`/#page=${host}`);
  const title = page.locator("textarea.page-title").first();
  await expect(title).toHaveValue("Gastgeber", { timeout: 30_000 });
  const editor = page.getByLabel("Dokumentinhalt", { exact: true }).first();
  await editor.click();
  const sub = await subPage(page, "Kapitel 1");
  await page.goBack();
  await expect(title).toHaveValue("Gastgeber", { timeout: 30_000 });
  const chip = editor.locator(`a[data-page-link][href="/#page=${sub}"]`);
  await expect(chip).toHaveText("Kapitel 1", { timeout: 30_000 });
  await chip.tap();
  await expect.poll(() => hashPage(page), { timeout: 30_000 }).toBe(sub);
  await expect(page.locator(".frame-tabs")).toHaveCount(0);
  expect(errors).toEqual([]);
});
