import { test, expect, type Locator, type Page } from "@playwright/test";
import { join } from "node:path";

// #652: the split view's right frame (components/split-pane.tsx) frames a
// page as the main frame does (components/page-chrome.tsx) – the title in
// the same size and weight, the tags and properties, the related pages,
// the sub-pages with "Unterseite hinzufügen" – for a database and for a
// document, also when the same page is open in both frames.
const origin = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
const shots = process.env.SPLIT_SHOTS;

async function setup(page: Page) {
  await page.request.post("/api/auth/demo", { headers: { origin } });
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const command = async (data: Record<string, unknown>) => {
    const response = await page.request.post("/api/command", { headers: { origin }, data: { workspaceId: boot.workspace.id, ...data } });
    expect(response.ok(), await response.text()).toBe(true);
    return response.json();
  };
  const stamp = `${Date.now()}`;
  const spaceId = boot.spaces[0].id as string;
  const tag = await command({ action: "tag.save", name: `Geteilt-${stamp}`, spaceId });
  const create = async (title: string, kind: string, extra: Record<string, unknown> = {}) =>
    (await command({ action: "page.create", spaceId, title, kind, ...extra })).id as string;
  const db = await create(`Projekte ${stamp}`, "database", { databaseKind: "empty" });
  const doc = await create(`Notiz ${stamp}`, "document");
  const related = await create(`Verwandt ${stamp}`, "document");
  for (const id of [db, doc, related]) await command({ action: "page.properties", pageId: id, addTags: [tag.id] });
  await create(`Unterseite DB ${stamp}`, "document", { parentId: db });
  await create(`Unterseite Notiz ${stamp}`, "document", { parentId: doc });
  return { stamp, tag: `Geteilt-${stamp}`, db, doc };
}

const frames = (page: Page) => [page.locator(".split-primary article.page-content"), page.locator(".split-pane article.page-content")] as const;

async function style(locator: Locator, properties: string[]) {
  return locator.evaluate((el, names) => {
    const css = getComputedStyle(el);
    return Object.fromEntries(names.map((name) => [name, css.getPropertyValue(name)]));
  }, properties);
}

async function sameChrome(page: Page, title: string, tag: string, sub: string, related: string) {
  for (const frame of frames(page)) {
    await expect(frame.locator("textarea.page-title")).toHaveValue(title, { timeout: 30_000 });
    await expect(frame.locator(".document-header .large-page-icon")).toBeVisible();
    // Tags and properties: the tag and "+ Eigenschaft".
    await expect(frame.locator(".page-properties .page-tag-name", { hasText: tag })).toBeVisible({ timeout: 30_000 });
    await expect(frame.getByRole("region", { name: "Tags und Eigenschaften" })).toBeVisible();
    // Related pages (the same tag) and the sub-pages.
    await expect(frame.locator(".related-pages")).toContainText(related, { timeout: 30_000 });
    await expect(frame.locator(".subpages")).toContainText(sub);
    await expect(frame.locator(".subpages").getByRole("button", { name: "Unterseite hinzufügen" })).toBeVisible();
  }
  const [main, side] = frames(page);
  const titleStyle = ["font-size", "font-weight", "font-family", "line-height"];
  expect(await style(side.locator("textarea.page-title"), titleStyle)).toEqual(await style(main.locator("textarea.page-title"), titleStyle));
  const boxStyle = ["max-width", "padding-top", "padding-right", "padding-left"];
  expect(await style(side, boxStyle)).toEqual(await style(main, boxStyle));
  expect(await side.getAttribute("class")).toBe(await main.getAttribute("class"));
}

test("the same database in both frames looks the same (#652)", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "The split view is for wide screens.");
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.setViewportSize({ width: 1600, height: 900 });
  const { stamp, tag, db } = await setup(page);
  await page.goto(`/?split=${db}#page=${db}`);
  await sameChrome(page, `Projekte ${stamp}`, tag, `Unterseite DB ${stamp}`, `Verwandt ${stamp}`);
  for (const frame of frames(page)) {
    await expect(frame.locator(".database-tabs")).toBeVisible();
    await expect(frame.locator(".database-toolbar")).toBeVisible();
  }
  if (shots) await page.screenshot({ path: join(shots, "652-split.png") });

  // A record added on the left shows on the right at once (not only with
  // the right frame's 10 s refresh).
  const [main, side] = frames(page);
  await expect(side.locator("tr[data-row-id]")).toHaveCount(0);
  await main.getByRole("button", { name: "Neue Zeile", exact: true }).click();
  await expect(main.locator("tr[data-row-id]")).toHaveCount(1, { timeout: 15_000 });
  await page.keyboard.press("Escape");
  await expect(side.locator("tr[data-row-id]")).toHaveCount(1, { timeout: 5_000 });

  // A sub-page opens in the frame it was clicked in.
  await side.locator(".subpages").getByRole("button", { name: `Unterseite DB ${stamp}` }).click();
  await expect(side.locator("textarea.page-title")).toHaveValue(`Unterseite DB ${stamp}`, { timeout: 30_000 });
  await expect(main.locator("textarea.page-title")).toHaveValue(`Projekte ${stamp}`);
  expect(errors).toEqual([]);
});

test("the same document in both frames looks the same and syncs (#652)", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "The split view is for wide screens.");
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.setViewportSize({ width: 1600, height: 900 });
  const { stamp, tag, doc } = await setup(page);
  await page.goto(`/?split=${doc}#page=${doc}`);
  await sameChrome(page, `Notiz ${stamp}`, tag, `Unterseite Notiz ${stamp}`, `Verwandt ${stamp}`);
  const [mainDoc, sideDoc] = frames(page);
  await sideDoc.getByLabel("Dokumentinhalt", { exact: true }).click();
  await page.keyboard.type(`Rechts ${stamp}`);
  await expect(mainDoc.getByLabel("Dokumentinhalt", { exact: true })).toContainText(`Rechts ${stamp}`, { timeout: 30_000 });
  if (shots) await page.screenshot({ path: join(shots, "652-split-document.png") });

  // A new title in the right frame reaches the main frame and the tree.
  const sideTitle = sideDoc.locator("textarea.page-title");
  await sideTitle.fill(`Notiz neu ${stamp}`);
  await sideTitle.press("Tab");
  await expect(page.locator(`.page-nav[data-page-id="${doc}"] .page-nav-title`).first()).toHaveText(`Notiz neu ${stamp}`, { timeout: 30_000 });
  expect(errors).toEqual([]);
});
