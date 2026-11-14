import { test, expect, type Page, type Locator } from "@playwright/test";
import { DatabaseSync } from "node:sqlite";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { join } from "node:path";

// Tabs and frames (#279, components/frame-tabs.tsx): ⌘/Ctrl-click opens new
// tabs, a tab is reordered by dragging and closed with ×, ⌘/Ctrl+Shift-click
// opens the other frame, a tab is dragged into it, a reload brings the
// layout back, back and forward go through each tab's own history – and
// phones stay one page at a time without a tab bar.
const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
const shots = process.env.TABS_SHOTS;

async function setup(page: Page) {
  const db = new DatabaseSync(join(process.env.FLOWPLAN_DATA_DIR!, "flowplan.sqlite"));
  db.exec("PRAGMA busy_timeout=5000;");
  const uid = randomUUID(),
    token = randomBytes(32).toString("hex");
  db.prepare("INSERT INTO users(id,subject,name,email,onboarded_at) VALUES(?,?,?,?,?)").run(uid, `frame-tabs:${uid}`, "Tilda Tab", `${uid}@example.test`, Date.now());
  db.prepare("INSERT INTO sessions(token,user_id,groups_json,expires) VALUES(?,?,?,?)").run(createHash("sha256").update(token).digest("hex"), uid, "[]", Date.now() + 3_600_000);
  db.close();
  await page.context().addCookies([{ name: "flowplan_session", value: token, url: origin, httpOnly: true, sameSite: "Lax" }]);
  const command = async (data: Record<string, unknown>) => {
    const response = await page.request.post("/api/command", { headers: { origin }, data });
    expect(response.ok(), await response.text()).toBe(true);
    return response.json();
  };
  await command({ action: "workspace.create", name: "Tabs" });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const create = async (title: string) =>
    (await command({ action: "page.create", workspaceId: boot.workspace.id, spaceId: boot.spaces[0].id, title, kind: "document" })).id as string;
  return { a: await create("Seite A"), b: await create("Seite B"), c: await create("Seite C"), d: await create("Seite D"), command };
}

const tree = (page: Page, id: string) => page.locator(`.page-nav[data-page-id="${id}"] .page-nav-title`).first();
const bar = (page: Page, frame: number) => page.locator(`.frame-tabs[data-tab-frame="${frame}"]`);
const tabsOf = (page: Page, frame: number) => bar(page, frame).getByRole("tab");
const titles = (page: Page, frame: number) => tabsOf(page, frame).locator(".frame-tab-title");
const mainTitle = (page: Page) => page.locator(".split-primary textarea.page-title");
const back = (page: Page) => page.locator(".topbar .history-button[data-direction=back]");
const forward = (page: Page) => page.locator(".topbar .history-button[data-direction=forward]");

// A pointer drag from one element to a point (the tabs use pointer events),
// once the page's cross-fade (lib/view-transition.ts) is over.
async function drag(page: Page, from: Locator, to: { x: number; y: number }) {
  await page.waitForFunction(() => !document.documentElement.dataset.viewTransition);
  const box = (await from.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 12, box.y + box.height / 2, { steps: 3 });
  await page.mouse.move(to.x, to.y, { steps: 12 });
  await page.mouse.up();
}

test("tabs: open with ⌘-click, reorder, close, the other frame, reload, history per tab", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "Tabs are for tablets and computers; phones are tested below.");
  test.skip(!process.env.FLOWPLAN_DATA_DIR, "Needs the test server data directory.");
  test.setTimeout(180_000);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const { a, b, c, d } = await setup(page);

  await page.goto(`/#page=${a}`);
  await expect(mainTitle(page)).toHaveValue("Seite A", { timeout: 30_000 });
  // One page: no tab bar, as before.
  await expect(page.locator(".frame-tabs")).toHaveCount(0);

  // ⌘/Ctrl-click in the page tree: new tabs beside the active one.
  await tree(page, b).click({ modifiers: ["ControlOrMeta"] });
  await expect(mainTitle(page)).toHaveValue("Seite B");
  await expect(titles(page, 0)).toHaveText(["Seite A", "Seite B"]);
  await tree(page, c).click({ modifiers: ["ControlOrMeta"] });
  await expect(titles(page, 0)).toHaveText(["Seite A", "Seite B", "Seite C"]);
  await expect(tabsOf(page, 0).nth(2)).toHaveAttribute("aria-selected", "true");
  await expect(mainTitle(page)).toHaveValue("Seite C");
  await expect(page).toHaveURL(new RegExp(`#page=${c}$`));
  // No split view any more for a plain ⌘-click.
  await expect(page.locator(".split-pane")).toHaveCount(0);

  // Clicking a tab shows its page.
  await tabsOf(page, 0).nth(0).click();
  await expect(mainTitle(page)).toHaveValue("Seite A");
  await expect(page).toHaveURL(new RegExp(`#page=${a}$`));

  // Reorder by dragging: A behind C.
  const lastBox = (await tabsOf(page, 0).nth(2).boundingBox())!;
  await drag(page, tabsOf(page, 0).nth(0), { x: lastBox.x + lastBox.width - 8, y: lastBox.y + lastBox.height / 2 });
  await expect(titles(page, 0)).toHaveText(["Seite B", "Seite C", "Seite A"]);
  await expect(mainTitle(page)).toHaveValue("Seite A");

  // The keyboard: the focused tab moves with Alt+Shift+←.
  await tabsOf(page, 0).nth(2).focus();
  await page.keyboard.press("Alt+Shift+ArrowLeft");
  await expect(titles(page, 0)).toHaveText(["Seite B", "Seite A", "Seite C"]);
  await expect(tabsOf(page, 0).nth(1)).toBeFocused();

  // Close with ×: B goes, A stays active.
  await tabsOf(page, 0).nth(0).hover();
  await tabsOf(page, 0).nth(0).getByRole("button", { name: "Seite B schließen" }).click();
  await expect(titles(page, 0)).toHaveText(["Seite A", "Seite C"]);
  await expect(mainTitle(page)).toHaveValue("Seite A");

  // ⌘/Ctrl+Shift-click: the other frame.
  await tree(page, d).click({ modifiers: ["ControlOrMeta", "Shift"] });
  await expect(page.locator(".split-pane")).toBeVisible();
  await expect(titles(page, 1)).toHaveText(["Seite D"]);
  await expect(page.locator(".split-pane .ProseMirror")).toBeVisible({ timeout: 30_000 });
  await expect(page).toHaveURL(new RegExp(`split=${d}`));
  await expect(mainTitle(page)).toHaveValue("Seite A");

  // Drag C into the right frame, before D.
  const dBox = (await tabsOf(page, 1).nth(0).boundingBox())!;
  await drag(page, tabsOf(page, 0).nth(1), { x: dBox.x + 10, y: dBox.y + dBox.height / 2 });
  await expect(titles(page, 1)).toHaveText(["Seite C", "Seite D"]);
  await expect(titles(page, 0)).toHaveText(["Seite A"]);
  await expect(tabsOf(page, 1).nth(0)).toHaveAttribute("aria-selected", "true");
  await expect(page).toHaveURL(new RegExp(`split=${c}`));
  if (shots) await page.screenshot({ path: join(shots, "tabs-two-frames.png") });

  // A reload brings the layout back.
  await page.reload();
  await expect(mainTitle(page)).toHaveValue("Seite A", { timeout: 30_000 });
  await expect(titles(page, 0)).toHaveText(["Seite A"]);
  await expect(titles(page, 1)).toHaveText(["Seite C", "Seite D"]);
  await expect(tabsOf(page, 1).nth(0)).toHaveAttribute("aria-selected", "true");

  // Closing the last tab of the right frame closes the frame.
  await tabsOf(page, 1).nth(1).click();
  await tabsOf(page, 1).nth(1).getByRole("button", { name: "Seite D schließen" }).click();
  await tabsOf(page, 1).nth(0).getByRole("button", { name: "Seite C schließen" }).click();
  await expect(page.locator(".split-pane")).toHaveCount(0);
  await expect(page.locator(".frame-tabs")).toHaveCount(0);

  // History per tab. Left frame worked in: a plain click goes there.
  await page.locator(".split-primary .main-scroll").click({ position: { x: 5, y: 5 } });
  await tree(page, b).click();
  await expect(mainTitle(page)).toHaveValue("Seite B");
  await expect(page.locator(".frame-tabs")).toHaveCount(0);
  // A second tab with its own steps: C, then D.
  await tree(page, c).click({ modifiers: ["ControlOrMeta"] });
  await expect(mainTitle(page)).toHaveValue("Seite C");
  await expect(back(page)).toBeDisabled();
  await tree(page, d).click();
  await expect(mainTitle(page)).toHaveValue("Seite D");
  await expect(titles(page, 0)).toHaveText(["Seite B", "Seite D"]);
  await back(page).click();
  await expect(mainTitle(page)).toHaveValue("Seite C");
  await expect(back(page)).toBeDisabled();
  await expect(forward(page)).toBeEnabled();
  // The first tab keeps its own: B, back to A.
  await tabsOf(page, 0).nth(0).click();
  await expect(mainTitle(page)).toHaveValue("Seite B");
  await back(page).click();
  await expect(mainTitle(page)).toHaveValue("Seite A");
  await expect(titles(page, 0)).toHaveText(["Seite A", "Seite C"]);
  await forward(page).click();
  await expect(mainTitle(page)).toHaveValue("Seite B");
  // The browser's own back acts on the active tab as well.
  await page.goBack();
  await expect(mainTitle(page)).toHaveValue("Seite A");
  await expect(titles(page, 0)).toHaveText(["Seite A", "Seite C"]);
  // The second tab's forward step is still there.
  await tabsOf(page, 0).nth(1).click();
  await expect(mainTitle(page)).toHaveValue("Seite C");
  // Outside of text (there Alt+→ moves by words).
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press("Alt+ArrowRight");
  await expect(mainTitle(page)).toHaveValue("Seite D");

  // Alt+W closes the active tab; middle click another.
  await page.locator(".split-primary .main-scroll").click({ position: { x: 5, y: 5 } });
  await page.keyboard.press("Alt+w");
  await expect(page.locator(".frame-tabs")).toHaveCount(0);
  await expect(mainTitle(page)).toHaveValue("Seite A");
  await tree(page, b).click({ button: "middle" });
  await expect(titles(page, 0)).toHaveText(["Seite A", "Seite B"]);
  await tabsOf(page, 0).nth(1).click({ button: "middle" });
  await expect(page.locator(".frame-tabs")).toHaveCount(0);

  // A page that went to the trash leaves its tab after a reload.
  await tree(page, c).click({ modifiers: ["ControlOrMeta"] });
  await expect(titles(page, 0)).toHaveText(["Seite A", "Seite C"]);
  // The tab's title follows a rename (saved when the title field is left,
  // as the page tree's).
  await expect(page.locator(".split-primary .ProseMirror")).toBeVisible();
  await expect(async () => {
    await mainTitle(page).fill("Seite C neu");
    await mainTitle(page).blur();
    await expect(titles(page, 0)).toHaveText(["Seite A", "Seite C neu"], { timeout: 3000 });
  }).toPass({ timeout: 30_000 });
  if (shots) await page.screenshot({ path: join(shots, "tabs-one-frame.png") });
  await tabsOf(page, 0).nth(0).click();
  await expect(mainTitle(page)).toHaveValue("Seite A");
  const trashed = await page.request.post("/api/command", { headers: { origin }, data: { action: "page.delete", pageId: c } });
  expect(trashed.ok(), await trashed.text()).toBe(true);
  await page.reload();
  await expect(mainTitle(page)).toHaveValue("Seite A", { timeout: 30_000 });
  await expect(page.locator(".frame-tabs")).toHaveCount(0);

  expect(errors).toEqual([]);
});

test("phones: no tab bar, a page at a time as before", async ({ page }, info) => {
  test.skip(info.project.name !== "mobile", "The phone layout.");
  test.skip(!process.env.FLOWPLAN_DATA_DIR, "Needs the test server data directory.");
  const { a, b } = await setup(page);
  await page.goto(`/#page=${a}`);
  await expect(page.locator("textarea.page-title")).toHaveValue("Seite A", { timeout: 30_000 });
  await page.evaluate((id) => (location.hash = `page=${id}`), b);
  await expect(page.locator("textarea.page-title")).toHaveValue("Seite B");
  await expect(page.locator(".frame-tabs")).toHaveCount(0);
  await page.goBack();
  await expect(page.locator("textarea.page-title")).toHaveValue("Seite A");
  await expect(page.locator(".frame-tabs")).toHaveCount(0);
  const stored = await page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith("flowplan-tabs:")));
  expect(stored).toEqual([]);
});
